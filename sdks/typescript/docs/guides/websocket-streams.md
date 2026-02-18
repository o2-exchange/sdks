# WebSocket Streams Guide

This guide covers real-time data streaming using the O2 TypeScript SDK.

The SDK provides WebSocket streaming through `AsyncGenerator` functions,
letting you consume real-time updates with `for await...of` loops.

All WebSocket messages are automatically parsed — `bigint` fields,
branded hex IDs, and `Side` normalization are applied before delivery.

## Order Book Depth

Stream real-time order book updates:

```ts
const stream = await client.streamDepth("FUEL/USDC", 10);
for await (const update of stream) {
  const asks = update.view?.sells ?? update.changes?.sells ?? [];
  const bids = update.view?.buys ?? update.changes?.buys ?? [];

  // price and quantity are bigint
  if (bids.length > 0) console.log(`Best bid: ${bids[0].price}`);
  if (asks.length > 0) console.log(`Best ask: ${asks[0].price}`);
}
```

The first message received is a full snapshot (`action: "subscribe_depth"`).
Subsequent messages are incremental updates
(`action: "subscribe_depth_update"`).

## Order Updates

Stream order status changes for your trading account:

```ts
const stream = await client.streamOrders(tradeAccountId);
for await (const update of stream) {
  for (const order of update.orders) {
    console.log(
      `Order ${order.order_id}: ` +
      `${order.close ? "closed" : "open"}, ` +
      `filled ${order.quantity_fill ?? 0n}/${order.quantity}`  // bigint
    );
  }
}
```

## Trade Stream

Stream trades as they occur in a market:

```ts
const stream = await client.streamTrades("FUEL/USDC");
for await (const update of stream) {
  for (const trade of update.trades) {
    console.log(`${trade.side} ${trade.quantity} @ ${trade.price}`);  // bigint
  }
}
```

## Balance Updates

Stream balance changes for your trading account:

```ts
const stream = await client.streamBalances(tradeAccountId);
for await (const update of stream) {
  for (const entry of update.balance) {
    console.log(`Balance: ${entry.trading_account_balance}`);  // bigint
    console.log(`  Locked: ${entry.total_locked}`);
    console.log(`  Unlocked: ${entry.total_unlocked}`);
  }
}
```

## Nonce Updates

Stream nonce changes (useful for tracking transaction confirmations):

```ts
const stream = await client.streamNonce(tradeAccountId);
for await (const update of stream) {
  console.log(`Nonce updated: ${update.nonce} on ${update.contract_id}`);  // bigint
}
```

## Multiple Streams

You can run multiple streams concurrently using `Promise.all` or separate
async functions:

```ts
async function monitorDepth() {
  const stream = await client.streamDepth("FUEL/USDC");
  for await (const update of stream) {
    // Handle depth updates
  }
}

async function monitorOrders() {
  const stream = await client.streamOrders(tradeAccountId);
  for await (const update of stream) {
    // Handle order updates
  }
}

// Run both concurrently
await Promise.all([monitorDepth(), monitorOrders()]);
```

## Cleanup

When you are done streaming, disconnect the WebSocket:

```ts
client.disconnectWs();
// or close everything:
client.close();
```

The WebSocket will automatically attempt to reconnect if the connection
drops. This behavior is controlled by the `O2WebSocket` options:

- **reconnect** — Enable auto-reconnect (default: `true`)
- **maxReconnectAttempts** — Max reconnection attempts (default: `10`)
- **reconnectDelayMs** — Base delay between reconnects (default: `1000ms`)
- **pingIntervalMs** — Heartbeat interval (default: `30000ms`)

Reconnection uses exponential backoff with jitter to avoid thundering herd
effects.

## Direct WebSocket Access

For advanced use cases, you can create a standalone `O2WebSocket` instance:

```ts
import { O2WebSocket, TESTNET } from "@o2exchange/sdk";

const ws = new O2WebSocket({
  config: TESTNET,
  reconnect: true,
  maxReconnectAttempts: 5,
});

await ws.connect();

for await (const update of ws.streamDepth(market.market_id, "10")) {
  console.log(update);
}

ws.disconnect();
```
