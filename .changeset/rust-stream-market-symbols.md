---
sdk-rust: minor
---

`stream_depth` and `stream_trades` now accept a market symbol pair (e.g. `"FUEL/USDC"`) as well as a hex market ID, matching the REST methods and the Python/TypeScript SDKs. The markets cache now uses interior mutability, so `get_markets`, `get_market` and `get_market_by_id` take `&self`.
