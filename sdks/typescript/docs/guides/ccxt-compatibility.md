# CCXT-Compatible API (Public Alpha)

The TypeScript SDK includes an experimental exchange class that extends the
official [`ccxt.Exchange`](https://docs.ccxt.com/docs/manual) base class and
returns CCXT unified response shapes. It is intended for early trading-bot
integrations and is maintained by O2 rather than merged into the upstream
`ccxt` package. Install the SDK and its optional peer dependency:

```sh
npm install @o2exchange/sdk ccxt
```

Importing `@o2exchange/sdk` does not load or require CCXT. Only the
`@o2exchange/sdk/ccxt` entry point requires it.

> **Alpha notice:** validate order behavior with small amounts on testnet before
> using this adapter with production funds. Method coverage and types may change
> in response to integrator feedback.

## Setup

Public market-data methods work immediately. Account setup and session creation
are explicit O2 extensions because they require an on-chain owner signature;
the constructor never performs either operation.

```ts
import { O2CCXT } from "@o2exchange/sdk/ccxt";

const exchange = new O2CCXT({
  network: "testnet",
  privateKey: process.env.O2_PRIVATE_KEY!,
});

await exchange.setupAccount();
await exchange.createSession(["fFUEL/fUSDC"]);
await exchange.loadMarkets();

const book = await exchange.fetchOrderBook("fFUEL/fUSDC", 20);
console.log(book.bids[0], book.asks[0]);

const order = await exchange.createOrder(
  "fFUEL/fUSDC",
  "limit",
  "buy",
  50,
  0.02,
  { orderType: "PostOnly" },
);
console.log(order.id, order.status);

await exchange.close();
```

Production custody can inject an external signer and an existing client. A
restored session avoids creating a new session:

```ts
import { O2CCXT } from "@o2exchange/sdk/ccxt";
import { Network, O2Client } from "@o2exchange/sdk";

const client = new O2Client({
  network: Network.MAINNET,
  apiOptions: { maxRetries: 0 },
});
const exchange = new O2CCXT({ client, signer: externalSigner });
exchange.restoreSession(savedSession);
```

When injecting a client for trading, configure `apiOptions.maxRetries` as `0`.
An O2CCXT-created client does this automatically so an ambiguous private
submission is never blindly repeated.

## Alpha method coverage

| CCXT unified method | Status | O2 notes |
| --- | --- | --- |
| `loadMarkets`, `fetchMarkets` | Supported | Spot markets only |
| `fetchOrderBook`, `fetchL2OrderBook` | Supported | `params.precision` accepts O2 levels 1–18 |
| `fetchTrades` | Supported | Maximum 50 results from the O2 API |
| `fetchTicker` | Supported | Unsupported ticker fields are `null` |
| `fetchOHLCV` | Supported | `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, and `1d` |
| `fetchBalance` | Supported | Requires a trade account or active session |
| `createOrder` | Limit and bounded FOK market | Market orders require `params.maxPrice` and `params.minPrice` |
| `cancelOrder`, `cancelAllOrders` | Supported | `cancelOrder` requires `symbol`; cancel-all can span markets |
| `fetchOrder`, `fetchOrders` | Supported | `fetchOrder` requires `symbol`; `fetchOrders` can span markets |
| `fetchOpenOrders`, `fetchClosedOrders` | Supported | Omitted `symbol` queries all loaded markets |
| Unbounded market orders | Not supported | O2 requires explicit price protection |
| `fetchMyTrades` | Supported | Omitted `symbol` queries all loaded markets; self-trade side is `null` |
| CCXT Pro `watch*` methods | Not yet supported | Use native O2 `stream*` methods for now |
| `withdraw` | Supported | Uses the CCXT signature and requires the owner signer |
| Deposits and transfers | Not supported | Use native O2 account methods |

Check `exchange.has` at runtime rather than assuming a method is available:

```ts
if (exchange.has.fetchOpenOrders) {
  const orders = await exchange.fetchOpenOrders("fFUEL/fUSDC");
}
```

## O2-specific parameters

CCXT's final `params` object carries O2-specific options:

```ts
await exchange.createOrder("fFUEL/fUSDC", "limit", "sell", 25, 0.03, {
  orderType: "PostOnly", // Spot, FillOrKill, PostOnly, or an O2 typed order value
  settleFirst: true,     // settle filled proceeds before placing the order
});

await exchange.fetchOrderBook("fFUEL/fUSDC", 50, {
  precision: 1, // O2 depth aggregation level; 1 is the finest
});

await exchange.createOrder("fFUEL/fUSDC", "market", "sell", 25, undefined, {
  maxPrice: 0.031,
  minPrice: 0.029,
});
```

`fetchOHLCV` also accepts `params.until` as a Unix timestamp in milliseconds.
For market orders, `amount` is always the base-asset quantity. Both bounds are
required: O2 will not submit an unbounded market order through this adapter.
The adapter executes the order as an O2 `FillOrKill` at `maxPrice` for buys or
`minPrice` for sells. It either fills the complete amount within the bound or
fails definitively; it never leaves a residual market order resting.
If the optional CCXT `price` argument is supplied, it must fall between
`minPrice` and `maxPrice` and cannot bypass the configured protection.

O2 matching is asynchronous. The create response may initially have
`status: "open"`; poll `fetchOrder(order.id, symbol)` until it becomes closed or
canceled before treating the execution as final. Because the indexed native
order is an O2 FOK, a later fetch currently reports `type: "limit"` and
`timeInForce: "FOK"`. This create/fetch type difference is an alpha limitation.

## Compatibility details

- All network methods are asynchronous and return promises, matching CCXT's
  JavaScript/TypeScript API.
- Prices, amounts, balances, and order-book levels are returned as JavaScript
  numbers in human-readable units. The native SDK continues to use `bigint`
  internally for chain values.
- O2's public trade payload identifies the maker's side. The CCXT facade
  reverses it to expose the taker's trade direction.
- Account trades use the account-relative maker/taker direction. Self-trades
  return one trade with `side: null` and retain `trader_side: "both"` in `info`.
- Price-protected market orders are native FOK orders. Their create response is
  normalized as `type: "market"`, while subsequent indexed fetches expose the
  native `type: "limit"` and `timeInForce: "FOK"`.
- Missing upstream data is represented by `null`; the original parsed O2 model
  remains available in each result's `info` field.
- `fetchBalance` uses `total_unlocked` as `free` and `total_locked` as `used`.
  It does not add `trading_account_balance` to `total_unlocked`, which would
  double-count funds.
- `O2CCXT` is an `instanceof ccxt.Exchange` and can use inherited CCXT helpers.
  CCXT remains external to the SDK bundle and optional for users of the core SDK.

## Gotchas and known gaps

- This is an O2-maintained public alpha, not an upstream `ccxt.o2` exchange.
  The adapter has passed limit and bounded-market lifecycle and soak testing on
  O2 testnet, but it has not been certified by CCXT or production-canary tested
  on mainnet. Start with capped balances and independent risk limits.
- A CCXT `market` order is a price-protected native O2 FOK order, not an
  unbounded market order. Both `maxPrice` and `minPrice` are required;
  `maxPrice` protects a buy and `minPrice` protects a sell. The whole amount
  fills inside the bound or the order fails.
- Matching and API indexing are asynchronous. A successful create can initially
  appear open, and a created, filled, or canceled order may not be visible to a
  read immediately. Poll `fetchOrder(id, symbol)` with bounded backoff before
  deciding the final state. A temporary missing/stale read is not proof that a
  private submission failed.
- The immediate response for a bounded market order reports `type: "market"`;
  a later indexed fetch reports its native representation as `type: "limit"`
  with `timeInForce: "FOK"`.
- The adapter never retries a private submission. A timeout or lost response can
  leave the outcome unknown even if O2 accepted it. On
  `O2AmbiguousSubmission`, reconcile orders and the account nonce before taking
  another action; never blindly submit the same order again.
- Account setup and session creation are explicit. Restore a saved session when
  possible, and keep its expiry and permitted markets in mind. `createOrder`
  defaults `settleFirst` to `true`, which may add a settlement action and
  latency before order placement.
- Check a restored session's permitted contract IDs before submitting. Testnet
  currently reports some unauthorized-market actions only as a generic
  `FAILED_REQUIRE` revert, so the adapter must surface `ExchangeError` when O2
  provides no semantic session error to map more precisely.
- CCXT results use JavaScript `number`; native chain accounting uses scaled
  integers. Use CCXT precision helpers before submission, and use `info` or the
  native SDK when exact integer amounts are required for accounting.
- `since` and `limit` are accepted where CCXT expects them, but the adapter does
  not automatically paginate unlimited history. Trade requests are capped at
  50 results per market, and multi-market results are bounded snapshots.
- Complete ticker statistics, market fee schedules, and per-result fee data are
  not currently available. Unsupported normalized fields are `null`; do not use
  them as the sole source for fee or P&L accounting.
- `fetchOrder` and `cancelOrder` require `symbol`. Self-trades are returned once
  with `side: null`, with both-side information retained in `info`.
- CCXT Pro `watch*`, unified deposit, and unified transfer methods are not
  implemented. Use native O2 streams and account methods, and call `close()`
  when finished to release client resources.

## O2 extension methods

- `setupAccount()`
- `createSession(markets, expiryDays?)`
- `restoreSession(session)`
- `settleBalance(market)`
- `withdraw(code, amount, address, tag?, params?)`
- `batchActions(groups, collectOrders?, session?)`

These delegate to the native SDK and preserve O2 signing, session, encoding,
and nonce behavior.

The limit-order lifecycle and a bounded FOK market fill against controlled
liquidity have been verified through the adapter on O2 testnet.

## Error and retry guidance

The adapter exports official CCXT categories such as `AuthenticationError`,
`InsufficientFunds`, `InvalidOrder`, `BadSymbol`, `RateLimitExceeded`,
`OrderNotFound`, and `NetworkError` from `@o2exchange/sdk/ccxt`. They support
normal checks such as `error instanceof ccxt.ExchangeError` where that matches
CCXT's own error hierarchy.

`O2AmbiguousSubmission` means a private request may have been accepted but its
response was unavailable, or a create response contained a transaction ID but
no order. Do not resubmit immediately. Reconcile open/closed orders and refresh
the O2 account nonce first. The original error is retained in `originalError`.

## Native streaming during the alpha

Until CCXT Pro-style `watch*` methods are added, use the wrapped client:

```ts
const stream = await exchange.o2Client.streamDepth("fFUEL/fUSDC");
for await (const update of stream) {
  console.log(update);
}
```

Please report adapter feedback with the exact method, arguments, expected CCXT
shape, and the returned `info` payload.
