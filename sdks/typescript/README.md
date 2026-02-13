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
const wallet = O2Client.generateWallet();
await client.setupAccount(wallet);
await client.createSession(wallet, ["fFUEL/fUSDC"]);
const response = await client.createOrder("fFUEL/fUSDC", "buy", "0.02", "50");
console.log(response.txId);
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
| `O2Client.generateWallet()` / `O2Client.loadWallet(hex)` | Create or load a Fuel wallet |
| `O2Client.generateEvmWallet()` / `O2Client.loadEvmWallet(hex)` | Create or load an EVM wallet |
| `setupAccount(wallet)` | Idempotent account setup |
| `setSession(session)` | Restore a serialized session onto the client |
| `createSession(wallet, markets, expiryDays?)` | Create and store a trading session |
| `createOrder(market, side, price, qty, options?)` | Place an order (`side`: `"buy"`/`"sell"`) |
| `cancelOrder(orderId, market)` | Cancel a specific order |
| `cancelAllOrders(market)` | Cancel all open orders |
| `settleBalance(market)` | Settle filled order proceeds |
| `batchActions(marketActions, collectOrders?)` | Submit type-safe action batches |
| `getMarkets()` / `getMarket(pair)` | Fetch market info |
| `getDepth(market)` / `getTrades(market)` | Order book and trade data |
| `getBalances(tradeAccountId)` / `getOrders(id, market)` | Account data |
| `streamDepth(market)` | Real-time order book stream |
| `streamOrders(id)` / `streamTrades(market)` | Real-time updates |
| `refreshNonce()` | Re-sync the stored session nonce |
| `withdraw(wallet, asset, amount, to?)` | Withdraw funds |

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

Integration tests (live testnet access required):

```bash
npm run test:integration
```

Note: these tests require outbound DNS/HTTPS/WebSocket access to O2 testnet endpoints. In sandboxed environments, run them outside the sandbox (unsandboxed) to avoid `fetch failed`/DNS resolution errors.

## AI Agent Integration

See [AGENTS.md](AGENTS.md) for an LLM-optimized reference covering all methods, types, error codes, and common patterns.
