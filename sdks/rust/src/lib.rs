/// O2 Exchange SDK for Rust.
///
/// A production-quality SDK for interacting with the O2 Exchange,
/// a fully on-chain order book DEX on the Fuel Network.
///
/// # Quick Start
///
/// ```rust,no_run
/// use o2_sdk::{O2Client, Network};
///
/// #[tokio::main]
/// async fn main() -> Result<(), o2_sdk::O2Error> {
///     let mut client = O2Client::new(Network::Testnet);
///
///     // Generate a wallet
///     let wallet = client.generate_wallet()?;
///
///     // Setup account (idempotent)
///     let account = client.setup_account(&wallet).await?;
///
///     // Fetch markets
///     let markets = client.get_markets().await?;
///
///     Ok(())
/// }
/// ```
///
/// # Guides
///
/// The [`guides`] module contains integration guides covering common
/// workflows and patterns:
///
/// - [`guides::trading`] — Order types, batch actions, and market maker patterns
/// - [`guides::market_data`] — Fetching depth, trades, candles, and balances
/// - [`guides::websocket_streams`] — Real-time data with `TypedStream`
/// - [`guides::error_handling`] — Error types and recovery patterns
/// - [`guides::external_signers`] — Integrating KMS/HSM via the `SignableWallet` trait
pub mod api;
pub mod client;
pub mod config;
pub mod crypto;
pub mod decimal;
pub mod encoding;
pub mod errors;
pub mod guides;
pub mod models;
pub mod websocket;

// Re-export primary types for convenience.
pub use client::O2Client;
pub use config::{Network, NetworkConfig};
pub use crypto::{EvmWallet, SignableWallet, Wallet};
pub use decimal::UnsignedDecimal;
pub use errors::O2Error;
pub use models::*;
pub use models::{
    Action, AssetId, MarketId, MarketSymbol, OrderId, OrderType, Side, TradeAccountId,
};
pub use websocket::{O2WebSocket, TypedStream, WsConfig};
