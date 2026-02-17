#![cfg(feature = "integration")]
/// Unit tests for WebSocket functionality using a mock server.
///
/// These tests use an in-process mock WebSocket server to test all subscription types,
/// reconnection, heartbeat, and long-lived connection behavior without hitting testnet.
///
/// Run with: cargo test --features integration --test websocket_tests
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message as WsMsg;

use o2_sdk::models::*;
use o2_sdk::websocket::{O2WebSocket, WsConfig};

/// Create a mock server that sends specific messages on connection.
async fn create_messaging_mock_server(messages: Vec<serde_json::Value>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            if let Ok(ws_stream) = accept_async(stream).await {
                let (mut sender, mut receiver) = ws_stream.split();

                // Send all messages immediately after connection
                for msg in &messages {
                    let text = serde_json::to_string(msg).unwrap();
                    let _ = sender.send(WsMsg::Text(text)).await;
                }

                // Keep connection alive
                while let Some(Ok(msg)) = receiver.next().await {
                    match msg {
                        WsMsg::Ping(data) => {
                            let _ = sender.send(WsMsg::Pong(data)).await;
                        }
                        WsMsg::Close(_) => break,
                        _ => {}
                    }
                }
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    format!("ws://{}", addr)
}

/// Create a mock server that drops connections after sending messages.
async fn create_reconnect_mock_server(
    first_messages: Vec<serde_json::Value>,
    second_messages: Vec<serde_json::Value>,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let connection_count = Arc::new(Mutex::new(0));

    tokio::spawn(async move {
        loop {
            if let Ok((stream, _)) = listener.accept().await {
                let mut count = connection_count.lock().await;
                *count += 1;
                let is_first = *count == 1;
                drop(count);

                if let Ok(ws_stream) = accept_async(stream).await {
                    let (mut sender, mut receiver) = ws_stream.split();

                    let messages = if is_first {
                        &first_messages
                    } else {
                        &second_messages
                    };

                    for msg in messages {
                        let text = serde_json::to_string(msg).unwrap();
                        let _ = sender.send(WsMsg::Text(text)).await;
                    }

                    if is_first {
                        // Drop connection after first message
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        let _ = sender.send(WsMsg::Close(None)).await;
                        continue;
                    }

                    // Keep second connection alive
                    while let Some(Ok(msg)) = receiver.next().await {
                        match msg {
                            WsMsg::Ping(data) => {
                                let _ = sender.send(WsMsg::Pong(data)).await;
                            }
                            WsMsg::Close(_) => break,
                            _ => {}
                        }
                    }
                }
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    format!("ws://{}", addr)
}

/// Create a mock server that refuses all connections.
async fn create_refusing_mock_server() -> String {
    // Bind a port but don't accept connections
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        // Immediately drop all connections
        while let Ok((_stream, _)) = listener.accept().await {
            // Don't process the connection
        }
    });

    format!("ws://{}", addr)
}

#[tokio::test]
async fn test_ws_depth_stream_receives_messages() {
    let messages = vec![
        json!({
            "action": "subscribe_depth_update",
            "market_id": "market1",
            "view": {
                "buys": [{"price": "100", "quantity": "10"}],
                "sells": []
            }
        }),
        json!({
            "action": "subscribe_depth",
            "market_id": "market1",
            "changes": {
                "buys": [{"price": "101", "quantity": "5"}],
                "sells": []
            }
        }),
        json!({
            "action": "subscribe_depth_update",
            "market_id": "market1",
            "view": {
                "buys": [{"price": "102", "quantity": "8"}],
                "sells": []
            }
        }),
    ];

    let url = create_messaging_mock_server(messages).await;
    let ws = O2WebSocket::connect(&url).await.unwrap();
    let mut stream = ws.stream_depth("market1", "10").await.unwrap();

    // Receive all 3 messages
    let mut received = vec![];
    for _ in 0..3 {
        if let Some(update) = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .ok()
            .flatten()
        {
            received.push(update.unwrap());
        }
    }

    assert_eq!(received.len(), 3, "Should receive 3 depth updates");
    assert!(
        received[0].view.is_some() || received[0].changes.is_some(),
        "First update should have view or changes"
    );

    let _ = ws.disconnect().await;
}

#[tokio::test]
async fn test_ws_orders_stream_receives_messages() {
    let messages = vec![json!({
        "action": "subscribe_orders",
        "orders": [{
            "order_id": "order123",
            "market_id": "market1",
            "side": "buy",
            "price": "100",
            "quantity": "10"
        }],
        "onchain_timestamp": "1234567890",
        "seen_timestamp": "1234567891"
    })];

    let url = create_messaging_mock_server(messages).await;
    let ws = O2WebSocket::connect(&url).await.unwrap();
    let identity = Identity::Address("test_address".to_string());
    let mut stream = ws.stream_orders(&[identity]).await.unwrap();

    let update = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .ok()
        .flatten();

    assert!(update.is_some(), "Should receive order update");
    let update = update.unwrap().unwrap();
    assert_eq!(update.action, "subscribe_orders");
    assert!(!update.orders.is_empty(), "Should have orders");

    let _ = ws.disconnect().await;
}

#[tokio::test]
async fn test_ws_trades_stream_receives_messages() {
    let messages = vec![json!({
        "action": "subscribe_trades",
        "trades": [{
            "trade_id": "trade123",
            "price": "100",
            "quantity": "5",
            "timestamp": "1234567890"
        }],
        "market_id": "market1",
        "onchain_timestamp": "1234567890",
        "seen_timestamp": "1234567891"
    })];

    let url = create_messaging_mock_server(messages).await;
    let ws = O2WebSocket::connect(&url).await.unwrap();
    let mut stream = ws.stream_trades("market1").await.unwrap();

    let update = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .ok()
        .flatten();

    assert!(update.is_some(), "Should receive trade update");
    let update = update.unwrap().unwrap();
    assert_eq!(update.action, "subscribe_trades");
    assert_eq!(update.market_id, MarketId::from("market1"));

    let _ = ws.disconnect().await;
}

#[tokio::test]
async fn test_ws_balances_stream_receives_messages() {
    let messages = vec![json!({
        "action": "subscribe_balances",
        "balance": [{
            "identity": {"Address": "test_address"},
            "asset_id": "asset123",
            "total_locked": "100",
            "total_unlocked": "200",
            "trading_account_balance": "300"
        }],
        "onchain_timestamp": "1234567890",
        "seen_timestamp": "1234567891"
    })];

    let url = create_messaging_mock_server(messages).await;
    let ws = O2WebSocket::connect(&url).await.unwrap();
    let identity = Identity::Address("test_address".to_string());
    let mut stream = ws.stream_balances(&[identity]).await.unwrap();

    let update = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .ok()
        .flatten();

    assert!(update.is_some(), "Should receive balance update");
    let update = update.unwrap().unwrap();
    assert_eq!(update.action, "subscribe_balances");
    assert!(!update.balance.is_empty(), "Should have balance entries");

    let _ = ws.disconnect().await;
}

#[tokio::test]
async fn test_ws_nonce_stream_receives_messages() {
    let messages = vec![json!({
        "action": "subscribe_nonce",
        "contract_id": "contract123",
        "nonce": "42",
        "onchain_timestamp": "1234567890",
        "seen_timestamp": "1234567891"
    })];

    let url = create_messaging_mock_server(messages).await;
    let ws = O2WebSocket::connect(&url).await.unwrap();
    let identity = Identity::Address("test_address".to_string());
    let mut stream = ws.stream_nonce(&[identity]).await.unwrap();

    let update = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .ok()
        .flatten();

    assert!(update.is_some(), "Should receive nonce update");
    let update = update.unwrap().unwrap();
    assert_eq!(update.action, "subscribe_nonce");
    assert_eq!(update.nonce, 42);

    let _ = ws.disconnect().await;
}

#[tokio::test]
async fn test_ws_reconnect_on_server_disconnect() {
    let first_messages = vec![json!({
        "action": "subscribe_depth",
        "market_id": "market1",
        "view": {"buys": [], "sells": []}
    })];

    let second_messages = vec![json!({
        "action": "subscribe_depth_update",
        "market_id": "market1",
        "view": {"buys": [{"price": "200", "quantity": "20"}], "sells": []}
    })];

    let url = create_reconnect_mock_server(first_messages, second_messages).await;

    let config = WsConfig {
        base_delay: Duration::from_millis(100),
        max_delay: Duration::from_millis(500),
        max_attempts: 3,
        ping_interval: Duration::from_secs(1),
        pong_timeout: Duration::from_secs(2),
    };

    let ws = O2WebSocket::connect_with_config(&url, config)
        .await
        .unwrap();
    let mut stream = ws.stream_depth("market1", "10").await.unwrap();

    // Receive first message
    let first = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .ok()
        .flatten();
    assert!(first.is_some(), "Should receive first message");

    // Wait for reconnection and second message (skip reconnect signal)
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut second = None;
    for _ in 0..5 {
        match tokio::time::timeout(Duration::from_secs(3), stream.next())
            .await
            .ok()
            .flatten()
        {
            Some(Ok(update)) => {
                second = Some(update);
                break;
            }
            Some(Err(_)) => continue, // skip reconnect signals
            None => break,
        }
    }
    assert!(second.is_some(), "Should receive message after reconnect");

    let _ = ws.disconnect().await;
}

#[tokio::test]
async fn test_ws_reconnect_resubscribes() {
    // This test verifies that both subscriptions are re-sent on reconnect.
    // We'll track subscription messages received by the server.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("ws://{}", addr);
    let subscriptions_received = Arc::new(Mutex::new(Vec::new()));
    let subs_clone = subscriptions_received.clone();

    tokio::spawn(async move {
        let mut connection_num = 0;
        loop {
            if let Ok((stream, _)) = listener.accept().await {
                connection_num += 1;
                let is_first = connection_num == 1;
                let subs = subs_clone.clone();

                if let Ok(ws_stream) = accept_async(stream).await {
                    let (mut sender, mut receiver) = ws_stream.split();

                    // Collect subscription messages
                    let mut message_count = 0;
                    while let Some(Ok(msg)) = receiver.next().await {
                        match msg {
                            WsMsg::Text(text) => {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                                    if let Some(action) =
                                        json.get("action").and_then(|a| a.as_str())
                                    {
                                        subs.lock().await.push(action.to_string());
                                        message_count += 1;

                                        // After receiving 2 subscription messages on first connection, close it
                                        if is_first && message_count >= 2 {
                                            tokio::time::sleep(Duration::from_millis(100)).await;
                                            let _ = sender.send(WsMsg::Close(None)).await;
                                            break;
                                        }
                                    }
                                }
                            }
                            WsMsg::Ping(data) => {
                                let _ = sender.send(WsMsg::Pong(data)).await;
                            }
                            WsMsg::Close(_) => break,
                            _ => {}
                        }
                    }
                }
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(50)).await;

    let config = WsConfig {
        base_delay: Duration::from_millis(100),
        max_delay: Duration::from_millis(500),
        max_attempts: 5,
        ping_interval: Duration::from_secs(10),
        pong_timeout: Duration::from_secs(20),
    };

    let ws = O2WebSocket::connect_with_config(&url, config)
        .await
        .unwrap();
    let _stream1 = ws.stream_depth("market1", "10").await.unwrap();
    let _stream2 = ws.stream_trades("market1").await.unwrap();

    // Wait for initial subscriptions and reconnection
    tokio::time::sleep(Duration::from_secs(2)).await;

    // Verify both subscriptions were re-sent after reconnect
    let subs = subscriptions_received.lock().await;
    let depth_count = subs.iter().filter(|s| *s == "subscribe_depth").count();
    let trades_count = subs.iter().filter(|s| *s == "subscribe_trades").count();

    assert!(
        depth_count >= 2,
        "Depth subscription should be sent twice (initial + reconnect), got {}",
        depth_count
    );
    assert!(
        trades_count >= 2,
        "Trades subscription should be sent twice (initial + reconnect), got {}",
        trades_count
    );

    let _ = ws.disconnect().await;
}

#[tokio::test]
async fn test_ws_max_reconnect_attempts_exhausted() {
    let url = create_refusing_mock_server().await;

    let config = WsConfig {
        base_delay: Duration::from_millis(50),
        max_delay: Duration::from_millis(100),
        max_attempts: 2,
        ping_interval: Duration::from_secs(10),
        pong_timeout: Duration::from_secs(20),
    };

    // Connection will fail because server refuses connections
    let result = O2WebSocket::connect_with_config(&url, config).await;
    assert!(result.is_err(), "Should fail to connect to refusing server");
}

#[tokio::test]
async fn test_ws_disconnect_closes_streams() {
    let messages = vec![json!({
        "action": "subscribe_depth",
        "market_id": "market1",
        "view": {"buys": [], "sells": []}
    })];

    let url = create_messaging_mock_server(messages).await;
    let ws = O2WebSocket::connect(&url).await.unwrap();
    let mut stream = ws.stream_depth("market1", "10").await.unwrap();

    assert!(ws.is_connected(), "Should be connected");

    // Disconnect
    let _ = ws.disconnect().await;

    // Wait a bit for disconnect to propagate
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert!(
        !ws.is_connected(),
        "Should not be connected after disconnect"
    );

    // Stream should return None after disconnect
    let next = stream.next().await;
    assert!(next.is_none(), "Stream should be closed after disconnect");
}

#[tokio::test]
async fn test_ws_multiple_subscribers_same_type() {
    let messages = vec![json!({
        "action": "subscribe_depth",
        "market_id": "market1",
        "view": {"buys": [{"price": "100", "quantity": "10"}], "sells": []}
    })];

    let url = create_messaging_mock_server(messages).await;
    let ws = O2WebSocket::connect(&url).await.unwrap();

    // Create two streams for the same subscription type
    let mut stream1 = ws.stream_depth("market1", "10").await.unwrap();
    let mut stream2 = ws.stream_depth("market1", "10").await.unwrap();

    // Both streams should receive the message
    let update1 = tokio::time::timeout(Duration::from_secs(2), stream1.next())
        .await
        .ok()
        .flatten();
    let update2 = tokio::time::timeout(Duration::from_secs(2), stream2.next())
        .await
        .ok()
        .flatten();

    assert!(update1.is_some(), "First stream should receive update");
    assert!(update2.is_some(), "Second stream should receive update");

    let _ = ws.disconnect().await;
}

#[tokio::test]
async fn test_ws_unsubscribe_removes_tracking() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("ws://{}", addr);
    let subscriptions = Arc::new(Mutex::new(Vec::new()));
    let subs_clone = subscriptions.clone();

    tokio::spawn(async move {
        let mut connection_num = 0;
        loop {
            if let Ok((stream, _)) = listener.accept().await {
                connection_num += 1;
                let is_first = connection_num == 1;
                let subs = subs_clone.clone();

                if let Ok(ws_stream) = accept_async(stream).await {
                    let (mut sender, mut receiver) = ws_stream.split();

                    while let Some(Ok(msg)) = receiver.next().await {
                        match msg {
                            WsMsg::Text(text) => {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                                    if let Some(action) =
                                        json.get("action").and_then(|a| a.as_str())
                                    {
                                        if connection_num == 2 {
                                            // Only track subscriptions on reconnect
                                            subs.lock().await.push(action.to_string());
                                        }
                                    }
                                }
                            }
                            WsMsg::Ping(data) => {
                                let _ = sender.send(WsMsg::Pong(data)).await;
                            }
                            WsMsg::Close(_) => break,
                            _ => {}
                        }
                    }

                    if is_first {
                        // Drop first connection after a delay
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        let _ = sender.send(WsMsg::Close(None)).await;
                    }
                }
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(50)).await;

    let config = WsConfig {
        base_delay: Duration::from_millis(100),
        max_delay: Duration::from_millis(500),
        max_attempts: 5,
        ping_interval: Duration::from_secs(10),
        pong_timeout: Duration::from_secs(20),
    };

    let ws = O2WebSocket::connect_with_config(&url, config)
        .await
        .unwrap();
    let _stream = ws.stream_depth("market1", "10").await.unwrap();

    tokio::time::sleep(Duration::from_millis(100)).await;

    // Unsubscribe before reconnect
    let _ = ws.unsubscribe_depth("market1").await;

    // Wait for reconnection to happen
    tokio::time::sleep(Duration::from_secs(2)).await;

    // Verify depth subscription was NOT re-sent on reconnect
    let subs = subscriptions.lock().await;
    assert!(
        !subs.contains(&"subscribe_depth".to_string()),
        "Depth subscription should not be re-sent after unsubscribe"
    );

    let _ = ws.disconnect().await;
}

#[tokio::test]
async fn test_ws_is_connected_state() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("ws://{}", addr);

    tokio::spawn(async move {
        let mut connection_num = 0;
        loop {
            if let Ok((stream, _)) = listener.accept().await {
                connection_num += 1;
                let is_first = connection_num == 1;

                if let Ok(ws_stream) = accept_async(stream).await {
                    let (mut sender, mut receiver) = ws_stream.split();

                    if is_first {
                        // Drop first connection quickly
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        let _ = sender.send(WsMsg::Close(None)).await;
                        continue;
                    }

                    // Keep subsequent connections alive
                    while let Some(Ok(msg)) = receiver.next().await {
                        match msg {
                            WsMsg::Ping(data) => {
                                let _ = sender.send(WsMsg::Pong(data)).await;
                            }
                            WsMsg::Close(_) => break,
                            _ => {}
                        }
                    }
                }
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(50)).await;

    let config = WsConfig {
        base_delay: Duration::from_millis(100),
        max_delay: Duration::from_millis(500),
        max_attempts: 5,
        ping_interval: Duration::from_secs(10),
        pong_timeout: Duration::from_secs(20),
    };

    let ws = O2WebSocket::connect_with_config(&url, config)
        .await
        .unwrap();

    assert!(ws.is_connected(), "Should be connected after connect");

    // Wait for disconnect to be detected (server drops immediately, client needs time to notice)
    tokio::time::sleep(Duration::from_millis(500)).await;

    // The connection should be disconnected OR in the process of reconnecting
    // We'll wait for the reconnection to complete
    tokio::time::sleep(Duration::from_millis(500)).await;

    // After reconnection, should be connected again
    assert!(
        ws.is_connected(),
        "Should be connected again after reconnect"
    );

    // Explicit disconnect
    let _ = ws.disconnect().await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !ws.is_connected(),
        "Should be disconnected after explicit disconnect"
    );
}

#[tokio::test]
async fn test_ws_server_ping_response() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("ws://{}", addr);
    let pong_received = Arc::new(Mutex::new(false));
    let pong_clone = pong_received.clone();

    tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            if let Ok(ws_stream) = accept_async(stream).await {
                let (mut sender, mut receiver) = ws_stream.split();

                // Send a ping
                let _ = sender.send(WsMsg::Ping(vec![1, 2, 3])).await;

                // Wait for pong
                while let Some(Ok(msg)) = receiver.next().await {
                    if matches!(msg, WsMsg::Pong(_)) {
                        *pong_clone.lock().await = true;
                        break;
                    }
                }

                // Keep connection alive briefly
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(50)).await;

    let ws = O2WebSocket::connect(&url).await.unwrap();

    // Wait for ping/pong exchange
    tokio::time::sleep(Duration::from_millis(500)).await;

    let pong = *pong_received.lock().await;
    assert!(pong, "Client should respond to server ping with pong");

    let _ = ws.disconnect().await;
}
