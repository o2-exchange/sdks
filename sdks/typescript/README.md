<p align="center">
  <img src="https://docs.o2.app/logo.svg" width="80" alt="O2 Exchange">
</p>

<h1 align="center">O2 SDK for TypeScript</h1>

<p align="center">
  <a href="https://github.com/o2-exchange/sdks/actions/workflows/ci.yml"><img src="https://github.com/o2-exchange/sdks/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-22.4%2B-green.svg" alt="Node.js 22.4+"></a>
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

Requires **Node.js 22.4+** for native runtime WebSocket support.
Also works in **Bun** and modern browsers.
Ships with dual ESM + CJS output.

## Quick Start

Recommended first integration path on testnet:

1. Create/load owner wallet
2. Call `setupAccount()` (idempotent account setup + faucet mint attempt on testnet/devnet)
3. (Optional) Call `topUpFromFaucet()` for an explicit testnet/devnet top-up
4. Create session with market permissions
5. Place orders
6. Read balances/orders
7. Settle balances back to your trading account after fills; order funds are moved into the market contract during execution and should be swept after fills or cancellations

```ts
import { Network, O2Client } from "@o2exchange/sdk";

const client = new O2Client({ network: Network.TESTNET });
const wallet = O2Client.generateWallet();

const { tradeAccountId } = await client.setupAccount(wallet);
await client.topUpFromFaucet(wallet);
await client.createSession(wallet, ["fFUEL/fUSDC"]);

const order = await client.createOrder("fFUEL/fUSDC", "buy", "0.02", "50");
console.log(`order tx=${order.txId}`);

const balances = await client.getBalances(tradeAccountId);
console.log(`fUSDC balance=${balances.fUSDC?.trading_account_balance ?? 0n}`);

const settle = await client.settleBalance("fFUEL/fUSDC");
console.log(`settle tx=${settle.txId}`);

client.close();
```

`getBalances(tradeAccountId)` is an aggregated view across trading account and
market contracts, so `settleBalance(...)` does not necessarily change aggregate totals.

## Network Configuration

Default network configs:

| Network | REST API | WebSocket | Fuel RPC | Faucet |
|---------|----------|-----------|----------|--------|
| `Network.TESTNET` | `https://api.testnet.o2.app` | `wss://api.testnet.o2.app/v1/ws` | `https://testnet.fuel.network/v1/graphql` | `https://fuel-o2-faucet.vercel.app/api/testnet/mint-v2` |
| `Network.DEVNET` | `https://api.devnet.o2.app` | `wss://api.devnet.o2.app/v1/ws` | `https://devnet.fuel.network/v1/graphql` | `https://fuel-o2-faucet.vercel.app/api/devnet/mint-v2` |
| `Network.MAINNET` | `https://api.o2.app` | `wss://api.o2.app/v1/ws` | `https://mainnet.fuel.network/v1/graphql` | none |

API rate limits: <https://docs.o2.app/api-endpoints-reference.html#rate-limits>.

Pass a custom deployment config if needed:

```ts
const client = new O2Client({
  config: {
    apiBase: "https://my-gateway.example.com",
    wsUrl: "wss://my-gateway.example.com/v1/ws",
    fuelRpc: "https://mainnet.fuel.network/v1/graphql",
    faucetUrl: null,
  },
});
```

> [!IMPORTANT]
> Mainnet note: there is no faucet; account setup requires an owner wallet that already has funds deposited for trading. SDK-native bridging flows are coming soon.

## Wallet Security

- `O2Client.generateWallet()` / `O2Client.generateEvmWallet()` use cryptographically secure randomness and are suitable for mainnet key generation.
- For production custody, use external signers (KMS/HSM/hardware wallets) instead of long-lived in-process private keys.
- See `docs/guides/external-signers.md` for production signer integration.

## Wallet Types and Identifiers

Why choose each wallet type:

- **Fuel-native wallet** — best for interoperability with other apps in the Fuel ecosystem.
- **EVM wallet** — best if you want to reuse existing EVM accounts across chains and simplify bridging from EVM chains.

O2 owner identity model:

- O2 `ownerId` is always a Fuel B256 (`0x` + 64 hex chars).
- Fuel-native wallets already expose that directly as `b256Address`.
- EVM wallets expose both:
  - `evmAddress` (`0x` + 40 hex chars)
  - `b256Address` (`0x` + 64 hex chars)
- For EVM wallets, `b256Address` is the EVM address zero-left-padded to 32 bytes:
  - `owner_b256 = 0x000000000000000000000000 + evmAddress.slice(2)`

Identifier usage:

| Context | Identifier |
|---------|------------|
| Owner/account/session APIs | `ownerId` = wallet `b256Address` |
| Trading account state | `tradeAccountId` (contract ID) |
| Human-visible EVM identity | `evmAddress` |
| Markets | pair (`"fFUEL/fUSDC"`) or `market_id` |

`ownerId` vs `tradeAccountId`:

- `ownerId` is wallet identity (`b256Address`) used for ownership/auth and session setup.
- `tradeAccountId` is the trading account contract ID used for balances/orders/account state.
- `setupAccount(wallet)` links these by creating/fetching the trading account for that owner.

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
| `topUpFromFaucet(wallet)` | Explicit faucet top-up to the wallet's trading account (testnet/devnet) |
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

## Guides

- [Identifiers and Wallet Types](docs/guides/identifiers.md)
- [Trading](docs/guides/trading.md)
- [Market Data](docs/guides/market-data.md)
- [WebSocket Streams](docs/guides/websocket-streams.md)
- [Error Handling](docs/guides/error-handling.md)
- [External Signers](docs/guides/external-signers.md)

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
