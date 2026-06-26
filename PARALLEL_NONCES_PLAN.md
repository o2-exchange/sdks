# Parallel Nonces — Plan & Big Picture

Status: in progress (branch `feat/parallel-nonces`). Owner: MM team.

## Why

The o2-market-making bot's quoting loop is work-bound at multiple seconds because
every on-chain order op is a synchronous round-trip and they **serialize on a
single sequential nonce** (today: an external TS signing server that owns one
incrementing u64 nonce). Inner ("touch") levels therefore can't refresh
sub-second → adverse selection. The O2 contracts already support **parallel
nonces** (a sliding-window bitmap allowing ~1024 concurrent in-flight ops, and 5
independent lanes per account), but neither the Python SDK nor this bot use them.

This effort adds parallel-nonce support to the **official Python SDK** (`o2-sdk`),
then moves the bot onto the SDK and retires the TS signing server for order ops.

## On-chain mechanism (reference — already on fuel-o2 / fuel-o2-exports `main`)

- `ParallelNonce` packed into U256: `{nonce_session_id(u8 0..4), timestamp(unix s),
  word_position(u128), bitmap_position(u8 0..127)}`.
- Sliding window = 8 words × 128 bits = **1024 concurrent slots**. `use_parallel_nonce`
  validates: not expired, word in `[base, base+8)`, bit not already consumed; advances
  `base` by 4 once a nonce passes the window midpoint.
- **5 independent lanes** (`nonce_session_id` 0..4) per trade account.
- Requires trade account `implementation_version >= 3` ("generation 3").
- Reference client impl (Rust, production): `~/code/spread-creator-bot`
  `packages/bot/src/client/o2/parallel_nonce.rs` + `trading.rs`. Port its logic and
  its hard-won gotchas (below).

## Locked design decisions

1. **Two first-class nonce tracks**, selected by the caller — not "parallel with
   sequential fallback":
   - `SequentialNonceProvider` — today's behavior extracted verbatim (scalar nonce,
     `_nonce_cache`, `+1` on success, `refresh_nonce` on revert). Used by low-frequency
     clients (e.g. the rebalancer) and **the only track that can perform account
     upgrades** (can't use a parallel nonce on a pre-v3 account).
   - `ParallelNonceProvider` — the window-cursor manager.
   - Motivating topology: multiple trading bots share one key on different **parallel
     lanes** (bot=0, second bot=1), while the rebalancer runs **sequential** to avoid
     contention. Solves the known bot↔rebalancer shared-key nonce conflict.
2. **Transparent surface.** Parallel nonces are an invariant, not a per-call mode: the
   caller submits actions as freely/concurrently as it wants with **no nonce arg, no
   rollback, no manual retry**. The only knob is set once at session creation
   (`nonce_strategy`, `nonce_session_id`).
3. **Manager fully owns the nonce on v3** (replaces `session.nonce` / `_nonce_cache`).
   The scalar is kept only on the v2/sequential track for backward compatibility.
4. **TTL = 120s default**, configurable (matches the contract expiry check).

## Surface

- `create_session(..., nonce_strategy: "parallel" | "sequential" = ?, nonce_session_id: int = 0)`.
- `setup_account()` transparently upgrades to v3 over the **sequential** track when
  `implementation_version < 3`, then sessions may use parallel.
- `batch_actions(actions, ...)` — unchanged signature; track-agnostic internally:
  ```
  loop (bounded):
    nonce = provider.next_nonce()                 # fresh slot; thread-safe; no await
    sig   = raw_sign(key, provider.signing_bytes(nonce, calls))   # u64 or U256
    try submit(nonce=str(nonce)) -> return
    except err:
      if provider.recover(err):  continue         # seq: refetch+retry; par: resync-once / rotate / 429 backoff
      else: raise                                  # real errors (balance, bad order) surface
  ```
- New API client methods: `GET /v1/accounts/window`, `POST /v1/accounts/upgrade`,
  `implementation_version` probe. (All proven in use by spread-creator-bot; confirm exact
  request/response shapes against fuel-o2.)

## Concurrency model

- `provider.next_nonce()` is **synchronous + `threading.Lock`** (the consuming MM bot is
  multi-threaded via ThreadPoolExecutor *and* the SDK is asyncio).
- `resync_from_chain()` / session rotation are async with an **`asyncio.Lock` for
  single-flight** (concurrent failing tasks must not all resync/rotate).
- Each retry **burns a fresh slot** (no reuse). Resync **once** per request, then fatal.
  Bounded 429 retries with backoff.

## Gotchas to port (from spread-creator-bot)

- Partial slot arrays from `/v1/accounts/window` (fewer than 8 slots for new accounts) —
  bounds-check `effective_bitmap`, treat out-of-range as empty.
- `first_free_position` starts at the slot **strictly after the highest consumed bit**,
  not the first hole (a hole may belong to an earlier run whose later positions already
  landed → would mint already-used nonces).
- Distinguish **nonce** errors ("Nonce in the request…", "Parallel nonce is not usable",
  "word position out of sliding window") from **session** errors ("Invalid session
  address", "Expired session") — don't burn nonces resyncing on a session problem.

## Bot integration (o2-market-making, branch `feat/parallel-nonces`, stacked on the throttle PR)

Internalize the signing server as an **in-process async runtime** to avoid a
threads→async rewrite of the bot:
- One asyncio event loop in a dedicated thread hosts the SDK client (+ parallel manager
  + KMS `ExternalSigner`).
- Bot worker threads call an `InProcessO2Signer` **synchronously** (drop-in for the HTTP
  `WrappedO2SigningServer`), bridged via `asyncio.run_coroutine_threadsafe(...).result()`.
- The bot's existing ThreadPoolExecutor fan-out now runs N submissions **concurrently
  with distinct parallel nonces** → loop time collapses from sum-of-serial to
  max-of-concurrent. `o2.py` order code barely changes.
- Lanes: bot=`session_id=0`, rebalancer=`sequential`.

## gitops (fuel-deployment-v2)

Move KMS sign permission from the signing-server service account to the MM-bot service
account; deploy to devnet, validate concurrency + loop-latency drop, then mainnet; retire
the TS signing server for order ops.

## Build order (this branch first)

1. Extract `NonceProvider` protocol + `SequentialNonceProvider` (pure refactor, no
   behavior change).  ← starting here
2. `ParallelNonceManager` / `ParallelNonceProvider` core (cursor / window / first-free /
   resync) + ported unit tests (no network).  ← starting here
3. Parallel signing-bytes encoding (U256 + calls) + API methods (window / upgrade /
   version probe).
4. Make `batch_actions` provider-agnostic; `create_session` strategy selection;
   `setup_account` auto-upgrade over sequential.
5. Devnet integration test: N concurrent orders all land with unique nonces.
6. Bot: `InProcessO2Signer` async runtime + KMS + lanes.
7. gitops: KMS perms move; devnet→mainnet; retire signing server.

## Cross-repo reference map

| Need | Reference |
|------|-----------|
| Parallel-nonce client logic | `~/code/spread-creator-bot/packages/bot/src/client/o2/parallel_nonce.rs`, `trading.rs` |
| On-chain validation | `~/code/fuel-o2-exports` `contracts/libs/src/parallel_nonce.sw`, `contracts/schema/src/trade_account_par.sw` |
| API endpoints / payloads | `~/code/fuel-o2` `/v1/session/actions`, `/v1/accounts/window`, `/v1/accounts/upgrade` |
| Existing SDK signing/crypto | `sdks/python/src/o2_sdk/{client.py,crypto.py,encoding.py,models.py}` |
| TS session-signing reference | `sdks/typescript/src/{client.ts,crypto.ts}` |
