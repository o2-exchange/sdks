/// WebSocket client for O2 Exchange real-time data.
///
/// Features:
/// - Auto-reconnect with exponential backoff
/// - Subscription tracking and automatic re-subscribe on reconnect
/// - Per-subscription channels (no race condition on concurrent stream calls)
/// - Heartbeat ping/pong with configurable intervals
/// - Graceful shutdown signaling
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio_stream::Stream;
use tokio_tungstenite::tungstenite::Message as WsMsg;

use crate::errors::O2Error;
use crate::models::*;

type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    WsMsg,
>;

type WsStream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

/// Configuration for WebSocket reconnection behavior.
#[derive(Debug, Clone)]
pub struct WsConfig {
    /// Base delay between reconnect attempts (default: 1s).
    pub base_delay: Duration,
    /// Maximum delay between reconnect attempts (default: 60s).
    pub max_delay: Duration,
    /// Maximum number of reconnect attempts (default: 10, 0 = infinite).
    pub max_attempts: usize,
    /// Interval between ping frames (default: 30s).
    pub ping_interval: Duration,
    /// Timeout for pong response before triggering reconnect (default: 60s).
    pub pong_timeout: Duration,
}

impl Default for WsConfig {
    fn default() -> Self {
        Self {
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            max_attempts: 10,
            ping_interval: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(60),
        }
    }
}

/// A typed stream of WebSocket messages.
pub struct TypedStream<T> {
    rx: mpsc::UnboundedReceiver<T>,
}

impl<T> Stream for TypedStream<T> {
    type Item = T;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

/// Shared inner state for the WebSocket connection.
struct WsInner {
    sink: Option<WsSink>,
    subscriptions: Vec<serde_json::Value>,
    depth_senders: Vec<mpsc::UnboundedSender<DepthUpdate>>,
    orders_senders: Vec<mpsc::UnboundedSender<OrderUpdate>>,
    trades_senders: Vec<mpsc::UnboundedSender<TradeUpdate>>,
    balances_senders: Vec<mpsc::UnboundedSender<BalanceUpdate>>,
    nonce_senders: Vec<mpsc::UnboundedSender<NonceUpdate>>,
}

impl WsInner {
    fn new() -> Self {
        Self {
            sink: None,
            subscriptions: Vec::new(),
            depth_senders: Vec::new(),
            orders_senders: Vec::new(),
            trades_senders: Vec::new(),
            balances_senders: Vec::new(),
            nonce_senders: Vec::new(),
        }
    }

    /// Remove closed senders from all sender lists.
    fn prune_closed_senders(&mut self) {
        self.depth_senders.retain(|s| !s.is_closed());
        self.orders_senders.retain(|s| !s.is_closed());
        self.trades_senders.retain(|s| !s.is_closed());
        self.balances_senders.retain(|s| !s.is_closed());
        self.nonce_senders.retain(|s| !s.is_closed());
    }

    /// Close all sender channels (signals receivers to terminate).
    fn close_all_senders(&mut self) {
        self.depth_senders.clear();
        self.orders_senders.clear();
        self.trades_senders.clear();
        self.balances_senders.clear();
        self.nonce_senders.clear();
    }
}

/// WebSocket client for O2 Exchange real-time data.
///
/// Supports auto-reconnect, subscription tracking, heartbeat,
/// and per-subscription channels for safe concurrent access.
pub struct O2WebSocket {
    url: String,
    config: WsConfig,
    inner: Arc<Mutex<WsInner>>,
    connected: Arc<AtomicBool>,
    should_run: Arc<AtomicBool>,
    last_pong: Arc<Mutex<Instant>>,
    reader_handle: Option<tokio::task::JoinHandle<()>>,
    ping_handle: Option<tokio::task::JoinHandle<()>>,
}

impl O2WebSocket {
    /// Connect to the O2 WebSocket endpoint.
    pub async fn connect(url: &str) -> Result<Self, O2Error> {
        Self::connect_with_config(url, WsConfig::default()).await
    }

    /// Connect with custom configuration.
    pub async fn connect_with_config(url: &str, config: WsConfig) -> Result<Self, O2Error> {
        let inner = Arc::new(Mutex::new(WsInner::new()));
        let connected = Arc::new(AtomicBool::new(false));
        let should_run = Arc::new(AtomicBool::new(true));
        let last_pong = Arc::new(Mutex::new(Instant::now()));

        let mut ws = Self {
            url: url.to_string(),
            config,
            inner,
            connected,
            should_run,
            last_pong,
            reader_handle: None,
            ping_handle: None,
        };

        ws.do_connect().await?;
        Ok(ws)
    }

    async fn do_connect(&mut self) -> Result<(), O2Error> {
        let (ws_stream, _) = tokio_tungstenite::connect_async(&self.url).await?;
        let (sink, stream) = ws_stream.split();

        {
            let mut guard = self.inner.lock().await;
            guard.sink = Some(sink);
        }

        self.connected.store(true, Ordering::SeqCst);
        *self.last_pong.lock().await = Instant::now();

        // Re-send all tracked subscriptions
        {
            let guard = self.inner.lock().await;
            let subs = guard.subscriptions.clone();
            if guard.sink.is_some() {
                // We need to drop guard to send, so collect first
                drop(guard);
                let mut inner = self.inner.lock().await;
                if let Some(ref mut sink) = inner.sink {
                    for sub in &subs {
                        let text = serde_json::to_string(sub).unwrap_or_default();
                        let _ = sink.send(WsMsg::Text(text)).await;
                    }
                }
            }
        }

        // Spawn read loop
        let inner_clone = self.inner.clone();
        let connected_clone = self.connected.clone();
        let should_run_clone = self.should_run.clone();
        let last_pong_clone = self.last_pong.clone();
        let url_clone = self.url.clone();
        let config_clone = self.config.clone();

        let reader_handle = tokio::spawn(async move {
            Self::read_loop(
                stream,
                inner_clone.clone(),
                connected_clone.clone(),
                should_run_clone.clone(),
                last_pong_clone.clone(),
            )
            .await;

            // If we should still be running, attempt reconnect
            if should_run_clone.load(Ordering::SeqCst) {
                connected_clone.store(false, Ordering::SeqCst);
                Self::reconnect_loop(
                    &url_clone,
                    &config_clone,
                    inner_clone,
                    connected_clone,
                    should_run_clone,
                    last_pong_clone,
                )
                .await;
            }
        });
        self.reader_handle = Some(reader_handle);

        // Spawn ping task
        let inner_ping = self.inner.clone();
        let connected_ping = self.connected.clone();
        let should_run_ping = self.should_run.clone();
        let last_pong_ping = self.last_pong.clone();
        let ping_interval = self.config.ping_interval;
        let pong_timeout = self.config.pong_timeout;

        let ping_handle = tokio::spawn(async move {
            Self::ping_loop(
                inner_ping,
                connected_ping,
                should_run_ping,
                last_pong_ping,
                ping_interval,
                pong_timeout,
            )
            .await;
        });
        self.ping_handle = Some(ping_handle);

        Ok(())
    }

    async fn read_loop(
        mut stream: WsStream,
        inner: Arc<Mutex<WsInner>>,
        connected: Arc<AtomicBool>,
        should_run: Arc<AtomicBool>,
        last_pong: Arc<Mutex<Instant>>,
    ) {
        while should_run.load(Ordering::SeqCst) {
            let msg = match stream.next().await {
                Some(Ok(m)) => m,
                Some(Err(_)) => break,
                None => break,
            };

            match msg {
                WsMsg::Text(text) => {
                    let text = text.to_string();
                    let parsed: serde_json::Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };

                    let action = parsed.get("action").and_then(|a| a.as_str()).unwrap_or("");

                    let mut guard = inner.lock().await;
                    guard.prune_closed_senders();

                    match action {
                        "subscribe_depth" | "subscribe_depth_update" => {
                            if let Ok(update) = serde_json::from_value::<DepthUpdate>(parsed) {
                                for tx in &guard.depth_senders {
                                    let _ = tx.send(update.clone());
                                }
                            }
                        }
                        "subscribe_orders" => {
                            if let Ok(update) = serde_json::from_value::<OrderUpdate>(parsed) {
                                for tx in &guard.orders_senders {
                                    let _ = tx.send(update.clone());
                                }
                            }
                        }
                        "trades" => {
                            if let Ok(update) = serde_json::from_value::<TradeUpdate>(parsed) {
                                for tx in &guard.trades_senders {
                                    let _ = tx.send(update.clone());
                                }
                            }
                        }
                        "subscribe_balances" => {
                            if let Ok(update) = serde_json::from_value::<BalanceUpdate>(parsed) {
                                for tx in &guard.balances_senders {
                                    let _ = tx.send(update.clone());
                                }
                            }
                        }
                        "nonce" => {
                            if let Ok(update) = serde_json::from_value::<NonceUpdate>(parsed) {
                                for tx in &guard.nonce_senders {
                                    let _ = tx.send(update.clone());
                                }
                            }
                        }
                        _ => {}
                    }
                }
                WsMsg::Pong(_) => {
                    *last_pong.lock().await = Instant::now();
                }
                WsMsg::Close(_) => {
                    connected.store(false, Ordering::SeqCst);
                    break;
                }
                WsMsg::Ping(data) => {
                    // Respond to server pings
                    let mut guard = inner.lock().await;
                    if let Some(ref mut sink) = guard.sink {
                        let _ = sink.send(WsMsg::Pong(data)).await;
                    }
                }
                _ => {}
            }
        }
    }

    async fn ping_loop(
        inner: Arc<Mutex<WsInner>>,
        connected: Arc<AtomicBool>,
        should_run: Arc<AtomicBool>,
        last_pong: Arc<Mutex<Instant>>,
        ping_interval: Duration,
        pong_timeout: Duration,
    ) {
        let mut interval = tokio::time::interval(ping_interval);
        interval.tick().await; // skip first immediate tick

        while should_run.load(Ordering::SeqCst) {
            interval.tick().await;

            if !connected.load(Ordering::SeqCst) {
                continue;
            }

            // Check pong timeout
            let last = *last_pong.lock().await;
            if last.elapsed() > pong_timeout {
                // Pong timeout — close sink to trigger reconnect in read loop
                let mut guard = inner.lock().await;
                if let Some(ref mut sink) = guard.sink {
                    let _ = sink.close().await;
                }
                connected.store(false, Ordering::SeqCst);
                continue;
            }

            // Send ping
            let mut guard = inner.lock().await;
            if let Some(ref mut sink) = guard.sink {
                let _ = sink.send(WsMsg::Ping(Vec::new())).await;
            }
        }
    }

    async fn reconnect_loop(
        url: &str,
        config: &WsConfig,
        inner: Arc<Mutex<WsInner>>,
        connected: Arc<AtomicBool>,
        should_run: Arc<AtomicBool>,
        last_pong: Arc<Mutex<Instant>>,
    ) {
        let mut delay = config.base_delay;
        let mut attempts = 0;

        while should_run.load(Ordering::SeqCst) {
            if config.max_attempts > 0 && attempts >= config.max_attempts {
                // Max attempts reached — signal all subscribers and stop
                let mut guard = inner.lock().await;
                guard.close_all_senders();
                return;
            }

            tokio::time::sleep(delay).await;
            attempts += 1;

            match tokio_tungstenite::connect_async(url).await {
                Ok((ws_stream, _)) => {
                    let (sink, stream) = ws_stream.split();

                    {
                        let mut guard = inner.lock().await;
                        guard.sink = Some(sink);
                    }

                    connected.store(true, Ordering::SeqCst);
                    *last_pong.lock().await = Instant::now();

                    // Re-send all tracked subscriptions
                    {
                        let guard = inner.lock().await;
                        let subs = guard.subscriptions.clone();
                        drop(guard);
                        let mut guard = inner.lock().await;
                        if let Some(ref mut sink) = guard.sink {
                            for sub in &subs {
                                let text = serde_json::to_string(sub).unwrap_or_default();
                                let _ = sink.send(WsMsg::Text(text)).await;
                            }
                        }
                    }

                    // Spawn new read loop (recursive via reconnect)
                    Self::read_loop(
                        stream,
                        inner.clone(),
                        connected.clone(),
                        should_run.clone(),
                        last_pong.clone(),
                    )
                    .await;

                    // If read loop exited and we should still run, reset delay and retry
                    if should_run.load(Ordering::SeqCst) {
                        connected.store(false, Ordering::SeqCst);
                        delay = config.base_delay;
                        attempts = 0;
                        continue;
                    }
                    return;
                }
                Err(_) => {
                    delay = (delay * 2).min(config.max_delay);
                }
            }
        }
    }

    async fn send_json(&self, value: serde_json::Value) -> Result<(), O2Error> {
        let text = serde_json::to_string(&value)?;
        let mut guard = self.inner.lock().await;
        if let Some(ref mut sink) = guard.sink {
            sink.send(WsMsg::Text(text))
                .await
                .map_err(|e| O2Error::WebSocketError(e.to_string()))
        } else {
            Err(O2Error::WebSocketError("Not connected".into()))
        }
    }

    fn add_subscription(inner: &mut WsInner, sub: serde_json::Value) {
        if !inner.subscriptions.contains(&sub) {
            inner.subscriptions.push(sub);
        }
    }

    /// Check if the WebSocket is currently connected.
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Subscribe to order book depth. Returns a stream of DepthUpdate messages.
    pub async fn stream_depth(
        &self,
        market_id: &str,
        precision: &str,
    ) -> Result<TypedStream<DepthUpdate>, O2Error> {
        let (tx, rx) = mpsc::unbounded_channel();
        let sub = json!({
            "action": "subscribe_depth",
            "market_id": market_id,
            "precision": precision
        });

        {
            let mut guard = self.inner.lock().await;
            guard.depth_senders.push(tx);
            Self::add_subscription(&mut guard, sub.clone());
        }

        self.send_json(sub).await?;
        Ok(TypedStream { rx })
    }

    /// Subscribe to order updates. Returns a stream of OrderUpdate messages.
    pub async fn stream_orders(
        &self,
        identities: &[Identity],
    ) -> Result<TypedStream<OrderUpdate>, O2Error> {
        let (tx, rx) = mpsc::unbounded_channel();
        let sub = json!({
            "action": "subscribe_orders",
            "identities": identities
        });

        {
            let mut guard = self.inner.lock().await;
            guard.orders_senders.push(tx);
            Self::add_subscription(&mut guard, sub.clone());
        }

        self.send_json(sub).await?;
        Ok(TypedStream { rx })
    }

    /// Subscribe to trades. Returns a stream of TradeUpdate messages.
    pub async fn stream_trades(
        &self,
        market_id: &str,
    ) -> Result<TypedStream<TradeUpdate>, O2Error> {
        let (tx, rx) = mpsc::unbounded_channel();
        let sub = json!({
            "action": "subscribe_trades",
            "market_id": market_id
        });

        {
            let mut guard = self.inner.lock().await;
            guard.trades_senders.push(tx);
            Self::add_subscription(&mut guard, sub.clone());
        }

        self.send_json(sub).await?;
        Ok(TypedStream { rx })
    }

    /// Subscribe to balance updates. Returns a stream of BalanceUpdate messages.
    pub async fn stream_balances(
        &self,
        identities: &[Identity],
    ) -> Result<TypedStream<BalanceUpdate>, O2Error> {
        let (tx, rx) = mpsc::unbounded_channel();
        let sub = json!({
            "action": "subscribe_balances",
            "identities": identities
        });

        {
            let mut guard = self.inner.lock().await;
            guard.balances_senders.push(tx);
            Self::add_subscription(&mut guard, sub.clone());
        }

        self.send_json(sub).await?;
        Ok(TypedStream { rx })
    }

    /// Subscribe to nonce updates. Returns a stream of NonceUpdate messages.
    pub async fn stream_nonce(
        &self,
        identities: &[Identity],
    ) -> Result<TypedStream<NonceUpdate>, O2Error> {
        let (tx, rx) = mpsc::unbounded_channel();
        let sub = json!({
            "action": "subscribe_nonce",
            "identities": identities
        });

        {
            let mut guard = self.inner.lock().await;
            guard.nonce_senders.push(tx);
            Self::add_subscription(&mut guard, sub.clone());
        }

        self.send_json(sub).await?;
        Ok(TypedStream { rx })
    }

    /// Unsubscribe from depth updates.
    pub async fn unsubscribe_depth(&self, market_id: &str) -> Result<(), O2Error> {
        self.send_json(json!({
            "action": "unsubscribe_depth",
            "market_id": market_id
        }))
        .await?;
        let mut guard = self.inner.lock().await;
        guard.subscriptions.retain(|s| {
            !(s.get("action").and_then(|a| a.as_str()) == Some("subscribe_depth")
                && s.get("market_id").and_then(|m| m.as_str()) == Some(market_id))
        });
        Ok(())
    }

    /// Unsubscribe from order updates.
    pub async fn unsubscribe_orders(&self) -> Result<(), O2Error> {
        self.send_json(json!({
            "action": "unsubscribe_orders"
        }))
        .await?;
        let mut guard = self.inner.lock().await;
        guard
            .subscriptions
            .retain(|s| s.get("action").and_then(|a| a.as_str()) != Some("subscribe_orders"));
        Ok(())
    }

    /// Unsubscribe from trade updates.
    pub async fn unsubscribe_trades(&self, market_id: &str) -> Result<(), O2Error> {
        self.send_json(json!({
            "action": "unsubscribe_trades",
            "market_id": market_id
        }))
        .await?;
        let mut guard = self.inner.lock().await;
        guard.subscriptions.retain(|s| {
            !(s.get("action").and_then(|a| a.as_str()) == Some("subscribe_trades")
                && s.get("market_id").and_then(|m| m.as_str()) == Some(market_id))
        });
        Ok(())
    }

    /// Unsubscribe from balance updates.
    pub async fn unsubscribe_balances(&self, identities: &[Identity]) -> Result<(), O2Error> {
        self.send_json(json!({
            "action": "unsubscribe_balances",
            "identities": identities
        }))
        .await?;
        let mut guard = self.inner.lock().await;
        guard
            .subscriptions
            .retain(|s| s.get("action").and_then(|a| a.as_str()) != Some("subscribe_balances"));
        Ok(())
    }

    /// Unsubscribe from nonce updates.
    pub async fn unsubscribe_nonce(&self, identities: &[Identity]) -> Result<(), O2Error> {
        self.send_json(json!({
            "action": "unsubscribe_nonce",
            "identities": identities
        }))
        .await?;
        let mut guard = self.inner.lock().await;
        guard
            .subscriptions
            .retain(|s| s.get("action").and_then(|a| a.as_str()) != Some("subscribe_nonce"));
        Ok(())
    }

    /// Close the WebSocket connection and stop all tasks.
    pub async fn disconnect(&self) -> Result<(), O2Error> {
        self.should_run.store(false, Ordering::SeqCst);
        self.connected.store(false, Ordering::SeqCst);

        // Send close frame
        let mut guard = self.inner.lock().await;
        if let Some(ref mut sink) = guard.sink {
            let _ = sink.send(WsMsg::Close(None)).await;
        }

        // Close all sender channels
        guard.close_all_senders();

        Ok(())
    }
}
