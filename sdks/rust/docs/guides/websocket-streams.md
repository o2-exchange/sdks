# WebSocket Streams Guide

This guide covers real-time data streaming using the O2 Rust SDK.

The SDK provides WebSocket streaming through `TypedStream<T>`, which
implements `tokio_stream::Stream` and can be consumed with
`while let Some(item) = stream.next().await`.

> For complete method signatures, see [AGENTS.md](../../AGENTS.md).

## Overview

All streaming methods:

- Return a `TypedStream<T>` that yields `Result<T, O2Error>` items.
- Share a single WebSocket connection managed by the `O2Client`.
- Support automatic reconnection with exponential backoff.
- Re-subscribe to channels on reconnect.

Stream items carry lifecycle signals:

- `Ok(update)` — a normal data message
- `Err(O2Error::WebSocketReconnected)` — the connection was lost and re-established; re-fetch state if needed
- `Err(O2Error::WebSocketDisconnected(_))` — permanent connection loss

For simple usage, `while let Some(Ok(update)) = stream.next().await`
ignores lifecycle signals and stops on any error.

## Order Book Depth

Stream real-time order book updates:

```rust
use tokio_stream::StreamExt;

let market = client.get_market("fFUEL/fUSDC").await?;
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
REST `get_depth` endpoint.

## Order Updates

Monitor your orders in real time:

```rust
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

```rust
use tokio_stream::StreamExt;

let market = client.get_market("fFUEL/fUSDC").await?;
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

```rust
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

```rust
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

```rust
use o2_sdk::Identity;
use tokio_stream::StreamExt;

let market = client.get_market("fFUEL/fUSDC").await?;
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
                println!("Trade: {} @ {}", trade.quantity.as_deref().unwrap_or("0"), trade.price.as_deref().unwrap_or("0"));
            }
        }
    }
});

// Run all streams concurrently
tokio::join!(depth_task, order_task, trade_task);
```

> **Note:** All streams share a single WebSocket connection, managed
> internally by the `O2WebSocket` client within `O2Client`.

## Handling Reconnections

For non-snapshot streams, handle reconnection signals to re-fetch
current state:

```rust
use tokio_stream::StreamExt;

let market = client.get_market("fFUEL/fUSDC").await?;
let mut stream = client.stream_depth(&market.market_id, "10").await?;

while let Some(result) = stream.next().await {
    match result {
        Ok(update) => {
            // Process the depth update
        }
        Err(o2_sdk::O2Error::WebSocketReconnected) => {
            // Connection was re-established and subscriptions restored.
            // A new snapshot will arrive shortly.
            println!("Reconnected — waiting for new snapshot");
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
```

## Configuration

Customize reconnection behavior via `WsConfig`:

```rust
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

```rust
client.disconnect_ws().await?;
```

For standalone `O2WebSocket` instances:

```rust
ws.disconnect().await?;
```
