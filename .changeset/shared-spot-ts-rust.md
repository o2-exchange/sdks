---
sdk-typescript: minor
sdk-rust: major
---

Add shared Spot order support while keeping shared PostOnly as the default.

Rust clients with exhaustive matches must handle the new
`Action::CreateSharedSpotOrder` and `OrderTypeEncoding::TurboSharedSpot` variants.
