---
sdk-typescript: major
---

Bound WebSocket stream buffering and release abandoned subscriptions and reconnect resources.

Each stream now buffers at most 1024 unread messages by default. Overflow clears
its buffer and rejects the next read with the exported `WebSocketBufferOverflowError`;
resync from REST before subscribing again. Configure `maxBufferedMessages` directly
on `O2WebSocket` or through `O2Client.webSocketOptions`. Consumers accepting larger
memory use can raise the limit, including to `Number.MAX_SAFE_INTEGER` for effectively
unbounded buffering; the limit counts messages, not bytes.

**Behavior changes:** returning, throwing or breaking a stream removes its handlers
and reconnect state immediately, even with a pending read. The last consumer sends
unsubscribe. Explicit unsubscribe ends local consumers and discards their buffers.
Identical orders, trades, balances and nonce subscriptions share one server topic;
conflicting parameters reject on the first read. Depth allows one consumer per
market and venue per connection, so each accepted stream receives an initial snapshot; use
a separate connection for independent depth consumers. Market IDs are normalized
across routing and unsubscribe.
Fresh depth consumers also ignore queued stale deltas until their new snapshot
arrives, including when restarting with another precision on the same connection.

Disconnect marks the instance terminated until it connects again. A peer close
with reconnect disabled also ends streams and emits `closed`. Queued data still
drains on full disconnect. Concurrent initial connects share a promise, new streams
during recovery preserve the backoff cycle, and successful recovery emits
`reconnected` exactly once. Reconnect timers and pending opens are cancelled on
disconnect. `isReconnecting()` exposes automatic recovery state.

Subclass authors: the protected `pendingSubscriptions` field is now a Map of
ref-counted topic subscriptions, replacing the previous request array.
