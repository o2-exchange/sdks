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
- **Full type safety** — Branded hex types, `bigint` chain integers, discriminated action union
- **Dual-mode numerics** — Pass human-readable strings (`"0.02"`) or raw `bigint` chain values
- **Automatic encoding** — Prices and quantities auto-scaled, FractionalPrice adjusted, min_order validated
- **Error handling** — Typed error classes for every API error code, `SessionActionsResponse.success` getter

## Quick Example

```ts
import { O2Client, Network } from "@o2exchange/sdk";

const client = new O2Client({ network: Network.TESTNET });
const wallet = O2Client.generateWallet();
await client.setupAccount(wallet);
await client.createSession(wallet, ["fFUEL/fUSDC"]);
const response = await client.createOrder("fFUEL/fUSDC", "buy", "0.02", "50");
if (response.success) {
  console.log(`Order TX: ${response.txId}`);
}
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
- **External Signers** — KMS/HSM integration for production deployments
- **API Reference** — Full type and method documentation (auto-generated below)
