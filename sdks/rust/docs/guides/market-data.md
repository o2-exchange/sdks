# Market Data Guide

This guide covers how to fetch market data from the O2 Exchange using
the Rust SDK.

> See also: [WebSocket Streams](crate::guides::websocket_streams) for real-time streaming,
> [`O2Client`](crate::client::O2Client) API reference.

## Listing Markets

```rust,ignore
let markets = client.get_markets().await?;
for market in &markets {
    println!(
        "{}/{}: base={} ({} decimals)",
        market.base.symbol, market.quote.symbol,
        market.base.symbol, market.base.decimals,
    );
}

// Get a specific market
let market = client.get_market("FUEL/USDC").await?;
println!("Min order: {}", market.min_order);
println!("Maker fee: {}", market.maker_fee);
```

The market pair lookup is case-sensitive and supports the `f`-prefix
convention used on testnet (e.g., `"FUEL/USDC"`). You can also look up
by hex market ID using [`O2Client::get_market_by_id`](crate::client::O2Client::get_market_by_id).

## Order Book Depth

Fetch a snapshot of the order book:

```rust,ignore
let depth = client.get_depth("FUEL/USDC", 10).await?;

let buys = depth.buys.as_deref().unwrap_or_default();
let sells = depth.sells.as_deref().unwrap_or_default();

if let Some(best_bid) = buys.first() {
    println!("Best bid: {} x {}", best_bid.price, best_bid.quantity);
}
if let Some(best_ask) = sells.first() {
    println!("Best ask: {} x {}", best_ask.price, best_ask.quantity);
}

// Iterate price levels
for level in buys.iter().take(5) {
    println!("  BID {} x {}", level.price, level.quantity);
}
for level in sells.iter().take(5) {
    println!("  ASK {} x {}", level.price, level.quantity);
}
```

The `precision` parameter controls price aggregation — lower values
produce fewer, wider price levels.

## Recent Trades

```rust,ignore
let trades_resp = client.get_trades("FUEL/USDC", 20).await?;
if let Some(trades) = &trades_resp.trades {
    for trade in trades {
        println!(
            "{} {} @ {} (id={})",
            trade.side.as_deref().unwrap_or("?"),
            trade.quantity.as_deref().unwrap_or("0"),
            trade.price.as_deref().unwrap_or("0"),
            trade.trade_id.as_deref().unwrap_or("?"),
        );
    }
}
```

## OHLCV Candles

```rust,ignore
use std::time::{SystemTime, UNIX_EPOCH};

let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
let bars = client.get_bars("FUEL/USDC", "1h", now - 86400, now).await?;

for bar in &bars {
    println!(
        "{}: O={} H={} L={} C={} V={}",
        bar.timestamp.as_ref().map(|v| v.to_string()).unwrap_or_default(),
        bar.open.as_deref().unwrap_or("?"),
        bar.high.as_deref().unwrap_or("?"),
        bar.low.as_deref().unwrap_or("?"),
        bar.close.as_deref().unwrap_or("?"),
        bar.volume.as_deref().unwrap_or("?"),
    );
}
```

Supported resolutions: `"1m"`, `"5m"`, `"15m"`, `"30m"`, `"1h"`, `"4h"`,
`"1d"`, `"1w"`.

## Ticker Data

```rust,ignore
let ticker = client.get_ticker("FUEL/USDC").await?;
println!("Last: {}", ticker.last_price.as_deref().unwrap_or("?"));
println!("Bid: {} / Ask: {}",
    ticker.best_bid.as_deref().unwrap_or("?"),
    ticker.best_ask.as_deref().unwrap_or("?"),
);
```

## Price Conversion

Market data is returned in on-chain integer format. Use the [`Market`](crate::Market)
helper methods to convert to/from human-readable values:

```rust,ignore
let market = client.get_market("FUEL/USDC").await?;
let depth = client.get_depth("FUEL/USDC", 10).await?;

if let Some(best_ask) = depth.sells.as_deref().and_then(|s| s.first()) {
    let chain_price: u64 = best_ask.price.parse().unwrap_or(0);
    let human_price = market.format_price(chain_price);
    println!("Best ask: {}", human_price);
}

// Human-readable → chain integer
let chain_price = market.scale_price(&"0.02".parse()?);
let chain_qty = market.scale_quantity(&"100".parse()?);
```

## Balances

```rust,ignore
let balances = client.get_balances(&session.trade_account_id).await?;
for (symbol, bal) in &balances {
    println!("{}:", symbol);
    println!("  Trading account: {}",
        bal.trading_account_balance.as_deref().unwrap_or("0"));
    println!("  Locked in orders: {}",
        bal.total_locked.as_deref().unwrap_or("0"));
    println!("  Unlocked: {}",
        bal.total_unlocked.as_deref().unwrap_or("0"));
}
```

## Low-Level API Access

For advanced use cases, you can access the underlying [`O2Api`](crate::api::O2Api) directly
through the `api` field:

```rust,ignore
// Aggregated assets
let assets = client.api.get_aggregated_assets().await?;

// Aggregated order book
let book = client.api.get_aggregated_orderbook("FUEL_USDC").await?;

// Market summaries
let summaries = client.api.get_aggregated_summary().await?;

// All tickers
let tickers = client.api.get_aggregated_ticker().await?;
```
