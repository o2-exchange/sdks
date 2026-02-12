/// REST API client for O2 Exchange.
///
/// Typed wrappers for every REST endpoint from the O2 API reference.
/// Uses reqwest for HTTP with JSON support.
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

        if !status.is_success() {
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

        serde_json::from_str(&text).map_err(|e| {
            O2Error::JsonError(format!(
                "Failed to parse response: {e}\nBody: {}",
                &text[..text.len().min(500)]
            ))
        })
    }

    // -----------------------------------------------------------------------
    // Market Data
    // -----------------------------------------------------------------------

    /// GET /v1/markets - List all markets.
    pub async fn get_markets(&self) -> Result<MarketsResponse, O2Error> {
        let url = format!("{}/v1/markets", self.config.api_base);
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/markets/summary - 24-hour market statistics.
    pub async fn get_market_summary(&self, market_id: &str) -> Result<MarketSummary, O2Error> {
        let url = format!(
            "{}/v1/markets/summary?market_id={}",
            self.config.api_base, market_id
        );
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/markets/ticker - Real-time ticker data.
    pub async fn get_market_ticker(&self, market_id: &str) -> Result<MarketTicker, O2Error> {
        let url = format!(
            "{}/v1/markets/ticker?market_id={}",
            self.config.api_base, market_id
        );
        let resp = self.client.get(&url).send().await?;
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
        let url = format!(
            "{}/v1/depth?market_id={}&precision={}",
            self.config.api_base, market_id, precision
        );
        let resp = self.client.get(&url).send().await?;
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
        let mut url = format!(
            "{}/v1/trades?market_id={}&direction={}&count={}",
            self.config.api_base, market_id, direction, count
        );
        if let Some(ts) = start_timestamp {
            url.push_str(&format!("&start_timestamp={}", ts));
        }
        if let Some(tid) = start_trade_id {
            url.push_str(&format!("&start_trade_id={}", tid));
        }
        let resp = self.client.get(&url).send().await?;
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
        let url = format!(
            "{}/v1/trades_by_account?market_id={}&contract={}&direction={}&count={}",
            self.config.api_base, market_id, contract, direction, count
        );
        let resp = self.client.get(&url).send().await?;
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
        let url = format!(
            "{}/v1/bars?market_id={}&from={}&to={}&resolution={}",
            self.config.api_base, market_id, from_ts, to_ts, resolution
        );
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    // -----------------------------------------------------------------------
    // Account & Balance
    // -----------------------------------------------------------------------

    /// POST /v1/accounts - Create a trading account.
    pub async fn create_account(
        &self,
        owner_address: &str,
    ) -> Result<CreateAccountResponse, O2Error> {
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
        let url = format!("{}/v1/accounts?owner={}", self.config.api_base, owner);
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/accounts - Get account info by trade_account_id.
    pub async fn get_account_by_id(
        &self,
        trade_account_id: &str,
    ) -> Result<AccountResponse, O2Error> {
        let url = format!(
            "{}/v1/accounts?trade_account_id={}",
            self.config.api_base, trade_account_id
        );
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/balance - Get asset balance.
    pub async fn get_balance(
        &self,
        asset_id: &str,
        contract: Option<&str>,
        address: Option<&str>,
    ) -> Result<BalanceResponse, O2Error> {
        let mut url = format!("{}/v1/balance?asset_id={}", self.config.api_base, asset_id);
        if let Some(c) = contract {
            url.push_str(&format!("&contract={}", c));
        }
        if let Some(a) = address {
            url.push_str(&format!("&address={}", a));
        }
        let resp = self.client.get(&url).send().await?;
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
        let mut url = format!(
            "{}/v1/orders?market_id={}&contract={}&direction={}&count={}",
            self.config.api_base, market_id, contract, direction, count
        );
        if let Some(open) = is_open {
            url.push_str(&format!("&is_open={}", open));
        }
        if let Some(ts) = start_timestamp {
            url.push_str(&format!("&start_timestamp={}", ts));
        }
        if let Some(oid) = start_order_id {
            url.push_str(&format!("&start_order_id={}", oid));
        }
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/order - Get a single order.
    pub async fn get_order(&self, market_id: &str, order_id: &str) -> Result<Order, O2Error> {
        let url = format!(
            "{}/v1/order?market_id={}&order_id={}",
            self.config.api_base, market_id, order_id
        );
        let resp = self.client.get(&url).send().await?;
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
        let url = format!("{}/v1/session/actions", self.config.api_base);
        let resp = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("O2-Owner-Id", owner_id)
            .json(request)
            .send()
            .await?;

        let text = resp.text().await?;

        // Parse as Value first for robustness, then extract fields.
        // The Order struct can have unexpected field types across API versions,
        // so we parse orders separately with a fallback.
        let val: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
            O2Error::JsonError(format!(
                "Failed to parse actions response JSON: {e}\nBody: {}",
                &text[..text.len().min(500)]
            ))
        })?;

        let tx_id = val.get("tx_id").and_then(|v| v.as_str()).map(String::from);
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
            Ok(parsed)
        } else if parsed.is_preflight_error() {
            let code = parsed.code.unwrap_or(0);
            let message = parsed.message.unwrap_or_default();
            Err(O2Error::from_code(code, message))
        } else if parsed.is_onchain_error() {
            Err(O2Error::OnChainRevert {
                message: parsed.message.unwrap_or_default(),
                reason: parsed.reason.unwrap_or_default(),
                receipts: parsed.receipts,
            })
        } else {
            // Ambiguous — return as-is for caller to handle
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
        let url = format!(
            "{}/analytics/v1/referral/code-info?code={}",
            self.config.api_base, code
        );
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    // -----------------------------------------------------------------------
    // Aggregated Endpoints
    // -----------------------------------------------------------------------

    /// GET /v1/aggregated/assets - List all trading assets.
    pub async fn get_aggregated_assets(&self) -> Result<Vec<AggregatedAsset>, O2Error> {
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
        let url = format!(
            "{}/v1/aggregated/orderbook?market_pair={}&depth={}&level={}",
            self.config.api_base, market_pair, depth, level
        );
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/aggregated/summary - 24-hour stats for all pairs.
    pub async fn get_aggregated_summary(&self) -> Result<Vec<PairSummary>, O2Error> {
        let url = format!("{}/v1/aggregated/summary", self.config.api_base);
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/aggregated/ticker - Real-time ticker for all pairs.
    pub async fn get_aggregated_ticker(&self) -> Result<Vec<PairTicker>, O2Error> {
        let url = format!("{}/v1/aggregated/ticker", self.config.api_base);
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    /// GET /v1/aggregated/trades - Recent trades for a pair.
    pub async fn get_aggregated_trades(&self, market_pair: &str) -> Result<Vec<Trade>, O2Error> {
        let url = format!(
            "{}/v1/aggregated/trades?market_pair={}",
            self.config.api_base, market_pair
        );
        let resp = self.client.get(&url).send().await?;
        self.parse_response(resp).await
    }

    // -----------------------------------------------------------------------
    // Faucet
    // -----------------------------------------------------------------------

    /// Mint tokens to a wallet address via the faucet (testnet/devnet only).
    pub async fn mint_to_address(&self, address: &str) -> Result<FaucetResponse, O2Error> {
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
