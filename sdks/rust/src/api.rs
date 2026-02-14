/// REST API client for O2 Exchange.
///
/// Typed wrappers for every REST endpoint from the O2 API reference.
/// Uses reqwest for HTTP with JSON support.
use std::any::type_name;

use log::debug;
use reqwest::Client;
use serde_json::json;

use crate::config::NetworkConfig;
use crate::errors::O2Error;
use crate::models::*;

/// Low-level REST API client for the O2 Exchange.
#[derive(Debug, Clone)]
pub struct O2Api {
    client: Client,
    config: NetworkConfig,
}

impl O2Api {
    /// Create a new API client with the given network configuration.
    pub fn new(config: NetworkConfig) -> Self {
        Self {
            client: Client::new(),
            config,
        }
    }

    /// Parse an API response, detecting error codes and returning typed errors.
    async fn parse_response<T: serde::de::DeserializeOwned>(
        &self,
        response: reqwest::Response,
    ) -> Result<T, O2Error> {
        let status = response.status();
        let text = response.text().await?;
        let target_type = type_name::<T>();
        debug!(
            "api.parse_response status={} target_type={} body_len={}",
            status,
            target_type,
            text.len()
        );

        if !status.is_success() {
            debug!(
                "api.parse_response non_success status={} body={}",
                status, text
            );
            // Try to parse as API error
            if let Ok(err) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(code) = err.get("code").and_then(|c| c.as_u64()) {
                    let message = err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Unknown error")
                        .to_string();
                    return Err(O2Error::from_code(code as u32, message));
                }
                if let Some(message) = err.get("message").and_then(|m| m.as_str()) {
                    let reason = err
                        .get("reason")
                        .and_then(|r| r.as_str())
                        .unwrap_or("")
                        .to_string();
                    return Err(O2Error::OnChainRevert {
                        message: message.to_string(),
                        reason,
                        receipts: err.get("receipts").cloned(),
                    });
                }
            }
            return Err(O2Error::HttpError(format!("HTTP {}: {}", status, text)));
        }

        match serde_json::from_str(&text) {
            Ok(parsed) => {
                debug!("api.parse_response decode_ok target_type={}", target_type);
                Ok(parsed)
            }
            Err(e) => {
                debug!(
                    "api.parse_response decode_failed target_type={} error={}",
                    target_type, e
                );
                Err(O2Error::JsonError(format!(
                    "Failed to parse response: {e}\nBody: {}",
                    &text[..text.len().min(500)]
                )))
            }
        }
    }

    // -----------------------------------------------------------------------
    // Market Data
    // -----------------------------------------------------------------------

    /// GET /v1/markets - List all markets.
    pub async fn get_markets(&self) -> Result<MarketsResponse, O2Error> {
        debug!("api.get_markets");
        let url = format!("{}/v1/markets", self.config.api_base);
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/markets/summary - 24-hour market statistics.
    pub async fn get_market_summary(&self, market_id: &str) -> Result<Vec<MarketSummary>, O2Error> {
        debug!("api.get_market_summary market_id={}", market_id);
        let url = format!("{}/v1/markets/summary", self.config.api_base);
        let resp = self
            .client
            .get(&url)
            .query(&[("market_id", market_id)])
            .send()
            .await?;
        self.parse_response(resp).await
    }

    /// GET /v1/markets/ticker - Real-time ticker data.
    pub async fn get_market_ticker(&self, market_id: &str) -> Result<Vec<MarketTicker>, O2Error> {
        debug!("api.get_market_ticker market_id={}", market_id);
        let url = format!("{}/v1/markets/ticker", self.config.api_base);
        let resp = self
            .client
            .get(&url)
            .query(&[("market_id", market_id)])
            .send()
            .await?;
        self.parse_response(resp).await
    }

    // -----------------------------------------------------------------------
    // Depth
    // -----------------------------------------------------------------------

    /// GET /v1/depth - Order book depth.
    pub async fn get_depth(
        &self,
        market_id: &str,
        precision: u64,
    ) -> Result<DepthSnapshot, O2Error> {
        debug!(
            "api.get_depth market_id={} precision={}",
            market_id, precision
        );
        let url = format!("{}/v1/depth", self.config.api_base);
        let precision_str = precision.to_string();
        let resp = self
            .client
            .get(&url)
            .query(&[
                ("market_id", market_id),
                ("precision", precision_str.as_str()),
            ])
            .send()
            .await?;
        let val: serde_json::Value = self.parse_response(resp).await?;
        // API wraps depth in "orders" or "view" field; unwrap it
        let depth = val
            .get("orders")
            .or_else(|| val.get("view"))
            .unwrap_or(&val);
        serde_json::from_value(depth.clone())
            .map_err(|e| O2Error::JsonError(format!("Failed to parse depth: {e}")))
    }

    // -----------------------------------------------------------------------
    // Trades
    // -----------------------------------------------------------------------

    /// GET /v1/trades - Recent trade history.
    pub async fn get_trades(
        &self,
        market_id: &str,
        direction: &str,
        count: u32,
        start_timestamp: Option<u64>,
        start_trade_id: Option<&str>,
    ) -> Result<TradesResponse, O2Error> {
        debug!(
            "api.get_trades market_id={} direction={} count={} start_timestamp={:?} start_trade_id={:?}",
            market_id, direction, count, start_timestamp, start_trade_id
        );
        let url = format!("{}/v1/trades", self.config.api_base);
        let count_str = count.to_string();
        let start_timestamp_str = start_timestamp.map(|ts| ts.to_string());
        let mut query: Vec<(&str, &str)> = vec![
            ("market_id", market_id),
            ("direction", direction),
            ("count", count_str.as_str()),
        ];
        if let Some(ts) = start_timestamp_str.as_deref() {
            query.push(("start_timestamp", ts));
        }
        if let Some(tid) = start_trade_id {
            query.push(("start_trade_id", tid));
        }
        let resp = self.client.get(&url).query(&query).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/trades_by_account - Trades by account.
    pub async fn get_trades_by_account(
        &self,
        market_id: &str,
        contract: &str,
        direction: &str,
        count: u32,
    ) -> Result<TradesResponse, O2Error> {
        debug!(
            "api.get_trades_by_account market_id={} contract={} direction={} count={}",
            market_id, contract, direction, count
        );
        let url = format!("{}/v1/trades_by_account", self.config.api_base);
        let count_str = count.to_string();
        let resp = self
            .client
            .get(&url)
            .query(&[
                ("market_id", market_id),
                ("contract", contract),
                ("direction", direction),
                ("count", count_str.as_str()),
            ])
            .send()
            .await?;
        self.parse_response(resp).await
    }

    /// GET /v1/bars - OHLCV candlestick data.
    pub async fn get_bars(
        &self,
        market_id: &str,
        from_ts: u64,
        to_ts: u64,
        resolution: &str,
    ) -> Result<Vec<Bar>, O2Error> {
        debug!(
            "api.get_bars market_id={} from_ts={} to_ts={} resolution={}",
            market_id, from_ts, to_ts, resolution
        );
        let url = format!("{}/v1/bars", self.config.api_base);
        let from_ts_str = from_ts.to_string();
        let to_ts_str = to_ts.to_string();
        let resp = self
            .client
            .get(&url)
            .query(&[
                ("market_id", market_id),
                ("from", from_ts_str.as_str()),
                ("to", to_ts_str.as_str()),
                ("resolution", resolution),
            ])
            .send()
            .await?;
        let val: serde_json::Value = self.parse_response(resp).await?;
        let bars_val = val.get("bars").unwrap_or(&val);
        serde_json::from_value(bars_val.clone())
            .map_err(|e| O2Error::JsonError(format!("Failed to parse bars: {e}")))
    }

    // -----------------------------------------------------------------------
    // Account & Balance
    // -----------------------------------------------------------------------

    /// POST /v1/accounts - Create a trading account.
    pub async fn create_account(
        &self,
        owner_address: &str,
    ) -> Result<CreateAccountResponse, O2Error> {
        debug!("api.create_account owner_address={}", owner_address);
        let url = format!("{}/v1/accounts", self.config.api_base);
        let body = json!({
            "identity": {
                "Address": owner_address
            }
        });
        let resp = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;
        self.parse_response(resp).await
    }

    /// GET /v1/accounts - Get account info by owner address.
    pub async fn get_account_by_owner(&self, owner: &str) -> Result<AccountResponse, O2Error> {
        debug!("api.get_account_by_owner owner={}", owner);
        let url = format!("{}/v1/accounts", self.config.api_base);
        let resp = self
            .client
            .get(&url)
            .query(&[("owner", owner)])
            .send()
            .await?;
        self.parse_response(resp).await
    }

    /// GET /v1/accounts - Get account info by trade_account_id.
    pub async fn get_account_by_id(
        &self,
        trade_account_id: &str,
    ) -> Result<AccountResponse, O2Error> {
        debug!(
            "api.get_account_by_id trade_account_id={}",
            trade_account_id
        );
        let url = format!("{}/v1/accounts", self.config.api_base);
        let resp = self
            .client
            .get(&url)
            .query(&[("trade_account_id", trade_account_id)])
            .send()
            .await?;
        self.parse_response(resp).await
    }

    /// GET /v1/balance - Get asset balance.
    pub async fn get_balance(
        &self,
        asset_id: &str,
        contract: Option<&str>,
        address: Option<&str>,
    ) -> Result<BalanceResponse, O2Error> {
        debug!(
            "api.get_balance asset_id={} contract={:?} address={:?}",
            asset_id, contract, address
        );
        let url = format!("{}/v1/balance", self.config.api_base);
        let mut query: Vec<(&str, &str)> = vec![("asset_id", asset_id)];
        if let Some(c) = contract {
            query.push(("contract", c));
        }
        if let Some(a) = address {
            query.push(("address", a));
        }
        let resp = self.client.get(&url).query(&query).send().await?;
        self.parse_response(resp).await
    }

    // -----------------------------------------------------------------------
    // Orders
    // -----------------------------------------------------------------------

    /// GET /v1/orders - Get order history.
    #[allow(clippy::too_many_arguments)]
    pub async fn get_orders(
        &self,
        market_id: &str,
        contract: &str,
        direction: &str,
        count: u32,
        is_open: Option<bool>,
        start_timestamp: Option<u64>,
        start_order_id: Option<&str>,
    ) -> Result<OrdersResponse, O2Error> {
        debug!(
            "api.get_orders market_id={} contract={} direction={} count={} is_open={:?} start_timestamp={:?} start_order_id={:?}",
            market_id, contract, direction, count, is_open, start_timestamp, start_order_id
        );
        let url = format!("{}/v1/orders", self.config.api_base);
        let count_str = count.to_string();
        let is_open_str = is_open.map(|open| open.to_string());
        let start_timestamp_str = start_timestamp.map(|ts| ts.to_string());
        let mut query: Vec<(&str, &str)> = vec![
            ("market_id", market_id),
            ("contract", contract),
            ("direction", direction),
            ("count", count_str.as_str()),
        ];
        if let Some(open) = is_open_str.as_deref() {
            query.push(("is_open", open));
        }
        if let Some(ts) = start_timestamp_str.as_deref() {
            query.push(("start_timestamp", ts));
        }
        if let Some(oid) = start_order_id {
            query.push(("start_order_id", oid));
        }
        let resp = self.client.get(&url).query(&query).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/order - Get a single order.
    pub async fn get_order(&self, market_id: &str, order_id: &str) -> Result<Order, O2Error> {
        debug!(
            "api.get_order market_id={} order_id={}",
            market_id, order_id
        );
        let url = format!("{}/v1/order", self.config.api_base);
        let resp = self
            .client
            .get(&url)
            .query(&[("market_id", market_id), ("order_id", order_id)])
            .send()
            .await?;
        let val: serde_json::Value = self.parse_response(resp).await?;
        // API wraps order in an "order" key
        let order_val = val.get("order").unwrap_or(&val);
        serde_json::from_value(order_val.clone())
            .map_err(|e| O2Error::JsonError(format!("Failed to parse order: {e}")))
    }

    // -----------------------------------------------------------------------
    // Session Management
    // -----------------------------------------------------------------------

    /// PUT /v1/session - Create or update a trading session.
    pub async fn create_session(
        &self,
        owner_id: &str,
        request: &SessionRequest,
    ) -> Result<SessionResponse, O2Error> {
        debug!(
            "api.create_session owner_id={} contract_id={} nonce={} expiry={}",
            owner_id, request.contract_id, request.nonce, request.expiry
        );
        let url = format!("{}/v1/session", self.config.api_base);
        let resp = self
            .client
            .put(&url)
            .header("Content-Type", "application/json")
            .header("O2-Owner-Id", owner_id)
            .json(request)
            .send()
            .await?;
        self.parse_response(resp).await
    }

    /// POST /v1/session/actions - Execute trading actions.
    pub(crate) async fn submit_actions(
        &self,
        owner_id: &str,
        request: &SessionActionsRequest,
    ) -> Result<SessionActionsResponse, O2Error> {
        debug!(
            "api.submit_actions owner_id={} nonce={} markets={} collect_orders={:?}",
            owner_id,
            request.nonce,
            request.actions.len(),
            request.collect_orders
        );
        let url = format!("{}/v1/session/actions", self.config.api_base);
        let resp = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("O2-Owner-Id", owner_id)
            .json(request)
            .send()
            .await?;
        // Reuse standard status/error handling first; this ensures non-2xx
        // responses are mapped consistently with the rest of the SDK.
        let val: serde_json::Value = self.parse_response(resp).await?;

        // Parse as Value first for robustness, then extract fields.
        // The Order struct can have unexpected field types across API versions,
        // so we parse orders separately with a fallback.
        let tx_id = val.get("tx_id").and_then(|v| v.as_str()).map(TxId::from);
        let code = val.get("code").and_then(|v| v.as_u64()).map(|v| v as u32);
        let message = val
            .get("message")
            .and_then(|v| v.as_str())
            .map(String::from);
        let reason = val.get("reason").and_then(|v| v.as_str()).map(String::from);
        let receipts = val.get("receipts").cloned();
        let orders = val
            .get("orders")
            .and_then(|o| serde_json::from_value::<Vec<Order>>(o.clone()).ok());

        let parsed = SessionActionsResponse {
            tx_id,
            orders,
            code,
            message,
            reason,
            receipts,
        };

        // Check for errors
        if parsed.is_success() {
            debug!("api.submit_actions parsed=success tx_id={:?}", parsed.tx_id);
            Ok(parsed)
        } else if parsed.is_preflight_error() {
            let code = parsed.code.unwrap_or(0);
            let message = parsed.message.unwrap_or_default();
            debug!(
                "api.submit_actions parsed=preflight_error code={} message={}",
                code, message
            );
            Err(O2Error::from_code(code, message))
        } else if parsed.is_onchain_error() {
            debug!(
                "api.submit_actions parsed=onchain_error message={:?} reason={:?}",
                parsed.message, parsed.reason
            );
            Err(O2Error::OnChainRevert {
                message: parsed.message.unwrap_or_default(),
                reason: parsed.reason.unwrap_or_default(),
                receipts: parsed.receipts,
            })
        } else {
            // Ambiguous — return as-is for caller to handle
            debug!("api.submit_actions parsed=ambiguous returning_raw_response");
            Ok(parsed)
        }
    }

    // -----------------------------------------------------------------------
    // Account Operations
    // -----------------------------------------------------------------------

    /// POST /v1/accounts/withdraw - Withdraw assets.
    pub async fn withdraw(
        &self,
        owner_id: &str,
        request: &WithdrawRequest,
    ) -> Result<WithdrawResponse, O2Error> {
        debug!(
            "api.withdraw owner_id={} trade_account_id={} asset_id={} amount={} nonce={}",
            owner_id, request.trade_account_id, request.asset_id, request.amount, request.nonce
        );
        let url = format!("{}/v1/accounts/withdraw", self.config.api_base);
        let resp = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("O2-Owner-Id", owner_id)
            .json(request)
            .send()
            .await?;
        self.parse_response(resp).await
    }

    // -----------------------------------------------------------------------
    // Analytics
    // -----------------------------------------------------------------------

    /// POST /analytics/v1/whitelist - Whitelist a trading account.
    pub async fn whitelist_account(
        &self,
        trade_account_id: &str,
    ) -> Result<WhitelistResponse, O2Error> {
        debug!(
            "api.whitelist_account trade_account_id={}",
            trade_account_id
        );
        let url = format!("{}/analytics/v1/whitelist", self.config.api_base);
        let body = WhitelistRequest {
            trade_account: trade_account_id.to_string(),
        };
        let resp = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;
        self.parse_response(resp).await
    }

    /// GET /analytics/v1/referral/code-info - Look up referral code.
    pub async fn get_referral_info(&self, code: &str) -> Result<ReferralInfo, O2Error> {
        debug!("api.get_referral_info code={}", code);
        let url = format!("{}/analytics/v1/referral/code-info", self.config.api_base);
        let resp = self
            .client
            .get(&url)
            .query(&[("code", code)])
            .send()
            .await?;
        self.parse_response(resp).await
    }

    // -----------------------------------------------------------------------
    // Aggregated Endpoints
    // -----------------------------------------------------------------------

    /// GET /v1/aggregated/assets - List all trading assets.
    pub async fn get_aggregated_assets(&self) -> Result<AggregatedAssets, O2Error> {
        debug!("api.get_aggregated_assets");
        let url = format!("{}/v1/aggregated/assets", self.config.api_base);
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/aggregated/orderbook - Order book depth by pair name.
    pub async fn get_aggregated_orderbook(
        &self,
        market_pair: &str,
        depth: u32,
        level: u32,
    ) -> Result<AggregatedOrderbook, O2Error> {
        debug!(
            "api.get_aggregated_orderbook market_pair={} depth={} level={}",
            market_pair, depth, level
        );
        let url = format!("{}/v1/aggregated/orderbook", self.config.api_base);
        let depth_str = depth.to_string();
        let level_str = level.to_string();
        let resp = self
            .client
            .get(&url)
            .query(&[
                ("market_pair", market_pair),
                ("depth", depth_str.as_str()),
                ("level", level_str.as_str()),
            ])
            .send()
            .await?;
        self.parse_response(resp).await
    }

    /// GET /v1/aggregated/coingecko/orderbook - CoinGecko orderbook depth by ticker ID.
    pub async fn get_aggregated_coingecko_orderbook(
        &self,
        ticker_id: &str,
        depth: u32,
    ) -> Result<CoingeckoAggregatedOrderbook, O2Error> {
        debug!(
            "api.get_aggregated_coingecko_orderbook ticker_id={} depth={}",
            ticker_id, depth
        );
        let url = format!("{}/v1/aggregated/coingecko/orderbook", self.config.api_base);
        let depth_str = depth.to_string();
        let resp = self
            .client
            .get(&url)
            .query(&[("ticker_id", ticker_id), ("depth", depth_str.as_str())])
            .send()
            .await?;
        self.parse_response(resp).await
    }

    /// GET /v1/aggregated/summary - 24-hour stats for all pairs.
    pub async fn get_aggregated_summary(&self) -> Result<Vec<PairSummary>, O2Error> {
        debug!("api.get_aggregated_summary");
        let url = format!("{}/v1/aggregated/summary", self.config.api_base);
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/aggregated/ticker - Real-time ticker for all pairs.
    pub async fn get_aggregated_ticker(&self) -> Result<AggregatedTicker, O2Error> {
        debug!("api.get_aggregated_ticker");
        let url = format!("{}/v1/aggregated/ticker", self.config.api_base);
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/aggregated/coingecko/tickers - CoinGecko ticker format.
    pub async fn get_aggregated_coingecko_tickers(&self) -> Result<Vec<PairTicker>, O2Error> {
        debug!("api.get_aggregated_coingecko_tickers");
        let url = format!("{}/v1/aggregated/coingecko/tickers", self.config.api_base);
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/aggregated/trades - Recent trades for a pair.
    pub async fn get_aggregated_trades(
        &self,
        market_pair: &str,
    ) -> Result<Vec<AggregatedTrade>, O2Error> {
        debug!("api.get_aggregated_trades market_pair={}", market_pair);
        let url = format!("{}/v1/aggregated/trades", self.config.api_base);
        let resp = self
            .client
            .get(&url)
            .query(&[("market_pair", market_pair)])
            .send()
            .await?;
        self.parse_response(resp).await
    }

    // -----------------------------------------------------------------------
    // Faucet
    // -----------------------------------------------------------------------

    /// Mint tokens to a wallet address via the faucet (testnet/devnet only).
    pub async fn mint_to_address(&self, address: &str) -> Result<FaucetResponse, O2Error> {
        debug!("api.mint_to_address address={}", address);
        let faucet_url = self
            .config
            .faucet_url
            .as_ref()
            .ok_or_else(|| O2Error::Other("Faucet not available on this network".into()))?;

        let body = json!({ "address": address });
        let resp = self
            .client
            .post(faucet_url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;
        self.parse_response(resp).await
    }

    /// Mint tokens directly to a trading account contract via the faucet (testnet/devnet only).
    pub async fn mint_to_contract(&self, contract_id: &str) -> Result<FaucetResponse, O2Error> {
        debug!("api.mint_to_contract contract_id={}", contract_id);
        let faucet_url = self
            .config
            .faucet_url
            .as_ref()
            .ok_or_else(|| O2Error::Other("Faucet not available on this network".into()))?;

        let body = json!({ "contract": contract_id });
        let resp = self
            .client
            .post(faucet_url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;
        self.parse_response(resp).await
    }
}
