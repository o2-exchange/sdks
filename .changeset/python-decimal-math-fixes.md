---
sdk-python: major
---

**Python SDK math fixes.** `Market.format_price` / `Market.format_quantity` now
return `decimal.Decimal` instead of `float`, preserving the full chain-side
precision (the previous float conversion silently rounded for high-decimal
markets or large balances). Cast with `float(...)` at the call site if a Python
float is required.

`Market.adjust_quantity` is rewritten to use the gcd-derived quantity period
(`base_factor / gcd(price, base_factor)`). The prior formula subtracted
`ceil(remainder / price)` from the requested quantity, which only restored the
FractionalPrice invariant when `price` divided the remainder — in the general
case the returned quantity still violated `(price * q) % base_factor == 0`.
The new implementation returns the largest multiple of the period not exceeding
the input, returning `0` when no positive valid quantity exists below the input
(caller must raise the request to at least one period). `price <= 0` now raises
`ValueError`.
