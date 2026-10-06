# WebSocket Streams Guide

This guide covers real-time data streaming using the O2 TypeScript SDK.

The SDK provides WebSocket streaming through `AsyncGenerator` functions,
letting you consume real-time updates with `for await...of` loops.

All WebSocket messages are automatically parsed — `bigint` fields,
branded hex IDs, and `Side` normalization are applied before delivery.

## Order Book Depth

Stream real-time order book updates:

```ts
const stream = await client.streamDepth("fFUEL/fUSDC", 1);
for await (const update of stream) {
  const asks = update.view?.asks ?? update.changes?.asks ?? [];
  const bids = update.view?.bids ?? update.changes?.bids ?? [];

  // price and quantity are bigint
  if (bids.length > 0) console.log(`Best bid: ${bids[0].price}`);
  if (asks.length > 0) console.log(`Best ask: ${asks[0].price}`);
}
```

The first message received is a full snapshot (`action: "subscribe_depth"`).
Subsequent messages are incremental updates
(`action: "subscribe_depth_update"`).
When restarting a stream on the same connection, updates still queued from the
previous subscription are ignored until the new snapshot arrives.

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
const stream = await client.streamTrades("fFUEL/fUSDC");
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
  const stream = await client.streamDepth("fFUEL/fUSDC");
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

Breaking out of a loop or calling `await stream.return(undefined)` releases that
stream immediately, including when a `next()` call is waiting for a message.
Identical orders, trades, balances, and nonce subscriptions share one server
subscription; the last consumer to finish sends the unsubscribe request.
Explicit `unsubscribe*()` calls also end
the corresponding local streams and discard their buffered messages.

The server supports one orders subscription per venue, one balances or nonce
subscription per connection, and one depth or trades subscription per market
and venue. Spot and Turbo streams have independent ownership and routing.
Consumers of the same topic
must use identical parameters. Conflicting parameters reject the new stream;
unsubscribe the current topic before changing its identities or precision.

Depth allows only one consumer per market and venue on each connection. A second consumer
rejects on its first read, even with identical precision, because an active topic
cannot provide another initial snapshot. Use a separate `O2Client` or `O2WebSocket`
connection when independent depth consumers need their own starting snapshots.

If you wrap a stream inside another async generator with `yield*`, returning the
outer generator can still wait behind its pending read. Return the SDK stream
directly or call the matching `unsubscribe*()` to cancel it immediately.

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
- **pingIntervalMs** — Connection liveness check interval (default: `30000ms`)

Reconnection uses exponential backoff with jitter to avoid thundering herd
effects.

## Slow Consumers

Each data or lifecycle stream buffers at most **1024 unread messages** by default.
If it exceeds the limit, the SDK releases that stream's handlers, discards its
buffer, and throws `WebSocketBufferOverflowError` on its next read. Other
consumers keep running. Messages are not silently dropped from a live stream.
Re-sync your state from REST before subscribing again, especially when applying
incremental depth updates.

Configure the limit with `maxBufferedMessages` on `O2WebSocket`, or through the
high-level client:

```ts
import { O2Client, WebSocketBufferOverflowError } from "@o2exchange/sdk";

const client = new O2Client({
  webSocketOptions: { maxBufferedMessages: 256 },
});

try {
  const stream = await client.streamOrders(tradeAccountId);
  for await (const update of stream) {
    // Process each update promptly.
  }
} catch (error) {
  if (!(error instanceof WebSocketBufferOverflowError)) throw error;
  // Re-fetch current orders, then start a new stream.
}
```

The limit must be a positive safe integer. It bounds the number of queued
messages, rather than their total bytes; memory use also depends on payload size
and the number of active consumers.

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
