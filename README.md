<p align="center">
  <a href="https://o2.app"><img src="https://docs.o2.app/logo.svg" width="120" alt="O2 Exchange"></a>
</p>

<h1 align="center">O2 Exchange SDKs</h1>

<p align="center">
  <em>Official SDKs for the O2 Exchange — a fully on-chain order book DEX on the Fuel Network</em>
</p>

<p align="center">
  <a href="https://github.com/o2-exchange/sdks/actions/workflows/ci.yml"><img src="https://github.com/o2-exchange/sdks/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0"></a>
</p>

---

## 📦 SDKs

| Language | Min Version | Async Runtime | Signing Library | Install |
|----------|------------|---------------|-----------------|---------|
| [Python](sdks/python/) | 3.10+ | `asyncio` | `coincurve` | `pip install o2-sdk` |
| [TypeScript](sdks/typescript/) | Node 18+ | native `async/await` | `@noble/secp256k1` | `npm install @o2exchange/sdk` |
| [Rust](sdks/rust/) | 1.75+ | `tokio` | `secp256k1` | git dependency |

## ✨ Features

All three SDKs share the same capabilities:

- **Trading** — Place, cancel, and manage orders with automatic price/quantity scaling
- **Market Data** — Order book depth, recent trades, OHLCV candles, and ticker data
- **WebSocket Streams** — Real-time depth, order, trade, balance, and nonce updates
- **Wallet Support** — Fuel-native and EVM wallets with session-based signing
- **Batch Actions** — Up to 5 actions per request (cancel + settle + create in one call)
- **Idempotent Setup** — `setup_account()` is safe to call on every startup

## 🚀 Quick Start

### Python

```python
import asyncio
from o2_sdk import O2Client, Network, OrderSide

async def main():
    client = O2Client(network=Network.TESTNET)
    owner = client.generate_wallet()
    account = await client.setup_account(owner)
    session = await client.create_session(owner=owner, markets=["fFUEL/fUSDC"])
    result = await client.create_order(session, "fFUEL/fUSDC", OrderSide.BUY, price=0.02, quantity=100.0)
    print(f"Created order with transaction ID {result.tx_id}")
    await client.close()

asyncio.run(main())
```

### TypeScript

```ts
import { O2Client, Network } from "@o2exchange/sdk";

const client = new O2Client({ network: Network.TESTNET });
const wallet = client.generateWallet();
const { tradeAccountId } = await client.setupAccount(wallet);
const session = await client.createSession(wallet, tradeAccountId, ["fFUEL/fUSDC"]);
const { response } = await client.createOrder(session, "fFUEL/fUSDC", "Buy", 0.02, 50.0);
console.log(response.tx_id);
```

### Rust

```rust
use o2_sdk::{O2Client, Network, Side, OrderType};

#[tokio::main]
async fn main() -> Result<(), o2_sdk::O2Error> {
    let mut client = O2Client::new(Network::Testnet);
    let wallet = client.generate_wallet()?;
    let account = client.setup_account(&wallet).await?;
    let mut session = client.create_session(&wallet, &["fFUEL/fUSDC"], 30).await?;
    let order = client.create_order(
        &mut session, "fFUEL/fUSDC", Side::Buy, 0.05.into(), 100.0.into(),
        OrderType::Spot, true, true,
    ).await?;
    Ok(())
}
```

## 🛠 Development

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Python | 3.10+ | [python.org](https://www.python.org/downloads/) |
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) |
| Rust | 1.75+ | [rustup.rs](https://rustup.rs/) |
| just | latest | See below |

Install [`just`](https://github.com/casey/just) (a command runner used to orchestrate builds, linting, and tests):

```bash
# macOS
brew install just

# Linux (prebuilt binary)
curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to /usr/local/bin

# Cargo (any platform)
cargo install just
```

### Setup

Clone the repo and install all SDK dependencies:

```bash
git clone https://github.com/o2-exchange/sdks.git
cd sdks
just setup    # Creates Python venv, installs Python + TypeScript deps
```

The Rust SDK uses Cargo and needs no additional setup beyond having `rustc` installed.

### Common Commands

```bash
just fmt       # Format all SDKs (ruff, biome, rustfmt)
just lint      # Lint all SDKs (ruff + mypy, biome + tsc, clippy)
just check     # Full pre-push check (format check + lint)
just test      # Run unit tests across all SDKs
```

Per-SDK targets are also available:

```bash
just fmt-python          just lint-python          just test-python
just fmt-typescript      just lint-typescript      just test-typescript
just fmt-rust            just lint-rust            just test-rust
```

### Integration Tests

Integration tests run against the O2 testnet. Run **one SDK at a time** to avoid overwhelming the testnet:

```bash
just integration python
just integration typescript
just integration rust
```

> **Note:** Integration tests require testnet connectivity and may take several minutes due to faucet cooldowns and on-chain confirmation times.

## 📁 Repository Structure

```
.
├── abi/
│   ├── mainnet/          # Mainnet contract ABIs
│   └── testnet/          # Testnet contract ABIs
├── sdks/
│   ├── python/           # Python SDK
│   │   ├── src/o2_sdk/
│   │   ├── tests/
│   │   ├── examples/
│   │   └── AGENTS.md     # LLM reference
│   ├── typescript/       # TypeScript SDK
│   │   ├── src/
│   │   ├── tests/
│   │   ├── examples/
│   │   └── AGENTS.md     # LLM reference
│   └── rust/             # Rust SDK
│       ├── src/
│       ├── tests/
│       ├── examples/
│       └── AGENTS.md     # LLM reference
├── .github/workflows/    # CI/CD pipelines
└── LICENSE               # Apache 2.0
```

## 📚 Documentation

- [O2 Documentation](https://docs.o2.app) — Exchange docs and API reference
- [O2 Markets API](https://api.o2.app/v1/markets) — On-chain contract IDs (mainnet)
- [Python SDK README](sdks/python/README.md) — Installation, usage, and examples
- [TypeScript SDK README](sdks/typescript/README.md) — Installation, usage, and examples
- [Rust SDK README](sdks/rust/README.md) — Installation, usage, and examples

Each SDK also includes an `AGENTS.md` with a complete LLM-optimized API reference for AI agent integration.

## 📄 License

[Apache License 2.0](LICENSE) — Copyright 2026 Breathe Speed Inc.
