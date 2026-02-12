//! Integration guides for the O2 Rust SDK.
//!
//! These guides cover common patterns and workflows for trading on the
//! O2 Exchange. Each sub-module contains a standalone guide rendered from
//! Markdown.
//!
//! # Available Guides
//!
//! | Guide | Description |
//! |-------|-------------|
//! | [`trading`] | Order types, cancel/replace, batch actions, and market maker patterns |
//! | [`market_data`] | Fetching depth, trades, candles, tickers, and balances |
//! | [`websocket_streams`] | Real-time data with [`TypedStream`](crate::TypedStream) and reconnection handling |
//! | [`error_handling`] | Error types, recovery patterns, and robust trading loops |
//! | [`external_signers`] | Integrating KMS/HSM via the [`SignableWallet`](crate::SignableWallet) trait |

#[doc = include_str!("../docs/guides/trading.md")]
pub mod trading {}

#[doc = include_str!("../docs/guides/market-data.md")]
pub mod market_data {}

#[doc = include_str!("../docs/guides/websocket-streams.md")]
pub mod websocket_streams {}

#[doc = include_str!("../docs/guides/error-handling.md")]
pub mod error_handling {}

#[doc = include_str!("../docs/guides/external-signers.md")]
pub mod external_signers {}
