# Rust SDK DevEx/Ergonomics Review Tracker (Temp)

Status: Active
Scope: `sdks/rust`
Started: 2026-02-14

## Workflow Rules
- Work one finding at a time, in priority order.
- For each finding:
  - present implementation plan
  - confirm decisions/questions with user
  - only then implement code changes
  - run validation/tests
  - record outcome and follow-ups

## Findings Queue

| ID | Finding | Severity | Status | Decision Needed |
|---|---|---|---|---|
| 1 | `submit_actions` bypasses HTTP status/error handling | High | Implemented | No |
| 2 | Query params are not URL-encoded | High | Implemented | No |
| 3 | Numeric scaling path can panic/silently coerce | High | Implemented | No |
| 4 | Nonce parsing silently defaults to `0` | High | Implemented | No |
| 5 | `setup_account` swallows faucet/whitelist failures | Medium | Implemented | No |
| 6 | `get_balances` silently drops per-asset errors | Medium | Implemented | No |
| 7 | WebSocket unsubscribe semantics are coarse | Medium | Implemented | No |
| 8 | Output models overuse `Option<String>`/`Value` | Medium | Implemented | No |
| 9 | Optionality audit against backend API structs | High | Implemented | No |

## Item 1 Notes: `submit_actions` error-path typing

Problem summary:
- `submit_actions` currently parses body directly and does not branch on HTTP status first.
- This can misclassify failures (e.g. non-JSON 4xx/5xx become `JsonError`).

Current file:
- `sdks/rust/src/api.rs`

Questions pending:
- Should `submit_actions` use the same `parse_response` behavior as all other endpoints for transport/status handling?
- If body parse fails on non-success status, should the SDK return:
  - `HttpError("HTTP <status>: <body>")` (consistent with existing behavior), or
  - a richer structured error variant (would be a breaking surface change)?
- For successful status with malformed JSON, should we keep current detailed body snippet in `JsonError`?

Proposed default (if no preference):
- Keep error enum unchanged (non-breaking).
- Add explicit status handling before JSON extraction in `submit_actions`.
- Preserve special post-parse logic for preflight/on-chain errors once status is successful.

## Decision Log

| Date | Item | Decision | Rationale |
|---|---|---|---|
| 2026-02-14 | 1 | Minimal scope: `submit_actions` should use shared HTTP/status handling; add `#[non_exhaustive]` to `O2Error`; no new variants yet | Improves correctness with low churn; preserves clarity and future extensibility |
| 2026-02-14 | 2 | Migrate all GET endpoints in `api.rs` to explicit `.query(...)`; keep methods explicit (no helper); query ordering differences acceptable | Ensures proper URL encoding with readable per-endpoint intent |
| 2026-02-14 | 3 | Numeric conversion/precision issues should return errors; `scale_price` and `scale_quantity` should return `Result`; `adjust_quantity` should error on `price == 0` | Removes silent coercion and panic-prone behavior in order construction path |
| 2026-02-14 | 4 | Nonce parse should error if malformed; support JSON numeric/string and `0x` hex formats; missing nonce may default to `0`; use `ParseError` | Preserves compatibility with known server formats while eliminating silent malformed nonce fallback |
| 2026-02-14 | 5 | Prioritize integration-test stability: keep setup non-fatal, add retries/backoff, whitelist only on testnet, and log failures to stderr | Reduces flakiness without changing return type or blocking non-testnet flows |
| 2026-02-14 | 6 | `get_balances` should fail fast; keep existing return type | Avoid silent partial data and preserve API surface simplicity |
| 2026-02-14 | 7 | Keep websocket API unchanged; fix unsubscribe bookkeeping to remove only exact matching subscribe payloads | Prevents accidental removal of unrelated subscriptions while minimizing surface change |
| 2026-02-14 | 8 | Aggressive typing migration: align Rust outputs to strict reusable leaf types (`u64`, typed IDs, normalized `Side` enum), with `serde(default)` for resilience and format normalization during deserialization | Maximizes type-safety/devex while tolerating partial payload drift where explicitly allowed |
| 2026-02-14 | 9 | Re-audit optional fields directly against backend API code; remove unnecessary `Option` where backend guarantees field presence | Prevent silent shape drift in SDK and improve ergonomics by reducing `unwrap`/branching burden |

## Change Log

| Date | Item | Changes | Validation |
|---|---|---|---|
| 2026-02-14 | - | Tracker initialized | - |
| 2026-02-14 | 1 | Updated `submit_actions` to route through `parse_response` before action-specific parsing; added `#[non_exhaustive]` to `O2Error` | `cargo check`; `cargo test --tests --no-run` |
| 2026-02-14 | 2 | Replaced manual query-string interpolation with explicit `.query(...)` for all GET endpoints in `api.rs` | `cargo check`; `cargo test --tests --no-run` |
| 2026-02-14 | 3 | Hardened numeric path in `Market` and `OrderType` by returning `Result` instead of coercing to `0`; added explicit metadata/zero-price guards and propagated errors through encoding/tests | `cargo check`; `cargo test --tests --no-run` |
| 2026-02-14 | 4 | Added strict nonce parsing helpers in `client` (decimal + `0x` hex), wired `create_session` and `get_nonce` to error on malformed nonce, and normalized TradeAccount nonce deserialization to accept JSON numbers/strings | `cargo check`; `cargo test --tests --no-run` |
| 2026-02-14 | 5 | Added non-fatal retry helpers for faucet minting (cooldown-aware) and testnet-only whitelist attempts, with stderr logging on retries/final failure | `cargo check`; `cargo test --tests --no-run` |
| 2026-02-14 | 6 | Changed `get_balances` to fail fast on first per-asset balance fetch error and return contextual error details | `cargo check`; `cargo test --tests --no-run` |
| 2026-02-14 | 7 | Updated websocket unsubscribe bookkeeping (`orders`, `balances`, `nonce`) to remove only exact matching subscribe payloads | `cargo check`; `cargo test --tests --no-run` |
| 2026-02-14 | 8 | Refactored core HTTP/WS models from loose `Option<String>`/`Value` fields to stronger reusable typed IDs/enums/`u64` numerics; added side normalization and numeric deserialization support for string/number/0x-hex formats; updated client/examples/tests for new strict model contracts | `cargo check`; `cargo test --no-run`; `cargo test` |
| 2026-02-14 | 9 | Aligned optionality and shapes to backend source: de-optionalized required REST/WS fields, corrected `/v1/markets/summary` and `/v1/markets/ticker` to `Vec<_>`, corrected `/v1/bars` envelope parsing, and fixed aggregated endpoint models/surfaces (map/list/orderbook/trades/coingecko routes); updated client/example callsites accordingly | `cargo check`; `cargo test --tests --no-run`; `cargo test` |

## Item 9 Notes: Optionality audit against backend API

Backend references used:
- `packages/api/src/app/routes/v1/markets.rs`
- `packages/api/src/app/routes/v1/orders.rs`
- `packages/api/src/app/routes/v1/trades.rs`
- `packages/api/src/app/routes/v1/accounts.rs`
- `packages/api/src/app/routes/v1/coins.rs`
- `packages/api/src/domain/bars.rs`
- `packages/api/src/domain/depth.rs`
- `packages/api/src/websocket/v1/responses.rs`

Preliminary conclusions:
- Keep optional (backend is explicitly optional):
  - Account lookup result object fields (`GetAccountResponse.*`)
  - `onchain_timestamp` in WS responses
  - market summary/ticker high/low/last/bid/ask style fields
  - optional IDs configured by deployment (e.g. whitelist/blacklist IDs)
- Remove optional (backend always provides):
  - Most top-level core response identifiers and required numerics
  - `Order` core fields (`order_id`, `timestamp`, `market_id`, `owner`, `fills`, `history`)
  - `Trade` core fields for `/v1/trades`
  - `Balance` core fields for `/v1/balance`
  - WS action payload core fields (`action`, `seen_timestamp`, ids/nonce, arrays)

Open decisions for implementation:
- Whether aggregated endpoints should be strictly typed to backend current shapes (breaking, but user already approved breaking changes earlier).
