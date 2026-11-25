---
sdk-python: minor
---

Add paper (Turbo Instant Pro) market support: `O2Api.get_markets(paper=True)`
lists only paper markets, `Market.paper` flags them, and
`O2Client(paper_markets=True)` resolves every market lookup, session, and order
against the paper catalog.
