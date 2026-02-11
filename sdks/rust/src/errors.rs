/// Error types for O2 Exchange SDK.
///
/// Maps all error codes from the O2 API (Section 8) to typed Rust errors.
/// Also handles the two distinct error formats for POST /v1/session/actions.
use thiserror::Error;

/// The primary error type for the O2 SDK.
#[derive(Error, Debug)]
pub enum O2Error {
    // General (1xxx)
    #[error("Internal server error (1000): {0}")]
    InternalError(String),

    #[error("Invalid request (1001): {0}")]
    InvalidRequest(String),

    #[error("Parse error (1002): {0}")]
    ParseError(String),

    #[error("Rate limit exceeded (1003): {0}")]
    RateLimitExceeded(String),

    #[error("Geo restricted (1004): {0}")]
    GeoRestricted(String),

    // Market (2xxx)
    #[error("Market not found (2000): {0}")]
    MarketNotFound(String),

    #[error("Market paused (2001): {0}")]
    MarketPaused(String),

    #[error("Market already exists (2002): {0}")]
    MarketAlreadyExists(String),

    // Order (3xxx)
    #[error("Order not found (3000): {0}")]
    OrderNotFound(String),

    #[error("Order not active (3001): {0}")]
    OrderNotActive(String),

    #[error("Invalid order params (3002): {0}")]
    InvalidOrderParams(String),

    // Account/Session (4xxx)
    #[error("Invalid signature (4000): {0}")]
    InvalidSignature(String),

    #[error("Invalid session (4001): {0}")]
    InvalidSession(String),

    #[error("Account not found (4002): {0}")]
    AccountNotFound(String),

    #[error("Whitelist not configured (4003): {0}")]
    WhitelistNotConfigured(String),

    // Trade (5xxx)
    #[error("Trade not found (5000): {0}")]
    TradeNotFound(String),

    #[error("Invalid trade count (5001): {0}")]
    InvalidTradeCount(String),

    // WebSocket (6xxx)
    #[error("Already subscribed (6000): {0}")]
    AlreadySubscribed(String),

    #[error("Too many subscriptions (6001): {0}")]
    TooManySubscriptions(String),

    #[error("Subscription error (6002): {0}")]
    SubscriptionError(String),

    // Validation (7xxx)
    #[error("Invalid amount (7000): {0}")]
    InvalidAmount(String),

    #[error("Invalid time range (7001): {0}")]
    InvalidTimeRange(String),

    #[error("Invalid pagination (7002): {0}")]
    InvalidPagination(String),

    #[error("No actions provided (7003): {0}")]
    NoActionsProvided(String),

    #[error("Too many actions (7004): {0}")]
    TooManyActions(String),

    // Block/Events (8xxx)
    #[error("Block not found (8000): {0}")]
    BlockNotFound(String),

    #[error("Events not found (8001): {0}")]
    EventsNotFound(String),

    // On-chain revert (no code)
    #[error("On-chain revert: {message}, reason: {reason}")]
    OnChainRevert {
        message: String,
        reason: String,
        receipts: Option<serde_json::Value>,
    },

    // Client-side errors
    #[error("Session expired: {0}")]
    SessionExpired(String),

    // Transport errors
    #[error("HTTP error: {0}")]
    HttpError(String),

    #[error("WebSocket error: {0}")]
    WebSocketError(String),

    #[error("JSON error: {0}")]
    JsonError(String),

    // Crypto errors
    #[error("Crypto error: {0}")]
    CryptoError(String),

    // Generic
    #[error("{0}")]
    Other(String),
}

impl O2Error {
    /// Create an O2Error from an API error code and message.
    pub fn from_code(code: u32, message: String) -> Self {
        match code {
            1000 => O2Error::InternalError(message),
            1001 => O2Error::InvalidRequest(message),
            1002 => O2Error::ParseError(message),
            1003 => O2Error::RateLimitExceeded(message),
            1004 => O2Error::GeoRestricted(message),
            2000 => O2Error::MarketNotFound(message),
            2001 => O2Error::MarketPaused(message),
            2002 => O2Error::MarketAlreadyExists(message),
            3000 => O2Error::OrderNotFound(message),
            3001 => O2Error::OrderNotActive(message),
            3002 => O2Error::InvalidOrderParams(message),
            4000 => O2Error::InvalidSignature(message),
            4001 => O2Error::InvalidSession(message),
            4002 => O2Error::AccountNotFound(message),
            4003 => O2Error::WhitelistNotConfigured(message),
            5000 => O2Error::TradeNotFound(message),
            5001 => O2Error::InvalidTradeCount(message),
            6000 => O2Error::AlreadySubscribed(message),
            6001 => O2Error::TooManySubscriptions(message),
            6002 => O2Error::SubscriptionError(message),
            7000 => O2Error::InvalidAmount(message),
            7001 => O2Error::InvalidTimeRange(message),
            7002 => O2Error::InvalidPagination(message),
            7003 => O2Error::NoActionsProvided(message),
            7004 => O2Error::TooManyActions(message),
            8000 => O2Error::BlockNotFound(message),
            8001 => O2Error::EventsNotFound(message),
            _ => O2Error::Other(format!("Unknown error code {code}: {message}")),
        }
    }

    /// Returns the error code if this is a coded API error.
    pub fn error_code(&self) -> Option<u32> {
        match self {
            O2Error::InternalError(_) => Some(1000),
            O2Error::InvalidRequest(_) => Some(1001),
            O2Error::ParseError(_) => Some(1002),
            O2Error::RateLimitExceeded(_) => Some(1003),
            O2Error::GeoRestricted(_) => Some(1004),
            O2Error::MarketNotFound(_) => Some(2000),
            O2Error::MarketPaused(_) => Some(2001),
            O2Error::MarketAlreadyExists(_) => Some(2002),
            O2Error::OrderNotFound(_) => Some(3000),
            O2Error::OrderNotActive(_) => Some(3001),
            O2Error::InvalidOrderParams(_) => Some(3002),
            O2Error::InvalidSignature(_) => Some(4000),
            O2Error::InvalidSession(_) => Some(4001),
            O2Error::AccountNotFound(_) => Some(4002),
            O2Error::WhitelistNotConfigured(_) => Some(4003),
            O2Error::TradeNotFound(_) => Some(5000),
            O2Error::InvalidTradeCount(_) => Some(5001),
            O2Error::AlreadySubscribed(_) => Some(6000),
            O2Error::TooManySubscriptions(_) => Some(6001),
            O2Error::SubscriptionError(_) => Some(6002),
            O2Error::InvalidAmount(_) => Some(7000),
            O2Error::InvalidTimeRange(_) => Some(7001),
            O2Error::InvalidPagination(_) => Some(7002),
            O2Error::NoActionsProvided(_) => Some(7003),
            O2Error::TooManyActions(_) => Some(7004),
            O2Error::BlockNotFound(_) => Some(8000),
            O2Error::EventsNotFound(_) => Some(8001),
            _ => None,
        }
    }

    /// Returns true if this error suggests retrying with backoff.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            O2Error::InternalError(_) | O2Error::RateLimitExceeded(_)
        )
    }
}

impl From<reqwest::Error> for O2Error {
    fn from(err: reqwest::Error) -> Self {
        O2Error::HttpError(err.to_string())
    }
}

impl From<serde_json::Error> for O2Error {
    fn from(err: serde_json::Error) -> Self {
        O2Error::JsonError(err.to_string())
    }
}

impl From<url::ParseError> for O2Error {
    fn from(err: url::ParseError) -> Self {
        O2Error::Other(format!("URL parse error: {err}"))
    }
}

impl From<tokio_tungstenite::tungstenite::Error> for O2Error {
    fn from(err: tokio_tungstenite::tungstenite::Error) -> Self {
        O2Error::WebSocketError(err.to_string())
    }
}
