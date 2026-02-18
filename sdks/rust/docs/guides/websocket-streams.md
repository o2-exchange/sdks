# WebSocket Streams Guide

This guide covers real-time data streaming using the O2 Rust SDK.

The SDK provides WebSocket streaming through [`TypedStream<T>`](crate::TypedStream), which
implements `tokio_stream::Stream` and can be consumed with
`while let Some(item) = stream.next().await`.

> See also: [`O2Client`](crate::client::O2Client) streaming methods,
> [`O2WebSocket`](crate::O2WebSocket) for standalone usage.
>
> Current backend behavior: `unsubscribe_orders` is connection-global (not
> identity-filtered), so unsubscribing order updates removes all order
> subscriptions on that socket.

## Overview

All streaming methods:

- Return a [`TypedStream<T>`](crate::TypedStream) that yields `Result<T, O2Error>` items.
- Share a single WebSocket connection managed by the [`O2Client`](crate::client::O2Client).
- Support automatic reconnection with exponential backoff.
- Re-subscribe to channels on reconnect.

Stream items carry data and terminal errors:

- `Ok(update)` — a normal data message
- `Err(O2Error::WebSocketDisconnected(_))` — permanent connection loss

Lifecycle/reconnect events are delivered separately via
[`O2Client::subscribe_ws_lifecycle`](crate::client::O2Client::subscribe_ws_lifecycle)
or [`O2WebSocket::subscribe_lifecycle`](crate::O2WebSocket::subscribe_lifecycle).

## Order Book Depth

Stream real-time order book updates:

```rust,ignore
use tokio_stream::StreamExt;

let market = client.get_market("FUEL/USDC").await?;
let mut stream = client.stream_depth(&market.market_id, "10").await?;

while let Some(Ok(update)) = stream.next().await {
    // First message is a full snapshot (action = "subscribe_depth")
    // Subsequent messages are incremental updates (action = "subscribe_depth_update")
    let is_snapshot = update.action.as_deref() == Some("subscribe_depth");

    if is_snapshot {
        if let Some(ref view) = update.view {
            let buys = view.buys.as_deref().unwrap_or_default();
            let sells = view.sells.as_deref().unwrap_or_default();
            println!("Snapshot: {} bids, {} asks", buys.len(), sells.len());
        }
    } else if let Some(ref changes) = update.changes {
        let buys = changes.buys.as_deref().unwrap_or_default();
        let sells = changes.sells.as_deref().unwrap_or_default();
        if let Some(bid) = buys.first() {
            println!("Best bid: {}", bid.price);
        }
        if let Some(ask) = sells.first() {
            println!("Best ask: {}", ask.price);
        }
    }
}
```

The `precision` parameter controls price aggregation, matching the
REST [`O2Client::get_depth`](crate::client::O2Client::get_depth) endpoint.

## Order Updates

Monitor your orders in real time:

```rust,ignore
use o2_sdk::Identity;
use tokio_stream::StreamExt;

let identity = Identity::ContractId(session.trade_account_id.to_string());
let mut stream = client.stream_orders(&[identity]).await?;

while let Some(Ok(update)) = stream.next().await {
    if let Some(ref orders) = update.orders {
        for order in orders {
            let status = if order.close == Some(true) { "CLOSED" } else { "OPEN" };
            let filled = format!(
                "{}/{}",
                order.quantity_fill.as_deref().unwrap_or("0"),
                order.quantity.as_deref().unwrap_or("0"),
            );
            println!(
                "[{}] {} {}: {}",
                status,
                order.side.as_deref().unwrap_or("?"),
                order.order_id.as_deref().unwrap_or("?"),
                filled,
            );
            if order.cancel == Some(true) {
                println!("  Canceled");
            }
        }
    }
}
```

## Trade Feed

Stream all trades for a market:

```rust,ignore
use tokio_stream::StreamExt;

let market = client.get_market("FUEL/USDC").await?;
let mut stream = client.stream_trades(&market.market_id).await?;

while let Some(Ok(update)) = stream.next().await {
    if let Some(ref trades) = update.trades {
        for trade in trades {
            println!(
                "{} {} @ {}",
                trade.side.as_deref().unwrap_or("?"),
                trade.quantity.as_deref().unwrap_or("0"),
                trade.price.as_deref().unwrap_or("0"),
            );
        }
    }
}
```

## Balance Updates

Monitor balance changes in real time:

```rust,ignore
use o2_sdk::Identity;
use tokio_stream::StreamExt;

let identity = Identity::ContractId(session.trade_account_id.to_string());
let mut stream = client.stream_balances(&[identity]).await?;

while let Some(Ok(update)) = stream.next().await {
    if let Some(ref entries) = update.balance {
        for entry in entries {
            println!(
                "Balance: {} (locked: {}, unlocked: {})",
                entry.trading_account_balance.as_deref().unwrap_or("0"),
                entry.total_locked.as_deref().unwrap_or("0"),
                entry.total_unlocked.as_deref().unwrap_or("0"),
            );
        }
    }
}
```

## Nonce Monitoring

Useful for detecting nonce changes from other sessions or external
transactions:

```rust,ignore
use o2_sdk::Identity;
use tokio_stream::StreamExt;

let identity = Identity::ContractId(session.trade_account_id.to_string());
let mut stream = client.stream_nonce(&[identity]).await?;

while let Some(Ok(update)) = stream.next().await {
    println!(
        "Nonce changed: {} (account={})",
        update.nonce.as_deref().unwrap_or("?"),
        update.contract_id.as_deref().unwrap_or("?"),
    );
}
```

## Running Multiple Streams

Use `tokio::join!` or `tokio::spawn` to run multiple streams concurrently:

```rust,ignore
use o2_sdk::Identity;
use tokio_stream::StreamExt;

let market = client.get_market("FUEL/USDC").await?;
let identity = Identity::ContractId(session.trade_account_id.to_string());

let mut depth_stream = client.stream_depth(&market.market_id, "10").await?;
let mut order_stream = client.stream_orders(&[identity.clone()]).await?;
let mut trade_stream = client.stream_trades(&market.market_id).await?;

let depth_task = tokio::spawn(async move {
    while let Some(Ok(update)) = depth_stream.next().await {
        if let Some(ref changes) = update.changes {
            if let Some(bid) = changes.buys.as_deref().and_then(|b| b.first()) {
                println!("Best bid: {}", bid.price);
            }
        }
    }
});

let order_task = tokio::spawn(async move {
    while let Some(Ok(update)) = order_stream.next().await {
        if let Some(ref orders) = update.orders {
            for order in orders {
                let status = if order.close == Some(true) { "closed" } else { "open" };
                println!("Order {}: {}", order.order_id.as_deref().unwrap_or("?"), status);
            }
        }
    }
});

let trade_task = tokio::spawn(async move {
    while let Some(Ok(update)) = trade_stream.next().await {
        if let Some(ref trades) = update.trades {
            for trade in trades {
                println!(
                    "Trade: {} @ {}",
                    trade.quantity.as_deref().unwrap_or("0"),
                    trade.price.as_deref().unwrap_or("0"),
                );
            }
        }
    }
});

// Run all streams concurrently
tokio::join!(depth_task, order_task, trade_task);
```

> **Note:** All streams share a single WebSocket connection, managed
> internally by the [`O2WebSocket`](crate::O2WebSocket) client within `O2Client`.

## Handling Reconnections

For non-snapshot streams, monitor lifecycle events and refresh state on reconnect:

```rust,ignore
use o2_sdk::WsLifecycleEvent;
use tokio_stream::StreamExt;

let market = client.get_market("FUEL/USDC").await?;
let mut stream = client.stream_depth(&market.market_id, "10").await?;
let mut lifecycle = client.subscribe_ws_lifecycle().await?;

loop {
    tokio::select! {
        Some(result) = stream.next() => {
            match result {
                Ok(update) => {
                    // Process the depth update
                }
                Err(o2_sdk::O2Error::WebSocketDisconnected(msg)) => {
                    println!("Permanently disconnected: {}", msg);
                    break;
                }
                Err(e) => {
                    println!("Stream error: {}", e);
                }
            }
        }
        Ok(evt) = lifecycle.recv() => {
            if let WsLifecycleEvent::Reconnected { .. } = evt {
                // Connection was re-established and subscriptions restored.
                // Re-fetch state if your strategy requires a fresh snapshot.
                println!("Reconnected — refreshing local state");
            }
        }
    }
}
```

## Configuration

Customize reconnection behavior via [`WsConfig`](crate::WsConfig):

```rust,ignore
use o2_sdk::{O2WebSocket, WsConfig};
use std::time::Duration;

let config = WsConfig {
    base_delay: Duration::from_secs(1),     // Base reconnect delay
    max_delay: Duration::from_secs(60),     // Maximum reconnect delay
    max_attempts: 10,                        // Max reconnect attempts (0 = infinite)
    ping_interval: Duration::from_secs(30), // Heartbeat interval
    pong_timeout: Duration::from_secs(60),  // Pong timeout before reconnect
};

let ws = O2WebSocket::connect_with_config("wss://ws.o2.app", config).await?;
```

Reconnection uses exponential backoff to avoid thundering herd effects.

## Graceful Shutdown

Always disconnect the WebSocket when done to cleanly release resources:

```rust,ignore
client.disconnect_ws().await?;
```

For standalone [`O2WebSocket`](crate::O2WebSocket) instances:

```rust,ignore
ws.disconnect().await?;
```
