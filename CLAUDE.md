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

All three SDKs decode Fuel VM revert codes into human-readable error names.
Fuel's `require()` reverts with `0xffffffffffff0000 | ordinal_1_based`, and
the SDKs map the ordinal to a named enum variant (e.g.,
`OrderCreationError::InvalidHeapPrices`).

### Source of truth

The error enums are defined in the contract ABIs bundled in this repo under
`abi/mainnet/` (and `abi/testnet/`, which is identical). Each ABI JSON has a
`metadataTypes` array — entries with `"type": "enum some::path::SomeError"`
contain a `components` array listing the variant names in ordinal order.

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

All three must have identical enum lists:

- `sdks/python/src/o2_sdk/onchain_revert.py` → `ABI_ERROR_ENUMS`
- `sdks/typescript/src/onchain-revert.ts` → `ABI_ERROR_ENUMS`
- `sdks/rust/src/onchain_revert.rs` → `ABI_ERROR_ENUMS`

### How ordinals work

Variants are **1-based** in declaration order. New variants appended at the
end get the next ordinal. Reordering or removing existing variants changes
all subsequent ordinals — this is a breaking change on the contract side.

### How to update after a contract upgrade

1. Get the new ABI JSON (from the contract build or the backend team)
2. Copy it to `abi/mainnet/` and `abi/testnet/`
3. Find the changed enum in `metadataTypes` — the `components` array has the variant names in order
4. Append new variants to the SDK's `ABI_ERROR_ENUMS` list in all three files
5. Run tests: `just test` or per-SDK test commands

### Fallback behavior

- **Unknown ordinal** (new variant not yet in SDK): `"unknown ABI error ordinal=N (raw=0x...)"`
- **No `Revert(DIGITS)` pattern found**: Raw reason truncated to 200 chars
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

Bump types: `major` (breaking), `minor` (feature), `patch` (fix).

### CI enforcement

PRs that modify files under `sdks/` must include a `.changeset/*.md` file.
The `changeset` CI job checks this automatically. For changes that genuinely
don't need release notes (CI config, docs typos), create an empty changeset
with no package entries.

### Release flow (automated via GitHub Actions)

Releases are fully automated with a human approval gate:

1. **Changesets accumulate** — as PRs merge to `main`, their `.changeset/*.md` files collect
2. **Release PR is created/updated** — `prepare-release.yml` runs on every push to `main`.
   If pending changesets exist, knope creates (or force-updates) a single PR from branch
   `release` → `main` with version bumps and changelog entries in the diff
3. **Maintainer reviews and merges** — the PR diff shows exactly what versions will bump
   and what changelog entries will be added. Merge when ready to ship.
4. **Tags + GitHub Releases created** — `release.yml` detects the merged release PR and
   runs `knope release`, which creates GitHub Releases (one per changed package).
   This creates tags like `sdk-python/v0.2.0` on the remote.
5. **Packages published** — the tags trigger the publish jobs in `release.yml`,
   which publish to PyPI / npm / crates.io via OIDC.

```bash
just release-dry-run    # preview what would ship (local, read-only)
```

### Config

- `knope.toml` — package definitions, workflows, scopes, GitHub repo
- `.changeset/` — pending changeset files (consumed on release)
- `sdks/{python,typescript,rust}/CHANGELOG.md` — generated changelogs (never edit by hand)
- `.github/workflows/prepare-release.yml` — creates/updates the release PR
- `.github/workflows/release.yml` — creates GitHub Releases + publishes packages

### GitHub token

The `prepare-release` and `release` workflows require a `PAT` secret (personal
access token or fine-grained token) with `contents: write` and
`pull-requests: write` permissions. The default `GITHUB_TOKEN` cannot trigger
downstream workflows (tag-push → publish), so a PAT is needed.

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
