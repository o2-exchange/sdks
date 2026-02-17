/// High-level O2Client that orchestrates the full trading workflow.
///
/// This is the primary entry point for SDK users. It handles wallet management,
/// account lifecycle, session management, order placement, and WebSocket streaming.
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::debug;

use crate::api::O2Api;
use crate::config::{Network, NetworkConfig};
use crate::crypto::SignableWallet;
use crate::crypto::{
    generate_evm_keypair, generate_keypair, load_evm_wallet, load_wallet, parse_hex_32, raw_sign,
    to_hex_string, EvmWallet, Wallet,
};
use crate::encoding::{
    build_actions_signing_bytes, build_session_signing_bytes, build_withdraw_signing_bytes, CallArg,
};
use crate::errors::O2Error;
use crate::models::*;
use crate::websocket::TypedStream;

/// Strategy for refreshing market metadata.
#[derive(Debug, Clone, Copy)]
pub enum MetadataPolicy {
    /// Reuse cached metadata and refresh only when cache age exceeds `ttl`.
    OptimisticTtl(Duration),
    /// Always refresh metadata before reads that depend on market config.
    StrictFresh,
}

impl Default for MetadataPolicy {
    fn default() -> Self {
        Self::OptimisticTtl(Duration::from_secs(45))
    }
}

/// The high-level O2 Exchange client.
pub struct O2Client {
    pub api: O2Api,
    pub config: NetworkConfig,
    markets_cache: Option<MarketsResponse>,
    markets_cache_at: Option<Instant>,
    metadata_policy: MetadataPolicy,
    ws: tokio::sync::Mutex<Option<crate::websocket::O2WebSocket>>,
}

/// Builder for composing a batch of actions against a single market.
///
/// Construct via [`O2Client::actions_for`]. Builder methods are infallible and
/// defer validation errors until [`MarketActionsBuilder::build`].
#[derive(Debug)]
pub struct MarketActionsBuilder {
    market: Market,
    actions: Vec<Action>,
    first_error: Option<O2Error>,
}

impl MarketActionsBuilder {
    fn new(market: Market) -> Self {
        Self {
            market,
            actions: Vec::new(),
            first_error: None,
        }
    }

    fn record_error_once(&mut self, err: O2Error) {
        if self.first_error.is_none() {
            self.first_error = Some(err);
        }
    }

    /// Add a settle-balance action.
    pub fn settle_balance(mut self) -> Self {
        self.actions.push(Action::SettleBalance);
        self
    }

    /// Add a cancel-order action.
    pub fn cancel_order(mut self, order_id: impl Into<OrderId>) -> Self {
        self.actions.push(Action::CancelOrder {
            order_id: order_id.into(),
        });
        self
    }

    /// Add a create-order action.
    ///
    /// Accepts the same flexible price/quantity inputs as [`O2Client::create_order`]:
    /// typed wrappers, `UnsignedDecimal`, and decimal strings.
    pub fn create_order<P, Q>(
        mut self,
        side: Side,
        price: P,
        quantity: Q,
        order_type: OrderType,
    ) -> Self
    where
        P: TryInto<OrderPriceInput, Error = O2Error>,
        Q: TryInto<OrderQuantityInput, Error = O2Error>,
    {
        if self.first_error.is_some() {
            return self;
        }

        let price = match price.try_into() {
            Ok(OrderPriceInput::Unchecked(v)) => v,
            Ok(OrderPriceInput::Checked(v)) => match self.market.validate_price_binding(&v) {
                Ok(()) => v.value(),
                Err(e) => {
                    self.record_error_once(e);
                    return self;
                }
            },
            Err(e) => {
                self.record_error_once(e);
                return self;
            }
        };

        let quantity = match quantity.try_into() {
            Ok(OrderQuantityInput::Unchecked(v)) => v,
            Ok(OrderQuantityInput::Checked(v)) => match self.market.validate_quantity_binding(&v) {
                Ok(()) => v.value(),
                Err(e) => {
                    self.record_error_once(e);
                    return self;
                }
            },
            Err(e) => {
                self.record_error_once(e);
                return self;
            }
        };

        self.actions.push(Action::CreateOrder {
            side,
            price,
            quantity,
            order_type,
        });
        self
    }

    /// Finalize and return the action list.
    ///
    /// Returns the first validation/conversion error encountered while building.
    pub fn build(self) -> Result<Vec<Action>, O2Error> {
        if let Some(err) = self.first_error {
            Err(err)
        } else {
            Ok(self.actions)
        }
    }
}

impl O2Client {
    fn should_whitelist_account(&self) -> bool {
        self.config.whitelist_required
    }

    #[cfg(test)]
    fn parse_nonce_value(value: &str, context: &str) -> Result<u64, O2Error> {
        if let Some(hex) = value
            .strip_prefix("0x")
            .or_else(|| value.strip_prefix("0X"))
        {
            return u64::from_str_radix(hex, 16).map_err(|e| {
                O2Error::ParseError(format!("Invalid hex nonce in {context}: '{value}' ({e})"))
            });
        }

        value.parse::<u64>().map_err(|e| {
            O2Error::ParseError(format!(
                "Invalid decimal nonce in {context}: '{value}' ({e})"
            ))
        })
    }

    fn parse_account_nonce(raw_nonce: Option<u64>, _context: &str) -> Result<u64, O2Error> {
        match raw_nonce {
            Some(v) => Ok(v),
            None => Ok(0),
        }
    }

    async fn retry_whitelist_account(&self, trade_account_id: &str) -> bool {
        debug!("client.retry_whitelist_account trade_account_id={trade_account_id}");
        // Whitelist is network-gated, not hostname-gated.
        if !self.should_whitelist_account() {
            debug!("client.retry_whitelist_account skipped (non-testnet)");
            return true;
        }

        let delays_secs = [0u64, 2, 5];
        let mut last_error = String::new();

        for (idx, delay) in delays_secs.iter().enumerate() {
            if *delay > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(*delay)).await;
            }

            match self.api.whitelist_account(trade_account_id).await {
                Ok(_) => {
                    debug!(
                        "client.retry_whitelist_account success attempt={} trade_account_id={}",
                        idx + 1,
                        trade_account_id
                    );
                    return true;
                }
                Err(e) => {
                    last_error = e.to_string();
                    if idx < delays_secs.len() - 1 {
                        eprintln!(
                            "whitelist_account attempt {} failed for {}: {} (retrying)",
                            idx + 1,
                            trade_account_id,
                            last_error
                        );
                    }
                }
            }
        }

        eprintln!(
            "whitelist_account failed after {} attempts for {}: {}",
            delays_secs.len(),
            trade_account_id,
            last_error
        );
        false
    }

    async fn retry_mint_to_contract(&self, trade_account_id: &str) -> bool {
        debug!("client.retry_mint_to_contract trade_account_id={trade_account_id}");
        // Faucet currently exists only on non-mainnet configs.
        if self.config.faucet_url.is_none() {
            debug!("client.retry_mint_to_contract skipped (no faucet url)");
            return true;
        }

        // Attempt immediately, then retry with cooldown-aware waits.
        let attempts = 4usize;
        let mut last_error = String::new();

        for idx in 0..attempts {
            if idx > 0 {
                let lower = last_error.to_ascii_lowercase();
                let wait_secs = if lower.contains("cooldown")
                    || lower.contains("rate limit")
                    || lower.contains("too many")
                {
                    65
                } else {
                    5
                };
                tokio::time::sleep(std::time::Duration::from_secs(wait_secs)).await;
            }

            match self.api.mint_to_contract(trade_account_id).await {
                Ok(resp) if resp.error.is_none() => {
                    debug!(
                        "client.retry_mint_to_contract success attempt={} trade_account_id={}",
                        idx + 1,
                        trade_account_id
                    );
                    return true;
                }
                Ok(resp) => {
                    last_error = resp
                        .error
                        .unwrap_or_else(|| "faucet returned an unknown error".to_string());
                    if idx < attempts - 1 {
                        eprintln!(
                            "mint_to_contract attempt {} returned error for {}: {} (retrying)",
                            idx + 1,
                            trade_account_id,
                            last_error
                        );
                    }
                }
                Err(e) => {
                    last_error = e.to_string();
                    if idx < attempts - 1 {
                        eprintln!(
                            "mint_to_contract attempt {} failed for {}: {} (retrying)",
                            idx + 1,
                            trade_account_id,
                            last_error
                        );
                    }
                }
            }
        }

        eprintln!(
            "mint_to_contract failed after {} attempts for {}: {}",
            attempts, trade_account_id, last_error
        );
        false
    }

    async fn should_faucet_account(&mut self, trade_account_id: &str) -> bool {
        let account_id = TradeAccountId::from(trade_account_id.to_string());
        match self.get_balances(&account_id).await {
            Ok(balances) => {
                let has_non_zero_balance = balances.values().any(|balance| {
                    balance.trading_account_balance > 0
                        || balance.total_locked > 0
                        || balance.total_unlocked > 0
                });
                debug!(
                    "client.should_faucet_account trade_account_id={} assets={} has_non_zero_balance={}",
                    trade_account_id,
                    balances.len(),
                    has_non_zero_balance
                );
                !has_non_zero_balance
            }
            Err(e) => {
                debug!(
                    "client.should_faucet_account balance_check_failed trade_account_id={} error={} fallback_should_faucet=true",
                    trade_account_id, e
                );
                true
            }
        }
    }

    /// Create a new O2Client for the given network.
    pub fn new(network: Network) -> Self {
        let config = NetworkConfig::from_network(network);
        Self {
            api: O2Api::new(config.clone()),
            config,
            markets_cache: None,
            markets_cache_at: None,
            metadata_policy: MetadataPolicy::default(),
            ws: tokio::sync::Mutex::new(None),
        }
    }

    /// Create a new O2Client with a custom configuration.
    pub fn with_config(config: NetworkConfig) -> Self {
        Self {
            api: O2Api::new(config.clone()),
            config,
            markets_cache: None,
            markets_cache_at: None,
            metadata_policy: MetadataPolicy::default(),
            ws: tokio::sync::Mutex::new(None),
        }
    }

    /// Configure how market metadata should be refreshed.
    pub fn set_metadata_policy(&mut self, policy: MetadataPolicy) {
        self.metadata_policy = policy;
    }

    // -----------------------------------------------------------------------
    // Wallet Management
    // -----------------------------------------------------------------------

    /// Generate a new Fuel-native wallet.
    pub fn generate_wallet(&self) -> Result<Wallet, O2Error> {
        debug!("client.generate_wallet");
        generate_keypair()
    }

    /// Generate a new EVM-compatible wallet.
    pub fn generate_evm_wallet(&self) -> Result<EvmWallet, O2Error> {
        debug!("client.generate_evm_wallet");
        generate_evm_keypair()
    }

    /// Load a Fuel-native wallet from a private key hex string.
    pub fn load_wallet(&self, private_key_hex: &str) -> Result<Wallet, O2Error> {
        debug!("client.load_wallet");
        let key = parse_hex_32(private_key_hex)?;
        load_wallet(&key)
    }

    /// Load an EVM wallet from a private key hex string.
    pub fn load_evm_wallet(&self, private_key_hex: &str) -> Result<EvmWallet, O2Error> {
        debug!("client.load_evm_wallet");
        let key = parse_hex_32(private_key_hex)?;
        load_evm_wallet(&key)
    }

    // -----------------------------------------------------------------------
    // Market Resolution
    // -----------------------------------------------------------------------

    /// Fetch and cache markets.
    pub async fn fetch_markets(&mut self) -> Result<&MarketsResponse, O2Error> {
        debug!("client.fetch_markets");
        let resp = self.api.get_markets().await?;
        self.markets_cache = Some(resp);
        self.markets_cache_at = Some(Instant::now());
        Ok(self.markets_cache.as_ref().unwrap())
    }

    /// Get cached markets, fetching if needed.
    async fn ensure_markets(&mut self) -> Result<&MarketsResponse, O2Error> {
        if self.should_refresh_markets() {
            debug!("client.ensure_markets refreshing cache");
            self.fetch_markets().await?;
        }
        Ok(self.markets_cache.as_ref().unwrap())
    }

    fn should_refresh_markets(&self) -> bool {
        if self.markets_cache.is_none() {
            return true;
        }

        match self.metadata_policy {
            MetadataPolicy::StrictFresh => true,
            MetadataPolicy::OptimisticTtl(ttl) => match self.markets_cache_at {
                None => true,
                Some(fetched_at) => fetched_at.elapsed() >= ttl,
            },
        }
    }

    /// Get all markets.
    pub async fn get_markets(&mut self) -> Result<Vec<Market>, O2Error> {
        debug!("client.get_markets");
        let resp = self.ensure_markets().await?;
        Ok(resp.markets.clone())
    }

    /// Get a market by symbol pair (e.g., "FUEL/USDC").
    pub async fn get_market<M>(&mut self, symbol: M) -> Result<Market, O2Error>
    where
        M: IntoMarketSymbol,
    {
        let symbol = symbol.into_market_symbol()?;
        debug!("client.get_market symbol={symbol}");
        let resp = self.ensure_markets().await?;
        for market in &resp.markets {
            if market.symbol_pair() == symbol {
                return Ok(market.clone());
            }
        }
        Err(O2Error::MarketNotFound(format!(
            "No market found for pair: {}",
            symbol
        )))
    }

    /// Get a market by hex market ID.
    pub async fn get_market_by_id(&mut self, market_id: &MarketId) -> Result<Market, O2Error> {
        debug!("client.get_market_by_id market_id={market_id}");
        let resp = self.ensure_markets().await?;
        for market in &resp.markets {
            if market.market_id == *market_id {
                return Ok(market.clone());
            }
        }
        Err(O2Error::MarketNotFound(format!(
            "No market found for id: {}",
            market_id
        )))
    }

    /// Get the chain_id from cached markets.
    async fn get_chain_id(&mut self) -> Result<u64, O2Error> {
        let resp = self.ensure_markets().await?;
        let chain_id_hex = resp.chain_id.as_str();
        let stripped = chain_id_hex.strip_prefix("0x").unwrap_or(chain_id_hex);
        u64::from_str_radix(stripped, 16)
            .map_err(|e| O2Error::Other(format!("Failed to parse chain_id: {e}")))
    }

    // -----------------------------------------------------------------------
    // Account Lifecycle
    // -----------------------------------------------------------------------

    /// Idempotent account setup: creates account, funds via faucet, whitelists.
    /// Safe to call on every bot startup.
    /// Works with both [`Wallet`] and [`EvmWallet`].
    pub async fn setup_account<W: SignableWallet>(
        &mut self,
        wallet: &W,
    ) -> Result<AccountResponse, O2Error> {
        debug!("client.setup_account");
        let owner_hex = to_hex_string(wallet.b256_address());

        // 1. Check if account already exists
        let existing = self.api.get_account_by_owner(&owner_hex).await?;
        let trade_account_id = if existing.trade_account_id.is_some() {
            existing.trade_account_id.clone().unwrap()
        } else {
            // 2. Create account
            let created = self.api.create_account(&owner_hex).await?;
            created.trade_account_id
        };

        // 3. Mint via faucet only when the account currently has no balances.
        if self.should_faucet_account(trade_account_id.as_str()).await {
            let _ = self.retry_mint_to_contract(trade_account_id.as_str()).await;
        } else {
            debug!(
                "client.setup_account skipping_faucet trade_account_id={} (non-zero balance detected)",
                trade_account_id
            );
        }

        // 4. Whitelist account (testnet-only, non-fatal; retry for transient failures)
        let _ = self
            .retry_whitelist_account(trade_account_id.as_str())
            .await;

        // 5. Return current account state
        self.api.get_account_by_id(trade_account_id.as_str()).await
    }

    // -----------------------------------------------------------------------
    // Session Management
    // -----------------------------------------------------------------------

    /// Create a trading session with a relative TTL.
    ///
    /// Works with both [`Wallet`] (Fuel-native) and [`EvmWallet`].
    pub async fn create_session<W: SignableWallet, S: AsRef<str>>(
        &mut self,
        owner: &W,
        market_names: &[S],
        ttl: Duration,
    ) -> Result<Session, O2Error> {
        let ttl_secs = ttl.as_secs();
        if ttl_secs == 0 {
            return Err(O2Error::InvalidSession(
                "Session TTL must be greater than zero seconds".into(),
            ));
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let expiry = now
            .checked_add(ttl_secs)
            .ok_or_else(|| O2Error::InvalidSession("Session TTL overflow".into()))?;

        self.create_session_until(owner, market_names, expiry).await
    }

    /// Create a trading session that expires at an absolute UNIX timestamp.
    ///
    /// Works with both [`Wallet`] (Fuel-native) and [`EvmWallet`].
    pub async fn create_session_until<W: SignableWallet, S: AsRef<str>>(
        &mut self,
        owner: &W,
        market_names: &[S],
        expiry_unix_secs: u64,
    ) -> Result<Session, O2Error> {
        debug!(
            "client.create_session_until markets={} expiry_unix_secs={}",
            market_names.len(),
            expiry_unix_secs
        );
        let owner_hex = to_hex_string(owner.b256_address());

        // Resolve market names to contract_ids
        let mut contract_ids_hex = Vec::new();
        let mut contract_ids_bytes = Vec::new();
        for name in market_names {
            let market = self.get_market(name.as_ref()).await?;
            contract_ids_hex.push(market.contract_id.clone());
            contract_ids_bytes.push(parse_hex_32(&market.contract_id)?);
        }

        let chain_id = self.get_chain_id().await?;

        // Get current nonce
        let account = self.api.get_account_by_owner(&owner_hex).await?;
        let trade_account_id = account
            .trade_account_id
            .clone()
            .ok_or_else(|| O2Error::AccountNotFound("No trade_account_id found".into()))?;

        let nonce = Self::parse_account_nonce(
            account.trade_account.as_ref().map(|ta| ta.nonce),
            "create_session account response",
        )?;

        // Generate session keypair
        let session_wallet = generate_keypair()?;

        // Build signing bytes
        let signing_bytes = build_session_signing_bytes(
            nonce,
            chain_id,
            &session_wallet.b256_address,
            &contract_ids_bytes,
            expiry_unix_secs,
        );

        // Sign with owner wallet (dispatches to Fuel or EVM personal_sign)
        let signature = owner.personal_sign(&signing_bytes)?;
        let sig_hex = to_hex_string(&signature);

        // Submit session
        let request = SessionRequest {
            contract_id: trade_account_id.clone(),
            session_id: Identity::Address(to_hex_string(&session_wallet.b256_address)),
            signature: Signature::Secp256k1(sig_hex),
            contract_ids: contract_ids_hex.clone(),
            nonce: nonce.to_string(),
            expiry: expiry_unix_secs.to_string(),
        };

        let _resp = self.api.create_session(&owner_hex, &request).await?;

        Ok(Session {
            owner_address: *owner.b256_address(),
            session_private_key: session_wallet.private_key,
            session_address: session_wallet.b256_address,
            trade_account_id,
            contract_ids: contract_ids_hex,
            expiry: expiry_unix_secs,
            nonce: nonce + 1,
        })
    }

    // -----------------------------------------------------------------------
    // Trading
    // -----------------------------------------------------------------------

    /// Create a single-market action builder with normalized market context.
    pub async fn actions_for<M>(&mut self, market_name: M) -> Result<MarketActionsBuilder, O2Error>
    where
        M: IntoMarketSymbol,
    {
        let market_name = market_name.into_market_symbol()?;
        debug!("client.actions_for market={}", market_name);
        let market = self.get_market(&market_name).await?;
        Ok(MarketActionsBuilder::new(market))
    }

    /// Check if a session has expired and return an error if so.
    fn check_session_expiry(session: &Session) -> Result<(), O2Error> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        if session.expiry > 0 && now >= session.expiry {
            return Err(O2Error::SessionExpired(
                "Session has expired. Create a new session before submitting actions.".into(),
            ));
        }
        Ok(())
    }

    /// Place a new order.
    ///
    /// `price` and `quantity` accept flexible inputs:
    /// - typed market-bound wrappers: [`Price`], [`Quantity`]
    /// - raw decimals: [`crate::UnsignedDecimal`]
    /// - decimal strings: `&str` / `String`
    ///
    /// If `settle_first` is true, a SettleBalance action is prepended.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_order<M, P, Q>(
        &mut self,
        session: &mut Session,
        market_name: M,
        side: Side,
        price: P,
        quantity: Q,
        order_type: OrderType,
        settle_first: bool,
        collect_orders: bool,
    ) -> Result<SessionActionsResponse, O2Error>
    where
        M: IntoMarketSymbol,
        P: TryInto<OrderPriceInput, Error = O2Error>,
        Q: TryInto<OrderQuantityInput, Error = O2Error>,
    {
        let market_name = market_name.into_market_symbol()?;
        debug!(
            "client.create_order market={} settle_first={} collect_orders={}",
            market_name, settle_first, collect_orders
        );
        let market = self.get_market(&market_name).await?;

        let price = match price.try_into()? {
            OrderPriceInput::Unchecked(v) => v,
            OrderPriceInput::Checked(v) => {
                market.validate_price_binding(&v)?;
                v.value()
            }
        };

        let quantity = match quantity.try_into()? {
            OrderQuantityInput::Unchecked(v) => v,
            OrderQuantityInput::Checked(v) => {
                market.validate_quantity_binding(&v)?;
                v.value()
            }
        };

        let mut actions = Vec::new();
        if settle_first {
            actions.push(Action::SettleBalance);
        }
        actions.push(Action::CreateOrder {
            side,
            price,
            quantity,
            order_type,
        });
        self.batch_actions(session, market.symbol_pair(), actions, collect_orders)
            .await
    }

    /// Cancel an order by order_id.
    pub async fn cancel_order<M>(
        &mut self,
        session: &mut Session,
        order_id: &OrderId,
        market_name: M,
    ) -> Result<SessionActionsResponse, O2Error>
    where
        M: IntoMarketSymbol,
    {
        let market_name = market_name.into_market_symbol()?;
        debug!(
            "client.cancel_order market={} order_id={}",
            market_name, order_id
        );
        self.batch_actions(
            session,
            market_name,
            vec![Action::CancelOrder {
                order_id: order_id.clone(),
            }],
            false,
        )
        .await
    }

    /// Cancel all open orders for a market.
    pub async fn cancel_all_orders<M>(
        &mut self,
        session: &mut Session,
        market_name: M,
    ) -> Result<Vec<SessionActionsResponse>, O2Error>
    where
        M: IntoMarketSymbol,
    {
        let market_name = market_name.into_market_symbol()?;
        debug!("client.cancel_all_orders market={}", market_name);
        Self::check_session_expiry(session)?;
        let market = self.get_market(&market_name).await?;
        let orders_resp = self
            .api
            .get_orders(
                market.market_id.as_str(),
                session.trade_account_id.as_str(),
                "desc",
                200,
                Some(true),
                None,
                None,
            )
            .await?;

        let orders = orders_resp.orders;
        let mut results = Vec::new();

        // Cancel up to 5 orders per batch
        for chunk in orders.chunks(5) {
            let actions = Self::build_cancel_actions(chunk.iter().map(|order| &order.order_id));

            if actions.is_empty() {
                continue;
            }

            let resp = self
                .batch_actions(session, &market_name, actions, false)
                .await?;
            results.push(resp);
        }

        Ok(results)
    }

    fn build_cancel_actions<'a, I>(order_ids: I) -> Vec<Action>
    where
        I: IntoIterator<Item = &'a OrderId>,
    {
        order_ids
            .into_iter()
            .filter_map(|order_id| {
                if order_id.as_str().trim().is_empty() {
                    None
                } else {
                    Some(Action::CancelOrder {
                        order_id: order_id.clone(),
                    })
                }
            })
            .collect()
    }

    /// Submit a batch of typed actions for a single market.
    ///
    /// Handles price/quantity scaling, encoding, signing, and nonce management.
    pub async fn batch_actions<M>(
        &mut self,
        session: &mut Session,
        market_name: M,
        actions: Vec<Action>,
        collect_orders: bool,
    ) -> Result<SessionActionsResponse, O2Error>
    where
        M: IntoMarketSymbol,
    {
        let market_name = market_name.into_market_symbol()?;
        debug!(
            "client.batch_actions market={} actions={} collect_orders={}",
            market_name,
            actions.len(),
            collect_orders
        );
        self.batch_actions_multi(session, &[(market_name, actions)], collect_orders)
            .await
    }

    /// Submit a batch of typed actions across one or more markets.
    pub async fn batch_actions_multi<M>(
        &mut self,
        session: &mut Session,
        market_actions: &[(M, Vec<Action>)],
        collect_orders: bool,
    ) -> Result<SessionActionsResponse, O2Error>
    where
        M: IntoMarketSymbol + Clone,
    {
        let total_actions: usize = market_actions
            .iter()
            .map(|(_, actions)| actions.len())
            .sum();
        debug!(
            "client.batch_actions_multi markets={} actions={} collect_orders={}",
            market_actions.len(),
            total_actions,
            collect_orders
        );
        Self::check_session_expiry(session)?;

        // Extract accounts_registry_id in a block so the borrow on self ends
        let accounts_registry_id = {
            let markets_resp = self.ensure_markets().await?;
            Some(parse_hex_32(markets_resp.accounts_registry_id.as_str())?)
        };

        let mut all_calls: Vec<CallArg> = Vec::new();
        let mut all_market_actions: Vec<MarketActions> = Vec::new();

        for (market_name, actions) in market_actions {
            let market_name = market_name.clone().into_market_symbol()?;
            let market = self.get_market(&market_name).await?;
            let mut actions_json: Vec<serde_json::Value> = Vec::new();

            for action in actions {
                let (call, json) = crate::encoding::action_to_call(
                    action,
                    &market,
                    session.trade_account_id.as_str(),
                    accounts_registry_id.as_ref(),
                )?;
                all_calls.push(call);
                actions_json.push(json);
            }

            all_market_actions.push(MarketActions {
                market_id: market.market_id.clone(),
                actions: actions_json,
            });
        }

        // Sign, submit, manage nonce
        let signing_bytes = build_actions_signing_bytes(session.nonce, &all_calls);
        let signature = raw_sign(&session.session_private_key, &signing_bytes)?;
        let sig_hex = to_hex_string(&signature);
        let owner_hex = to_hex_string(&session.owner_address);

        let request = SessionActionsRequest {
            actions: all_market_actions,
            signature: Signature::Secp256k1(sig_hex),
            nonce: session.nonce.to_string(),
            trade_account_id: session.trade_account_id.clone(),
            session_id: Identity::Address(to_hex_string(&session.session_address)),
            collect_orders: Some(collect_orders),
            variable_outputs: None,
        };

        match self.api.submit_actions(&owner_hex, &request).await {
            Ok(resp) => {
                session.nonce += 1;
                Ok(resp)
            }
            Err(e) => {
                session.nonce += 1;
                let _ = self.refresh_nonce(session).await;
                Err(e)
            }
        }
    }

    /// Settle balance for a market.
    pub async fn settle_balance<M>(
        &mut self,
        session: &mut Session,
        market_name: M,
    ) -> Result<SessionActionsResponse, O2Error>
    where
        M: IntoMarketSymbol,
    {
        let market_name = market_name.into_market_symbol()?;
        debug!("client.settle_balance market={}", market_name);
        self.batch_actions(session, market_name, vec![Action::SettleBalance], false)
            .await
    }

    // -----------------------------------------------------------------------
    // Market Data
    // -----------------------------------------------------------------------

    /// Get order book depth.
    pub async fn get_depth<M>(
        &mut self,
        market_name: M,
        precision: u64,
    ) -> Result<DepthSnapshot, O2Error>
    where
        M: IntoMarketSymbol,
    {
        let market_name = market_name.into_market_symbol()?;
        debug!(
            "client.get_depth market={} precision={}",
            market_name, precision
        );
        let market = self.get_market(&market_name).await?;
        self.api
            .get_depth(market.market_id.as_str(), precision)
            .await
    }

    /// Get recent trades.
    pub async fn get_trades<M>(
        &mut self,
        market_name: M,
        count: u32,
    ) -> Result<TradesResponse, O2Error>
    where
        M: IntoMarketSymbol,
    {
        let market_name = market_name.into_market_symbol()?;
        debug!("client.get_trades market={} count={}", market_name, count);
        let market = self.get_market(&market_name).await?;
        self.api
            .get_trades(market.market_id.as_str(), "desc", count, None, None)
            .await
    }

    /// Get OHLCV bars.
    pub async fn get_bars<M>(
        &mut self,
        market_name: M,
        resolution: &str,
        from_ts: u64,
        to_ts: u64,
    ) -> Result<Vec<Bar>, O2Error>
    where
        M: IntoMarketSymbol,
    {
        let market_name = market_name.into_market_symbol()?;
        debug!(
            "client.get_bars market={} resolution={} from_ts={} to_ts={}",
            market_name, resolution, from_ts, to_ts
        );
        let market = self.get_market(&market_name).await?;
        self.api
            .get_bars(market.market_id.as_str(), from_ts, to_ts, resolution)
            .await
    }

    /// Get market ticker.
    pub async fn get_ticker<M>(&mut self, market_name: M) -> Result<MarketTicker, O2Error>
    where
        M: IntoMarketSymbol,
    {
        let market_name = market_name.into_market_symbol()?;
        debug!("client.get_ticker market={}", market_name);
        let market = self.get_market(&market_name).await?;
        let tickers = self
            .api
            .get_market_ticker(market.market_id.as_str())
            .await?;
        tickers
            .into_iter()
            .next()
            .ok_or_else(|| O2Error::Other("No ticker returned for requested market".into()))
    }

    // -----------------------------------------------------------------------
    // Account Data
    // -----------------------------------------------------------------------

    /// Get balances for a trading account, keyed by asset symbol.
    pub async fn get_balances(
        &mut self,
        trade_account_id: &TradeAccountId,
    ) -> Result<HashMap<String, BalanceResponse>, O2Error> {
        debug!("client.get_balances trade_account_id={}", trade_account_id);
        let markets = self.get_markets().await?;
        let mut balances = HashMap::new();
        let mut seen_assets = std::collections::HashSet::new();

        for market in &markets {
            for (symbol, asset_id) in [
                (&market.base.symbol, &market.base.asset),
                (&market.quote.symbol, &market.quote.asset),
            ] {
                if seen_assets.insert(asset_id.clone()) {
                    let bal = self
                        .api
                        .get_balance(asset_id.as_str(), Some(trade_account_id.as_str()), None)
                        .await
                        .map_err(|e| {
                            O2Error::Other(format!(
                                "Failed to fetch balance for asset {} ({}) on account {}: {}",
                                symbol, asset_id, trade_account_id, e
                            ))
                        })?;
                    balances.insert(symbol.clone(), bal);
                }
            }
        }

        Ok(balances)
    }

    /// Get orders for a trading account in a market.
    pub async fn get_orders<M>(
        &mut self,
        trade_account_id: &TradeAccountId,
        market_name: M,
        is_open: Option<bool>,
        count: u32,
    ) -> Result<OrdersResponse, O2Error>
    where
        M: IntoMarketSymbol,
    {
        let market_name = market_name.into_market_symbol()?;
        debug!(
            "client.get_orders trade_account_id={} market={} is_open={:?} count={}",
            trade_account_id, market_name, is_open, count
        );
        let market = self.get_market(&market_name).await?;
        self.api
            .get_orders(
                market.market_id.as_str(),
                trade_account_id.as_str(),
                "desc",
                count,
                is_open,
                None,
                None,
            )
            .await
    }

    /// Get a single order.
    pub async fn get_order<M>(&mut self, market_name: M, order_id: &str) -> Result<Order, O2Error>
    where
        M: IntoMarketSymbol,
    {
        let market_name = market_name.into_market_symbol()?;
        debug!(
            "client.get_order market={} order_id={}",
            market_name, order_id
        );
        let market = self.get_market(&market_name).await?;
        self.api
            .get_order(market.market_id.as_str(), order_id)
            .await
    }

    // -----------------------------------------------------------------------
    // Nonce Management
    // -----------------------------------------------------------------------

    /// Get the current nonce for a trading account.
    pub async fn get_nonce(&self, trade_account_id: &str) -> Result<u64, O2Error> {
        debug!("client.get_nonce trade_account_id={}", trade_account_id);
        let account = self.api.get_account_by_id(trade_account_id).await?;
        Self::parse_account_nonce(
            account.trade_account.as_ref().map(|ta| ta.nonce),
            "get_nonce account response",
        )
    }

    /// Refresh the nonce on a session from the API.
    pub async fn refresh_nonce(&self, session: &mut Session) -> Result<u64, O2Error> {
        debug!(
            "client.refresh_nonce trade_account_id={}",
            session.trade_account_id
        );
        let nonce = self.get_nonce(session.trade_account_id.as_str()).await?;
        session.nonce = nonce;
        Ok(nonce)
    }

    // -----------------------------------------------------------------------
    // Withdrawals
    // -----------------------------------------------------------------------

    /// Withdraw assets from the trading account to the owner wallet.
    /// Works with both [`Wallet`] (Fuel-native) and [`EvmWallet`].
    pub async fn withdraw<W: SignableWallet>(
        &mut self,
        owner: &W,
        session: &Session,
        asset_id: &AssetId,
        amount: &str,
        to: Option<&str>,
    ) -> Result<WithdrawResponse, O2Error> {
        debug!(
            "client.withdraw trade_account_id={} asset_id={} amount={} to={:?}",
            session.trade_account_id, asset_id, amount, to
        );
        let owner_hex = to_hex_string(owner.b256_address());
        let to_address_hex = to.unwrap_or(&owner_hex);
        let to_address_bytes = parse_hex_32(to_address_hex)?;
        let asset_id_bytes = parse_hex_32(asset_id.as_str())?;
        let amount_u64: u64 = amount
            .parse()
            .map_err(|e| O2Error::Other(format!("Invalid amount: {e}")))?;

        let nonce = self.get_nonce(session.trade_account_id.as_str()).await?;
        let chain_id = self.get_chain_id().await?;

        // Build withdraw signing bytes and sign with owner wallet
        let signing_bytes = build_withdraw_signing_bytes(
            nonce,
            chain_id,
            0, // Address discriminant
            &to_address_bytes,
            &asset_id_bytes,
            amount_u64,
        );
        let signature = owner.personal_sign(&signing_bytes)?;
        let sig_hex = to_hex_string(&signature);

        let request = WithdrawRequest {
            trade_account_id: session.trade_account_id.clone(),
            signature: Signature::Secp256k1(sig_hex),
            nonce: nonce.to_string(),
            to: Identity::Address(to_address_hex.to_string()),
            asset_id: asset_id.clone(),
            amount: amount.to_string(),
        };

        self.api.withdraw(&owner_hex, &request).await
    }

    // -----------------------------------------------------------------------
    // WebSocket Streaming (shared connection)
    // -----------------------------------------------------------------------

    /// Ensure the shared WebSocket is connected, creating or replacing as needed.
    async fn ensure_ws(
        ws_slot: &mut Option<crate::websocket::O2WebSocket>,
        ws_url: &str,
    ) -> Result<(), O2Error> {
        debug!("client.ensure_ws url={}", ws_url);
        if ws_slot.as_ref().is_some_and(|ws| ws.is_terminated()) {
            *ws_slot = None;
        }
        if ws_slot.is_none() {
            *ws_slot = Some(crate::websocket::O2WebSocket::connect(ws_url).await?);
        }
        Ok(())
    }

    /// Stream depth updates over a shared WebSocket connection.
    pub async fn stream_depth(
        &self,
        market_id: &str,
        precision: &str,
    ) -> Result<TypedStream<DepthUpdate>, O2Error> {
        debug!(
            "client.stream_depth market_id={} precision={}",
            market_id, precision
        );
        let mut guard = self.ws.lock().await;
        Self::ensure_ws(&mut guard, &self.config.ws_url).await?;
        guard
            .as_ref()
            .unwrap()
            .stream_depth(market_id, precision)
            .await
    }

    /// Stream order updates over a shared WebSocket connection.
    pub async fn stream_orders(
        &self,
        identities: &[Identity],
    ) -> Result<TypedStream<OrderUpdate>, O2Error> {
        debug!("client.stream_orders identities={}", identities.len());
        let mut guard = self.ws.lock().await;
        Self::ensure_ws(&mut guard, &self.config.ws_url).await?;
        guard.as_ref().unwrap().stream_orders(identities).await
    }

    /// Stream trade updates over a shared WebSocket connection.
    pub async fn stream_trades(
        &self,
        market_id: &str,
    ) -> Result<TypedStream<TradeUpdate>, O2Error> {
        debug!("client.stream_trades market_id={}", market_id);
        let mut guard = self.ws.lock().await;
        Self::ensure_ws(&mut guard, &self.config.ws_url).await?;
        guard.as_ref().unwrap().stream_trades(market_id).await
    }

    /// Stream balance updates over a shared WebSocket connection.
    pub async fn stream_balances(
        &self,
        identities: &[Identity],
    ) -> Result<TypedStream<BalanceUpdate>, O2Error> {
        debug!("client.stream_balances identities={}", identities.len());
        let mut guard = self.ws.lock().await;
        Self::ensure_ws(&mut guard, &self.config.ws_url).await?;
        guard.as_ref().unwrap().stream_balances(identities).await
    }

    /// Stream nonce updates over a shared WebSocket connection.
    pub async fn stream_nonce(
        &self,
        identities: &[Identity],
    ) -> Result<TypedStream<NonceUpdate>, O2Error> {
        debug!("client.stream_nonce identities={}", identities.len());
        let mut guard = self.ws.lock().await;
        Self::ensure_ws(&mut guard, &self.config.ws_url).await?;
        guard.as_ref().unwrap().stream_nonce(identities).await
    }

    /// Disconnect the shared WebSocket connection and release resources.
    pub async fn disconnect_ws(&self) -> Result<(), O2Error> {
        debug!("client.disconnect_ws");
        let mut guard = self.ws.lock().await;
        if let Some(ws) = guard.take() {
            ws.disconnect().await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use crate::{
        config::{Network, NetworkConfig},
        models::{Action, Market, MarketAsset, MarketsResponse, OrderId, OrderType, Side},
    };

    use super::{MarketActionsBuilder, MetadataPolicy, O2Client};

    fn dummy_markets_response() -> MarketsResponse {
        MarketsResponse {
            books_registry_id: "0x1".into(),
            books_whitelist_id: None,
            books_blacklist_id: None,
            accounts_registry_id: "0x2".into(),
            trade_account_oracle_id: "0x3".into(),
            fast_bridge_asset_registry_contract_id: None,
            chain_id: "0x0".to_string(),
            base_asset_id: "0x4".into(),
            markets: Vec::new(),
        }
    }

    fn dummy_market(market_id: &str) -> Market {
        Market {
            contract_id: "0x01".into(),
            market_id: market_id.into(),
            whitelist_id: None,
            blacklist_id: None,
            maker_fee: 0,
            taker_fee: 0,
            min_order: 0,
            dust: 0,
            price_window: 0,
            base: MarketAsset {
                symbol: "fETH".to_string(),
                asset: "0xbase".into(),
                decimals: 9,
                max_precision: 6,
            },
            quote: MarketAsset {
                symbol: "fUSDC".to_string(),
                asset: "0xquote".into(),
                decimals: 9,
                max_precision: 6,
            },
        }
    }

    #[test]
    fn parse_nonce_decimal() {
        assert_eq!(
            O2Client::parse_nonce_value("42", "test").expect("decimal nonce should parse"),
            42
        );
    }

    #[test]
    fn parse_nonce_hex_lowercase() {
        assert_eq!(
            O2Client::parse_nonce_value("0x2a", "test").expect("hex nonce should parse"),
            42
        );
    }

    #[test]
    fn parse_nonce_hex_uppercase_prefix() {
        assert_eq!(
            O2Client::parse_nonce_value("0X2A", "test").expect("hex nonce should parse"),
            42
        );
    }

    #[test]
    fn parse_nonce_missing_defaults_zero() {
        assert_eq!(
            O2Client::parse_account_nonce(None, "test").expect("missing nonce should default"),
            0
        );
    }

    #[test]
    fn parse_nonce_invalid_is_error() {
        let err = O2Client::parse_nonce_value("not-a-nonce", "test")
            .expect_err("invalid nonce should return parse error");
        assert!(format!("{err}").contains("Parse error"));
    }

    #[test]
    fn metadata_policy_refreshes_when_cache_empty() {
        let client = O2Client::new(Network::Testnet);
        assert!(client.should_refresh_markets());
    }

    #[test]
    fn metadata_policy_optimistic_ttl_respects_recent_cache() {
        let mut client = O2Client::new(Network::Testnet);
        client.metadata_policy = MetadataPolicy::OptimisticTtl(Duration::from_secs(60));
        client.markets_cache = Some(dummy_markets_response());
        client.markets_cache_at = Some(Instant::now());
        assert!(!client.should_refresh_markets());
    }

    #[test]
    fn metadata_policy_optimistic_ttl_refreshes_expired_cache() {
        let mut client = O2Client::new(Network::Testnet);
        client.metadata_policy = MetadataPolicy::OptimisticTtl(Duration::from_millis(10));
        client.markets_cache = Some(dummy_markets_response());
        client.markets_cache_at = Some(Instant::now() - Duration::from_secs(1));
        assert!(client.should_refresh_markets());
    }

    #[test]
    fn metadata_policy_strict_fresh_always_refreshes() {
        let mut client = O2Client::new(Network::Testnet);
        client.metadata_policy = MetadataPolicy::StrictFresh;
        client.markets_cache = Some(dummy_markets_response());
        client.markets_cache_at = Some(Instant::now());
        assert!(client.should_refresh_markets());
    }

    #[test]
    fn market_actions_builder_builds_valid_actions() {
        let market = dummy_market("0xmarket_a");
        let actions = MarketActionsBuilder::new(market)
            .settle_balance()
            .create_order(Side::Buy, "1.25", "10", OrderType::Spot)
            .cancel_order("0xdeadbeef")
            .build()
            .expect("builder should produce actions");

        assert_eq!(actions.len(), 3);
        assert!(matches!(actions[0], Action::SettleBalance));
        assert!(matches!(actions[1], Action::CreateOrder { .. }));
        assert!(matches!(actions[2], Action::CancelOrder { .. }));
    }

    #[test]
    fn market_actions_builder_defers_parse_error_until_build() {
        let market = dummy_market("0xmarket_a");
        let result = MarketActionsBuilder::new(market)
            .create_order(Side::Buy, "bad-price", "10", OrderType::Spot)
            .cancel_order("0xwill-not-be-added")
            .build();

        assert!(result.is_err());
    }

    #[test]
    fn market_actions_builder_rejects_stale_typed_inputs_on_build() {
        let market_a = dummy_market("0xmarket_a");
        let market_b = dummy_market("0xmarket_b");

        let typed_price = market_a.price("1.0").expect("price should parse");
        let typed_quantity = market_a.quantity("2.0").expect("qty should parse");

        let result = MarketActionsBuilder::new(market_b)
            .create_order(Side::Buy, typed_price, typed_quantity, OrderType::PostOnly)
            .build();

        assert!(result.is_err());
    }

    #[test]
    fn whitelist_is_enabled_only_for_testnet() {
        let testnet = O2Client::new(Network::Testnet);
        let devnet = O2Client::new(Network::Devnet);
        let mainnet = O2Client::new(Network::Mainnet);

        assert!(testnet.should_whitelist_account());
        assert!(!devnet.should_whitelist_account());
        assert!(!mainnet.should_whitelist_account());
    }

    #[test]
    fn whitelist_behavior_can_be_overridden_in_custom_config() {
        let mut config = NetworkConfig::from_network(Network::Mainnet);
        config.whitelist_required = true;
        let custom = O2Client::with_config(config);
        assert!(custom.should_whitelist_account());
    }

    #[test]
    fn build_cancel_actions_skips_empty_order_ids() {
        let empty = OrderId::default();
        let valid = OrderId::from("0xabc123");

        let actions = O2Client::build_cancel_actions([&empty, &valid]);
        assert_eq!(actions.len(), 1);
        match &actions[0] {
            Action::CancelOrder { order_id } => assert_eq!(order_id.as_str(), valid.as_str()),
            _ => panic!("expected cancel action"),
        }
    }
}
