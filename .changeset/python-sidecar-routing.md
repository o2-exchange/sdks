---
sdk-python: major
---

Add direct Turbo sidecar discovery, session authorization, trading, market data,
and streams to the Python SDK.

Supplied trading markets must match both the market ID and contract ID in the
selected venue's catalog. Orders now use the catalog's precision and order
limits. Refresh stored market objects when their contract changes.
