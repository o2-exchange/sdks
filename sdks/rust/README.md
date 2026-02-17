<p align="center">
  <img src="https://docs.o2.app/logo.svg" width="80" alt="O2 Exchange">
</p>

<h1 align="center">O2 SDK for Rust</h1>

<p align="center">
  <a href="https://github.com/o2-exchange/sdks/actions/workflows/ci.yml"><img src="https://github.com/o2-exchange/sdks/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://rust-lang.org"><img src="https://img.shields.io/badge/rust-1.75+-orange.svg" alt="Rust 1.75+"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0"></a>
</p>

<p align="center">
  Official Rust SDK for the <a href="https://o2.app">O2 Exchange</a> — a fully on-chain order book DEX on the Fuel Network.
</p>

---

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
o2-sdk = { git = "https://github.com/o2-exchange/sdks.git", path = "sdks/rust" }
tokio = { version = "1", features = ["full"] }
```

**MSRV**: Rust 1.75

## Quick Start

```rust
use o2_sdk::{MetadataPolicy, O2Client, Network, OrderType, Side};

#[tokio::main]
async fn main() -> Result<(), o2_sdk::O2Error> {
    let mut client = O2Client::new(Network::Testnet);
    client.set_metadata_policy(MetadataPolicy::OptimisticTtl(std::time::Duration::from_secs(45)));
    let wallet = client.generate_wallet()?;
    let _account = client.setup_account(&wallet).await?;
    let market_symbol: o2_sdk::MarketSymbol = "fFUEL/fUSDC".into();
    let mut session = client.create_session(&wallet, &[&market_symbol], std::time::Duration::from_secs(30 * 24 * 3600)).await?;
    let market = client.get_market(&market_symbol).await?;
    let price = market.price("0.05")?;
    let quantity = market.quantity("100")?;
    let order = client.create_order(
        &mut session, &market_symbol, Side::Buy, price, quantity, OrderType::Spot, true, true,
    ).await?;
    println!("tx: {}", order.tx_id.unwrap_or_default());
    Ok(())
}
```

## Features

- **Trading** — Place, cancel, and manage orders with automatic price/quantity scaling
- **Market Data** — Fetch order book depth, recent trades, OHLCV candles, and ticker data
- **WebSocket Streams** — Real-time depth, order, trade, balance, and nonce updates via `Stream`
- **Wallet Support** — Fuel-native and EVM wallets with session-based signing
- **Batch Actions** — Submit up to 5 actions per request (cancel + settle + create in one call)
- **Async Runtime** — Built on `tokio` with `reqwest` for HTTP and `tokio-tungstenite` for WebSocket
- **Type Safety** — Strongly typed responses with `serde` deserialization and `thiserror` errors

## API Overview

| Method | Description |
|--------|-------------|
| `generate_wallet()` / `load_wallet(hex)` | Create or load a Fuel wallet |
| `generate_evm_wallet()` / `load_evm_wallet(hex)` | Create or load an EVM wallet |
| `setup_account(&wallet)` | Idempotent account setup |
| `create_session(&wallet, markets, ttl)` | Create a trading session |
| `create_order(&mut session, market_symbol, side, price, qty, ...)` | Place an order |
| `cancel_order(&mut session, order_id, market)` | Cancel a specific order |
| `cancel_all_orders(&mut session, market)` | Cancel all open orders |
| `settle_balance(&mut session, market)` | Settle filled order proceeds |
| `batch_actions(&mut session, actions, calls, collect)` | Submit raw action batch |
| `get_markets()` / `get_market(name)` | Fetch market info |
| `get_depth(market, precision)` / `get_trades(market, count)` | Order book and trade data |
| `get_balances(trade_account_id)` / `get_orders(id, market, ...)` | Account data |
| `stream_depth(market_id, precision)` | Real-time order book stream |
| `stream_orders(identities)` / `stream_trades(market_id)` | Real-time updates |

See [AGENTS.md](AGENTS.md) for the complete API reference with all parameters and types.

## Guides

| Guide | Description |
|-------|-------------|
| [Trading](docs/guides/trading.md) | Order types, batch actions, cancel/replace, and market maker patterns |
| [Market Data](docs/guides/market-data.md) | Fetching depth, trades, candles, tickers, and balances |
| [WebSocket Streams](docs/guides/websocket-streams.md) | Real-time data with `TypedStream` and reconnection handling |
| [Error Handling](docs/guides/error-handling.md) | Error types, recovery patterns, and robust trading loops |
| [External Signers](docs/guides/external-signers.md) | Integrating KMS/HSM via the `SignableWallet` trait |

## Examples

| Example | Description |
|---------|-------------|
| [`quickstart.rs`](examples/quickstart.rs) | Connect, create a wallet, place your first order |
| [`market_maker.rs`](examples/market_maker.rs) | Two-sided quoting loop with cancel/replace |
| [`taker_bot.rs`](examples/taker_bot.rs) | Monitor depth and take liquidity |
| [`portfolio.rs`](examples/portfolio.rs) | Multi-market balance tracking and management |

Run an example:

```bash
cargo run --example quickstart
```

## Testing

Unit tests (no network required):

```bash
cargo test
```

Integration tests (requires `O2_PRIVATE_KEY` env var):

```bash
O2_PRIVATE_KEY=0x... cargo test -- --ignored --test-threads=1
```

The `--test-threads=1` flag avoids nonce race conditions during integration tests.

## AI Agent Integration

See [AGENTS.md](AGENTS.md) for an LLM-optimized reference covering all methods, types, error codes, and common patterns.
