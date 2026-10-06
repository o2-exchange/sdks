---
sdk-typescript: minor
---

Add Turbo 3.0 support for trading, market data, and real-time updates, including
TP/SL, cancellation, and settlement. Existing calls keep their standard trading
defaults, and older deployments remain supported. Add perpetual-session support
and rolling 30-day trading volume reads.

Subclass compatibility: the protected `marketsCache`, `marketsCacheTime`, and
`marketsRefreshPromise` fields are replaced by a private catalog cache keyed by
venue. Subclasses should use the protected `fetchMarkets(selection)` method.
