# Changelog
## 0.3.1 (2026-08-07)

### Fixes

- stop retrying stale actions (#65)
- Stop automatically retrying `/v1/session/actions` after rate-limit or transport failures, and bound each action request with a configurable HTTP timeout. Callers now receive the failure immediately so they can reconcile current state and build fresh actions instead of submitting stale signed intent.

## 0.3.0 (2026-08-04)

### Breaking Changes

#### Parallel nonces for concurrent action submission

`create_session(nonce_strategy="parallel")` puts a session on the trade
account's sliding-window nonce track, so many actions can be in flight at once
with no serialization and no manual retry. `ensure_parallel_session()` is the
startup path: it opens the session, probes the account with a benign
`settle_balance`, and upgrades the account proxy if the parallel entry points
are missing.

Parallel capability cannot be read from the API. `sync_state` reports V3 for
every synced account, including legacy accounts whose parallel submissions
revert, so capability is established by probing with `probe_parallel_support()`
and classified with `is_selector_mismatch_revert()`. `TradeAccount` exposes
`sync_generation`, documented as the indexer signal it actually is rather than
anything to gate on.
`O2Error` now also carries `raw_reason`, the backend's untouched reason string.

Retries on the parallel track only cover rejections that prove the actions did
not execute. `nonce already used` is surfaced rather than retried, since it is
also what a submission that landed but lost its response looks like, and
`is_parallel_nonce_already_used()` identifies it. Resyncing the nonce window is
single-flight so two retries cannot draw the same slot.

An already-consumed nonce slot is reported two ways depending on whether the
indexer has caught up: the API rejects before submitting, or the contract
reverts with `ExtendedNonceError::AlreadyUsed`. `is_parallel_nonce_already_used`
covers both. `is_nonce_rejection` is the broad companion, true for any nonce
refusal at either layer, for callers deciding whether a failure implicates the
session rather than whether a submission may be retried.

### Features

- allow async signing paths for typescript SDK (#47)

#### Fix withdrawal functions and encoding

The withdrawal signing payload placed `asset_id` before `amount`, but the
contract verifies the signature over `(Identity, amount, AssetId)`, so every
SDK-signed withdrawal was rejected as an invalid owner signature. The payload
now matches the ABI argument order.

`withdraw` also accepts a contract destination rather than only an address:
`ContractIdentity` in Python, `Identity` in TypeScript, and any
`IntoWithdrawDestination` in Rust, where `Option<&str>` still resolves to an
address so existing call sites are unchanged.

### Fixes

- fix precision issues in quantities and prices (#46)
- fix withdrawal encoding (#60)
- Fix invalid quantity round-down mechanisms when creating orders

## 0.2.0 (2026-03-27)

### Breaking Changes

#### Breaking changes

- **Renamed `DepthSnapshot.buys`/`.sells` to `.bids`/`.asks`** (all SDKs).
  Search-and-replace `buys` → `bids` and `sells` → `asks` on any code
  accessing depth snapshots or WebSocket depth updates.
  Rust uses `#[serde(rename)]` so JSON deserialization is unaffected.

- **Changed `Trade.timestamp` type** — Python: `str` → `int`, TypeScript:
  `string` → `number`. Rust was already `u128` (unchanged). Remove any
  `int()` / `parseInt()` wrappers around timestamp access.

- **Depth precision is now a 1–18 index** instead of a raw wire value.
  `get_depth(precision=1)` and `stream_depth(precision=1)` both mean
  "most precise" (finest tick). Higher values bucket prices into larger
  groups. The SDK converts to the wire format internally.
  **Default changed from `10` to `1`** — if you were relying on the old
  default, pass `precision=2` to get equivalent grouping.

- **`get_orders` / `getOrders` parameter order changed** (all SDKs).
  Now `(market, account, ...)` instead of `(account, market, ...)` to
  match the market-first convention used by all other methods.

#### Features

- **`MarketRef` type alias (TypeScript)** — all client methods that accept
  a market parameter now use `MarketRef` (`string | MarketId | Market`)
  instead of bare `string | Market`, making signatures self-documenting.

- **`trader_side` field on Trade** — account-scoped trade queries
  (`get_trades(account=...)` / `get_account_trades()`) now include a
  `trader_side` field: `"maker"`, `"taker"`, or `"both"` (self-trade).
  Use this with `side` (the maker's order side) to determine your fill
  direction without tracking open orders.

- **On-chain revert decoding (TypeScript)** — ported from Python/Rust.
  `OnChainRevertError` now decodes Fuel VM revert codes into human-readable
  names (e.g. `"OrderCreationError::NotEnoughBalance"`) with context-aware
  enum inference. Accessible via `error.reason` on any on-chain revert.

- **Account-filtered trades** — new `get_trades(account=...)` parameter
  (Python) / `getTrades(market, count, account)` (TS) /
  `get_account_trades()` (Rust) fetches trades scoped to a specific
  trade account via `/v1/trades_by_account`.

- **Cursor-based pagination** on `get_trades` and `get_orders` — pass
  `cursor` to page through large result sets without offset drift.

- **Input validation at API boundaries** — hex IDs, market pairs, and
  precision values are validated before making network calls. Invalid
  inputs raise descriptive errors instead of producing opaque 400s.

- **`get_bars()` resolution validation** — invalid resolution strings
  are rejected client-side with the set of valid values listed in the
  error message.

- **WebSocket reliability** — auto-reconnect with configurable backoff,
  heartbeat/ping-pong, subscription replay on reconnect, and lifecycle
  event streams (`stream_lifecycle()`) for monitoring connection state.

#### Fixes

- **Python WebSocket shutdown: 10+ min → <0.2s** — async generators
  were blocked on `queue.get()` indefinitely. Fixed by racing queue
  reads against a close event, so `client.close()` returns immediately.

- **TypeScript `getBars()` returned raw API envelope** instead of
  `Bar[]` — callers got `{action, bars, market_id}` instead of the
  bars array. Now correctly extracts and returns `Bar[]`.

- **`stream_depth` was dead at `precision=1`** — the backend expects
  `10^level` on the wire, but SDKs were passing the raw user value.
  `precision=1` sent `1` → mapped to an unused broadcast channel.
  SDKs now convert `10^precision` at the client layer.

- **Lifecycle events delivered on disconnect (TypeScript, Rust)** —
  `streamLifecycle()` consumers now receive the terminal `"closed"`
  event before the generator exits. Previously, a synchronous race in
  `disconnect()` caused the event to be queued but never yielded.
  Rust reordered to emit the lifecycle event before closing data channels.

- **On-chain revert returns clean error name** instead of appending the
  decoded name to multi-KB receipt blobs. Undecodable raw reasons are
  truncated to 200 characters.

- **On-chain errors decoded from embedded receipts** — when the backend
  returns `receipts: null`, the SDKs now extract error info from the
  Rust Debug formatted receipts embedded in the reason string. Handles
  both `Revert { ra: ... }` (ABI errors) and `PanicInstruction { reason: ... }`
  (VM errors like `NotEnoughBalance`).

- **`Trade.timestamp` documented as milliseconds** — all three SDKs
  incorrectly documented the timestamp as microseconds.

### Features

- add security policy
- production hardening across all three SDKs (#26)

### Fixes

- include docs with typescript sdk publish
