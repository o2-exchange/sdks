---
sdk-python: minor
---

Add automatic and explicit sequential/parallel nonce selection to withdrawals,
including typed SRC-16/EIP-712 owner signatures for `par_withdraw`. Expand the
`Signer` protocol with raw-digest signing; sequential-only custom signers may
raise `NotImplementedError` from that method.
