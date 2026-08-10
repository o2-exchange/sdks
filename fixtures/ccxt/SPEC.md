# O2 CCXT Compatibility Specification (Alpha)

This specification is shared by the TypeScript and async Python adapters. The
adapters are O2-maintained and are not distributed as official CCXT exchanges.
They extend the official CCXT Exchange classes through optional dependencies,
so importing the core O2 SDK does not require CCXT.

## General rules

- Network methods use the exact CCXT-style positional signatures, including
  optional `symbol`, `since`, `limit`, `reload`, and `params` arguments.
- Timestamps are Unix milliseconds. Missing values are `null`.
- Human-readable prices, quantities, balances, and costs are JSON numbers.
- The parsed native O2 value is retained in `info`.
- Chain integers in shared fixtures are decimal strings.
- Unsupported values are `null`; fields are not silently invented.
- Limit and price-bounded market order creation are supported during alpha.
- Neither adapter retries ambiguous private submissions.

## Trade side

- Public O2 trades report the maker order side. CCXT public trade direction is
  normalized to the opposite, taker side.
- For account trades with `trader_side: "maker"`, account side equals O2 side.
- For account trades with `trader_side: "taker"`, account side is opposite O2
  side.
- For `trader_side: "both"`, normalized `side` is `null`. Emit one trade only
  and preserve the raw role information in `info`.

## Balances

- `total_unlocked` becomes `free`.
- `total_locked` becomes `used`.
- `free + used` becomes `total`.
- `trading_account_balance` is already included in `total_unlocked` and must not
  be added again.

## Errors

Adapters use official CCXT error classes. Errors are compatible with
`instanceof ccxt.ExchangeError` and Python
`isinstance(error, ccxt.ExchangeError)` when the CCXT dependency is installed.

An accepted private request whose response is missing or lost raises
`O2AmbiguousSubmission`. The adapter must not retry it. Callers must reconcile
orders and account nonce before resubmitting.
