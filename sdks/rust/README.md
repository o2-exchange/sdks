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
o2-sdk = "0.1.0"
tokio = { version = "1", features = ["full"] }
```

**MSRV**: Rust 1.75

## Quick Start

Recommended first integration path on testnet:

1. Create/load owner wallet
2. Call `setup_account()` (idempotent setup + faucet mint attempt on testnet/devnet)
3. (Optional) Call `top_up_from_faucet()` for an explicit testnet/devnet top-up
4. Create session
5. Place orders
6. Read balances/orders
7. Settle balances back to your trading account after fills; order funds are moved into the market contract during execution and should be swept after fills or cancellations

```rust
use o2_sdk::{Network, O2Client, OrderType, Side};

#[tokio::main]
async fn main() -> Result<(), o2_sdk::O2Error> {
    let mut client = O2Client::new(Network::Testnet);
    let wallet = client.generate_wallet()?;
    let account = client.setup_account(&wallet).await?;
    let _ = client.top_up_from_faucet(&wallet).await?;

    let market_symbol = "fFUEL/fUSDC";
    let mut session = client
        .create_session(
            &wallet,
            &[market_symbol],
            std::time::Duration::from_secs(30 * 24 * 3600),
        )
        .await?;

    let market = client.get_market(market_symbol).await?;
    let response = client
        .create_order(
            &mut session,
            market_symbol,
            Side::Buy,
            market.price("0.02")?,
            market.quantity("50")?,
            OrderType::Spot,
            true,
            true,
        )
        .await?;
    println!("order tx={}", response.tx_id.unwrap_or_default());

    if let Some(trade_account_id) = account.trade_account_id {
        let balances = client.get_balances(&trade_account_id).await?;
        println!("assets={}", balances.len());
    }

    let settle = client.settle_balance(&mut session, market_symbol).await?;
    println!("settle tx={}", settle.tx_id.unwrap_or_default());
    Ok(())
}
```

`get_balances(trade_account_id)` is an aggregated view across trading account
and market contracts, so `settle_balance(...)` does not necessarily change aggregate totals.

## Network Configuration

Default network configs:

| Network | REST API | WebSocket | Fuel RPC | Faucet |
|---------|----------|-----------|----------|--------|
| `Network::Testnet` | `https://api.testnet.o2.app` | `wss://api.testnet.o2.app/v1/ws` | `https://testnet.fuel.network/v1/graphql` | `https://fuel-o2-faucet.vercel.app/api/testnet/mint-v2` |
| `Network::Devnet` | `https://api.devnet.o2.app` | `wss://api.devnet.o2.app/v1/ws` | `https://devnet.fuel.network/v1/graphql` | `https://fuel-o2-faucet.vercel.app/api/devnet/mint-v2` |
| `Network::Mainnet` | `https://api.o2.app` | `wss://api.o2.app/v1/ws` | `https://mainnet.fuel.network/v1/graphql` | none |

API rate limits: <https://docs.o2.app/api-endpoints-reference.html#rate-limits>.

Use custom config if needed:

```rust
use o2_sdk::{Network, NetworkConfig, O2Client};

let mut cfg = NetworkConfig::from_network(Network::Mainnet);
cfg.api_base = "https://my-gateway.example.com".into();
cfg.ws_url = "wss://my-gateway.example.com/v1/ws".into();
cfg.faucet_url = None;

let client = O2Client::with_config(cfg);
```

> [!IMPORTANT]
> Mainnet note: there is no faucet; account setup requires an owner wallet that already has funds deposited for trading. SDK-native bridging flows are coming soon.

## Wallet Security

- `generate_wallet()` / `generate_evm_wallet()` use cryptographically secure randomness and are suitable for mainnet key generation.
- For production custody, use external signers (KMS/HSM/hardware wallets) instead of long-lived in-process private keys.
- See `docs/guides/external-signers.md` for production signer integration.

## Wallet Types and Identifiers

Why choose each wallet type:

- **Fuel-native wallet** — best for interoperability with other apps in the Fuel ecosystem.
- **EVM wallet** — best if you want to reuse existing EVM accounts across chains and simplify bridging from EVM chains.

O2 owner identity model:

- O2 owner identity is always Fuel B256 (`0x` + 64 hex chars).
- Fuel-native wallets already expose that directly as B256.
- EVM wallets expose both EVM and B256 forms.
- For EVM wallets, B256 is the EVM address zero-left-padded to 32 bytes:
  - `owner_b256 = 0x000000000000000000000000 + evm_address[2:]`

Identifier usage:

| Context | Identifier |
|---------|------------|
| Owner/account/session APIs | owner B256 (`wallet.b256_address`) |
| Trading account state | `trade_account_id` (contract ID) |
| Human-visible EVM identity | `evm_address` |
| Markets | pair (`"fFUEL/fUSDC"`) or `market_id` |

`owner_id` vs `trade_account_id`:

- `owner_id` is wallet identity (B256) used for ownership/auth and session setup.
- `trade_account_id` is the trading account contract ID used for balances/orders/account state.
- `setup_account(&wallet)` links these by creating/fetching the trading account for that owner.

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
| `top_up_from_faucet(&wallet)` | Explicit faucet top-up to the wallet's trading account (testnet/devnet) |
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
| [Identifiers and Wallet Types](docs/guides/identifiers.md) | Fuel vs EVM wallet choice, owner ID mapping, and identifier rules |

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
