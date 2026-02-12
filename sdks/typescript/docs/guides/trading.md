# Trading Guide

This guide covers common trading patterns using the O2 TypeScript SDK.

> For complete method signatures, see the {@link O2Client} API reference.

## Order Types

The O2 Exchange supports six order types, specified via the `orderType`
parameter of {@link O2Client.createOrder}.

### Spot (default)

A standard limit order that rests on the book if not immediately filled.

```ts
await client.createOrder(session, "fFUEL/fUSDC", "Buy", 0.02, 100.0);
```

### PostOnly

Guaranteed to be a maker order. Rejected immediately if it would cross
the spread and match an existing order.

```ts
await client.createOrder(
  session, "fFUEL/fUSDC", "Buy", 0.02, 100.0,
  "PostOnly",
);
```

### Market

Executes immediately at the best available price. Fails if the order
book is empty.

```ts
await client.createOrder(
  session, "fFUEL/fUSDC", "Buy", 0.03, 100.0,
  "Market",
);
```

### FillOrKill

Must be filled entirely in a single match, or the entire order is
rejected.

```ts
await client.createOrder(
  session, "fFUEL/fUSDC", "Buy", 0.03, 100.0,
  "FillOrKill",
);
```

### Limit

Like Spot, but includes a limit price and timestamp for time-in-force
semantics:

```ts
await client.createOrder(
  session, "fFUEL/fUSDC", "Buy", 0.02, 100.0,
  { Limit: ["25000000", String(Math.floor(Date.now() / 1000))] },
);
```

### BoundedMarket

A market order with price bounds — executes at market price but only
within the specified range:

```ts
await client.createOrder(
  session, "fFUEL/fUSDC", "Buy", 0.025, 100.0,
  { BoundedMarket: { max_price: "30000000", min_price: "10000000" } },
);
```

## Cancel and Replace

Cancel an existing order:

```ts
// Cancel by order ID
await client.cancelOrder(session, "0xabc...", "fFUEL/fUSDC");

// Cancel all open orders
await client.cancelAllOrders(session, "fFUEL/fUSDC");
```

To atomically cancel-and-replace in a single transaction, use
{@link O2Client.batchActions} with raw action payloads:

```ts
import type { ActionPayload, Market } from "@o2exchange/sdk";

const market: Market = await client.getMarket("fFUEL/fUSDC");

const actions: ActionPayload[] = [
  { CancelOrder: { order_id: oldOrderId } },
  { SettleBalance: { to: { ContractId: session.tradeAccountId } } },
  {
    CreateOrder: {
      side: "Buy",
      price: newPrice,
      quantity: newQty,
      order_type: "Spot",
    },
  },
];

const { response } = await client.batchActions(
  session,
  [{ market_id: market.market_id, actions }],
  market,
  marketsResponse.accounts_registry_id,
  true, // collectOrders
);
```

> **Important:** When using {@link O2Client.batchActions}, prices and
> quantities must be **pre-scaled chain integer strings**. Use
> {@link scalePriceForMarket} and {@link scaleQuantityForMarket} to convert
> from human-readable values.

## Settling Balances

When your orders are filled, the proceeds remain locked in the order book
contract until they are settled back to your trading account.

{@link O2Client.createOrder} handles this automatically when `settleFirst`
is `true` (the default). You can also settle manually:

```ts
await client.settleBalance(session, "fFUEL/fUSDC");
```

## Market Maker Pattern

A simple two-sided quoting loop using batch actions:

```ts
import { O2Client, Network } from "@o2exchange/sdk";
import type { ActionPayload } from "@o2exchange/sdk";

const client = new O2Client({ network: Network.TESTNET });
// ... setup wallet, account, session ...

const market = await client.getMarket("fFUEL/fUSDC");
const marketsResponse = await client.api.getMarkets();
let buyId: string | null = null;
let sellId: string | null = null;

while (true) {
  const actions: ActionPayload[] = [];

  // Cancel previous orders
  if (buyId) actions.push({ CancelOrder: { order_id: buyId } });
  if (sellId) actions.push({ CancelOrder: { order_id: sellId } });

  // Settle and place new orders
  actions.push({ SettleBalance: { to: { ContractId: session.tradeAccountId } } });
  actions.push({
    CreateOrder: { side: "Buy", price: buyPrice, quantity: qty, order_type: "PostOnly" },
  });
  actions.push({
    CreateOrder: { side: "Sell", price: sellPrice, quantity: qty, order_type: "PostOnly" },
  });

  const { response, session: s } = await client.batchActions(
    session,
    [{ market_id: market.market_id, actions }],
    market,
    marketsResponse.accounts_registry_id,
    true,
  );
  session = s;

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
const order = await client.getOrder("fFUEL/fUSDC", "0xabc...");
console.log(`Closed: ${order.close}`);
console.log(`Filled: ${order.quantity_fill} / ${order.quantity}`);
```

For real-time order updates, use {@link O2Client.streamOrders}:

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
const result = await client.withdraw(
  wallet,
  tradeAccountId,
  assetId,
  "1000000000", // amount in chain integer string
);
console.log(`Withdrawal tx: ${result.tx_id}`);
```

> **Note:** Withdrawals require the **owner wallet** (not the session key)
> and use `personalSign`.

## Nonce Management

The SDK automatically manages nonces during trading. If you encounter nonce
errors after a failed transaction, refresh the nonce:

```ts
await client.refreshNonce(session);
```

You can also fetch the current nonce directly:

```ts
const nonce = await client.getNonce(tradeAccountId);
```
