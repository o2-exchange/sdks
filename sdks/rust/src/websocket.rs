/// WebSocket client for O2 Exchange real-time data.
///
/// Provides async stream-based subscriptions for depth, orders, trades,
/// balances, and nonce updates via tokio-tungstenite.
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
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

/// WebSocket client for O2 Exchange real-time data.
pub struct O2WebSocket {
    sink: Arc<Mutex<WsSink>>,
    _reader_handle: tokio::task::JoinHandle<()>,
    depth_tx: Arc<Mutex<Option<mpsc::UnboundedSender<DepthUpdate>>>>,
    orders_tx: Arc<Mutex<Option<mpsc::UnboundedSender<OrderUpdate>>>>,
    trades_tx: Arc<Mutex<Option<mpsc::UnboundedSender<TradeUpdate>>>>,
    balances_tx: Arc<Mutex<Option<mpsc::UnboundedSender<BalanceUpdate>>>>,
    nonce_tx: Arc<Mutex<Option<mpsc::UnboundedSender<NonceUpdate>>>>,
}

impl O2WebSocket {
    /// Connect to the O2 WebSocket endpoint.
    pub async fn connect(url: &str) -> Result<Self, O2Error> {
        let (ws_stream, _) = tokio_tungstenite::connect_async(url).await?;
        let (sink, stream) = ws_stream.split();

        let depth_tx: Arc<Mutex<Option<mpsc::UnboundedSender<DepthUpdate>>>> =
            Arc::new(Mutex::new(None));
        let orders_tx: Arc<Mutex<Option<mpsc::UnboundedSender<OrderUpdate>>>> =
            Arc::new(Mutex::new(None));
        let trades_tx: Arc<Mutex<Option<mpsc::UnboundedSender<TradeUpdate>>>> =
            Arc::new(Mutex::new(None));
        let balances_tx: Arc<Mutex<Option<mpsc::UnboundedSender<BalanceUpdate>>>> =
            Arc::new(Mutex::new(None));
        let nonce_tx: Arc<Mutex<Option<mpsc::UnboundedSender<NonceUpdate>>>> =
            Arc::new(Mutex::new(None));

        let depth_tx_clone = depth_tx.clone();
        let orders_tx_clone = orders_tx.clone();
        let trades_tx_clone = trades_tx.clone();
        let balances_tx_clone = balances_tx.clone();
        let nonce_tx_clone = nonce_tx.clone();

        let reader_handle = tokio::spawn(async move {
            Self::read_loop(
                stream,
                depth_tx_clone,
                orders_tx_clone,
                trades_tx_clone,
                balances_tx_clone,
                nonce_tx_clone,
            )
            .await;
        });

        Ok(Self {
            sink: Arc::new(Mutex::new(sink)),
            _reader_handle: reader_handle,
            depth_tx,
            orders_tx,
            trades_tx,
            balances_tx,
            nonce_tx,
        })
    }

    async fn read_loop(
        mut stream: WsStream,
        depth_tx: Arc<Mutex<Option<mpsc::UnboundedSender<DepthUpdate>>>>,
        orders_tx: Arc<Mutex<Option<mpsc::UnboundedSender<OrderUpdate>>>>,
        trades_tx: Arc<Mutex<Option<mpsc::UnboundedSender<TradeUpdate>>>>,
        balances_tx: Arc<Mutex<Option<mpsc::UnboundedSender<BalanceUpdate>>>>,
        nonce_tx: Arc<Mutex<Option<mpsc::UnboundedSender<NonceUpdate>>>>,
    ) {
        while let Some(msg) = stream.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(_) => break,
            };

            let text = match msg {
                WsMsg::Text(t) => t.to_string(),
                WsMsg::Ping(_) => continue,
                WsMsg::Close(_) => break,
                _ => continue,
            };

            let parsed: serde_json::Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let action = parsed.get("action").and_then(|a| a.as_str()).unwrap_or("");

            match action {
                "subscribe_depth" | "subscribe_depth_update" => {
                    if let Ok(update) = serde_json::from_value::<DepthUpdate>(parsed) {
                        let guard = depth_tx.lock().await;
                        if let Some(tx) = guard.as_ref() {
                            let _ = tx.send(update);
                        }
                    }
                }
                "subscribe_orders" => {
                    if let Ok(update) = serde_json::from_value::<OrderUpdate>(parsed) {
                        let guard = orders_tx.lock().await;
                        if let Some(tx) = guard.as_ref() {
                            let _ = tx.send(update);
                        }
                    }
                }
                "trades" => {
                    if let Ok(update) = serde_json::from_value::<TradeUpdate>(parsed) {
                        let guard = trades_tx.lock().await;
                        if let Some(tx) = guard.as_ref() {
                            let _ = tx.send(update);
                        }
                    }
                }
                "subscribe_balances" => {
                    if let Ok(update) = serde_json::from_value::<BalanceUpdate>(parsed) {
                        let guard = balances_tx.lock().await;
                        if let Some(tx) = guard.as_ref() {
                            let _ = tx.send(update);
                        }
                    }
                }
                "nonce" => {
                    if let Ok(update) = serde_json::from_value::<NonceUpdate>(parsed) {
                        let guard = nonce_tx.lock().await;
                        if let Some(tx) = guard.as_ref() {
                            let _ = tx.send(update);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    async fn send_json(&self, value: serde_json::Value) -> Result<(), O2Error> {
        let text = serde_json::to_string(&value)?;
        let mut sink = self.sink.lock().await;
        sink.send(WsMsg::Text(text))
            .await
            .map_err(|e| O2Error::WebSocketError(e.to_string()))
    }

    /// Subscribe to order book depth. Returns a stream of DepthUpdate messages.
    pub async fn stream_depth(
        &self,
        market_id: &str,
        precision: &str,
    ) -> Result<TypedStream<DepthUpdate>, O2Error> {
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut guard = self.depth_tx.lock().await;
            *guard = Some(tx);
        }

        self.send_json(json!({
            "action": "subscribe_depth",
            "market_id": market_id,
            "precision": precision
        }))
        .await?;

        Ok(TypedStream { rx })
    }

    /// Subscribe to order updates. Returns a stream of OrderUpdate messages.
    pub async fn stream_orders(
        &self,
        identities: &[Identity],
    ) -> Result<TypedStream<OrderUpdate>, O2Error> {
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut guard = self.orders_tx.lock().await;
            *guard = Some(tx);
        }

        self.send_json(json!({
            "action": "subscribe_orders",
            "identities": identities
        }))
        .await?;

        Ok(TypedStream { rx })
    }

    /// Subscribe to trades. Returns a stream of TradeUpdate messages.
    pub async fn stream_trades(
        &self,
        market_id: &str,
    ) -> Result<TypedStream<TradeUpdate>, O2Error> {
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut guard = self.trades_tx.lock().await;
            *guard = Some(tx);
        }

        self.send_json(json!({
            "action": "subscribe_trades",
            "market_id": market_id
        }))
        .await?;

        Ok(TypedStream { rx })
    }

    /// Subscribe to balance updates. Returns a stream of BalanceUpdate messages.
    pub async fn stream_balances(
        &self,
        identities: &[Identity],
    ) -> Result<TypedStream<BalanceUpdate>, O2Error> {
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut guard = self.balances_tx.lock().await;
            *guard = Some(tx);
        }

        self.send_json(json!({
            "action": "subscribe_balances",
            "identities": identities
        }))
        .await?;

        Ok(TypedStream { rx })
    }

    /// Subscribe to nonce updates. Returns a stream of NonceUpdate messages.
    pub async fn stream_nonce(
        &self,
        identities: &[Identity],
    ) -> Result<TypedStream<NonceUpdate>, O2Error> {
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut guard = self.nonce_tx.lock().await;
            *guard = Some(tx);
        }

        self.send_json(json!({
            "action": "subscribe_nonce",
            "identities": identities
        }))
        .await?;

        Ok(TypedStream { rx })
    }

    /// Unsubscribe from depth updates.
    pub async fn unsubscribe_depth(&self, market_id: &str) -> Result<(), O2Error> {
        self.send_json(json!({
            "action": "unsubscribe_depth",
            "market_id": market_id
        }))
        .await
    }

    /// Unsubscribe from order updates.
    pub async fn unsubscribe_orders(&self) -> Result<(), O2Error> {
        self.send_json(json!({
            "action": "unsubscribe_orders"
        }))
        .await
    }

    /// Unsubscribe from trade updates.
    pub async fn unsubscribe_trades(&self, market_id: &str) -> Result<(), O2Error> {
        self.send_json(json!({
            "action": "unsubscribe_trades",
            "market_id": market_id
        }))
        .await
    }

    /// Unsubscribe from balance updates.
    pub async fn unsubscribe_balances(&self, identities: &[Identity]) -> Result<(), O2Error> {
        self.send_json(json!({
            "action": "unsubscribe_balances",
            "identities": identities
        }))
        .await
    }

    /// Unsubscribe from nonce updates.
    pub async fn unsubscribe_nonce(&self, identities: &[Identity]) -> Result<(), O2Error> {
        self.send_json(json!({
            "action": "unsubscribe_nonce",
            "identities": identities
        }))
        .await
    }

    /// Close the WebSocket connection.
    pub async fn disconnect(&self) -> Result<(), O2Error> {
        let mut sink = self.sink.lock().await;
        sink.send(WsMsg::Close(None))
            .await
            .map_err(|e| O2Error::WebSocketError(e.to_string()))
    }
}
