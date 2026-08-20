---
sdk-python: major
sdk-rust: major
sdk-typescript: minor
---

Type depth stream `changes` entries as signed relative deltas with the new
`DepthChange` type; snapshots keep absolute `DepthLevel` quantities. Add a
`DepthBook` helper to every SDK that applies both correctly (accumulate each
delta onto the resting quantity, remove the level when the sum reaches zero)
and update the taker-bot examples to use it. The Rust and TypeScript SDKs now
read the `subscribe_depth` ack's snapshot from its `orders` key, and the Rust
change type can deserialize the negative quantities the stream sends (the
previous `u64` could not represent them).

`DepthBook.apply` is atomic per update in Python: a malformed entry raises
before any mutation, so a book can never be half-applied.

Breaking for Python and Rust: `DepthUpdate.changes` is now
`DepthSnapshot | DepthChanges` in Python and `Option<DepthChanges>` (signed
`i128` quantities) in Rust.
