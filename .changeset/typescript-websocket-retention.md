---
sdk-typescript: patch
---

Release abandoned WebSocket stream handlers and reconnect resources.

Breaking a stream or calling its `return()`/`throw()` now releases its handlers
and reconnect entry immediately, including when a read is waiting for a message.
Automatic unsubscribe runs only after the final active consumer of that topic
stops. Reconnect timers and pending opens are cancelled on disconnect, concurrent
opens share a connection, and stale socket events cannot affect its replacement.

Existing buffering, multiple-consumer admission, explicit unsubscribe behavior,
spot/Turbo routing, and the protected `pendingSubscriptions` request array are
preserved. Slow consumers still require an application-level buffering policy.
