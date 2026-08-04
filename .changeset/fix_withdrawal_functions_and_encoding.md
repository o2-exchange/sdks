---
sdk-typescript: minor
sdk-python: minor
sdk-rust: minor
---

# Fix withdrawal functions and encoding

The withdrawal signing payload placed `asset_id` before `amount`, but the
contract verifies the signature over `(Identity, amount, AssetId)`, so every
SDK-signed withdrawal was rejected as an invalid owner signature. The payload
now matches the ABI argument order.

`withdraw` also accepts a contract destination rather than only an address:
`ContractIdentity` in Python, `Identity` in TypeScript, and any
`IntoWithdrawDestination` in Rust, where `Option<&str>` still resolves to an
address so existing call sites are unchanged.
