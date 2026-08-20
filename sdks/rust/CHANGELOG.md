# Changelog
## 0.3.0 (2026-08-20)

### Breaking Changes

- DepthUpdate.changes is DepthSnapshot for snapshots
and DepthChanges for incremental updates (both expose bids/asks).

* fix(rust)!: depth stream changes are signed deltas; add DepthBook

The incremental depth stream sends signed relative quantity changes,
not absolute level sizes; the previous u64 change type could not even
deserialize a negative decrement. DepthUpdate.changes now uses the new
DepthChange/DepthChanges types with i128 quantities, the view field
also accepts the subscribe_depth ack's orders key, and the new
DepthBook maintains a local book with the correct accumulate
semantics. The taker_bot example uses it.
- DepthUpdate.changes is Option<DepthChanges> (signed
i128 quantities) instead of Option<DepthSnapshot>.

* fix(typescript): depth stream changes are signed deltas; add DepthBook

The incremental depth stream sends signed relative quantity changes,
not absolute level sizes. DepthUpdate.changes now uses the new
DepthChange type and documents the contract, parseDepthUpdate reads
the subscribe_depth ack's orders key into view, and the new DepthBook
class maintains a local book with the correct accumulate semantics.
The taker-bot example uses it instead of misreading delta entries as
levels.

* chore: add changeset for the depth delta types

* test: pin the DepthBook removal boundary in all three SDKs

A mutation-testing pass on a downstream consumer of the same accumulate
logic showed the exact-boundary gap: no test held a level whose sum
lands on exactly one. Adds that case to the Python, Rust, and
TypeScript DepthBook tests.

* fix(python): make DepthBook.apply atomic per update

A malformed entry now raises before any mutation. Under relative delta
semantics a partially applied update silently corrupts the book, so the
whole update parses first and applies only if every entry is valid.

#### Type depth stream `changes` entries as signed relative deltas with the new

`DepthChange` type; snapshots keep absolute `DepthLevel` quantities. Add a
`DepthBook` helper to every SDK that applies both correctly (accumulate each
delta onto the resting quantity, remove the level when the sum reaches zero)
and update the taker-bot examples to use it. The Rust and TypeScript SDKs now
read the `subscribe_depth` ack's snapshot from its `orders` key, and the Rust
change type can deserialize the negative quantities the stream sends (the
previous `u64` could not represent them).

`DepthBook.apply` is atomic per update in Python: a malformed entry raises
before any mutation, so a book can never be half-applied.

Breaking for Python and Rust: `DepthUpdate.changes` is now
`DepthSnapshot | DepthChanges` in Python and `Option<DepthChanges>` (signed
`i128` quantities) in Rust.

### Fixes

- depth stream changes are signed deltas across all three SDKs (#73)

## 0.2.2 (2026-08-10)

### Fixes

- Stop requiring the retired whitelist during account setup. The whitelist system is retired on every o2 network, and the legacy analytics endpoint fails against markets that have no whitelist contract, which made testnet account setup fatal. Python and Rust now ship `whitelist_required=false` for testnet; TypeScript no longer calls the endpoint during setup. Custom configs can still opt back in where the mechanism exists.

## 0.2.1 (2026-08-04)

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
