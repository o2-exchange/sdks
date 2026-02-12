/// Integration guides for the O2 Rust SDK.
///
/// These guides cover common patterns and workflows for trading on the
/// O2 Exchange. Each sub-module contains a standalone guide rendered from
/// Markdown.
///
/// # Available Guides
///
/// | Guide | Description |
/// |-------|-------------|
/// | [`trading`] | Order types, cancel/replace, batch actions, and market maker patterns |
/// | [`market_data`] | Fetching depth, trades, candles, tickers, and balances |
/// | [`websocket_streams`] | Real-time data with [`TypedStream`](crate::TypedStream) and reconnection handling |
/// | [`error_handling`] | Error types, recovery patterns, and robust trading loops |
/// | [`external_signers`] | Integrating KMS/HSM via the [`SignableWallet`](crate::SignableWallet) trait |

/// Order types, batch actions, cancel/replace, market maker patterns,
/// order monitoring, withdrawals, and nonce management.
#[doc = include_str!("../docs/guides/trading.md")]
pub mod trading {}

/// Listing markets, order book depth, recent trades, OHLCV candles,
/// ticker data, price conversion, balances, and low-level API access.
#[doc = include_str!("../docs/guides/market-data.md")]
pub mod market_data {}

/// Real-time depth, order, trade, balance, and nonce streams via
/// WebSocket with reconnection handling and configuration.
#[doc = include_str!("../docs/guides/websocket-streams.md")]
pub mod websocket_streams {}

/// Error variant reference, matching specific errors, on-chain reverts,
/// response-level error detection, nonce errors, and robust trading loops.
#[doc = include_str!("../docs/guides/error-handling.md")]
pub mod error_handling {}

/// Implementing the `SignableWallet` trait for external key management
/// systems (KMS/HSM) with Fuel-native and EVM signing support.
#[doc = include_str!("../docs/guides/external-signers.md")]
pub mod external_signers {}
