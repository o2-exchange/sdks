---
sdk-typescript: major
---

Add Turbo (margin) trading at `client.turbo`. `long()` and `short()` compose the sweep, the funding leg and the order into one signed atomic batch — a buy draws quote against the credit line, a sell borrows the asset in kind — so callers never handle draw/borrow/repay themselves. Also covers the account lifecycle (`open`, `addMargin`, `extend`, `closePosition`, `repayDrawn`, `closeAccount`), reads (`snapshot`, `positions`, `limits`, `maxSell`), and the referral programme (`turbo.referral`). `createSession(wallet, markets, { turbo: true })` scopes the session to the margin pool and the caller's margin accounts, including ones not yet opened — the scope is signed and cannot be widened afterwards.
