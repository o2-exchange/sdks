# O2 SDK for TypeScript — LLM Reference

## Installation

```bash
npm install @o2exchange/sdk
```

Requires Node.js 22.4+.
Also works in Bun and modern browsers.

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
| `session` | — | `SessionState \| null` | Getter: the currently active session |
| `setSession(session)` | `SessionState` | `void` | Restore a serialized session |
| `clearSession()` | — | `void` | Clear the active session |
| `setupAccount(wallet)` | `Signer` | `{ tradeAccountId, nonce }` | Idempotent account setup |
| `createSession(wallet, markets, expiryDays?)` | `Signer`, market list, days | `SessionState` | Create and store trading session |
| `createOrder(market, side, price, quantity, options?)` | market, `"buy"\|"sell"`, `Numeric`, `Numeric`, options incl. `session?` | `SessionActionsResponse` | Place order (nonce auto-managed) |
| `cancelOrder(orderId, market, session?)` | orderId, market, session? | `SessionActionsResponse` | Cancel an order |
| `cancelAllOrders(market, session?)` | market, session? | `SessionActionsResponse[] \| null` | Cancel all open orders |
| `settleBalance(market, session?)` | market, session? | `SessionActionsResponse` | Settle filled balances |
| `batchActions(marketActions, collectOrders?, session?)` | type-safe action groups | `SessionActionsResponse` | Submit multi-action batch |
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
| `refreshNonce(session?)` | session? | `bigint` | Re-fetch nonce and update a session |
| `withdraw(wallet, asset, amount, to?)` | owner signer, symbol/assetId, `Numeric`, `Identity \| string`? | `WithdrawResponse` | Withdraw funds |
| `disconnectWs()` | — | `void` | Close WebSocket connection |
| `close()` | — | `void` | Close all resources (WebSocket + cache) |

### Utility Exports

These helpers are exported from the package root (`@o2exchange/sdk`).

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `ensureNumeric(value, fieldName)` | `unknown`, string | `Numeric` | Runtime guard for decimal-string or bigint inputs |
| `capitalizeSide(side)` | `"buy"\|"sell"` | `"Buy"\|"Sell"` | Convert side to API wire format |
| `scaleNumericPrice(value, decimals, maxPrecision)` | `Numeric`, ints | `string` | Scale price to chain integer string |
| `scaleOrderType(orderType, market)` | order type, market | `WireOrderType` | Scale order-type price fields |
| `resolveMarket(markets, pairOrId)` | market list/response, string | `Market` | Resolve symbol pair or market ID |
| `resolveMarketRef(markets, market)` | market list/response, `MarketRef` | `Market` | Resolve a `MarketRef` |
| `resolveAsset(markets, symbolOrId)` | market list/response, string | `{ assetId, decimals }` | Resolve asset symbol or ID |

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
| `buildWithdrawSigningBytes(...)` | nonce, chainId, toDiscriminant, toAddress, assetId, amount | `Uint8Array` | Signing payload; emitted in `(Identity, amount, AssetId)` ABI order |
| `actionToCall(action, market, registryId?)` | JSON action, market info | `ContractCall` | High-to-low level conversion |
| `scaleDecimalString(value, decimals)` | decimal string, int | `bigint` | Decimal string to chain integer |
| `scalePriceString(value, decimals, maxPrecision)` | decimal string, ints | `bigint` | Decimal string price to chain integer |
| `scalePrice(price, decimals, maxPrecision)` | number, ints | `bigint` | Human to chain price |
| `scaleQuantity(qty, decimals, maxPrecision)` | number, ints | `bigint` | Human to chain quantity |
| `validateFractionalPrice(price, qty, baseDecimals)` | bigints, int | `boolean` | Check FractionalPrice divisibility |
| `adjustQuantityForFractionalPrice(price, qty, baseDecimals)` | bigints, int | `bigint` | Round quantity down to valid quantum |
| `validateMinOrder(price, qty, baseDecimals, minOrder)` | bigints, int, bigint | `boolean` | Check minimum order value |
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
  const asks = update.view?.asks ?? update.changes?.asks ?? [];
  const bids = update.view?.bids ?? update.changes?.bids ?? [];
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
await client.createSession(signer, ["fFUEL/fUSDC"]);
const response = await client.createOrder("fFUEL/fUSDC", "buy", "0.02", "100");
```

For EVM accounts, use `ExternalEvmSigner` with an additional `evmAddress` parameter:

```ts
import { ExternalEvmSigner } from "@o2exchange/sdk";

const evmSigner = new ExternalEvmSigner("0x000...abcd", "0xabcd...1234", (digest) => {
  const { r, s, recoveryId } = myKms.sign(digest);
  return toFuelCompactSignature(r, s, recoveryId);
});
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

## Action Factories

Helper functions for building typed actions (used with `batchActions`):

| Function | Params | Description |
|----------|--------|-------------|
| `createOrderAction(side, price, qty, orderType?)` | `Side`, `Numeric`, `Numeric`, `OrderType` | Create order action |
| `cancelOrderAction(orderId)` | `OrderId` | Cancel order action |
| `settleBalanceAction()` | — | Settle balance action |
| `registerRefererAction(to)` | `Identity` | Register a referrer |

## Critical Implementation Notes

- **Session is stored on the client**: after `createSession()` or `setSession()`, trading methods use that stored session implicitly.
- **External signers**: `setupAccount()`, `createSession()`, and `withdraw()` accept any `Signer` (`ExternalSigner` for Fuel, `ExternalEvmSigner` for EVM). Session actions use the session key, not the owner signer.
- Session creation uses `personalSign` (Fuel/EVM prefixed). Session actions use `rawSign` (no prefix).
- Nonce increments on-chain even on reverts. The SDK auto-resyncs in many error paths; call `refreshNonce()` after failures if needed.
- Function selectors are `u64(len) + utf8(name)`, not keccak hashes.
- `chain_id` can be `0` on testnet and is valid.
- `setupAccount()` is idempotent and safe to call on startup.

## Fast Bridge

Import `FastBridgeClient`, `BridgeApiError`, and the three parsing helpers from
`@o2exchange/sdk`; bridge types are available through `import type { bridge }`.
This client is separate from O2 trading sessions and `O2Client.withdraw()`.
Construct with `{ baseUrl: string, timeoutMs?: number, fetch?: typeof globalThis.fetch }`;
timeout defaults to 30000 ms. An explicit proxy root URL without `/v1` is required. No built-in network URLs,
automatic retries, or redirects. An ambiguous submit timeout requires status
reconciliation, not blind resubmission.

All methods return `Promise<ResponseType>`:

| Method | Parameters | Response type |
|--------|------------|---------------|
| `getInfo` | None | `bridge.InfoResponse` |
| `getAssets` | `chainId?: number` | `bridge.AssetsResponse` |
| `getDepositInfo` | `sourceChainId: number, assetId?: string, amount?: string` | `bridge.DepositInfoResponse` |
| `prepareDeposit` | `bridge.DepositPrepareRequest` | `bridge.DepositPrepareResponse` |
| `submitDeposit` | `bridge.SubmitRequest` | `bridge.DepositSubmitResponse` |
| `getDepositStatus` | `sourceChainId: number, evmTxHash: string` | `bridge.DepositStatusResponse` |
| `getWithdrawInfo` | `destinationChainId: number, assetId?: string, amount?: string` | `bridge.WithdrawInfoResponse` |
| `getWithdrawFee` | `destinationChainId: number, assetId: string` | `bridge.WithdrawFeeResponse` |
| `prepareWithdraw` | `bridge.WithdrawPrepareRequest` | `bridge.WithdrawPrepareResponse` |
| `submitWithdraw` | `bridge.SubmitRequest` | `bridge.WithdrawSubmitResponse` |
| `getWithdrawStatus` | `fuelTxId: string` | `bridge.WithdrawStatusResponse` |

Request fields (wire names are the same):

- `DepositPrepareRequest`: `sourceChainId: number`, `from: string` (20-byte EVM address), `to: string` (Fuel B256), required `toType: "address" | "contract"`, `assetId: string`, `amount: string`, optional `permit: DepositPermit`.
- `DepositPermit`: `deadline: string` (Unix seconds), `v: number`, `r: string`, `s: string` (32-byte hex). This is a separate EIP-2612 token approval, not the transaction signature.
- `WithdrawPrepareRequest`: `destinationChainId: number`, `from: string` (Fuel B256 address), `to: string` (20-byte EVM address), `assetId: string`, `amount: string`.
- `SubmitRequest`: `unsignedTransaction: string`, `preparationProof: string`, `signature: string`. Preserve exact prepared bytes/proof. Fuel prepare also returns `fuelChainId`; do not include it in submit.

`assetId` is the full Fuel AssetId, not the asset sub-ID. API amounts are decimal
integer strings in Fuel asset base units; no human-unit or float conversion.
Submit means accepted, not confirmed; unknown status remains a 404 error and
`unavailable` relay state does not mean delivered.

| Helper | Parameters | Result |
|--------|------------|--------|
| `parsePreparationProof` | `proof: string` | `bridge.PreparationProofClaims`: `version, keyId, expiresAt, signer` |
| `parseEvmUnsignedTransaction` | `unsignedTransaction: string` | `bridge.EvmDepositInspection`: envelope, decoded Messenger call/permit, fee caps, local `signingDigest` |
| `parseFuelUnsignedTransaction` | `unsignedTransaction: string, fuelChainId: bigint, fuelMaxInputs: number` | `bridge.FuelWithdrawalInspection`: call, assets, fees, policies, inputs/outputs, local `transactionId` |

Proof claims are **unauthenticated**, even if parseable. `expiresAt` is Unix
seconds; expired proofs can parse. No `verify` helper or Worker secret belongs
in a client. Only the proxy authenticates proof/operation/transaction binding.
Fuel chain ID and consensus `maxInputs` must be independently trusted; the
latter is not encoded in the transaction and determines absolute VM pointers.
Parsers make no RPC calls and reject unsupported formats, fixed Fuel Coin
outputs, and zero withdrawal recipients, but are not economic approval.

Inspection quantities use `bigint`. EVM `amount` uses EVM token units/wei;
`estimatedNetworkFee = gasLimit * maxFeePerGas` is a cap excluding rollup L1
fees. Fuel `bridgeFee` is the embedded quote; `netAmount = grossAmount - bridgeFee`
is expected, not guaranteed. `networkFee.maxFee` is in Fuel base-asset units.
`expirationBlockHeight` is independent of proof expiry. Change/Variable output
amounts and Variable recipients/assets are unsigned execution results.

Before signing, compare chain/contracts, recipient/type, asset, amount, fee
limits, expiry and all inputs/outputs against trusted expectations. Sign the
locally computed raw digest using `fuelCompactSign`, not `personalSign` or
`rawSign` (both rehash). Fuel uses compact 64-byte signatures; EVM needs 65-byte
`r || s || v`. See [the complete example](examples/fast-bridge.ts).

`BridgeApiError extends O2Error` exposes `status`, string `bridgeCode`, `message`,
and `details`. Transport errors retain native fetch/timeout error types; parser
failures throw errors. Do not handle proxy codes as numeric O2 trading codes.
