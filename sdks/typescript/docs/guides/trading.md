# Trading Guide

This guide covers common trading patterns using the O2 TypeScript SDK.

## Order Types

The O2 Exchange supports six order types, specified via the `orderType`
option of `O2Client.createOrder`.

### Spot (default)

A standard limit order that rests on the book if not immediately filled.

```ts
await client.createOrder("fFUEL/fUSDC", "Buy", "0.02", "100");
```

### PostOnly

Guaranteed to be a maker order. Rejected immediately if it would cross
the spread and match an existing order.

```ts
await client.createOrder("fFUEL/fUSDC", "Buy", "0.02", "100", { orderType: "PostOnly" });
```

### Market

Executes immediately at the best available price.

```ts
await client.createOrder("fFUEL/fUSDC", "Buy", "0.03", "100", { orderType: "Market" });
```

### FillOrKill

Must be filled entirely in a single match, or the entire order is rejected.

```ts
await client.createOrder("fFUEL/fUSDC", "Buy", "0.03", "100", { orderType: "FillOrKill" });
```

### Limit

Like Spot, but includes a limit price and timestamp for time-in-force semantics.
Use the `limitOrder()` helper:

```ts
import { limitOrder } from "@o2exchange/sdk";

await client.createOrder(
  "fFUEL/fUSDC", "Buy", "0.02", "100",
  { orderType: limitOrder("0.025", String(Math.floor(Date.now() / 1000))) },
);
```

### BoundedMarket

A market order with price bounds. Use the `boundedMarketOrder()` helper:

```ts
import { boundedMarketOrder } from "@o2exchange/sdk";

await client.createOrder(
  "fFUEL/fUSDC", "Buy", "0.025", "100",
  { orderType: boundedMarketOrder("0.03", "0.01") },
);
```

### CreateOrderOptions

Optional parameters are passed via a `CreateOrderOptions` object:

```ts
import type { CreateOrderOptions } from "@o2exchange/sdk";

const opts: CreateOrderOptions = {
  orderType: "PostOnly",    // default: "Spot"
  settleFirst: true,        // default: true
  collectOrders: true,      // default: true
};

await client.createOrder("fFUEL/fUSDC", "Buy", "0.02", "100", opts);
```

## Dual-Mode Numerics

Price and quantity parameters accept a `Numeric` type (`string | bigint`):

- **`string`** — Human-readable decimal (e.g., `"0.02"`, `"100.5"`). The SDK
  auto-scales to chain integers using precise string parsing (no float intermediary).
- **`bigint`** — Raw chain integer (e.g., `20000000n`). Passed through directly
  with no scaling.

```ts
// Human-readable strings (auto-scaled):
await client.createOrder("fFUEL/fUSDC", "Buy", "0.02", "100");

// Raw bigints (pass-through for power users):
await client.createOrder("fFUEL/fUSDC", "Buy", 20000000n, 100000000000n);

// Mix modes:
await client.createOrder("fFUEL/fUSDC", "Buy", "0.02", 100000000000n);
```

Values from API responses (e.g., `order.price`, `depth.sells[0].price`) are
`bigint` and pass through the bigint path automatically — no double-scaling.

## Cancel and Replace

Cancel an existing order:

```ts
await client.cancelOrder(orderId, "fFUEL/fUSDC");

// Cancel all open orders
await client.cancelAllOrders("fFUEL/fUSDC");
```

## Batch Actions

Use `batchActions` with the type-safe `Action` union for atomic
cancel+settle+replace patterns:

```ts
import {
  cancelOrderAction,
  createOrderAction,
  settleBalanceAction,
  type MarketActionGroup,
} from "@o2exchange/sdk";

const groups: MarketActionGroup[] = [
  {
    market: "fFUEL/fUSDC",
    actions: [
      cancelOrderAction(oldOrderId),
      settleBalanceAction(),
      createOrderAction("Buy", "0.02", "100", "PostOnly"),
      createOrderAction("Sell", "0.05", "50", "PostOnly"),
    ],
  },
];

const response = await client.batchActions(groups, true);
if (response.success) {
  console.log(`TX: ${response.txId}`);
}
```

Market resolution, price/quantity scaling, FractionalPrice adjustment,
min_order validation, and accounts registry lookup are all handled
internally — no manual scaling or registry lookups needed.

## Settling Balances

When your orders are filled, the proceeds remain locked in the order book
contract until they are settled back to your trading account.

`createOrder` handles this automatically when `settleFirst` is `true`
(the default). You can also settle manually:

```ts
await client.settleBalance("fFUEL/fUSDC");
```

## Market Maker Pattern

A simple two-sided quoting loop using batch actions:

```ts
import {
  O2Client, Network,
  cancelOrderAction, createOrderAction, settleBalanceAction,
  type MarketActionGroup, type OrderId,
} from "@o2exchange/sdk";

const client = new O2Client({ network: Network.TESTNET });
const wallet = O2Client.generateWallet();
await client.setupAccount(wallet);
await client.createSession(wallet, ["fFUEL/fUSDC"], 30);

let buyId: OrderId | null = null;
let sellId: OrderId | null = null;

while (true) {
  const actions = [];

  if (buyId) actions.push(cancelOrderAction(buyId));
  if (sellId) actions.push(cancelOrderAction(sellId));
  actions.push(settleBalanceAction());
  actions.push(createOrderAction("Buy", buyPrice, qty, "PostOnly"));
  actions.push(createOrderAction("Sell", sellPrice, qty, "PostOnly"));

  const response = await client.batchActions(
    [{ market: "fFUEL/fUSDC", actions }],
    true,
  );

  buyId = response.orders?.find((o) => o.side === "Buy")?.order_id ?? null;
  sellId = response.orders?.find((o) => o.side === "Sell")?.order_id ?? null;

  await new Promise((r) => setTimeout(r, 10_000));
}
```

## Order Monitoring

Query order status:

```ts
// All orders for an account
const orders = await client.getOrders(tradeAccountId, "fFUEL/fUSDC");

// Open orders only
const openOrders = await client.getOrders(tradeAccountId, "fFUEL/fUSDC", true);

// Single order by ID
const order = await client.getOrder("fFUEL/fUSDC", orderId);
console.log(`Closed: ${order.close}`);
console.log(`Filled: ${order.quantity_fill} / ${order.quantity}`); // bigint values
```

For real-time order updates, use `streamOrders`:

```ts
const stream = await client.streamOrders(tradeAccountId);
for await (const update of stream) {
  for (const order of update.orders) {
    console.log(`Order ${order.order_id}: ${order.close ? "closed" : "open"}`);
  }
}
```

## Withdrawals

Withdraw funds from the trading account to the owner wallet:

```ts
const result = await client.withdraw(wallet, "fUSDC", "100.0");
console.log(`Withdrawal tx: ${result.tx_id}`);
```

The asset accepts symbol names (`"fUSDC"`) or hex asset IDs. The amount
is `Numeric` — pass a human-readable string or raw `bigint`. The trade
account ID and destination are resolved from the wallet automatically.

> **Note:** Withdrawals require the **owner wallet** (not the session key).

## Nonce Management

The SDK automatically manages nonces during trading. If you encounter nonce
errors after a failed transaction, refresh the nonce:

```ts
await client.refreshNonce();
```

You can also fetch the current nonce directly:

```ts
const nonce = await client.getNonce(tradeAccountId);
```
