---
sdk-typescript: major
sdk-python: major
---

Add the O2-maintained CCXT-compatible public alpha at `@o2exchange/sdk/ccxt` and `o2_sdk.ccxt`. The adapters extend the official TypeScript and asynchronous Python CCXT `Exchange` classes, provide normalized market data and private trading methods, map failures to official CCXT errors, and support testnet-verified limit and price-bounded market orders while keeping CCXT optional for each core SDK.
