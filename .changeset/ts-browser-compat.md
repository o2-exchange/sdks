---
sdk-typescript: major
---

### Breaking changes

- **Minimum Node.js version raised to 22.4+** — the SDK now uses the
  native `WebSocket` API (`globalThis.WebSocket`) instead of the `ws`
  library. Node 22.4 is the first version with stable native WebSocket
  support. Node 22 has been in LTS since October 2024.

- **Removed `ws` dependency** — the SDK is now zero-dependency for
  WebSocket connectivity. If you were importing `ws` types, they are
  no longer needed.

### Features

- **Browser & Bun compatibility** — the SDK now works in browsers, Bun,
  Deno, and any runtime with a standard `WebSocket` API. No Node.js-
  specific APIs are used for WebSocket connectivity.

- **`webSocketFactory` option** — pass a custom WebSocket constructor
  via `O2WebSocketOptions.webSocketFactory` for testing or non-standard
  runtimes.

- **App-level PING/PONG heartbeat** — liveness detection now sends a
  `PING` text message (server responds `PONG`) instead of relying on
  protocol-level `ws.ping()`. Works identically across all runtimes.
