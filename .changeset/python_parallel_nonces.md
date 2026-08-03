---
sdk-python: major
---

# Parallel nonces for concurrent action submission

`create_session(nonce_strategy="parallel")` puts a session on the trade
account's sliding-window nonce track, so many actions can be in flight at once
with no serialization and no manual retry. `ensure_parallel_session()` is the
startup path: it opens the session, probes the account with a benign
`settle_balance`, and upgrades the account proxy if the parallel entry points
are missing.

Parallel capability cannot be read from the API. `sync_state` reports V3 for
every synced account, including legacy accounts whose parallel submissions
revert, so `AccountInfo.version` and `AccountInfo.is_parallel_capable` are gone,
replaced by `sync_generation` documented as the indexer signal it actually is.
Use `probe_parallel_support()` or `is_selector_mismatch_revert()` instead.
`O2Error` now also carries `raw_reason`, the backend's untouched reason string.
