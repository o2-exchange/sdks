/// High-level O2Client that orchestrates the full trading workflow.
///
/// This is the primary entry point for SDK users. It handles wallet management,
/// account lifecycle, session management, order placement, and WebSocket streaming.
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::api::O2Api;
use crate::config::{Network, NetworkConfig};
use crate::crypto::{
    evm_personal_sign, generate_evm_keypair, generate_keypair, load_evm_wallet, load_wallet,
    parse_hex_32, personal_sign, raw_sign, to_hex_string, EvmWallet, Wallet,
};
use crate::encoding::{
    build_actions_signing_bytes, build_session_signing_bytes, build_withdraw_signing_bytes,
    cancel_order_to_call, create_order_to_call, settle_balance_to_call, CallArg,
};
use crate::errors::O2Error;
use crate::models::*;
use crate::websocket::{O2WebSocket, TypedStream};

/// The high-level O2 Exchange client.
pub struct O2Client {
    pub api: O2Api,
    pub config: NetworkConfig,
    markets_cache: Option<MarketsResponse>,
}

impl O2Client {
    /// Create a new O2Client for the given network.
    pub fn new(network: Network) -> Self {
        let config = NetworkConfig::from_network(network);
        Self {
            api: O2Api::new(config.clone()),
            config,
            markets_cache: None,
        }
    }

    /// Create a new O2Client with a custom configuration.
    pub fn with_config(config: NetworkConfig) -> Self {
        Self {
            api: O2Api::new(config.clone()),
            config,
            markets_cache: None,
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

    /// Get a market by symbol pair (e.g., "FUEL/USDC") or hex market_id.
    pub async fn get_market(&mut self, symbol_or_id: &str) -> Result<Market, O2Error> {
        let resp = self.ensure_markets().await?;
        // Check if it's a symbol pair
        if symbol_or_id.contains('/') {
            for market in &resp.markets {
                if market.symbol_pair() == symbol_or_id {
                    return Ok(market.clone());
                }
            }
            return Err(O2Error::MarketNotFound(format!(
                "No market found for pair: {}",
                symbol_or_id
            )));
        }
        // Assume hex market_id
        for market in &resp.markets {
            if market.market_id == symbol_or_id {
                return Ok(market.clone());
            }
        }
        Err(O2Error::MarketNotFound(format!(
            "No market found for id: {}",
            symbol_or_id
        )))
    }

    /// Get the chain_id from cached markets.
    async fn get_chain_id(&mut self) -> Result<u64, O2Error> {
        let resp = self.ensure_markets().await?;
        let chain_id_hex = resp.chain_id.as_deref().unwrap_or("0x0000000000000000");
        let stripped = chain_id_hex.strip_prefix("0x").unwrap_or(chain_id_hex);
        u64::from_str_radix(stripped, 16)
            .map_err(|e| O2Error::Other(format!("Failed to parse chain_id: {e}")))
    }

    // -----------------------------------------------------------------------
    // Account Lifecycle
    // -----------------------------------------------------------------------

    /// Idempotent account setup: creates account, funds via faucet, whitelists.
    /// Safe to call on every bot startup.
    pub async fn setup_account(&mut self, wallet: &Wallet) -> Result<AccountResponse, O2Error> {
        let owner_hex = to_hex_string(&wallet.b256_address);

        // 1. Check if account already exists
        let existing = self.api.get_account_by_owner(&owner_hex).await?;
        let trade_account_id = if existing.trade_account_id.is_some() {
            existing.trade_account_id.clone().unwrap()
        } else {
            // 2. Create account
            let created = self.api.create_account(&owner_hex).await?;
            created.trade_account_id.ok_or_else(|| {
                O2Error::Other("Account creation returned no trade_account_id".into())
            })?
        };

        // 3. Mint via faucet (testnet/devnet only, non-fatal)
        if self.config.faucet_url.is_some() {
            match self.api.mint_to_contract(&trade_account_id).await {
                Ok(_) => {}
                Err(_) => {
                    // Faucet cooldown or error — not fatal
                }
            }
        }

        // 4. Whitelist account (idempotent)
        let _ = self.api.whitelist_account(&trade_account_id).await;

        // 5. Return current account state
        self.api.get_account_by_id(&trade_account_id).await
    }

    /// Idempotent account setup for EVM wallets.
    pub async fn setup_evm_account(
        &mut self,
        wallet: &EvmWallet,
    ) -> Result<AccountResponse, O2Error> {
        let owner_hex = to_hex_string(&wallet.b256_address);

        let existing = self.api.get_account_by_owner(&owner_hex).await?;
        let trade_account_id = if existing.trade_account_id.is_some() {
            existing.trade_account_id.clone().unwrap()
        } else {
            let created = self.api.create_account(&owner_hex).await?;
            created.trade_account_id.ok_or_else(|| {
                O2Error::Other("Account creation returned no trade_account_id".into())
            })?
        };

        if self.config.faucet_url.is_some() {
            let _ = self.api.mint_to_contract(&trade_account_id).await;
        }

        let _ = self.api.whitelist_account(&trade_account_id).await;

        self.api.get_account_by_id(&trade_account_id).await
    }

    // -----------------------------------------------------------------------
    // Session Management
    // -----------------------------------------------------------------------

    /// Create a trading session for a Fuel-native owner wallet.
    pub async fn create_session(
        &mut self,
        owner: &Wallet,
        market_names: &[&str],
        expiry_days: u64,
    ) -> Result<Session, O2Error> {
        let owner_hex = to_hex_string(&owner.b256_address);

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

        let nonce: u64 = account
            .trade_account
            .as_ref()
            .and_then(|ta| ta.nonce.as_deref())
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);

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

        // Sign with owner wallet (personalSign for Fuel)
        let signature = personal_sign(&owner.private_key, &signing_bytes)?;
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
            owner_address: owner.b256_address,
            session_private_key: session_wallet.private_key,
            session_address: session_wallet.b256_address,
            trade_account_id,
            contract_ids: contract_ids_hex,
            expiry,
            nonce: nonce + 1,
        })
    }

    /// Create a trading session for an EVM owner wallet.
    pub async fn create_evm_session(
        &mut self,
        owner: &EvmWallet,
        market_names: &[&str],
        expiry_days: u64,
    ) -> Result<Session, O2Error> {
        let owner_hex = to_hex_string(&owner.b256_address);

        let mut contract_ids_hex = Vec::new();
        let mut contract_ids_bytes = Vec::new();
        for name in market_names {
            let market = self.get_market(name).await?;
            contract_ids_hex.push(market.contract_id.clone());
            contract_ids_bytes.push(parse_hex_32(&market.contract_id)?);
        }

        let chain_id = self.get_chain_id().await?;

        let account = self.api.get_account_by_owner(&owner_hex).await?;
        let trade_account_id = account
            .trade_account_id
            .clone()
            .ok_or_else(|| O2Error::AccountNotFound("No trade_account_id found".into()))?;

        let nonce: u64 = account
            .trade_account
            .as_ref()
            .and_then(|ta| ta.nonce.as_deref())
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);

        let session_wallet = generate_keypair()?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let expiry = now + (expiry_days * 24 * 3600);

        let signing_bytes = build_session_signing_bytes(
            nonce,
            chain_id,
            &session_wallet.b256_address,
            &contract_ids_bytes,
            expiry,
        );

        // Sign with EVM personal_sign (keccak256)
        let signature = evm_personal_sign(&owner.private_key, &signing_bytes)?;
        let sig_hex = to_hex_string(&signature);

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
            owner_address: owner.b256_address,
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
        market_name: &str,
        side: Side,
        price: f64,
        quantity: f64,
        order_type: OrderType,
        settle_first: bool,
        collect_orders: bool,
    ) -> Result<SessionActionsResponse, O2Error> {
        Self::check_session_expiry(session)?;
        let market = self.get_market(market_name).await?;
        let contract_id = parse_hex_32(&market.contract_id)?;
        let base_asset = parse_hex_32(&market.base.asset)?;
        let quote_asset = parse_hex_32(&market.quote.asset)?;
        let trade_account_id_bytes = parse_hex_32(&session.trade_account_id)?;

        let scaled_price = market.scale_price(price);
        let scaled_quantity = market.scale_quantity(quantity);

        // Adjust quantity for FractionalPrice constraint
        let scaled_quantity = market.adjust_quantity(scaled_price, scaled_quantity);

        // Validate order constraints
        market
            .validate_order(scaled_price, scaled_quantity)
            .map_err(O2Error::InvalidOrderParams)?;

        // Convert OrderType to encoding and JSON representations
        let (ot_encoding, ot_json) = order_type.to_encoding(&market);

        let side_str = side.as_str();

        // Build calls for signing
        let mut calls: Vec<CallArg> = Vec::new();
        let mut actions_json: Vec<serde_json::Value> = Vec::new();

        if settle_first {
            calls.push(settle_balance_to_call(
                &contract_id,
                1, // ContractId discriminant
                &trade_account_id_bytes,
            ));
            actions_json.push(json!({
                "SettleBalance": {
                    "to": {
                        "ContractId": session.trade_account_id
                    }
                }
            }));
        }

        calls.push(create_order_to_call(
            &contract_id,
            side_str,
            scaled_price,
            scaled_quantity,
            &ot_encoding,
            market.base.decimals,
            &base_asset,
            &quote_asset,
        ));
        actions_json.push(json!({
            "CreateOrder": {
                "side": side_str,
                "price": scaled_price.to_string(),
                "quantity": scaled_quantity.to_string(),
                "order_type": ot_json
            }
        }));

        // Build signing bytes and sign
        let signing_bytes = build_actions_signing_bytes(session.nonce, &calls);
        let signature = raw_sign(&session.session_private_key, &signing_bytes)?;
        let sig_hex = to_hex_string(&signature);

        let owner_hex = to_hex_string(&session.owner_address);

        let request = SessionActionsRequest {
            actions: vec![MarketActions {
                market_id: market.market_id.clone(),
                actions: actions_json,
            }],
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
                // Re-fetch nonce on error for resync (best-effort)
                let _ = self.refresh_nonce(session).await;
                Err(e)
            }
        }
    }

    /// Cancel an order by order_id.
    pub async fn cancel_order(
        &mut self,
        session: &mut Session,
        order_id: &str,
        market_name: &str,
    ) -> Result<SessionActionsResponse, O2Error> {
        Self::check_session_expiry(session)?;
        let market = self.get_market(market_name).await?;
        let contract_id = parse_hex_32(&market.contract_id)?;
        let order_id_bytes = parse_hex_32(order_id)?;

        let calls = vec![cancel_order_to_call(&contract_id, &order_id_bytes)];
        let signing_bytes = build_actions_signing_bytes(session.nonce, &calls);
        let signature = raw_sign(&session.session_private_key, &signing_bytes)?;
        let sig_hex = to_hex_string(&signature);
        let owner_hex = to_hex_string(&session.owner_address);

        let request = SessionActionsRequest {
            actions: vec![MarketActions {
                market_id: market.market_id.clone(),
                actions: vec![json!({
                    "CancelOrder": {
                        "order_id": order_id
                    }
                })],
            }],
            signature: Signature::Secp256k1(sig_hex),
            nonce: session.nonce.to_string(),
            trade_account_id: session.trade_account_id.clone(),
            session_id: Identity::Address(to_hex_string(&session.session_address)),
            collect_orders: None,
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

    /// Cancel all open orders for a market.
    pub async fn cancel_all_orders(
        &mut self,
        session: &mut Session,
        market_name: &str,
    ) -> Result<Vec<SessionActionsResponse>, O2Error> {
        Self::check_session_expiry(session)?;
        let market = self.get_market(market_name).await?;
        let orders_resp = self
            .api
            .get_orders(
                &market.market_id,
                &session.trade_account_id,
                "desc",
                200,
                Some(true),
                None,
                None,
            )
            .await?;

        let orders = orders_resp.orders.unwrap_or_default();
        let mut results = Vec::new();

        // Cancel up to 5 orders per batch
        for chunk in orders.chunks(5) {
            let contract_id = parse_hex_32(&market.contract_id)?;
            let mut calls = Vec::new();
            let mut actions_json = Vec::new();

            for order in chunk {
                if let Some(ref oid) = order.order_id {
                    let order_id_bytes = parse_hex_32(oid)?;
                    calls.push(cancel_order_to_call(&contract_id, &order_id_bytes));
                    actions_json.push(json!({
                        "CancelOrder": {
                            "order_id": oid
                        }
                    }));
                }
            }

            if calls.is_empty() {
                continue;
            }

            let signing_bytes = build_actions_signing_bytes(session.nonce, &calls);
            let signature = raw_sign(&session.session_private_key, &signing_bytes)?;
            let sig_hex = to_hex_string(&signature);
            let owner_hex = to_hex_string(&session.owner_address);

            let request = SessionActionsRequest {
                actions: vec![MarketActions {
                    market_id: market.market_id.clone(),
                    actions: actions_json,
                }],
                signature: Signature::Secp256k1(sig_hex),
                nonce: session.nonce.to_string(),
                trade_account_id: session.trade_account_id.clone(),
                session_id: Identity::Address(to_hex_string(&session.session_address)),
                collect_orders: None,
                variable_outputs: None,
            };

            let result = self.api.submit_actions(&owner_hex, &request).await;
            session.nonce += 1;
            results.push(result?);
        }

        Ok(results)
    }

    /// Submit a batch of typed actions for a single market.
    ///
    /// Handles price/quantity scaling, encoding, signing, and nonce management.
    pub async fn batch_actions(
        &mut self,
        session: &mut Session,
        market_name: &str,
        actions: Vec<Action>,
        collect_orders: bool,
    ) -> Result<SessionActionsResponse, O2Error> {
        Self::check_session_expiry(session)?;
        let market = self.get_market(market_name).await?;
        let markets_resp = self.ensure_markets().await?;
        let accounts_registry_id = markets_resp
            .accounts_registry_id
            .as_deref()
            .map(parse_hex_32)
            .transpose()?;

        let mut calls: Vec<CallArg> = Vec::new();
        let mut actions_json: Vec<serde_json::Value> = Vec::new();

        for action in &actions {
            let (call, json) = crate::encoding::action_to_call(
                action,
                &market,
                &session.trade_account_id,
                accounts_registry_id.as_ref(),
            )?;
            calls.push(call);
            actions_json.push(json);
        }

        self.batch_actions_raw(
            session,
            vec![MarketActions {
                market_id: market.market_id.clone(),
                actions: actions_json,
            }],
            calls,
            collect_orders,
        )
        .await
    }

    /// Submit a batch of raw pre-built actions for advanced use.
    ///
    /// Use this when you need full control over the `CallArg` and JSON payloads.
    pub async fn batch_actions_raw(
        &mut self,
        session: &mut Session,
        market_actions: Vec<MarketActions>,
        calls: Vec<CallArg>,
        collect_orders: bool,
    ) -> Result<SessionActionsResponse, O2Error> {
        let signing_bytes = build_actions_signing_bytes(session.nonce, &calls);
        let signature = raw_sign(&session.session_private_key, &signing_bytes)?;
        let sig_hex = to_hex_string(&signature);
        let owner_hex = to_hex_string(&session.owner_address);

        let request = SessionActionsRequest {
            actions: market_actions,
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
        market_name: &str,
    ) -> Result<SessionActionsResponse, O2Error> {
        let market = self.get_market(market_name).await?;
        let contract_id = parse_hex_32(&market.contract_id)?;
        let trade_account_id_bytes = parse_hex_32(&session.trade_account_id)?;

        let calls = vec![settle_balance_to_call(
            &contract_id,
            1,
            &trade_account_id_bytes,
        )];
        let signing_bytes = build_actions_signing_bytes(session.nonce, &calls);
        let signature = raw_sign(&session.session_private_key, &signing_bytes)?;
        let sig_hex = to_hex_string(&signature);
        let owner_hex = to_hex_string(&session.owner_address);

        let request = SessionActionsRequest {
            actions: vec![MarketActions {
                market_id: market.market_id.clone(),
                actions: vec![json!({
                    "SettleBalance": {
                        "to": {
                            "ContractId": session.trade_account_id
                        }
                    }
                })],
            }],
            signature: Signature::Secp256k1(sig_hex),
            nonce: session.nonce.to_string(),
            trade_account_id: session.trade_account_id.clone(),
            session_id: Identity::Address(to_hex_string(&session.session_address)),
            collect_orders: None,
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

    // -----------------------------------------------------------------------
    // Market Data
    // -----------------------------------------------------------------------

    /// Get order book depth.
    pub async fn get_depth(
        &mut self,
        market_name: &str,
        precision: u64,
    ) -> Result<DepthSnapshot, O2Error> {
        let market = self.get_market(market_name).await?;
        self.api.get_depth(&market.market_id, precision).await
    }

    /// Get recent trades.
    pub async fn get_trades(
        &mut self,
        market_name: &str,
        count: u32,
    ) -> Result<TradesResponse, O2Error> {
        let market = self.get_market(market_name).await?;
        self.api
            .get_trades(&market.market_id, "desc", count, None, None)
            .await
    }

    /// Get OHLCV bars.
    pub async fn get_bars(
        &mut self,
        market_name: &str,
        resolution: &str,
        from_ts: u64,
        to_ts: u64,
    ) -> Result<Vec<Bar>, O2Error> {
        let market = self.get_market(market_name).await?;
        self.api
            .get_bars(&market.market_id, from_ts, to_ts, resolution)
            .await
    }

    /// Get market ticker.
    pub async fn get_ticker(&mut self, market_name: &str) -> Result<MarketTicker, O2Error> {
        let market = self.get_market(market_name).await?;
        self.api.get_market_ticker(&market.market_id).await
    }

    // -----------------------------------------------------------------------
    // Account Data
    // -----------------------------------------------------------------------

    /// Get balances for a trading account, keyed by asset_id.
    pub async fn get_balances(
        &mut self,
        trade_account_id: &str,
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
                    if let Ok(bal) = self
                        .api
                        .get_balance(asset_id, Some(trade_account_id), None)
                        .await
                    {
                        balances.insert(symbol.clone(), bal);
                    }
                }
            }
        }

        Ok(balances)
    }

    /// Get orders for a trading account in a market.
    pub async fn get_orders(
        &mut self,
        trade_account_id: &str,
        market_name: &str,
        is_open: Option<bool>,
        count: u32,
    ) -> Result<OrdersResponse, O2Error> {
        let market = self.get_market(market_name).await?;
        self.api
            .get_orders(
                &market.market_id,
                trade_account_id,
                "desc",
                count,
                is_open,
                None,
                None,
            )
            .await
    }

    /// Get a single order.
    pub async fn get_order(&mut self, market_name: &str, order_id: &str) -> Result<Order, O2Error> {
        let market = self.get_market(market_name).await?;
        self.api.get_order(&market.market_id, order_id).await
    }

    // -----------------------------------------------------------------------
    // Nonce Management
    // -----------------------------------------------------------------------

    /// Get the current nonce for a trading account.
    pub async fn get_nonce(&self, trade_account_id: &str) -> Result<u64, O2Error> {
        let account = self.api.get_account_by_id(trade_account_id).await?;
        let nonce: u64 = account
            .trade_account
            .as_ref()
            .and_then(|ta| ta.nonce.as_deref())
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
        Ok(nonce)
    }

    /// Refresh the nonce on a session from the API.
    pub async fn refresh_nonce(&self, session: &mut Session) -> Result<u64, O2Error> {
        let nonce = self.get_nonce(&session.trade_account_id).await?;
        session.nonce = nonce;
        Ok(nonce)
    }

    // -----------------------------------------------------------------------
    // Withdrawals
    // -----------------------------------------------------------------------

    /// Withdraw assets from the trading account to the owner wallet.
    pub async fn withdraw(
        &mut self,
        owner: &Wallet,
        session: &Session,
        asset_id: &str,
        amount: &str,
        to: Option<&str>,
    ) -> Result<WithdrawResponse, O2Error> {
        let owner_hex = to_hex_string(&owner.b256_address);
        let to_address_hex = to.unwrap_or(&owner_hex);
        let to_address_bytes = parse_hex_32(to_address_hex)?;
        let asset_id_bytes = parse_hex_32(asset_id)?;
        let amount_u64: u64 = amount
            .parse()
            .map_err(|e| O2Error::Other(format!("Invalid amount: {e}")))?;

        let nonce = self.get_nonce(&session.trade_account_id).await?;
        let chain_id = self.get_chain_id().await?;

        // Build withdraw signing bytes and sign with owner wallet (personalSign)
        let signing_bytes = build_withdraw_signing_bytes(
            nonce,
            chain_id,
            0, // Address discriminant
            &to_address_bytes,
            &asset_id_bytes,
            amount_u64,
        );
        let signature = personal_sign(&owner.private_key, &signing_bytes)?;
        let sig_hex = to_hex_string(&signature);

        let request = WithdrawRequest {
            trade_account_id: session.trade_account_id.clone(),
            signature: Signature::Secp256k1(sig_hex),
            nonce: nonce.to_string(),
            to: Identity::Address(to_address_hex.to_string()),
            asset_id: asset_id.to_string(),
            amount: amount.to_string(),
        };

        self.api.withdraw(&owner_hex, &request).await
    }

    /// Withdraw assets from the trading account (EVM owner wallet).
    pub async fn withdraw_evm(
        &mut self,
        owner: &EvmWallet,
        session: &Session,
        asset_id: &str,
        amount: &str,
        to: Option<&str>,
    ) -> Result<WithdrawResponse, O2Error> {
        let owner_hex = to_hex_string(&owner.b256_address);
        let to_address_hex = to.unwrap_or(&owner_hex);
        let to_address_bytes = parse_hex_32(to_address_hex)?;
        let asset_id_bytes = parse_hex_32(asset_id)?;
        let amount_u64: u64 = amount
            .parse()
            .map_err(|e| O2Error::Other(format!("Invalid amount: {e}")))?;

        let nonce = self.get_nonce(&session.trade_account_id).await?;
        let chain_id = self.get_chain_id().await?;

        let signing_bytes = build_withdraw_signing_bytes(
            nonce,
            chain_id,
            0,
            &to_address_bytes,
            &asset_id_bytes,
            amount_u64,
        );
        let signature = evm_personal_sign(&owner.private_key, &signing_bytes)?;
        let sig_hex = to_hex_string(&signature);

        let request = WithdrawRequest {
            trade_account_id: session.trade_account_id.clone(),
            signature: Signature::Secp256k1(sig_hex),
            nonce: nonce.to_string(),
            to: Identity::Address(to_address_hex.to_string()),
            asset_id: asset_id.to_string(),
            amount: amount.to_string(),
        };

        self.api.withdraw(&owner_hex, &request).await
    }

    // -----------------------------------------------------------------------
    // WebSocket Streaming
    // -----------------------------------------------------------------------

    /// Connect to WebSocket and stream depth updates.
    pub async fn stream_depth(
        &self,
        market_id: &str,
        precision: &str,
    ) -> Result<(O2WebSocket, TypedStream<DepthUpdate>), O2Error> {
        let ws = O2WebSocket::connect(&self.config.ws_url).await?;
        let stream = ws.stream_depth(market_id, precision).await?;
        Ok((ws, stream))
    }

    /// Connect to WebSocket and stream order updates.
    pub async fn stream_orders(
        &self,
        identities: &[Identity],
    ) -> Result<(O2WebSocket, TypedStream<OrderUpdate>), O2Error> {
        let ws = O2WebSocket::connect(&self.config.ws_url).await?;
        let stream = ws.stream_orders(identities).await?;
        Ok((ws, stream))
    }

    /// Connect to WebSocket and stream trade updates.
    pub async fn stream_trades(
        &self,
        market_id: &str,
    ) -> Result<(O2WebSocket, TypedStream<TradeUpdate>), O2Error> {
        let ws = O2WebSocket::connect(&self.config.ws_url).await?;
        let stream = ws.stream_trades(market_id).await?;
        Ok((ws, stream))
    }

    /// Connect to WebSocket and stream balance updates.
    pub async fn stream_balances(
        &self,
        identities: &[Identity],
    ) -> Result<(O2WebSocket, TypedStream<BalanceUpdate>), O2Error> {
        let ws = O2WebSocket::connect(&self.config.ws_url).await?;
        let stream = ws.stream_balances(identities).await?;
        Ok((ws, stream))
    }

    /// Connect to WebSocket and stream nonce updates.
    pub async fn stream_nonce(
        &self,
        identities: &[Identity],
    ) -> Result<(O2WebSocket, TypedStream<NonceUpdate>), O2Error> {
        let ws = O2WebSocket::connect(&self.config.ws_url).await?;
        let stream = ws.stream_nonce(identities).await?;
        Ok((ws, stream))
    }
}
