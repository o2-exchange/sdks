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
pub mod api;
pub mod client;
pub mod config;
pub mod crypto;
pub mod decimal;
pub mod encoding;
pub mod errors;
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
