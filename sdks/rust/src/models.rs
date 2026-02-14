/// Data models for O2 Exchange API types.
///
/// All models use serde for JSON serialization/deserialization.
/// String fields are used for large numeric values to avoid precision loss.
use rust_decimal::Decimal;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, HashMap};

use crate::decimal::UnsignedDecimal;
use crate::errors::O2Error;

macro_rules! newtype_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(s: impl Into<String>) -> Self {
                Self(s.into())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_string())
            }
        }

        impl std::ops::Deref for $name {
            type Target = str;
            fn deref(&self) -> &str {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self(String::new())
            }
        }
    };
}

newtype_id!(
    /// A market symbol pair like "FUEL/USDC".
    MarketSymbol
);
newtype_id!(
    /// A hex contract ID.
    ContractId
);
newtype_id!(
    /// A hex market ID.
    MarketId
);
newtype_id!(
    /// A hex order ID.
    OrderId
);
newtype_id!(
    /// A trade identifier.
    TradeId
);
newtype_id!(
    /// A hex trade account ID.
    TradeAccountId
);
newtype_id!(
    /// A hex asset ID.
    AssetId
);

fn normalize_hex_prefixed(s: String) -> String {
    if s.starts_with("0x") || s.starts_with("0X") || s.is_empty() {
        s
    } else {
        format!("0x{s}")
    }
}

/// A hex transaction ID.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct TxId(String);

impl TxId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(normalize_hex_prefixed(s.into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for TxId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for TxId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for TxId {
    fn from(s: String) -> Self {
        Self::new(s)
    }
}

impl From<&str> for TxId {
    fn from(s: &str) -> Self {
        Self::new(s)
    }
}

impl std::ops::Deref for TxId {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

impl Default for TxId {
    fn default() -> Self {
        Self(String::new())
    }
}

impl<'de> Deserialize<'de> for TxId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Ok(TxId::new(raw))
    }
}

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
            f.write_str("a u64 or a string containing a decimal/0x-hex u64")
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<u64, E> {
            Ok(v)
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<u64, E> {
            u64::try_from(v).map_err(de::Error::custom)
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<u64, E> {
            if let Some(hex) = v.strip_prefix("0x").or_else(|| v.strip_prefix("0X")) {
                u64::from_str_radix(hex, 16).map_err(de::Error::custom)
            } else {
                v.parse().map_err(de::Error::custom)
            }
        }
    }
    deserializer.deserialize_any(StringOrU64)
}

/// Deserialize an optional value that may be a JSON number or a string, storing as u64.
fn deserialize_optional_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value: Option<serde_json::Value> = Option::deserialize(deserializer)?;
    match value {
        Some(serde_json::Value::String(s)) => {
            if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                u64::from_str_radix(hex, 16)
                    .map(Some)
                    .map_err(serde::de::Error::custom)
            } else {
                s.parse().map(Some).map_err(serde::de::Error::custom)
            }
        }
        Some(serde_json::Value::Number(n)) => n
            .as_u64()
            .ok_or_else(|| serde::de::Error::custom("number is not u64"))
            .map(Some),
        Some(serde_json::Value::Null) | None => Ok(None),
        Some(v) => Err(serde::de::Error::custom(format!(
            "expected string/number/null for u64 field, got {v}"
        ))),
    }
}

/// Deserialize a value that may be a JSON number or a string containing a u128.
fn deserialize_string_or_u128<'de, D>(deserializer: D) -> Result<u128, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de;

    struct StringOrU128;
    impl<'de> de::Visitor<'de> for StringOrU128 {
        type Value = u128;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a u128 or a string containing a decimal u128")
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<u128, E> {
            Ok(v as u128)
        }
        fn visit_u128<E: de::Error>(self, v: u128) -> Result<u128, E> {
            Ok(v)
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<u128, E> {
            u128::try_from(v).map_err(de::Error::custom)
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<u128, E> {
            v.parse().map_err(de::Error::custom)
        }
    }
    deserializer.deserialize_any(StringOrU128)
}

/// Deserialize a value that may be a JSON number or a string containing an f64.
fn deserialize_string_or_f64<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de;

    struct StringOrF64;
    impl<'de> de::Visitor<'de> for StringOrF64 {
        type Value = f64;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("an f64 or a string containing an f64")
        }
        fn visit_f64<E: de::Error>(self, v: f64) -> Result<f64, E> {
            Ok(v)
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<f64, E> {
            Ok(v as f64)
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<f64, E> {
            Ok(v as f64)
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<f64, E> {
            v.parse().map_err(de::Error::custom)
        }
    }
    deserializer.deserialize_any(StringOrF64)
}

/// Deserialize an optional value that may be a JSON number or a string, storing as f64.
fn deserialize_optional_f64<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value: Option<serde_json::Value> = Option::deserialize(deserializer)?;
    match value {
        Some(serde_json::Value::String(s)) => s.parse().map(Some).map_err(serde::de::Error::custom),
        Some(serde_json::Value::Number(n)) => n
            .as_f64()
            .ok_or_else(|| serde::de::Error::custom("number is not f64"))
            .map(Some),
        Some(serde_json::Value::Null) | None => Ok(None),
        Some(v) => Err(serde::de::Error::custom(format!(
            "expected string/number/null for f64 field, got {v}"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Public trading enums
// ---------------------------------------------------------------------------

/// Order side: Buy or Sell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    /// Returns the API string representation.
    pub fn as_str(&self) -> &str {
        match self {
            Side::Buy => "Buy",
            Side::Sell => "Sell",
        }
    }
}

impl std::fmt::Display for Side {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for Side {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Side {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        match raw.to_ascii_lowercase().as_str() {
            "buy" => Ok(Side::Buy),
            "sell" => Ok(Side::Sell),
            _ => Err(serde::de::Error::custom(format!("invalid side '{raw}'"))),
        }
    }
}

/// High-level order type with associated data.
///
/// Used in `create_order` and `Action::CreateOrder` to provide compile-time
/// safety instead of raw `&str` matching. Limit and BoundedMarket variants
/// carry their required parameters.
#[derive(Debug, Clone)]
pub enum OrderType {
    Spot,
    Market,
    FillOrKill,
    PostOnly,
    Limit {
        price: UnsignedDecimal,
        timestamp: u64,
    },
    BoundedMarket {
        max_price: UnsignedDecimal,
        min_price: UnsignedDecimal,
    },
}

/// High-level action for use with `batch_actions`.
///
/// Converts to the low-level `CallArg` and JSON representations internally.
#[derive(Debug, Clone)]
pub enum Action {
    CreateOrder {
        side: Side,
        price: UnsignedDecimal,
        quantity: UnsignedDecimal,
        order_type: OrderType,
    },
    CancelOrder {
        order_id: OrderId,
    },
    SettleBalance,
    RegisterReferer {
        to: Identity,
    },
}

impl OrderType {
    /// Convert to the low-level `OrderTypeEncoding` and JSON representation
    /// used by the encoding and API layers.
    pub fn to_encoding(
        &self,
        market: &Market,
    ) -> Result<(crate::encoding::OrderTypeEncoding, serde_json::Value), O2Error> {
        use crate::encoding::OrderTypeEncoding;
        match self {
            OrderType::Spot => Ok((OrderTypeEncoding::Spot, serde_json::json!("Spot"))),
            OrderType::Market => Ok((OrderTypeEncoding::Market, serde_json::json!("Market"))),
            OrderType::FillOrKill => Ok((
                OrderTypeEncoding::FillOrKill,
                serde_json::json!("FillOrKill"),
            )),
            OrderType::PostOnly => Ok((OrderTypeEncoding::PostOnly, serde_json::json!("PostOnly"))),
            OrderType::Limit { price, timestamp } => {
                let scaled_price = market.scale_price(price)?;
                Ok((
                    OrderTypeEncoding::Limit {
                        price: scaled_price,
                        timestamp: *timestamp,
                    },
                    serde_json::json!({ "Limit": [scaled_price.to_string(), timestamp.to_string()] }),
                ))
            }
            OrderType::BoundedMarket {
                max_price,
                min_price,
            } => {
                let scaled_max = market.scale_price(max_price)?;
                let scaled_min = market.scale_price(min_price)?;
                Ok((
                    OrderTypeEncoding::BoundedMarket {
                        max_price: scaled_max,
                        min_price: scaled_min,
                    },
                    serde_json::json!({ "BoundedMarket": { "max_price": scaled_max.to_string(), "min_price": scaled_min.to_string() } }),
                ))
            }
        }
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
    pub asset: AssetId,
    pub decimals: u32,
    pub max_precision: u32,
}

/// A trading market.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Market {
    pub contract_id: ContractId,
    pub market_id: MarketId,
    pub whitelist_id: Option<ContractId>,
    pub blacklist_id: Option<ContractId>,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub maker_fee: u64,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub taker_fee: u64,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub min_order: u64,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub dust: u64,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub price_window: u64,
    pub base: MarketAsset,
    pub quote: MarketAsset,
}

impl Market {
    fn checked_pow_u64(exp: u32, field: &str) -> Result<u64, O2Error> {
        10u64
            .checked_pow(exp)
            .ok_or_else(|| O2Error::Other(format!("Invalid {field}: 10^{exp} overflows u64")))
    }

    fn checked_pow_u128(exp: u32, field: &str) -> Result<u128, O2Error> {
        10u128
            .checked_pow(exp)
            .ok_or_else(|| O2Error::Other(format!("Invalid {field}: 10^{exp} overflows u128")))
    }

    fn checked_truncate_factor(
        decimals: u32,
        max_precision: u32,
        field: &str,
    ) -> Result<u64, O2Error> {
        if max_precision > decimals {
            return Err(O2Error::Other(format!(
                "Invalid {field}: max_precision ({max_precision}) exceeds decimals ({decimals})"
            )));
        }
        Self::checked_pow_u64(decimals - max_precision, field)
    }

    /// Convert a chain-scaled price to human-readable.
    pub fn format_price(&self, chain_value: u64) -> UnsignedDecimal {
        let factor = 10u64.pow(self.quote.decimals);
        let d = Decimal::from(chain_value) / Decimal::from(factor);
        UnsignedDecimal::new(d).unwrap()
    }

    /// Convert a human-readable price to chain-scaled integer, truncated to max_precision.
    pub fn scale_price(&self, human_value: &UnsignedDecimal) -> Result<u64, O2Error> {
        let factor_u64 = Self::checked_pow_u64(self.quote.decimals, "quote.decimals")?;
        let factor = Decimal::from(factor_u64);
        let scaled_str = (*human_value.inner() * factor).floor().to_string();
        let scaled = scaled_str.parse::<u64>().map_err(|e| {
            O2Error::Other(format!(
                "Failed to scale price '{}' into u64: {e}",
                human_value
            ))
        })?;
        let truncate_factor = Self::checked_truncate_factor(
            self.quote.decimals,
            self.quote.max_precision,
            "quote precision",
        )?;
        Ok((scaled / truncate_factor) * truncate_factor)
    }

    /// Convert a chain-scaled quantity to human-readable.
    pub fn format_quantity(&self, chain_value: u64) -> UnsignedDecimal {
        let factor = 10u64.pow(self.base.decimals);
        let d = Decimal::from(chain_value) / Decimal::from(factor);
        UnsignedDecimal::new(d).unwrap()
    }

    /// Convert a human-readable quantity to chain-scaled integer, truncated to max_precision.
    pub fn scale_quantity(&self, human_value: &UnsignedDecimal) -> Result<u64, O2Error> {
        let factor_u64 = Self::checked_pow_u64(self.base.decimals, "base.decimals")?;
        let factor = Decimal::from(factor_u64);
        let scaled_str = (*human_value.inner() * factor).floor().to_string();
        let scaled = scaled_str.parse::<u64>().map_err(|e| {
            O2Error::Other(format!(
                "Failed to scale quantity '{}' into u64: {e}",
                human_value
            ))
        })?;
        let truncate_factor = Self::checked_truncate_factor(
            self.base.decimals,
            self.base.max_precision,
            "base precision",
        )?;
        Ok((scaled / truncate_factor) * truncate_factor)
    }

    /// The symbol pair, e.g. "FUEL/USDC".
    pub fn symbol_pair(&self) -> MarketSymbol {
        MarketSymbol::new(format!("{}/{}", self.base.symbol, self.quote.symbol))
    }

    /// Adjust quantity downward so that `(price * quantity) % 10^base_decimals == 0`.
    /// Returns the original quantity if already valid.
    pub fn adjust_quantity(&self, price: u64, quantity: u64) -> Result<u64, O2Error> {
        if price == 0 {
            return Err(O2Error::InvalidOrderParams(
                "Price cannot be zero when adjusting quantity".into(),
            ));
        }
        let base_factor = Self::checked_pow_u128(self.base.decimals, "base.decimals")?;
        let product = price as u128 * quantity as u128;
        let remainder = product % base_factor;
        if remainder == 0 {
            return Ok(quantity);
        }
        let adjusted_product = product - remainder;
        let adjusted = adjusted_product / price as u128;
        if adjusted > u64::MAX as u128 {
            return Err(O2Error::InvalidOrderParams(
                "Adjusted quantity exceeds u64 range".into(),
            ));
        }
        Ok(adjusted as u64)
    }

    /// Validate that a price*quantity satisfies min_order and FractionalPrice constraints.
    pub fn validate_order(&self, price: u64, quantity: u64) -> Result<(), O2Error> {
        let base_factor = Self::checked_pow_u128(self.base.decimals, "base.decimals")?;
        let quote_value = (price as u128 * quantity as u128) / base_factor;
        let min_order: u128 = self.min_order as u128;
        if quote_value < min_order {
            return Err(O2Error::InvalidOrderParams(format!(
                "Quote value {} below min_order {}",
                quote_value, min_order
            )));
        }
        // FractionalPrice check
        if (price as u128 * quantity as u128) % base_factor != 0 {
            return Err(O2Error::InvalidOrderParams(
                "FractionalPrice: (price * quantity) % 10^base_decimals != 0".into(),
            ));
        }
        Ok(())
    }
}

/// Top-level response from GET /v1/markets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketsResponse {
    pub books_registry_id: ContractId,
    pub books_whitelist_id: Option<ContractId>,
    pub books_blacklist_id: Option<ContractId>,
    pub accounts_registry_id: ContractId,
    pub trade_account_oracle_id: ContractId,
    pub fast_bridge_asset_registry_contract_id: Option<ContractId>,
    pub chain_id: String,
    pub base_asset_id: AssetId,
    pub markets: Vec<Market>,
}

/// Market summary from GET /v1/markets/summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketSummary {
    pub market_id: MarketId,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub high_price: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub low_price: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub last_price: Option<u64>,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub volume_24h: u128,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub change_24h: f64,
}

/// Market ticker from GET /v1/markets/ticker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketTicker {
    pub market_id: MarketId,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub high: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub low: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub bid: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub bid_volume: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub ask: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub ask_volume: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub open: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub close: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub last: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub previous_close: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_f64")]
    pub change: Option<f64>,
    #[serde(default, deserialize_with = "deserialize_optional_f64")]
    pub percentage: Option<f64>,
    #[serde(default, deserialize_with = "deserialize_optional_f64")]
    pub average: Option<f64>,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub base_volume: u128,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub quote_volume: u128,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub timestamp: u128,
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/// Trading account info from GET /v1/accounts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeAccount {
    #[serde(default)]
    pub last_modification: u64,
    #[serde(default, deserialize_with = "deserialize_string_or_u64")]
    pub nonce: u64,
    pub owner: Identity,
    #[serde(default)]
    pub synced_with_network: Option<bool>,
    #[serde(default)]
    pub sync_state: Option<serde_json::Value>,
}

/// Account response from GET /v1/accounts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountResponse {
    pub trade_account_id: Option<TradeAccountId>,
    pub trade_account: Option<TradeAccount>,
    pub session: Option<SessionInfo>,
}

/// Session info within an account response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: Identity,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub expiry: u64,
    pub contract_ids: Vec<ContractId>,
}

/// Response from POST /v1/accounts (create account).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAccountResponse {
    pub trade_account_id: TradeAccountId,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub nonce: u64,
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/// Request body for PUT /v1/session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRequest {
    pub contract_id: TradeAccountId,
    pub session_id: Identity,
    pub signature: Signature,
    pub contract_ids: Vec<ContractId>,
    pub nonce: String,
    pub expiry: String,
}

/// Response from PUT /v1/session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResponse {
    pub tx_id: TxId,
    pub trade_account_id: TradeAccountId,
    pub contract_ids: Vec<ContractId>,
    pub session_id: Identity,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub session_expiry: u64,
}

/// Local session state tracked by the client.
#[derive(Debug, Clone)]
pub struct Session {
    pub owner_address: [u8; 32],
    pub session_private_key: [u8; 32],
    pub session_address: [u8; 32],
    pub trade_account_id: TradeAccountId,
    pub contract_ids: Vec<ContractId>,
    pub expiry: u64,
    pub nonce: u64,
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/// An order from the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    #[serde(default)]
    pub order_id: OrderId,
    pub side: Side,
    pub order_type: serde_json::Value,
    #[serde(default, deserialize_with = "deserialize_string_or_u64")]
    pub quantity: u64,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub quantity_fill: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_string_or_u64")]
    pub price: u64,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub price_fill: Option<u64>,
    pub timestamp: Option<serde_json::Value>,
    #[serde(default)]
    pub close: bool,
    #[serde(default)]
    pub partially_filled: bool,
    #[serde(default)]
    pub cancel: bool,
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
    pub market_id: Option<MarketId>,
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
    pub identity: Identity,
    pub market_id: MarketId,
    #[serde(default)]
    pub orders: Vec<Order>,
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

/// A trade from the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub trade_id: TradeId,
    pub side: Side,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub total: u128,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub quantity: u64,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub price: u64,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub timestamp: u128,
    #[serde(default)]
    pub maker: Option<Identity>,
    #[serde(default)]
    pub taker: Option<Identity>,
}

/// Response from GET /v1/trades.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradesResponse {
    #[serde(default)]
    pub trades: Vec<Trade>,
    pub market_id: MarketId,
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/// Order book balance entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBookBalance {
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub locked: u128,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub unlocked: u128,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub fee: u128,
}

/// Balance response from GET /v1/balance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceResponse {
    pub order_books: HashMap<String, OrderBookBalance>,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub total_locked: u128,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub total_unlocked: u128,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub trading_account_balance: u128,
}

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

/// A single depth level (price + quantity).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepthLevel {
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub price: u64,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub quantity: u64,
}

/// Depth snapshot from GET /v1/depth or WebSocket subscribe_depth.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepthSnapshot {
    #[serde(default)]
    pub buys: Vec<DepthLevel>,
    #[serde(default)]
    pub sells: Vec<DepthLevel>,
}

/// Depth update from WebSocket subscribe_depth_update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepthUpdate {
    pub action: String,
    pub changes: Option<DepthSnapshot>,
    #[serde(alias = "view")]
    pub view: Option<DepthSnapshot>,
    pub market_id: MarketId,
    pub onchain_timestamp: Option<String>,
    pub seen_timestamp: Option<String>,
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

/// OHLCV bar/candle data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bar {
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub open: u64,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub high: u64,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub low: u64,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub close: u64,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub buy_volume: u128,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub sell_volume: u128,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub timestamp: u128,
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
pub(crate) struct MarketActions {
    pub market_id: MarketId,
    pub actions: Vec<serde_json::Value>,
}

/// Request body for POST /v1/session/actions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SessionActionsRequest {
    pub actions: Vec<MarketActions>,
    pub signature: Signature,
    pub nonce: String,
    pub trade_account_id: TradeAccountId,
    pub session_id: Identity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collect_orders: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variable_outputs: Option<u32>,
}

/// Response from POST /v1/session/actions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionActionsResponse {
    pub tx_id: Option<TxId>,
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
    pub trade_account_id: TradeAccountId,
    pub signature: Signature,
    pub nonce: String,
    pub to: Identity,
    pub asset_id: AssetId,
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

/// Asset metadata from GET /v1/aggregated/assets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatedAssetInfo {
    pub name: String,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub unified_cryptoasset_id: u64,
    pub can_withdraw: bool,
    pub can_deposit: bool,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub min_withdraw: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub min_deposit: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub maker_fee: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub taker_fee: f64,
}

/// Symbol-keyed assets map from GET /v1/aggregated/assets.
pub type AggregatedAssets = BTreeMap<String, AggregatedAssetInfo>;

/// Aggregated orderbook from GET /v1/aggregated/orderbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatedOrderbook {
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub timestamp: u64,
    pub bids: Vec<[f64; 2]>,
    pub asks: Vec<[f64; 2]>,
}

/// CoinGecko aggregated orderbook from GET /v1/aggregated/coingecko/orderbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoingeckoAggregatedOrderbook {
    pub ticker_id: String,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub timestamp: u64,
    pub bids: Vec<[f64; 2]>,
    pub asks: Vec<[f64; 2]>,
}

/// Pair summary from GET /v1/aggregated/summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairSummary {
    pub trading_pairs: String,
    pub base_currency: String,
    pub quote_currency: String,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub last_price: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub lowest_ask: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub highest_bid: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub base_volume: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub quote_volume: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub price_change_percent_24h: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub highest_price_24h: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub lowest_price_24h: f64,
}

/// Aggregated ticker value from GET /v1/aggregated/ticker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatedTickerData {
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub last_price: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub base_volume: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub quote_volume: f64,
}

/// Pair-keyed map from GET /v1/aggregated/ticker.
pub type AggregatedTicker = BTreeMap<String, AggregatedTickerData>;

/// Pair ticker from GET /v1/aggregated/coingecko/tickers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairTicker {
    pub ticker_id: String,
    pub base_currency: String,
    pub target_currency: String,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub last_price: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub base_volume: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub target_volume: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub bid: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub ask: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub high: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub low: f64,
}

/// Trade from GET /v1/aggregated/trades.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatedTrade {
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub trade_id: u64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub price: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub base_volume: f64,
    #[serde(deserialize_with = "deserialize_string_or_f64")]
    pub quote_volume: f64,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub timestamp: u64,
    #[serde(rename = "type")]
    pub trade_type: String,
}

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

/// WebSocket order update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderUpdate {
    pub action: String,
    #[serde(default)]
    pub orders: Vec<Order>,
    pub onchain_timestamp: Option<String>,
    pub seen_timestamp: String,
}

/// WebSocket trade update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeUpdate {
    pub action: String,
    #[serde(default)]
    pub trades: Vec<Trade>,
    pub market_id: MarketId,
    pub onchain_timestamp: Option<String>,
    pub seen_timestamp: String,
}

/// WebSocket balance entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceEntry {
    pub identity: Identity,
    pub asset_id: AssetId,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub total_locked: u128,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub total_unlocked: u128,
    #[serde(deserialize_with = "deserialize_string_or_u128")]
    pub trading_account_balance: u128,
    pub order_books: HashMap<String, OrderBookBalance>,
}

/// WebSocket balance update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceUpdate {
    pub action: String,
    #[serde(default)]
    pub balance: Vec<BalanceEntry>,
    pub onchain_timestamp: Option<String>,
    pub seen_timestamp: String,
}

/// WebSocket nonce update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NonceUpdate {
    pub action: String,
    pub contract_id: TradeAccountId,
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    pub nonce: u64,
    pub onchain_timestamp: Option<String>,
    pub seen_timestamp: String,
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
