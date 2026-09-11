//! Single-attempt, timeout-bounded Fast Bridge HTTP client.
mod inspection;
pub mod models;
pub use inspection::*;
pub use models::*;
use reqwest::{Client, Method, Url};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::time::Duration;

/// Proxy errors preserve HTTP status, string code, and structured details.
#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("Bridge HTTP {status} ({code}): {message}")]
    Api {
        status: u16,
        code: String,
        message: String,
        details: Option<serde_json::Value>,
    },
    #[error(transparent)]
    Transport(#[from] reqwest::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("Invalid bridge data: {0}")]
    Invalid(String),
}

/// Separate from trading account withdrawal. No automatic retries or RPC discovery.
#[derive(Debug, Clone)]
pub struct FastBridgeClient {
    base_url: String,
    client: Client,
}
impl FastBridgeClient {
    /// Use an explicit proxy root URL and a 30-second per-request timeout.
    pub fn new(base_url: &str) -> Result<Self, BridgeError> {
        Self::with_timeout(base_url, Duration::from_secs(30))
    }
    pub fn with_timeout(base_url: &str, timeout: Duration) -> Result<Self, BridgeError> {
        let url = Url::parse(base_url).map_err(|e| BridgeError::Invalid(e.to_string()))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || timeout.is_zero()
        {
            return Err(BridgeError::Invalid("Invalid bridge URL or timeout".into()));
        }
        let client = Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            base_url: url.as_str().trim_end_matches('/').into(),
            client,
        })
    }
    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&impl Serialize>,
    ) -> Result<T, BridgeError> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base_url))
            .query(query);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await?;
        let status = response.status();
        let text = response.text().await?;
        let payload: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| BridgeError::Api {
                status: status.as_u16(),
                code: "INVALID_RESPONSE".into(),
                message: "Bridge returned non-JSON response".into(),
                details: None,
            })?;
        if !status.is_success() {
            let error = &payload["error"];
            return Err(BridgeError::Api {
                status: status.as_u16(),
                code: error["code"].as_str().unwrap_or("HTTP_ERROR").into(),
                message: error["message"]
                    .as_str()
                    .unwrap_or("Bridge request failed")
                    .into(),
                details: error.get("details").cloned(),
            });
        }
        if !payload.is_object() {
            return Err(BridgeError::Api {
                status: status.as_u16(),
                code: "INVALID_RESPONSE".into(),
                message: "Bridge response must be an object".into(),
                details: None,
            });
        }
        Ok(serde_json::from_value(payload)?)
    }
    /// GET /v1/info
    pub async fn get_info(&self) -> Result<InfoResponse, BridgeError> {
        self.request(Method::GET, "/v1/info", &[], None::<&()>)
            .await
    }
    /// GET /v1/assets
    pub async fn get_assets(&self, chain_id: Option<u64>) -> Result<AssetsResponse, BridgeError> {
        let mut query = Vec::new();
        if let Some(value) = chain_id {
            query.push(("chainId", value.to_string()));
        }
        self.request(Method::GET, "/v1/assets", &query, None::<&()>)
            .await
    }
    /// GET /v1/deposit/info
    pub async fn get_deposit_info(
        &self,
        source_chain_id: u64,
        asset_id: Option<&str>,
        amount: Option<&str>,
    ) -> Result<DepositInfoResponse, BridgeError> {
        let mut query = Vec::new();
        query.push(("sourceChainId", source_chain_id.to_string()));
        if let Some(value) = asset_id {
            query.push(("assetId", value.to_string()));
        }
        if let Some(value) = amount {
            query.push(("amount", value.to_string()));
        }
        self.request(Method::GET, "/v1/deposit/info", &query, None::<&()>)
            .await
    }
    /// POST /v1/deposit/prepare
    pub async fn prepare_deposit(
        &self,
        request: &DepositPrepareRequest,
    ) -> Result<DepositPrepareResponse, BridgeError> {
        self.request(Method::POST, "/v1/deposit/prepare", &[], Some(request))
            .await
    }
    /// POST /v1/deposit/submit
    pub async fn submit_deposit(
        &self,
        request: &SubmitRequest,
    ) -> Result<DepositSubmitResponse, BridgeError> {
        self.request(Method::POST, "/v1/deposit/submit", &[], Some(request))
            .await
    }
    /// GET /v1/deposit/status
    pub async fn get_deposit_status(
        &self,
        source_chain_id: u64,
        evm_tx_hash: &str,
    ) -> Result<DepositStatusResponse, BridgeError> {
        let mut query = Vec::new();
        query.push(("sourceChainId", source_chain_id.to_string()));
        query.push(("evmTxHash", evm_tx_hash.to_string()));
        self.request(Method::GET, "/v1/deposit/status", &query, None::<&()>)
            .await
    }
    /// GET /v1/withdraw/info
    pub async fn get_withdraw_info(
        &self,
        destination_chain_id: u64,
        asset_id: Option<&str>,
        amount: Option<&str>,
    ) -> Result<WithdrawInfoResponse, BridgeError> {
        let mut query = Vec::new();
        query.push(("destinationChainId", destination_chain_id.to_string()));
        if let Some(value) = asset_id {
            query.push(("assetId", value.to_string()));
        }
        if let Some(value) = amount {
            query.push(("amount", value.to_string()));
        }
        self.request(Method::GET, "/v1/withdraw/info", &query, None::<&()>)
            .await
    }
    /// GET /v1/withdraw/fee
    pub async fn get_withdraw_fee(
        &self,
        destination_chain_id: u64,
        asset_id: &str,
    ) -> Result<WithdrawFeeResponse, BridgeError> {
        let mut query = Vec::new();
        query.push(("destinationChainId", destination_chain_id.to_string()));
        query.push(("assetId", asset_id.to_string()));
        self.request(Method::GET, "/v1/withdraw/fee", &query, None::<&()>)
            .await
    }
    /// POST /v1/withdraw/prepare
    pub async fn prepare_withdraw(
        &self,
        request: &WithdrawPrepareRequest,
    ) -> Result<WithdrawPrepareResponse, BridgeError> {
        self.request(Method::POST, "/v1/withdraw/prepare", &[], Some(request))
            .await
    }
    /// POST /v1/withdraw/submit
    pub async fn submit_withdraw(
        &self,
        request: &SubmitRequest,
    ) -> Result<WithdrawSubmitResponse, BridgeError> {
        self.request(Method::POST, "/v1/withdraw/submit", &[], Some(request))
            .await
    }
    /// GET /v1/withdraw/status
    pub async fn get_withdraw_status(
        &self,
        fuel_tx_id: &str,
    ) -> Result<WithdrawStatusResponse, BridgeError> {
        let mut query = Vec::new();
        query.push(("fuelTxId", fuel_tx_id.to_string()));
        self.request(Method::GET, "/v1/withdraw/status", &query, None::<&()>)
            .await
    }
}
