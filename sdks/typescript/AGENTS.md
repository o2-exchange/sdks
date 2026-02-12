# O2 SDK for TypeScript — LLM Reference

## Installation

```bash
npm install @o2exchange/sdk
```

Requires Node.js 18+.

## Quick Start (5-line working example)

```ts
import { O2Client, Network } from "@o2exchange/sdk";

const client = new O2Client({ network: Network.TESTNET });
const wallet = client.generateWallet();
const { tradeAccountId } = await client.setupAccount(wallet);
const session = await client.createSession(wallet, tradeAccountId, ["fFUEL/fUSDC"]);
const { response } = await client.createOrder(session, "fFUEL/fUSDC", "Buy", 0.02, 50.0);
```

## API Reference

### O2Client

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `constructor` | `{ network?: Network, config?: NetworkConfig }` | `O2Client` | Create client (default: TESTNET) |
| `generateWallet()` | — | `WalletState` | Generate Fuel-native wallet |
| `generateEvmWallet()` | — | `WalletState` | Generate EVM wallet |
| `loadWallet(hex)` | `privateKeyHex: string` | `WalletState` | Load Fuel wallet from hex |
| `loadEvmWallet(hex)` | `privateKeyHex: string` | `WalletState` | Load EVM wallet from hex |
| `setupAccount(wallet)` | `WalletState` | `{ tradeAccountId, nonce }` | Idempotent account setup |
| `createSession(wallet, tradeAccountId, markets, expiryDays?)` | wallet, id, markets, days | `SessionState` | Create trading session |
| `createOrder(session, market, side, price, quantity, orderType?, settleFirst?, collectOrders?)` | session, market, params | `{ response, session }` | Place order with auto-scaling |
| `cancelOrder(session, orderId, market)` | session, orderId, market | `{ response, session }` | Cancel an order |
| `cancelAllOrders(session, market)` | session, market | `{ response, session } \| null` | Cancel all open orders |
| `settleBalance(session, market)` | session, market | `{ response, session }` | Settle filled balances |
| `batchActions(session, marketActions, market, registryId, collectOrders?)` | raw actions | `{ response, session }` | Submit raw action batch |
| `getMarkets()` | — | `Market[]` | Fetch all markets |
| `getMarket(pair)` | `"FUEL/USDC"` | `Market` | Resolve market by pair |
| `getDepth(market, precision?)` | market, precision | `DepthSnapshot` | Get order book depth |
| `getTrades(market, count?)` | market, count | `Trade[]` | Get recent trades |
| `getBars(market, resolution, from, to)` | market, params | `Bar[]` | Get OHLCV candles |
| `getTicker(market)` | market | `MarketTicker` | Get ticker data |
| `getBalances(tradeAccountId)` | id | `Record<string, BalanceResponse>` | Get all balances by symbol |
| `getOrders(tradeAccountId, market, isOpen?, count?)` | id, market, params | `Order[]` | Get orders |
| `getOrder(market, orderId)` | market, orderId | `Order` | Get single order |
| `streamDepth(market, precision?)` | market | `AsyncGenerator<DepthUpdate>` | Stream order book |
| `streamOrders(tradeAccountId)` | id | `AsyncGenerator<OrderUpdate>` | Stream order updates |
| `streamTrades(market)` | market | `AsyncGenerator<TradeUpdate>` | Stream trades |
| `streamBalances(tradeAccountId)` | id | `AsyncGenerator<BalanceUpdate>` | Stream balances |
| `streamNonce(tradeAccountId)` | id | `AsyncGenerator<NonceUpdate>` | Stream nonce updates |
| `getNonce(tradeAccountId)` | id | `bigint` | Fetch current nonce |
| `refreshNonce(session)` | session | `bigint` | Re-fetch nonce from API |
| `withdraw(wallet, tradeAccountId, assetId, amount, to?)` | wallet, params | `WithdrawResponse` | Withdraw funds |
| `disconnectWs()` | — | `void` | Close WebSocket connection |

### Low-Level Modules

#### Crypto (`crypto.ts`)

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `generateWallet()` | — | `Wallet` | Generate Fuel keypair |
| `walletFromPrivateKey(key)` | `Uint8Array \| string` | `Wallet` | Load Fuel wallet |
| `generateEvmWallet()` | — | `EvmWallet` | Generate EVM keypair |
| `evmWalletFromPrivateKey(key)` | `Uint8Array \| string` | `EvmWallet` | Load EVM wallet |
| `fuelCompactSign(privKey, digest)` | key, 32-byte digest | `Uint8Array(64)` | Sign with recovery in MSB of byte 32 |
| `personalSign(privKey, message)` | key, message | `Uint8Array(64)` | Fuel personalSign (session creation) |
| `rawSign(privKey, message)` | key, message | `Uint8Array(64)` | Raw SHA-256 sign (session actions) |
| `evmPersonalSign(privKey, message)` | key, message | `Uint8Array(64)` | EVM personalSign (EVM owner sessions) |

#### Encoding (`encoding.ts`)

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `u64BE(value)` | `number \| bigint` | `Uint8Array(8)` | Big-endian u64 encoding |
| `functionSelector(name)` | `string` | `Uint8Array` | `u64(len) + utf8(name)` |
| `encodeIdentity(disc, addr)` | `0\|1, Uint8Array(32)` | `Uint8Array(40)` | Identity encoding |
| `encodeOrderArgs(price, qty, type)` | bigints, variant | `Uint8Array` | OrderArgs struct |
| `buildSessionSigningBytes(...)` | nonce, chainId, addr, cids, expiry | `Uint8Array` | Session signing payload |
| `buildActionsSigningBytes(nonce, calls)` | nonce, calls | `Uint8Array` | Action signing payload |
| `actionToCall(action, market, registryId?)` | JSON action, market info | `ContractCall` | High-to-low level conversion |
| `scalePrice(price, decimals, maxPrecision)` | number, ints | `bigint` | Human to chain price |
| `scaleQuantity(qty, decimals, maxPrecision)` | number, ints | `bigint` | Human to chain quantity |
| `formatDecimal(chainValue, decimals)` | bigint, int | `number` | Chain to human |
| `hexToBytes(hex)` | `string` | `Uint8Array` | Hex to bytes |
| `bytesToHex(bytes)` | `Uint8Array` | `string` | Bytes to 0x-prefixed hex |

## Common Patterns

### 1. Setup & First Trade

```ts
const client = new O2Client({ network: Network.TESTNET });
const wallet = client.generateWallet();
const { tradeAccountId } = await client.setupAccount(wallet);
const session = await client.createSession(wallet, tradeAccountId, ["fFUEL/fUSDC"]);
const { response } = await client.createOrder(session, "fFUEL/fUSDC", "Buy", 0.02, 50.0);
console.log(`Order TX: ${response.tx_id}`);
```

### 2. Market Maker Loop

```ts
let buyId: string | null = null;
let sellId: string | null = null;

while (true) {
  const actions: ActionPayload[] = [];
  if (buyId) actions.push({ CancelOrder: { order_id: buyId } });
  if (sellId) actions.push({ CancelOrder: { order_id: sellId } });
  actions.push({ SettleBalance: { to: { ContractId: tradeAccountId } } });
  actions.push({ CreateOrder: { side: "Buy", price: buyPrice, quantity: qty, order_type: "Spot" } });
  actions.push({ CreateOrder: { side: "Sell", price: sellPrice, quantity: qty, order_type: "Spot" } });

  const { response, session: s } = await client.batchActions(
    session, [{ market_id: market.market_id, actions }], market, registryId, true
  );
  session = s;
  buyId = response.orders?.find(o => o.side === "Buy")?.order_id ?? null;
  sellId = response.orders?.find(o => o.side === "Sell")?.order_id ?? null;
  await sleep(10000);
}
```

### 3. Real-Time Depth Monitoring

```ts
const depthStream = await client.streamDepth("fFUEL/fUSDC", 10);
for await (const update of depthStream) {
  const asks = update.view?.sells ?? update.changes?.sells ?? [];
  const bids = update.view?.buys ?? update.changes?.buys ?? [];
  console.log(`Best bid: ${bids[0]?.price}, Best ask: ${asks[0]?.price}`);
}
```

### 4. Order Management

```ts
// Cancel specific order
await client.cancelOrder(session, orderId, "fFUEL/fUSDC");

// Cancel all open orders
await client.cancelAllOrders(session, "fFUEL/fUSDC");

// Settle balance
await client.settleBalance(session, "fFUEL/fUSDC");

// Refresh nonce after errors
await client.refreshNonce(session);
```

### 5. Balance Tracking & Withdrawals

```ts
const balances = await client.getBalances(tradeAccountId);
for (const [symbol, bal] of Object.entries(balances)) {
  console.log(`${symbol}: ${bal.trading_account_balance}`);
}

// Withdraw
await client.withdraw(wallet, tradeAccountId, assetId, "1000000000");
```

## Error Handling

| Code | Name | Recovery |
|------|------|----------|
| 1000 | InternalError | Retry with backoff |
| 1003 | RateLimitExceeded | Wait 3-5s, retry (auto-handled) |
| 2000 | MarketNotFound | Check market_id |
| 3000 | OrderNotFound | Order may be filled/cancelled |
| 4000 | InvalidSignature | Check signing logic |
| 4001 | InvalidSession | Recreate session |
| 4002 | AccountNotFound | Call setupAccount() |
| 7004 | TooManyActions | Max 5 actions per batch |

On-chain reverts have no `code` field — check `error.reason` for revert name (e.g., `"NotEnoughBalance"`, `"TraderNotWhiteListed"`, `"PricePrecision"`, `"FractionalPrice"`).

```ts
try {
  await client.createOrder(session, market, "Buy", price, qty);
} catch (error) {
  if (error instanceof O2Error) {
    console.log(error.code, error.message, error.reason);
  }
}
```

## Type Reference

| Type | Key Fields | Description |
|------|------------|-------------|
| `WalletState` | `privateKey, b256Address, isEvm` | Wallet state |
| `SessionState` | `sessionPrivateKey, sessionAddress, tradeAccountId, nonce, contractIds` | Session state |
| `Market` | `contract_id, market_id, base, quote, min_order, dust` | Market config |
| `MarketAsset` | `symbol, asset, decimals, max_precision` | Asset in a market |
| `Order` | `order_id, side, price, quantity, order_type, close, cancel` | Order record |
| `Trade` | `trade_id, side, price, quantity, total, timestamp` | Trade record |
| `BalanceResponse` | `trading_account_balance, total_locked, total_unlocked, order_books` | Balance info |
| `DepthSnapshot` | `buys, sells` (each: `{ price, quantity }[]`) | Order book depth |
| `DepthUpdate` | `action, view?, changes?, market_id` | WebSocket depth update |
| `Identity` | `{ Address: hex }` or `{ ContractId: hex }` | Fuel identity enum |

## Critical Implementation Notes

- Session creation uses `personalSign` (Fuel prefix). Session actions use `rawSign` (no prefix).
- EVM owner wallets use `evmPersonalSign` for session creation. Session wallet always uses Fuel-style.
- Nonce increments on-chain even on reverts. Always refresh on errors.
- Function selectors are `u64(len) + utf8(name)`, NOT keccak256 hashes.
- `chain_id` can be `0` on testnet — this is valid.
- OrderType encoding is tightly packed (no padding to largest variant).
- Gas is always `u64::MAX` (18446744073709551615n).
- `setupAccount()` is idempotent — safe to call on every startup.
