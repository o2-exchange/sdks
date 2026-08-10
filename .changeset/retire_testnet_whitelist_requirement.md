---
sdk-python: patch
sdk-typescript: patch
sdk-rust: patch
---

Stop requiring the retired whitelist during account setup. The whitelist system is retired on every o2 network, and the legacy analytics endpoint fails against markets that have no whitelist contract, which made testnet account setup fatal. Python and Rust now ship `whitelist_required=false` for testnet; TypeScript no longer calls the endpoint during setup. Custom configs can still opt back in where the mechanism exists.
