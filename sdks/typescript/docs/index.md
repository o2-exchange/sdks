# O2 SDK for TypeScript

The official TypeScript SDK for the [O2 Exchange](https://o2.app) — a fully
on-chain central limit order book (CLOB) DEX on the
[Fuel Network](https://fuel.network).

This SDK provides everything you need to trade programmatically on the O2
Exchange: wallet management, account lifecycle, session-based trading, market
data retrieval, and real-time WebSocket streaming.

> For general information about the O2 Exchange platform, see the
> [O2 Exchange documentation](https://docs.o2.app).

## Features

- **Wallet management** — Generate or load Fuel-native and EVM-compatible wallets
- **Account lifecycle** — Idempotent account setup with automatic faucet and whitelist
- **Session-based trading** — Delegated signing with automatic nonce management
- **Market data** — Depth, trades, candles, and ticker data
- **Real-time streaming** — WebSocket streams via `AsyncGenerator` / `for await`
- **Full type safety** — Comprehensive TypeScript types for all API responses
- **Automatic encoding** — Prices and quantities auto-scaled to chain integers
- **Error handling** — Typed error classes for every API error code

## Quick Example

```ts
import { O2Client, Network } from "@o2exchange/sdk";

const client = new O2Client({ network: Network.TESTNET });
const wallet = client.generateWallet();
const { tradeAccountId } = await client.setupAccount(wallet);
const session = await client.createSession(wallet, tradeAccountId, ["fFUEL/fUSDC"]);
const { response } = await client.createOrder(session, "fFUEL/fUSDC", "Buy", 0.02, 50.0);
console.log(`Order TX: ${response.tx_id}`);
client.close();
```

## Installation

```bash
npm install @o2exchange/sdk
```

Requires **Node.js 18+**.

## Documentation

- **Quick Start** — Step-by-step guide to your first trade
- **Trading Guide** — Order types, batch actions, and advanced patterns
- **Market Data** — Fetching depth, trades, candles, and tickers
- **WebSocket Streams** — Real-time data with `for await`
- **Error Handling** — Error types and recovery patterns
- **API Reference** — Full type and method documentation (auto-generated below)
