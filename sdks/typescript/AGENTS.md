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
const wallet = O2Client.generateWallet();
await client.setupAccount(wallet);
await client.createSession(wallet, ["fFUEL/fUSDC"]);
const response = await client.createOrder("fFUEL/fUSDC", "buy", "0.02", "50");
```

## API Reference

### O2Client

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `constructor` | `{ network?: Network, config?: NetworkConfig, marketsCacheTtlMs?: number }` | `O2Client` | Create client (default: TESTNET) |
| `O2Client.generateWallet()` | — | `WalletState` | Generate Fuel-native wallet |
| `O2Client.generateEvmWallet()` | — | `WalletState` | Generate EVM wallet |
| `O2Client.loadWallet(hex)` | `privateKeyHex: string` | `WalletState` | Load Fuel wallet from hex |
| `O2Client.loadEvmWallet(hex)` | `privateKeyHex: string` | `WalletState` | Load EVM wallet from hex |
| `setSession(session)` | `SessionState` | `void` | Restore a serialized session |
| `setupAccount(wallet)` | `Signer` | `{ tradeAccountId, nonce }` | Idempotent account setup |
| `createSession(wallet, markets, expiryDays?)` | `Signer`, market list, days | `SessionState` | Create and store trading session |
| `createOrder(market, side, price, quantity, options?)` | market, `"buy"\|"sell"`, `Numeric`, `Numeric`, options | `SessionActionsResponse` | Place order (nonce auto-managed) |
| `cancelOrder(orderId, market)` | orderId, market | `SessionActionsResponse` | Cancel an order |
| `cancelAllOrders(market)` | market | `SessionActionsResponse[] \| null` | Cancel all open orders |
| `settleBalance(market)` | market | `SessionActionsResponse` | Settle filled balances |
| `batchActions(marketActions, collectOrders?)` | type-safe action groups | `SessionActionsResponse` | Submit multi-action batch |
| `getMarkets()` | — | `Market[]` | Fetch all markets |
| `getMarket(pair)` | `"FUEL/USDC"` | `Market` | Resolve market by pair |
| `getDepth(market, precision?)` | market, precision | `DepthSnapshot` | Get order book depth |
| `getTrades(market, count?)` | market, count | `Trade[]` | Get recent trades |
| `getBars(market, resolution, from, to)` | market, params | `Bar[]` | Get OHLCV candles |
| `getTicker(market)` | market | `MarketTicker` | Get ticker data |
| `getBalances(tradeAccountId)` | id | `Record<string, BalanceResponse>` | Get balances keyed by symbol |
| `getOrders(tradeAccountId, market, isOpen?, count?)` | id, market, params | `Order[]` | Get orders |
| `getOrder(market, orderId)` | market, orderId | `Order` | Get single order |
| `streamDepth(market, precision?)` | market | `AsyncGenerator<DepthUpdate>` | Stream order book |
| `streamOrders(tradeAccountId)` | id | `AsyncGenerator<OrderUpdate>` | Stream order updates |
| `streamTrades(market)` | market | `AsyncGenerator<TradeUpdate>` | Stream trades |
| `streamBalances(tradeAccountId)` | id | `AsyncGenerator<BalanceUpdate>` | Stream balances |
| `streamNonce(tradeAccountId)` | id | `AsyncGenerator<NonceUpdate>` | Stream nonce updates |
| `getNonce(tradeAccountId)` | id | `bigint` | Fetch current nonce |
| `refreshNonce()` | — | `bigint` | Re-fetch nonce and update stored session |
| `withdraw(wallet, asset, amount, to?)` | owner signer, symbol/assetId, `Numeric`, address? | `WithdrawResponse` | Withdraw funds |
| `disconnectWs()` | — | `void` | Close WebSocket connection |
| `close()` | — | `void` | Close all resources (WebSocket + cache) |

### Low-Level Modules

Low-level crypto and encoding helpers are exported from:

```ts
import { ... } from "@o2exchange/sdk/internals";
```

#### Crypto (`internals`)

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
| `fuelPersonalSignDigest(message)` | message bytes | `Uint8Array(32)` | Fuel personalSign digest (external signers) |
| `evmPersonalSignDigest(message)` | message bytes | `Uint8Array(32)` | EVM personal_sign digest (external signers) |
| `toFuelCompactSignature(r, s, v)` | 32B r, 32B s, 0\|1 | `Uint8Array(64)` | Convert `(r,s,v)` to Fuel compact format |

#### Encoding (`internals`)

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
const wallet = O2Client.generateWallet();
const { tradeAccountId } = await client.setupAccount(wallet);
await client.createSession(wallet, ["fFUEL/fUSDC"]);
const response = await client.createOrder("fFUEL/fUSDC", "buy", "0.02", "50");
console.log(`Order TX: ${response.txId}`);
```

### 2. Market Maker Loop

```ts
import { cancelOrderAction, createOrderAction, settleBalanceAction } from "@o2exchange/sdk";

let buyId: string | null = null;
let sellId: string | null = null;

while (true) {
  const actions = [];
  if (buyId) actions.push(cancelOrderAction(buyId));
  if (sellId) actions.push(cancelOrderAction(sellId));
  actions.push(settleBalanceAction());
  actions.push(createOrderAction("buy", buyPrice, qty, "PostOnly"));
  actions.push(createOrderAction("sell", sellPrice, qty, "PostOnly"));

  const response = await client.batchActions([{ market: "fFUEL/fUSDC", actions }], true);
  buyId = response.orders?.find((o) => o.side === "buy")?.order_id ?? null;
  sellId = response.orders?.find((o) => o.side === "sell")?.order_id ?? null;
  await sleep(10_000);
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
await client.cancelOrder(orderId, "fFUEL/fUSDC");
await client.cancelAllOrders("fFUEL/fUSDC");
await client.settleBalance("fFUEL/fUSDC");
await client.refreshNonce();
```

### 5. External Signer (KMS/HSM)

```ts
import { ExternalSigner } from "@o2exchange/sdk";
import { toFuelCompactSignature } from "@o2exchange/sdk/internals";

const signer = new ExternalSigner("0x1234...abcd", (digest) => {
  const { r, s, recoveryId } = myKms.sign(digest);
  return toFuelCompactSignature(r, s, recoveryId);
});

await client.setupAccount(signer);
await client.createSession(signer, ["FUEL/USDC"]);
const response = await client.createOrder("FUEL/USDC", "buy", "0.02", "100");
```

### 6. Balance Tracking & Withdrawals

```ts
const balances = await client.getBalances(tradeAccountId);
for (const [symbol, bal] of Object.entries(balances)) {
  console.log(`${symbol}: ${bal.trading_account_balance}`);
}

await client.withdraw(wallet, "fUSDC", "100.0");
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

On-chain reverts have no `code` field — check `error.reason` for revert name (e.g., `"NotEnoughBalance"`, `"TraderNotWhiteListed"`, `"PricePrecision"`).

```ts
try {
  await client.createOrder("fFUEL/fUSDC", "buy", "0.02", "100");
} catch (error) {
  if (error instanceof O2Error) {
    console.log(error.code, error.message, error.reason);
  }
}
```

## Critical Implementation Notes

- **Session is stored on the client**: after `createSession()` or `setSession()`, trading methods use that stored session implicitly.
- **External signers**: `setupAccount()`, `createSession()`, and `withdraw()` accept any `Signer`. Session actions use the session key, not the owner signer.
- Session creation uses `personalSign` (Fuel/EVM prefixed). Session actions use `rawSign` (no prefix).
- Nonce increments on-chain even on reverts. The SDK auto-resyncs in many error paths; call `refreshNonce()` after failures if needed.
- Function selectors are `u64(len) + utf8(name)`, not keccak hashes.
- `chain_id` can be `0` on testnet and is valid.
- `setupAccount()` is idempotent and safe to call on startup.
