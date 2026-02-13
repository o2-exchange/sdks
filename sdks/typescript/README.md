<p align="center">
  <img src="https://docs.o2.app/logo.svg" width="80" alt="O2 Exchange">
</p>

<h1 align="center">O2 SDK for TypeScript</h1>

<p align="center">
  <a href="https://github.com/o2-exchange/sdks/actions/workflows/ci.yml"><img src="https://github.com/o2-exchange/sdks/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-18+-green.svg" alt="Node.js 18+"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0"></a>
</p>

<p align="center">
  Official TypeScript SDK for the <a href="https://o2.app">O2 Exchange</a> — a fully on-chain order book DEX on the Fuel Network.
</p>

---

## Installation

```bash
npm install @o2exchange/sdk
```

Requires **Node.js 18+**. Ships with dual ESM + CJS output.

## Quick Start

```ts
import { O2Client, Network } from "@o2exchange/sdk";

const client = new O2Client({ network: Network.TESTNET });
const wallet = client.generateWallet();
const { tradeAccountId } = await client.setupAccount(wallet);
const session = await client.createSession(wallet, tradeAccountId, ["fFUEL/fUSDC"]);
const { response } = await client.createOrder(session, "fFUEL/fUSDC", "Buy", 0.02, 50.0);
console.log(response.tx_id);
```

## Features

- **Trading** — Place, cancel, and manage orders with automatic price/quantity scaling
- **Market Data** — Fetch order book depth, recent trades, OHLCV candles, and ticker data
- **WebSocket Streams** — Real-time depth, order, trade, balance, and nonce updates via `AsyncGenerator`
- **Wallet Support** — Fuel-native and EVM wallets with session-based signing
- **Batch Actions** — Submit up to 5 actions per request (cancel + settle + create in one call)
- **Dual Output** — ESM and CJS builds for maximum compatibility
- **Zero Heavy Dependencies** — Uses `@noble/secp256k1` and `@noble/hashes` (no native modules)

## API Overview

| Method | Description |
|--------|-------------|
| `generateWallet()` / `loadWallet(hex)` | Create or load a Fuel wallet |
| `generateEvmWallet()` / `loadEvmWallet(hex)` | Create or load an EVM wallet |
| `setupAccount(wallet)` | Idempotent account setup |
| `createSession(wallet, tradeAccountId, markets)` | Create a trading session |
| `createOrder(session, market, side, price, qty)` | Place an order |
| `cancelOrder(session, orderId, market)` | Cancel a specific order |
| `cancelAllOrders(session, market)` | Cancel all open orders |
| `settleBalance(session, market)` | Settle filled order proceeds |
| `batchActions(session, actions, market, registryId)` | Submit raw action batch |
| `getMarkets()` / `getMarket(pair)` | Fetch market info |
| `getDepth(market)` / `getTrades(market)` | Order book and trade data |
| `getBalances(tradeAccountId)` / `getOrders(id, market)` | Account data |
| `streamDepth(market)` | Real-time order book stream |
| `streamOrders(id)` / `streamTrades(market)` | Real-time updates |
| `withdraw(wallet, tradeAccountId, assetId, amount)` | Withdraw funds |

See [AGENTS.md](AGENTS.md) for the complete API reference with all parameters and types.

## Examples

| Example | Description |
|---------|-------------|
| [`quickstart.ts`](examples/quickstart.ts) | Connect, create a wallet, place your first order |
| [`market-maker.ts`](examples/market-maker.ts) | Two-sided quoting loop with cancel/replace |
| [`taker-bot.ts`](examples/taker-bot.ts) | Monitor depth and take liquidity |
| [`portfolio.ts`](examples/portfolio.ts) | Multi-market balance tracking and management |

Run an example:

```bash
npx tsx examples/quickstart.ts
```

## Testing

Unit tests (no network required):

```bash
npm test
```

Integration tests (requires `O2_PRIVATE_KEY` and `O2_INTEGRATION` env vars):

```bash
O2_INTEGRATION=1 O2_PRIVATE_KEY=0x... npm test
```

## AI Agent Integration

See [AGENTS.md](AGENTS.md) for an LLM-optimized reference covering all methods, types, error codes, and common patterns.
