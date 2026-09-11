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

| Endpoint | `Network.MAINNET` | `Network.TESTNET` | `Network.DEVNET` |
|----------|---------|---------|--------|
| REST API | `https://api.o2.app` | `https://api.testnet.o2.app` | `https://api.devnet.o2.app` |
| WebSocket | `wss://api.o2.app/v1/ws` | `wss://api.testnet.o2.app/v1/ws` | `wss://api.devnet.o2.app/v1/ws` |
| Fuel RPC | `https://mainnet.fuel.network/v1/graphql` | `https://testnet.fuel.network/v1/graphql` | `https://devnet.fuel.network/v1/graphql` |
| Faucet | none | `https://fuel-o2-faucet.vercel.app/api/testnet/mint-v2` | `https://fuel-o2-faucet.vercel.app/api/devnet/mint-v2` |
| Fast Bridge API ([info](#fast-bridge)) | `https://bridge.o2.app` | `https://bridge.testnet.o2.app` | `https://bridge.devnet.o2.app` |

> [!WARNING]
> Devnet will be deprecated soon. Use Testnet for new development and testing.

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
> Mainnet note: there is no faucet; account setup requires an owner wallet that already has funds deposited for trading. See [Fast Bridge](#fast-bridge) for cross-chain transfers.

## Fast Bridge

Use `FastBridgeClient` for EVM-to-Fuel deposits and Fuel-to-EVM withdrawals.
It is separate from `O2Client.withdraw()` and does not use trading sessions.

Default network configs:

| Setting | Default |
|---------|---------|
| Proxy URL (`baseUrl`) | Required for every network; no built-in mainnet/testnet URL. Supply the root URL without `/v1`. |
| Request timeout (`timeoutMs`) | `30000` (30 seconds) |

Configure the bridge independently of `O2Client`'s `Network` setting:

```ts
import { FastBridgeClient } from "@o2exchange/sdk";

const bridge = new FastBridgeClient({
  baseUrl: "https://my-bridge.example.com",
  timeoutMs: 30_000,
});
const info = await bridge.getInfo();
```

See the [Fast Bridge example](examples/fast-bridge.ts) for all endpoints,
native ETH/ERC-20 requests, permit fields, proof decoding, transaction
inspection, signing, submission, status, and error handling.

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
- **Turbo (Margin)** — Trade a credit line with `long()` / `short()`; funding, sweeping and settling happen behind the call
- **Dual Output** — ESM and CJS builds for maximum compatibility
- **Zero Heavy Dependencies** — Uses `@noble/secp256k1` and `@noble/hashes` (no native modules)

## API Overview

| Method | Description |
|--------|-------------|
| `O2Client.generateWallet()` / `O2Client.loadWallet(hex)` | Create or load a Fuel wallet |
| `O2Client.generateEvmWallet()` / `O2Client.loadEvmWallet(hex)` | Create or load an EVM wallet |
| `setupAccount(wallet)` | Idempotent account setup |
| `topUpFromFaucet(wallet)` | Explicit faucet top-up to the wallet's trading account (testnet/devnet) |
| `setSession(session)` / `clearSession()` | Restore or clear the active client session |
| `createSession(wallet, markets, options?)` | Create and store a trading session (`{ turbo: true }` scopes it for margin) |
| `createOrder(market, side, price, qty, options?)` | Place an order (`side`: `"buy"`/`"sell"`) |
| `cancelOrder(orderId, market, session?)` | Cancel a specific order |
| `cancelAllOrders(market, session?)` | Cancel all open orders |
| `settleBalance(market, session?)` | Settle filled order proceeds |
| `batchActions(marketActions, collectOrders?, session?)` | Submit type-safe action batches |
| `getMarkets()` / `getMarket(pair)` | Fetch market info |
| `getDepth(market)` / `getTrades(market)` | Order book and trade data |
| `getBalances(tradeAccountId)` / `getOrders(id, market)` | Account data |
| `streamDepth(market)` | Real-time order book stream |
| `streamOrders(id)` / `streamTrades(market)` | Real-time updates |
| `refreshNonce(session?)` | Re-sync a session nonce |
| `withdraw(wallet, asset, amount, to?)` | Withdraw funds |
| `turbo.open(params)` | Open a Turbo (margin) account |
| `turbo.long(market, size, options?)` | Buy on the credit line — draws and settles behind the call |
| `turbo.short(market, size, options?)` | Sell short — borrows the asset in kind behind the call |
| `turbo.closePosition(market, options?)` | Close a position |
| `turbo.snapshot()` / `turbo.positions()` / `turbo.limits()` | Account state, positions, and the on-chain gate stack |
| `turbo.addMargin()` / `turbo.extend()` / `turbo.closeAccount()` | Account lifecycle |
| `turbo.referral.mintCode()` / `.activate(code)` / `.status()` | Referral programme |

Utility exports such as `resolveMarket`, `resolveAsset`, `ensureNumeric`, and
`scaleOrderType` are available from the package root for custom client flows.
Low-level encoding helpers, including `adjustQuantityForFractionalPrice`, are
available from `@o2exchange/sdk/internals`.

See [AGENTS.md](AGENTS.md) for the complete API reference with all parameters and types.

## Guides

- [Identifiers and Wallet Types](docs/guides/identifiers.md)
- [Trading](docs/guides/trading.md)
- [Turbo (Margin) Trading](docs/guides/turbo.md)
- [CCXT Compatibility (Alpha)](docs/guides/ccxt-compatibility.md)
- [Market Data](docs/guides/market-data.md)
- [WebSocket Streams](docs/guides/websocket-streams.md)
- [Error Handling](docs/guides/error-handling.md)
- [External Signers](docs/guides/external-signers.md)

## Examples

| Example | Description |
|---------|-------------|
| [`quickstart.ts`](examples/quickstart.ts) | Connect, create a wallet, place your first order |
| [`fast-bridge.ts`](examples/fast-bridge.ts) | Cross-chain discovery, inspection, signing, submission, and status |
| [`market-maker.ts`](examples/market-maker.ts) | Two-sided quoting loop with cancel/replace |
| [`taker-bot.ts`](examples/taker-bot.ts) | Monitor depth and take liquidity |
| [`portfolio.ts`](examples/portfolio.ts) | Multi-market balance tracking and management |
| [`turbo.ts`](examples/turbo.ts) | Open a Turbo account, go long and short on the credit line, close out |

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
