//! O2 Exchange SDK for Rust.
//!
//! A production-quality SDK for interacting with the O2 Exchange,
//! a fully on-chain order book DEX on the Fuel Network.
//!
//! # What This SDK Provides
//!
//! - High-level workflow client: [`O2Client`]
//! - Typed REST API access: [`api::O2Api`]
//! - Typed WebSocket streams: [`TypedStream`]
//! - Strong domain models for markets, balances, orders, and sessions
//!
//! # Quick Start
//!
//! ```rust,no_run
//! use o2_sdk::{O2Client, Network};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), o2_sdk::O2Error> {
//!     let mut client = O2Client::new(Network::Testnet);
//!
//!     // Generate a wallet
//!     let wallet = client.generate_wallet()?;
//!
//!     // Setup account (idempotent)
//!     let _account = client.setup_account(&wallet).await?;
//!
//!     // Fetch markets
//!     let _markets = client.get_markets().await?;
//!
//!     Ok(())
//! }
//! ```
//!
//! # Recommended Workflow
//!
//! 1. Create an [`O2Client`] with the target [`Network`].
//! 2. Create or load a wallet.
//! 3. Run [`O2Client::setup_account`] once at startup.
//! 4. Create a signed trading session with [`O2Client::create_session`].
//! 5. Submit typed actions with [`O2Client::create_order`] / [`O2Client::batch_actions`].
//! 6. Stream updates with [`O2Client::stream_depth`] / [`O2Client::stream_orders`] / [`O2Client::stream_nonce`].
//!
//! # Common Tasks
//!
//! ## Wallet + Account Setup
//!
//! ```rust,no_run
//! use o2_sdk::{Network, O2Client};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), o2_sdk::O2Error> {
//!     let mut client = O2Client::new(Network::Testnet);
//!     let wallet = client.generate_wallet()?;
//!     let account = client.setup_account(&wallet).await?;
//!
//!     println!("trade account id: {:?}", account.trade_account_id);
//!     Ok(())
//! }
//! ```
//!
//! ## Market Discovery + Session Creation
//!
//! ```rust,no_run
//! use o2_sdk::{Network, O2Client};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), o2_sdk::O2Error> {
//!     let mut client = O2Client::new(Network::Testnet);
//!     let owner = client.generate_wallet()?;
//!     client.setup_account(&owner).await?;
//!
//!     let mut session = client.create_session(&owner, &["fuel/usdc"], std::time::Duration::from_secs(7 * 24 * 3600)).await?;
//!     println!("session nonce: {}", session.nonce);
//!     Ok(())
//! }
//! ```
//!
//! ## Place and Cancel Orders
//!
//! ```rust,no_run
//! use o2_sdk::{Network, O2Client, OrderType, Side};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), o2_sdk::O2Error> {
//!     let mut client = O2Client::new(Network::Testnet);
//!     let owner = client.generate_wallet()?;
//!     client.setup_account(&owner).await?;
//!
//!     let market = "fuel/usdc";
//!     let mut session = client.create_session(&owner, &[market], std::time::Duration::from_secs(7 * 24 * 3600)).await?;
//!     let market_info = client.get_market(market).await?;
//!     let price = market_info.price("100")?;
//!     let quantity = market_info.quantity("2")?;
//!
//!     let response = client
//!         .create_order(
//!             &mut session,
//!             market,
//!             Side::Buy,
//!             price,
//!             quantity,
//!             OrderType::Market,
//!             false,
//!             true,
//!         )
//!         .await?;
//!
//!     if let Some(order_id) = response
//!         .orders
//!         .as_ref()
//!         .and_then(|orders| orders.first())
//!         .map(|o| o.order_id.clone())
//!     {
//!         let _ = client.cancel_order(&mut session, &order_id, market).await?;
//!     }
//!     Ok(())
//! }
//! ```
//!
//! ## Balances and Nonce Management
//!
//! ```rust,no_run
//! use o2_sdk::{Network, O2Client};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), o2_sdk::O2Error> {
//!     let mut client = O2Client::new(Network::Testnet);
//!     let wallet = client.generate_wallet()?;
//!     let account = client.setup_account(&wallet).await?;
//!     let trade_account_id = account.trade_account_id.unwrap();
//!
//!     let balances = client.get_balances(&trade_account_id).await?;
//!     for (symbol, balance) in balances {
//!         println!("{symbol}: {}", balance.trading_account_balance);
//!     }
//!
//!     let nonce = client.get_nonce(trade_account_id.as_str()).await?;
//!     println!("nonce: {nonce}");
//!     Ok(())
//! }
//! ```
//!
//! # Logging
//!
//! This crate emits debug-level logs through the [`log`](https://docs.rs/log/) facade
//! for API and client calls. Configure any compatible logger in your binary, then set
//! `RUST_LOG=debug` to inspect request flow and setup behavior.
//!
//! Market metadata refresh can be configured via [`MetadataPolicy`] and
//! [`O2Client::set_metadata_policy`].
//!
//! # Errors
//!
//! All fallible operations return [`O2Error`]. Match specific variants for robust handling:
//!
//! - Preflight/API validation failures (`code`/`message` style errors)
//! - On-chain revert failures (`OnChainRevert`)
//! - Transport/serialization failures (`HttpError`, `JsonError`, etc.)
//!
//! See [`guides::error_handling`] for recovery patterns.
//!
//! # Guides
//!
//! The [`guides`] module contains integration guides covering common
//! workflows and patterns:
//!
//! - [`guides::trading`] — Order types, batch actions, and market maker patterns
//! - [`guides::market_data`] — Fetching depth, trades, candles, and balances
//! - [`guides::websocket_streams`] — Real-time data with `TypedStream`
//! - [`guides::error_handling`] — Error types and recovery patterns
//! - [`guides::external_signers`] — Integrating KMS/HSM via the `SignableWallet` trait
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
pub use client::{MetadataPolicy, O2Client};
pub use config::{Network, NetworkConfig};
pub use crypto::{EvmWallet, SignableWallet, Wallet};
pub use decimal::UnsignedDecimal;
pub use errors::O2Error;
pub use models::*;
pub use models::{
    Action, AssetId, MarketId, MarketSymbol, OrderId, OrderType, Side, TradeAccountId,
};
pub use websocket::{O2WebSocket, TypedStream, WsConfig};
