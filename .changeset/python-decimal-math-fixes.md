---
sdk-python: major
---

**Python SDK math fixes.** `Market.format_price` / `Market.format_quantity` now
return `decimal.Decimal` instead of `float`, preserving the full chain-side
precision (the previous float conversion silently rounded for high-decimal
markets or large balances). Cast with `float(...)` at the call site if a Python
float is required. `Market.adjust_quantity` now uses exact integer ceiling
division instead of `math.ceil(remainder / price)`, eliminating a precision loss
that could shift the adjusted quantity by one base-unit when `remainder` or
`price` exceed the float53 mantissa.
