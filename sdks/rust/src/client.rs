/// High-level O2Client that orchestrates the full trading workflow.
///
/// This is the primary entry point for SDK users. It handles wallet management,
/// account lifecycle, session management, order placement, and WebSocket streaming.
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::api::O2Api;
use crate::config::{Network, NetworkConfig};
use crate::crypto::SignableWallet;
use crate::crypto::{
    generate_evm_keypair, generate_keypair, load_evm_wallet, load_wallet, parse_hex_32, raw_sign,
    to_hex_string, EvmWallet, Wallet,
};
use crate::decimal::UnsignedDecimal;
use crate::encoding::{
    build_actions_signing_bytes, build_session_signing_bytes, build_withdraw_signing_bytes, CallArg,
};
use crate::errors::O2Error;
use crate::models::*;
use crate::websocket::TypedStream;

/// The high-level O2 Exchange client.
pub struct O2Client {
    pub api: O2Api,
    pub config: NetworkConfig,
    markets_cache: Option<MarketsResponse>,
    ws: tokio::sync::Mutex<Option<crate::websocket::O2WebSocket>>,
}

impl O2Client {
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
        // Whitelist is testnet-only for current environments.
        if !self.config.api_base.contains("api.testnet.o2.app") {
            return true;
        }

        let delays_secs = [0u64, 2, 5];
        let mut last_error = String::new();

        for (idx, delay) in delays_secs.iter().enumerate() {
            if *delay > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(*delay)).await;
            }

            match self.api.whitelist_account(trade_account_id).await {
                Ok(_) => return true,
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
        // Faucet currently exists only on non-mainnet configs.
        if self.config.faucet_url.is_none() {
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
                Ok(resp) if resp.error.is_none() => return true,
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

    /// Create a new O2Client for the given network.
    pub fn new(network: Network) -> Self {
        let config = NetworkConfig::from_network(network);
        Self {
            api: O2Api::new(config.clone()),
            config,
            markets_cache: None,
            ws: tokio::sync::Mutex::new(None),
        }
    }

    /// Create a new O2Client with a custom configuration.
    pub fn with_config(config: NetworkConfig) -> Self {
        Self {
            api: O2Api::new(config.clone()),
            config,
            markets_cache: None,
            ws: tokio::sync::Mutex::new(None),
        }
    }

    // -----------------------------------------------------------------------
    // Wallet Management
    // -----------------------------------------------------------------------

    /// Generate a new Fuel-native wallet.
    pub fn generate_wallet(&self) -> Result<Wallet, O2Error> {
        generate_keypair()
    }

    /// Generate a new EVM-compatible wallet.
    pub fn generate_evm_wallet(&self) -> Result<EvmWallet, O2Error> {
        generate_evm_keypair()
    }

    /// Load a Fuel-native wallet from a private key hex string.
    pub fn load_wallet(&self, private_key_hex: &str) -> Result<Wallet, O2Error> {
        let key = parse_hex_32(private_key_hex)?;
        load_wallet(&key)
    }

    /// Load an EVM wallet from a private key hex string.
    pub fn load_evm_wallet(&self, private_key_hex: &str) -> Result<EvmWallet, O2Error> {
        let key = parse_hex_32(private_key_hex)?;
        load_evm_wallet(&key)
    }

    // -----------------------------------------------------------------------
    // Market Resolution
    // -----------------------------------------------------------------------

    /// Fetch and cache markets.
    pub async fn fetch_markets(&mut self) -> Result<&MarketsResponse, O2Error> {
        let resp = self.api.get_markets().await?;
        self.markets_cache = Some(resp);
        Ok(self.markets_cache.as_ref().unwrap())
    }

    /// Get cached markets, fetching if needed.
    async fn ensure_markets(&mut self) -> Result<&MarketsResponse, O2Error> {
        if self.markets_cache.is_none() {
            self.fetch_markets().await?;
        }
        Ok(self.markets_cache.as_ref().unwrap())
    }

    /// Get all markets.
    pub async fn get_markets(&mut self) -> Result<Vec<Market>, O2Error> {
        let resp = self.ensure_markets().await?;
        Ok(resp.markets.clone())
    }

    /// Get a market by symbol pair (e.g., "FUEL/USDC").
    pub async fn get_market(&mut self, symbol: &MarketSymbol) -> Result<Market, O2Error> {
        let resp = self.ensure_markets().await?;
        for market in &resp.markets {
            if market.symbol_pair() == *symbol {
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

        // 3. Mint via faucet (non-fatal; retry to reduce flaky setup on cooldown windows)
        let _ = self.retry_mint_to_contract(trade_account_id.as_str()).await;

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

    /// Create a trading session for an owner wallet.
    /// Works with both [`Wallet`] (Fuel-native) and [`EvmWallet`].
    pub async fn create_session<W: SignableWallet>(
        &mut self,
        owner: &W,
        market_names: &[&MarketSymbol],
        expiry_days: u64,
    ) -> Result<Session, O2Error> {
        let owner_hex = to_hex_string(owner.b256_address());

        // Resolve market names to contract_ids
        let mut contract_ids_hex = Vec::new();
        let mut contract_ids_bytes = Vec::new();
        for name in market_names {
            let market = self.get_market(name).await?;
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

        // Calculate expiry
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let expiry = now + (expiry_days * 24 * 3600);

        // Build signing bytes
        let signing_bytes = build_session_signing_bytes(
            nonce,
            chain_id,
            &session_wallet.b256_address,
            &contract_ids_bytes,
            expiry,
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
            expiry: expiry.to_string(),
        };

        let _resp = self.api.create_session(&owner_hex, &request).await?;

        Ok(Session {
            owner_address: *owner.b256_address(),
            session_private_key: session_wallet.private_key,
            session_address: session_wallet.b256_address,
            trade_account_id,
            contract_ids: contract_ids_hex,
            expiry,
            nonce: nonce + 1,
        })
    }

    // -----------------------------------------------------------------------
    // Trading
    // -----------------------------------------------------------------------

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

    /// Place a new order. Handles encoding, signing, and nonce management.
    ///
    /// If `settle_first` is true, a SettleBalance action is prepended.
    /// Uses typed `Side` and `OrderType` enums for compile-time safety.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_order(
        &mut self,
        session: &mut Session,
        market_name: &MarketSymbol,
        side: Side,
        price: UnsignedDecimal,
        quantity: UnsignedDecimal,
        order_type: OrderType,
        settle_first: bool,
        collect_orders: bool,
    ) -> Result<SessionActionsResponse, O2Error> {
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
        self.batch_actions(session, market_name, actions, collect_orders)
            .await
    }

    /// Cancel an order by order_id.
    pub async fn cancel_order(
        &mut self,
        session: &mut Session,
        order_id: &OrderId,
        market_name: &MarketSymbol,
    ) -> Result<SessionActionsResponse, O2Error> {
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
    pub async fn cancel_all_orders(
        &mut self,
        session: &mut Session,
        market_name: &MarketSymbol,
    ) -> Result<Vec<SessionActionsResponse>, O2Error> {
        Self::check_session_expiry(session)?;
        let market = self.get_market(market_name).await?;
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
            let actions: Vec<Action> = chunk
                .iter()
                .map(|order| Action::CancelOrder {
                    order_id: order.order_id.clone(),
                })
                .collect();

            if actions.is_empty() {
                continue;
            }

            let resp = self
                .batch_actions(session, market_name, actions, false)
                .await?;
            results.push(resp);
        }

        Ok(results)
    }

    /// Submit a batch of typed actions for a single market.
    ///
    /// Handles price/quantity scaling, encoding, signing, and nonce management.
    pub async fn batch_actions(
        &mut self,
        session: &mut Session,
        market_name: &MarketSymbol,
        actions: Vec<Action>,
        collect_orders: bool,
    ) -> Result<SessionActionsResponse, O2Error> {
        self.batch_actions_multi(session, &[(market_name, actions)], collect_orders)
            .await
    }

    /// Submit a batch of typed actions across one or more markets.
    pub async fn batch_actions_multi(
        &mut self,
        session: &mut Session,
        market_actions: &[(&MarketSymbol, Vec<Action>)],
        collect_orders: bool,
    ) -> Result<SessionActionsResponse, O2Error> {
        Self::check_session_expiry(session)?;

        // Extract accounts_registry_id in a block so the borrow on self ends
        let accounts_registry_id = {
            let markets_resp = self.ensure_markets().await?;
            Some(parse_hex_32(markets_resp.accounts_registry_id.as_str())?)
        };

        let mut all_calls: Vec<CallArg> = Vec::new();
        let mut all_market_actions: Vec<MarketActions> = Vec::new();

        for (market_name, actions) in market_actions {
            let market = self.get_market(market_name).await?;
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
    pub async fn settle_balance(
        &mut self,
        session: &mut Session,
        market_name: &MarketSymbol,
    ) -> Result<SessionActionsResponse, O2Error> {
        self.batch_actions(session, market_name, vec![Action::SettleBalance], false)
            .await
    }

    // -----------------------------------------------------------------------
    // Market Data
    // -----------------------------------------------------------------------

    /// Get order book depth.
    pub async fn get_depth(
        &mut self,
        market_name: &MarketSymbol,
        precision: u64,
    ) -> Result<DepthSnapshot, O2Error> {
        let market = self.get_market(market_name).await?;
        self.api
            .get_depth(market.market_id.as_str(), precision)
            .await
    }

    /// Get recent trades.
    pub async fn get_trades(
        &mut self,
        market_name: &MarketSymbol,
        count: u32,
    ) -> Result<TradesResponse, O2Error> {
        let market = self.get_market(market_name).await?;
        self.api
            .get_trades(market.market_id.as_str(), "desc", count, None, None)
            .await
    }

    /// Get OHLCV bars.
    pub async fn get_bars(
        &mut self,
        market_name: &MarketSymbol,
        resolution: &str,
        from_ts: u64,
        to_ts: u64,
    ) -> Result<Vec<Bar>, O2Error> {
        let market = self.get_market(market_name).await?;
        self.api
            .get_bars(market.market_id.as_str(), from_ts, to_ts, resolution)
            .await
    }

    /// Get market ticker.
    pub async fn get_ticker(
        &mut self,
        market_name: &MarketSymbol,
    ) -> Result<MarketTicker, O2Error> {
        let market = self.get_market(market_name).await?;
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
    pub async fn get_orders(
        &mut self,
        trade_account_id: &TradeAccountId,
        market_name: &MarketSymbol,
        is_open: Option<bool>,
        count: u32,
    ) -> Result<OrdersResponse, O2Error> {
        let market = self.get_market(market_name).await?;
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
    pub async fn get_order(
        &mut self,
        market_name: &MarketSymbol,
        order_id: &str,
    ) -> Result<Order, O2Error> {
        let market = self.get_market(market_name).await?;
        self.api
            .get_order(market.market_id.as_str(), order_id)
            .await
    }

    // -----------------------------------------------------------------------
    // Nonce Management
    // -----------------------------------------------------------------------

    /// Get the current nonce for a trading account.
    pub async fn get_nonce(&self, trade_account_id: &str) -> Result<u64, O2Error> {
        let account = self.api.get_account_by_id(trade_account_id).await?;
        Self::parse_account_nonce(
            account.trade_account.as_ref().map(|ta| ta.nonce),
            "get_nonce account response",
        )
    }

    /// Refresh the nonce on a session from the API.
    pub async fn refresh_nonce(&self, session: &mut Session) -> Result<u64, O2Error> {
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
        let mut guard = self.ws.lock().await;
        Self::ensure_ws(&mut guard, &self.config.ws_url).await?;
        guard.as_ref().unwrap().stream_orders(identities).await
    }

    /// Stream trade updates over a shared WebSocket connection.
    pub async fn stream_trades(
        &self,
        market_id: &str,
    ) -> Result<TypedStream<TradeUpdate>, O2Error> {
        let mut guard = self.ws.lock().await;
        Self::ensure_ws(&mut guard, &self.config.ws_url).await?;
        guard.as_ref().unwrap().stream_trades(market_id).await
    }

    /// Stream balance updates over a shared WebSocket connection.
    pub async fn stream_balances(
        &self,
        identities: &[Identity],
    ) -> Result<TypedStream<BalanceUpdate>, O2Error> {
        let mut guard = self.ws.lock().await;
        Self::ensure_ws(&mut guard, &self.config.ws_url).await?;
        guard.as_ref().unwrap().stream_balances(identities).await
    }

    /// Stream nonce updates over a shared WebSocket connection.
    pub async fn stream_nonce(
        &self,
        identities: &[Identity],
    ) -> Result<TypedStream<NonceUpdate>, O2Error> {
        let mut guard = self.ws.lock().await;
        Self::ensure_ws(&mut guard, &self.config.ws_url).await?;
        guard.as_ref().unwrap().stream_nonce(identities).await
    }

    /// Disconnect the shared WebSocket connection and release resources.
    pub async fn disconnect_ws(&self) -> Result<(), O2Error> {
        let mut guard = self.ws.lock().await;
        if let Some(ws) = guard.take() {
            ws.disconnect().await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::O2Client;

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
}
