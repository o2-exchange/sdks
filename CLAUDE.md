# O2 SDKs - Development Guide

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

### Remaining Issue: TraderNotWhiteListed

All three SDKs have the same intermittent `TraderNotWhiteListed` failure on trading tests:
- The whitelist API (`/analytics/v1/whitelist`) returns success
- But the on-chain state doesn't always reflect it in time for the next transaction
- This causes `test_order_placement` and `test_cross_account_fill` to fail

### What's Been Done

1. **Whitelist retry helpers** added to Python and Rust tests:
   - `_whitelist_with_retry` / `whitelist_with_retry`: Re-whitelists with 3s propagation delay
   - `_create_order_with_whitelist_retry` / `create_order_with_whitelist_retry`: Catches `TraderNotWhiteListed`, re-whitelists, retries
   - Both trading tests call re-whitelist at the start

2. **TypeScript** does NOT yet have whitelist retry (it was passing before this issue appeared)

3. **Cross-account fill tests** simplified across all SDKs:
   - Use market-data pricing (`best_ask * 1.1`) via `get_market_prices` helper
   - Use 90% of taker's quote balance for taker quantity (no intermediate volume estimation)
   - Don't assert maker order is closed/filled (too strict for shared testnet)

### Non-trading tests: All passing across all SDKs
- Market data (get_markets, get_depth, get_trades, get_market_by_pair)
- Account flow (create_account, setup_account_idempotent)
- Session creation
- Nonce fetch, balance check
- WebSocket depth streaming

### What Needs to Be Done

1. **Fix the whitelist propagation issue**: The core problem is that re-whitelisting + 3s delay isn't enough. Options:
   - Increase propagation delay (5s, 10s?)
   - Query the on-chain whitelist state before placing orders (if API supports it)
   - Add whitelist retry to TypeScript tests too
   - Move whitelist into `setup_account` with longer delay in the fixture setup

2. **Run tests ONE SDK at a time** — running all three simultaneously overwhelms the testnet whitelist service

3. **CI workflow** (`.github/workflows/integration.yml`) may need timeout increases
