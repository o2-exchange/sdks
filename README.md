<p align="center">
  <img src="https://docs.o2.app/logo.svg" width="120" alt="O2 Exchange">
</p>

<h1 align="center">O2 Exchange SDKs</h1>

<p align="center">
  <em>Official SDKs for the O2 Exchange — a fully on-chain order book DEX on the Fuel Network</em>
</p>

<p align="center">
  <a href="https://github.com/o2-exchange/contracts/actions/workflows/ci.yml"><img src="https://github.com/o2-exchange/contracts/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0"></a>
</p>

---

## 📦 SDKs

| Language | Min Version | Async Runtime | Signing Library | Install |
|----------|------------|---------------|-----------------|---------|
| [Python](sdks/python/) | 3.10+ | `asyncio` | `coincurve` | `pip install o2-sdk` |
| [TypeScript](sdks/typescript/) | Node 18+ | native `async/await` | `@noble/secp256k1` | `npm install o2-sdk` |
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
from o2_sdk import O2Client, Network

async def main():
    client = O2Client(network=Network.TESTNET)
    owner = client.generate_wallet()
    account = await client.setup_account(owner)
    session = await client.create_session(owner=owner, markets=["fFUEL/fUSDC"])
    result = await client.create_order(session, "fFUEL/fUSDC", "Buy", price=0.02, quantity=100.0)
    print(result.tx_id)
    await client.close()

asyncio.run(main())
```

### TypeScript

```ts
import { O2Client, Network } from "o2-sdk";

const client = new O2Client({ network: Network.TESTNET });
const wallet = client.generateWallet();
const { tradeAccountId } = await client.setupAccount(wallet);
const session = await client.createSession(wallet, tradeAccountId, ["fFUEL/fUSDC"]);
const { response } = await client.createOrder(session, "fFUEL/fUSDC", "Buy", 0.02, 50.0);
console.log(response.tx_id);
```

### Rust

```rust
use o2_sdk::{O2Client, Network};

#[tokio::main]
async fn main() -> Result<(), o2_sdk::O2Error> {
    let mut client = O2Client::new(Network::Testnet);
    let wallet = client.generate_wallet()?;
    let account = client.setup_account(&wallet).await?;
    let mut session = client.create_session(&wallet, &["fFUEL/fUSDC"], 30).await?;
    let order = client.create_order(
        &mut session, "fFUEL/fUSDC", "Buy", 0.05, 100.0, "Spot", true, true,
    ).await?;
    Ok(())
}
```

## 📁 Repository Structure

```
o2-sdks/
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
- [O2 Markets API](https://api.o2.app/v1/markets) — On-chain contract IDs
- [Python SDK README](sdks/python/README.md) — Installation, usage, and examples
- [TypeScript SDK README](sdks/typescript/README.md) — Installation, usage, and examples
- [Rust SDK README](sdks/rust/README.md) — Installation, usage, and examples

Each SDK also includes an `AGENTS.md` with a complete LLM-optimized API reference for AI agent integration.

## 📄 License

[Apache License 2.0](LICENSE) — Copyright 2025 Breathe Speed Inc.
