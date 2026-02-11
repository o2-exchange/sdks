/// Data models for O2 Exchange API types.
///
/// All models use serde for JSON serialization/deserialization.
/// String fields are used for large numeric values to avoid precision loss.
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

/// Deserialize a value that may be a JSON number or a string containing a number.
fn deserialize_string_or_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de;

    struct StringOrU64;
    impl<'de> de::Visitor<'de> for StringOrU64 {
        type Value = u64;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a u64 or a string containing a u64")
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<u64, E> {
            Ok(v)
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<u64, E> {
            v.parse().map_err(de::Error::custom)
        }
    }
    deserializer.deserialize_any(StringOrU64)
}

/// Deserialize an optional value that may be a JSON number or a string, storing as String.
fn deserialize_optional_string_or_number<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value: Option<serde_json::Value> = Option::deserialize(deserializer)?;
    match value {
        Some(serde_json::Value::String(s)) => Ok(Some(s)),
        Some(serde_json::Value::Number(n)) => Ok(Some(n.to_string())),
        Some(serde_json::Value::Null) | None => Ok(None),
        Some(v) => Ok(Some(v.to_string())),
    }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/// A Fuel Identity — either an Address or a ContractId.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Identity {
    Address(String),
    ContractId(String),
}

impl Identity {
    pub fn address_value(&self) -> &str {
        match self {
            Identity::Address(a) => a,
            Identity::ContractId(c) => c,
        }
    }
}

/// A signature wrapper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Signature {
    Secp256k1(String),
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

/// Asset info within a market.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketAsset {
    pub symbol: String,
    pub asset: String,
    pub decimals: u32,
    pub max_precision: u32,
}

/// A trading market.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Market {
    pub contract_id: String,
    pub market_id: String,
    pub maker_fee: String,
    pub taker_fee: String,
    pub min_order: String,
    pub dust: String,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub price_window: u64,
    pub base: MarketAsset,
    pub quote: MarketAsset,
}

impl Market {
    /// Convert a chain-scaled price to human-readable.
    pub fn format_price(&self, chain_value: u64) -> f64 {
        chain_value as f64 / 10f64.powi(self.quote.decimals as i32)
    }

    /// Convert a human-readable price to chain-scaled integer, truncated to max_precision.
    pub fn scale_price(&self, human_value: f64) -> u64 {
        let scaled = (human_value * 10f64.powi(self.quote.decimals as i32)) as u64;
        let truncate_factor = 10u64.pow(self.quote.decimals - self.quote.max_precision);
        (scaled / truncate_factor) * truncate_factor
    }

    /// Convert a chain-scaled quantity to human-readable.
    pub fn format_quantity(&self, chain_value: u64) -> f64 {
        chain_value as f64 / 10f64.powi(self.base.decimals as i32)
    }

    /// Convert a human-readable quantity to chain-scaled integer, truncated to max_precision.
    pub fn scale_quantity(&self, human_value: f64) -> u64 {
        let scaled = (human_value * 10f64.powi(self.base.decimals as i32)) as u64;
        let truncate_factor = 10u64.pow(self.base.decimals - self.base.max_precision);
        (scaled / truncate_factor) * truncate_factor
    }

    /// The symbol pair string, e.g. "FUEL/USDC".
    pub fn symbol_pair(&self) -> String {
        format!("{}/{}", self.base.symbol, self.quote.symbol)
    }

    /// Validate that a price*quantity satisfies min_order and FractionalPrice constraints.
    pub fn validate_order(&self, price: u64, quantity: u64) -> Result<(), String> {
        let base_factor = 10u128.pow(self.base.decimals);
        let quote_value = (price as u128 * quantity as u128) / base_factor;
        let min_order: u128 = self.min_order.parse().unwrap_or(0);
        if quote_value < min_order {
            return Err(format!(
                "Quote value {} below min_order {}",
                quote_value, min_order
            ));
        }
        // FractionalPrice check
        if (price as u128 * quantity as u128) % base_factor != 0 {
            return Err("FractionalPrice: (price * quantity) % 10^base_decimals != 0".into());
        }
        Ok(())
    }
}

/// Top-level response from GET /v1/markets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketsResponse {
    pub books_registry_id: Option<String>,
    pub accounts_registry_id: Option<String>,
    pub trade_account_oracle_id: Option<String>,
    pub chain_id: Option<String>,
    pub base_asset_id: Option<String>,
    pub markets: Vec<Market>,
}

/// Market summary from GET /v1/markets/summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketSummary {
    pub market_id: Option<String>,
    pub high: Option<String>,
    pub low: Option<String>,
    pub volume: Option<String>,
    pub price_change: Option<String>,
    pub last_price: Option<String>,
}

/// Market ticker from GET /v1/markets/ticker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketTicker {
    pub market_id: Option<String>,
    pub best_bid: Option<String>,
    pub best_ask: Option<String>,
    pub last_price: Option<String>,
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/// Trading account info from GET /v1/accounts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeAccount {
    pub last_modification: Option<u64>,
    pub nonce: Option<String>,
    pub owner: Option<Identity>,
    #[serde(default)]
    pub synced_with_network: Option<bool>,
    #[serde(default)]
    pub sync_state: Option<serde_json::Value>,
}

/// Account response from GET /v1/accounts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountResponse {
    pub trade_account_id: Option<String>,
    pub trade_account: Option<TradeAccount>,
    pub session: Option<SessionInfo>,
}

/// Session info within an account response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: Option<Identity>,
    pub expiry: Option<String>,
    pub contract_ids: Option<Vec<String>>,
}

/// Response from POST /v1/accounts (create account).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAccountResponse {
    pub trade_account_id: Option<String>,
    pub nonce: Option<String>,
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/// Request body for PUT /v1/session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRequest {
    pub contract_id: String,
    pub session_id: Identity,
    pub signature: Signature,
    pub contract_ids: Vec<String>,
    pub nonce: String,
    pub expiry: String,
}

/// Response from PUT /v1/session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResponse {
    pub tx_id: Option<String>,
    pub trade_account_id: Option<String>,
    pub contract_ids: Option<Vec<String>>,
    pub session_id: Option<Identity>,
    pub session_expiry: Option<String>,
}

/// Local session state tracked by the client.
#[derive(Debug, Clone)]
pub struct Session {
    pub owner_address: [u8; 32],
    pub session_private_key: [u8; 32],
    pub session_address: [u8; 32],
    pub trade_account_id: String,
    pub contract_ids: Vec<String>,
    pub expiry: u64,
    pub nonce: u64,
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/// An order from the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub order_id: Option<String>,
    pub side: Option<String>,
    pub order_type: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "deserialize_optional_string_or_number")]
    pub quantity: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string_or_number")]
    pub quantity_fill: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string_or_number")]
    pub price: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string_or_number")]
    pub price_fill: Option<String>,
    pub timestamp: Option<serde_json::Value>,
    pub close: Option<bool>,
    pub partially_filled: Option<bool>,
    pub cancel: Option<bool>,
    #[serde(default)]
    pub desired_quantity: Option<serde_json::Value>,
    #[serde(default)]
    pub base_decimals: Option<u32>,
    #[serde(default)]
    pub account: Option<Identity>,
    #[serde(default)]
    pub fill: Option<serde_json::Value>,
    #[serde(default)]
    pub order_tx_history: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub market_id: Option<String>,
    #[serde(default)]
    pub owner: Option<Identity>,
    #[serde(default)]
    pub history: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub fills: Option<Vec<serde_json::Value>>,
}

/// Response from GET /v1/orders.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrdersResponse {
    pub identity: Option<Identity>,
    pub market_id: Option<String>,
    pub orders: Option<Vec<Order>>,
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

/// A trade from the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub trade_id: Option<String>,
    pub side: Option<String>,
    pub total: Option<String>,
    pub quantity: Option<String>,
    pub price: Option<String>,
    pub timestamp: Option<String>,
    #[serde(default)]
    pub maker: Option<Identity>,
    #[serde(default)]
    pub taker: Option<Identity>,
}

/// Response from GET /v1/trades.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradesResponse {
    pub trades: Option<Vec<Trade>>,
    pub market_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/// Order book balance entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBookBalance {
    pub locked: Option<String>,
    pub unlocked: Option<String>,
}

/// Balance response from GET /v1/balance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceResponse {
    pub order_books: Option<HashMap<String, OrderBookBalance>>,
    pub total_locked: Option<String>,
    pub total_unlocked: Option<String>,
    pub trading_account_balance: Option<String>,
}

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

/// A single depth level (price + quantity).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepthLevel {
    pub price: String,
    pub quantity: String,
}

/// Depth snapshot from GET /v1/depth or WebSocket subscribe_depth.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepthSnapshot {
    pub buys: Option<Vec<DepthLevel>>,
    pub sells: Option<Vec<DepthLevel>>,
}

/// Depth update from WebSocket subscribe_depth_update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepthUpdate {
    pub action: Option<String>,
    pub changes: Option<DepthSnapshot>,
    #[serde(alias = "view")]
    pub view: Option<DepthSnapshot>,
    pub market_id: Option<String>,
    pub onchain_timestamp: Option<String>,
    pub seen_timestamp: Option<String>,
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

/// OHLCV bar/candle data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bar {
    pub open: Option<String>,
    pub high: Option<String>,
    pub low: Option<String>,
    pub close: Option<String>,
    pub volume: Option<String>,
    pub timestamp: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Session Actions
// ---------------------------------------------------------------------------

/// A CreateOrder action payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateOrderAction {
    pub side: String,
    pub price: String,
    pub quantity: String,
    pub order_type: serde_json::Value,
}

/// A CancelOrder action payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelOrderAction {
    pub order_id: String,
}

/// A SettleBalance action payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettleBalanceAction {
    pub to: Identity,
}

/// A single action in the actions request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ActionItem {
    CreateOrder {
        #[serde(rename = "CreateOrder")]
        create_order: CreateOrderAction,
    },
    CancelOrder {
        #[serde(rename = "CancelOrder")]
        cancel_order: CancelOrderAction,
    },
    SettleBalance {
        #[serde(rename = "SettleBalance")]
        settle_balance: SettleBalanceAction,
    },
    RegisterReferer {
        #[serde(rename = "RegisterReferer")]
        register_referer: SettleBalanceAction,
    },
}

/// A market-grouped set of actions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketActions {
    pub market_id: String,
    pub actions: Vec<serde_json::Value>,
}

/// Request body for POST /v1/session/actions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionActionsRequest {
    pub actions: Vec<MarketActions>,
    pub signature: Signature,
    pub nonce: String,
    pub trade_account_id: String,
    pub session_id: Identity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collect_orders: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variable_outputs: Option<u32>,
}

/// Response from POST /v1/session/actions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionActionsResponse {
    pub tx_id: Option<String>,
    pub orders: Option<Vec<Order>>,
    // Error fields
    pub code: Option<u32>,
    pub message: Option<String>,
    pub reason: Option<String>,
    pub receipts: Option<serde_json::Value>,
}

impl SessionActionsResponse {
    /// Returns true if the response indicates success (has tx_id).
    pub fn is_success(&self) -> bool {
        self.tx_id.is_some()
    }

    /// Returns true if this is a pre-flight validation error (has code field).
    pub fn is_preflight_error(&self) -> bool {
        self.code.is_some() && self.tx_id.is_none()
    }

    /// Returns true if this is an on-chain revert error (has message but no code).
    pub fn is_onchain_error(&self) -> bool {
        self.message.is_some() && self.code.is_none() && self.tx_id.is_none()
    }
}

// ---------------------------------------------------------------------------
// Withdraw
// ---------------------------------------------------------------------------

/// Request body for POST /v1/accounts/withdraw.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WithdrawRequest {
    pub trade_account_id: String,
    pub signature: Signature,
    pub nonce: String,
    pub to: Identity,
    pub asset_id: String,
    pub amount: String,
}

/// Response from POST /v1/accounts/withdraw.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WithdrawResponse {
    pub tx_id: Option<String>,
    pub code: Option<u32>,
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// Whitelist
// ---------------------------------------------------------------------------

/// Request body for POST /analytics/v1/whitelist.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhitelistRequest {
    #[serde(rename = "tradeAccount")]
    pub trade_account: String,
}

/// Response from POST /analytics/v1/whitelist.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhitelistResponse {
    pub success: Option<bool>,
    #[serde(rename = "tradeAccount")]
    pub trade_account: Option<String>,
    #[serde(rename = "alreadyWhitelisted")]
    pub already_whitelisted: Option<bool>,
}

// ---------------------------------------------------------------------------
// Faucet
// ---------------------------------------------------------------------------

/// Response from faucet mint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaucetResponse {
    pub message: Option<String>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Referral
// ---------------------------------------------------------------------------

/// Response from GET /analytics/v1/referral/code-info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferralInfo {
    pub valid: Option<bool>,
    #[serde(rename = "ownerAddress")]
    pub owner_address: Option<String>,
    #[serde(rename = "isActive")]
    pub is_active: Option<bool>,
}

// ---------------------------------------------------------------------------
// Aggregated
// ---------------------------------------------------------------------------

/// Asset from GET /v1/aggregated/assets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatedAsset {
    pub id: Option<String>,
    pub symbol: Option<String>,
    pub name: Option<String>,
}

/// Aggregated orderbook from GET /v1/aggregated/orderbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatedOrderbook {
    pub asks: Option<Vec<Vec<String>>>,
    pub bids: Option<Vec<Vec<String>>>,
    pub timestamp: Option<serde_json::Value>,
}

/// Pair summary from GET /v1/aggregated/summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairSummary {
    pub trading_pairs: Option<String>,
    pub last_price: Option<String>,
    pub lowest_ask: Option<String>,
    pub highest_bid: Option<String>,
    pub base_volume: Option<String>,
    pub quote_volume: Option<String>,
    pub price_change_percent_24h: Option<String>,
    pub highest_price_24h: Option<String>,
    pub lowest_price_24h: Option<String>,
}

/// Pair ticker from GET /v1/aggregated/ticker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairTicker {
    pub ticker_id: Option<String>,
    pub base_currency: Option<String>,
    pub target_currency: Option<String>,
    pub last_price: Option<String>,
    pub base_volume: Option<String>,
    pub target_volume: Option<String>,
    pub bid: Option<String>,
    pub ask: Option<String>,
    pub high: Option<String>,
    pub low: Option<String>,
}

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

/// WebSocket order update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderUpdate {
    pub action: Option<String>,
    pub orders: Option<Vec<Order>>,
    pub onchain_timestamp: Option<String>,
    pub seen_timestamp: Option<String>,
}

/// WebSocket trade update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeUpdate {
    pub action: Option<String>,
    pub trades: Option<Vec<Trade>>,
    pub market_id: Option<String>,
    pub onchain_timestamp: Option<String>,
    pub seen_timestamp: Option<String>,
}

/// WebSocket balance entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceEntry {
    pub identity: Option<Identity>,
    pub asset_id: Option<String>,
    pub total_locked: Option<String>,
    pub total_unlocked: Option<String>,
    pub trading_account_balance: Option<String>,
    pub order_books: Option<HashMap<String, OrderBookBalance>>,
}

/// WebSocket balance update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceUpdate {
    pub action: Option<String>,
    pub balance: Option<Vec<BalanceEntry>>,
    pub onchain_timestamp: Option<String>,
    pub seen_timestamp: Option<String>,
}

/// WebSocket nonce update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NonceUpdate {
    pub action: Option<String>,
    pub contract_id: Option<String>,
    pub nonce: Option<String>,
    pub onchain_timestamp: Option<String>,
    pub seen_timestamp: Option<String>,
}

/// Generic WebSocket message for initial parsing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsMessage {
    pub action: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Transaction result for simple operations (cancel, settle).
#[derive(Debug, Clone)]
pub struct TxResult {
    pub tx_id: String,
    pub orders: Vec<Order>,
}
