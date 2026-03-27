# O2 SDKs - Development Guide

This repository is published at `https://github.com/o2-exchange/sdks.git`.

## Build Orchestration

A `justfile` is provided for common tasks across all SDKs:

```bash
just check        # Full pre-push check (format + lint)
just fmt           # Format all SDKs
just lint          # Lint all SDKs
just test          # Run all unit tests
```

Per-SDK targets are also available: `just fmt-python`, `just lint-rust`, etc.

## Linting & Formatting

| SDK | Linter | Formatter | Type Checker |
|-----|--------|-----------|--------------|
| Python | ruff | ruff | mypy |
| TypeScript | biome | biome | tsc |
| Rust | clippy | rustfmt | — (compiler) |

### Python
```bash
cd sdks/python
ruff format src tests examples        # format
ruff check src tests examples          # lint
mypy src/o2_sdk                        # type check
```

### TypeScript
```bash
cd sdks/typescript
npx @biomejs/biome format --write src tests examples   # format
npx @biomejs/biome check src tests examples             # lint
npx tsc --noEmit                                        # type check
```

### Rust
```bash
cd sdks/rust
cargo fmt              # format
cargo clippy -- -D warnings   # lint
```

## Running Integration Tests

### Python SDK
```bash
python3 -m venv /tmp/o2-test-env && /tmp/o2-test-env/bin/pip install -e "sdks/python[dev]"
/tmp/o2-test-env/bin/pytest sdks/python/tests/test_integration.py -m integration -v --timeout=600
```
- `uv` is NOT available on this system
- pyproject.toml uses `asyncio_mode = "auto"` and `asyncio_default_fixture_loop_scope = "module"`

### TypeScript SDK
```bash
cd sdks/typescript && O2_INTEGRATION=1 npx vitest run tests/integration.test.ts
```

### Rust SDK
```bash
cd sdks/rust && cargo test --features integration --test integration_tests -- --test-threads=1
```

## Integration Test Design Patterns

- **Book-independent tests**: All order book tests must tolerate empty books and concurrent test runs
- **PostOnly Buy**: Use minimum price step `10^(-max_precision)` — guaranteed below any ask
- **PostOnly Sell**: Use market-data pricing (`best_ask * 1.1`) or `safe_sell_price()` from balance alone
- **Cross-account fill**: Don't assert maker order is filled (other orders may consume taker funds first)
- **Two funded accounts**: Maker + taker needed for cross-account tests to avoid self-trade cancellation
- **Faucet cooldown**: 60-second cooldown; use retry loops with 65s sleep

## Maintaining On-Chain Revert Decoding

All three SDKs decode on-chain revert errors into human-readable names like
`OrderCreationError::OrderPartiallyFilled`.

### How Fuel VM reverts work

Sway's `require()` and `revert_with_log()` do two things:
1. **LOG** the typed error value (a `LogData` receipt with the ABI-encoded enum)
2. **REVERT** with a fixed signal constant (NOT the variant ordinal)

Signal constants (`sway-lib-std/src/error_signals.sw`):
- `0xffffffffffff0000` — `FAILED_REQUIRE` (`require()` failed)
- `0xffffffffffff0006` — `REVERT_WITH_LOG` (`revert_with_log()` called)
- `0xffffffffffff0001` — `FAILED_TRANSFER_TO_ADDRESS`
- `0xffffffffffff0003..0005` — `FAILED_ASSERT_EQ/ASSERT/ASSERT_NE`

The revert code tells you the *type* of failure. The *specific* error variant
is in the LOG receipt that precedes the revert.

### How the SDKs decode errors

The backend wraps on-chain failures as `{code: 1000, reason: "..."}` where the
`reason` string contains the fuels-rs error chain with decoded logs and raw
receipts. The SDKs extract the error using a priority chain:

1. **LogResult extraction** — The backend's fuels-rs decoded the LOG receipt.
   The result appears as `Ok("VariantName")` in a `LogResult { results: [...] }`
   block. The last entry matching a known variant is the error.

2. **LogData receipt parsing** — The raw `LogData` receipt has `rb` (the ABI
   log-ID identifying the enum type) and `data` (first 8 bytes = 0-based
   variant discriminant). Match `rb` against the `loggedTypes` in the ABI.

3. **Signal recognition** — Identify the Fuel VM signal constant.
4. **PanicInstruction** — Extract `PanicInstruction { reason: Name }`.
5. **"and error:" summary** — Extract the backend's error summary.
6. **Truncation** — Cap long reasons at 200 chars.

### Source of truth

The error enums and their log-IDs come from `abi/mainnet/*.json` (identical
to testnet). Each ABI has a `loggedTypes` array mapping `logId` →
`concreteTypeId`, which identifies the enum type and its variant list.

| ABI file | Error enums |
|----------|-------------|
| `order-book-abi.json` | OrderCreationError, OrderCancelError, FeeError, OrderBookInitializationError |
| `trade-account-abi.json` | NonceError, SignerError, CallerError, SessionError, WithdrawError |
| `order-book-blacklist-abi.json` | BlacklistError |
| `order-book-whitelist-abi.json` | WhitelistError |
| `trade-account-registry-abi.json` | TradeAccountRegistryError |
| `order-book-registry-abi.json` | OrderBookRegistryError |
| `order-book-proxy-abi.json` | SetProxyOwnerError |

Standard library enums (PauseError, AccessError, InitializationError,
SignatureError) appear in multiple ABIs and rarely change.

### Files to keep in sync

All three must have identical `ABI_ERROR_ENUMS` mappings (logId → enum name → variants):

- `sdks/python/src/o2_sdk/onchain_revert.py` → `ABI_ERROR_ENUMS` dict
- `sdks/typescript/src/onchain-revert.ts` → `ABI_ERROR_ENUMS` Map
- `sdks/rust/src/onchain_revert.rs` → `ABI_ERROR_ENUMS` const array

### How to update after a contract upgrade

1. Get the new ABI JSON (from the contract build or the backend team)
2. Copy it to `abi/mainnet/` and `abi/testnet/`
3. In `loggedTypes`, find the new/changed error enum's `logId` and `concreteTypeId`
4. In `concreteTypes`/`metadataTypes`, find the variant `components` list
5. Update `ABI_ERROR_ENUMS` in all three SDK files with the new logId + variants
6. Run tests: `just test`

### Fallback behavior

- **No LogResult or LogData match**: Signal constant name returned (e.g., "REVERT_WITH_LOG")
- **Unknown logId** (new enum not yet in SDK): Falls through to signal recognition
- **Full receipts**: Always accessible via `.receipts` property on the error object

## Release Notes (knope)

Release notes use [knope](https://knope.tech) — a Rust-based CLI that manages
changelogs and version bumping from per-PR changeset files.

### Creating a changeset

When you change SDK code, create a changeset describing the change:

```bash
just changeset          # interactive prompt
# or
knope document-change   # same thing
```

This creates a `.changeset/<name>.md` file with YAML frontmatter specifying
which SDK(s) are affected and the bump type:

```markdown
---
sdk-python: minor
sdk-typescript: minor
---
Added `trader_side` field to Trade model.
```

Bump types: `major`, `minor`, `patch`. Note: while version is 0.x,
knope treats `major` as a minor bump (0.1.0 → 0.2.0) and `minor` as a
patch bump (0.1.0 → 0.1.1). Use `major` for breaking/feature releases
pre-1.0.

### CI enforcement

PRs that modify files under `sdks/` must include a `.changeset/*.md` file.
The `changeset` CI job checks this automatically. For changes that genuinely
don't need release notes (CI config, docs typos), create an empty changeset
with no package entries.

### Release flow

1. **Changesets accumulate** — as PRs merge to `main`, their `.changeset/*.md`
   files collect in the repo
2. **Release PR auto-created** — `prepare-release.yml` runs on every push to
   `main`. If pending changesets exist, knope creates (or force-updates) a PR
   from branch `release` → `main` with version bumps and changelog entries
3. **Maintainer reviews and merges** the release PR
4. **Maintainer manually triggers** the Release workflow:
   Actions → Release → "Run workflow" → select `main` branch
5. **All in one run**: `knope release` creates GitHub Releases + tags, then
   publish jobs run in the same workflow → PyPI / npm / crates.io via OIDC

```bash
knope prepare-release --dry-run --verbose  # preview version bumps + changelog
knope release --dry-run --verbose          # preview what tags/releases would be created
```

### Why release is a single workflow

`github.token` events can't trigger other workflows (GitHub's anti-recursion
guard). So we can't rely on tag-push to trigger separate publish jobs. Instead,
the Release workflow does everything in one run: `knope release` creates tags
and GitHub Releases, then the publish jobs run as dependent jobs (`needs:
create-releases`) in the same workflow.

### Config

- `knope.toml` — package definitions, workflows, scopes, GitHub repo
- `.changeset/` — pending changeset files (consumed on release)
- `sdks/{python,typescript,rust}/CHANGELOG.md` — generated changelogs (never edit by hand)
- `.github/workflows/prepare-release.yml` — creates/updates the release PR
- `.github/workflows/release.yml` — creates GitHub Releases + publishes packages

### Tag format

Knope uses `sdk-{language}/v{version}` tags (e.g., `sdk-python/v0.2.0`).
The v0.1.0 releases used a different format (`python-v0.1.0`) before knope
was adopted. Baseline tags in knope's format were created pointing to the
same commit so knope has a reference point.

## Current Status (as of 2026-02-11)

### All tests passing across all three SDKs

- **Python**: 12/12 tests passing
- **TypeScript**: 10/10 tests passing
- **Rust**: 14/14 tests passing

### Anti-fragility patterns implemented

1. **Whitelist retry helpers** in all three SDKs:
   - `whitelist_with_retry`: Re-whitelists with 10s on-chain propagation delay
   - `create_order_with_whitelist_retry`: Catches `TraderNotWhiteListed`, re-whitelists with backoff, retries up to 5 times
   - Explicit whitelist call during account setup (before minting)
   - Re-whitelist at the start of each trading test

2. **Cross-account fill** designed for busy/empty books:
   - Taker quantity capped at 3x maker quantity (prevents OutOfGas from too many intermediate fills)
   - Don't assert maker order is closed/filled (other orders may consume taker funds first)

3. **Run tests ONE SDK at a time** — running all three simultaneously overwhelms the testnet
