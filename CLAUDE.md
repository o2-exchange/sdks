# O2 SDKs - Development Guide

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
cd sdks/rust && cargo test -- --ignored --test-threads=1
```

## Integration Test Design Patterns

- **Book-independent tests**: All order book tests must tolerate empty books and concurrent test runs
- **PostOnly Buy**: Use minimum price step `10^(-max_precision)` — guaranteed below any ask
- **PostOnly Sell**: Use market-data pricing (`best_ask * 1.1`) or `safe_sell_price()` from balance alone
- **Cross-account fill**: Don't assert maker order is filled (other orders may consume taker funds first)
- **Two funded accounts**: Maker + taker needed for cross-account tests to avoid self-trade cancellation
- **Faucet cooldown**: 60-second cooldown; use retry loops with 65s sleep

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
