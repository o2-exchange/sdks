//! Proxy v1 wire models. Decimal amount strings use Fuel asset base units.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuelContracts {
    pub fast_bridge: String,
    pub asset_registry: String,
    pub wrapped_assets_minter: String,
    pub gas_oracle: String,
    pub rate_limiter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawalFuelContracts {
    pub asset_registry: String,
    pub wrapped_assets_minter: String,
    pub gas_oracle: String,
    pub rate_limiter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainSummary {
    pub chain_id: u64,
    pub name: String,
    pub messenger_address: String,
    pub outpost_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuelInfo {
    pub chain_id: String,
    pub network: String,
    pub contracts: FuelContracts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoResponse {
    pub environment: String,
    pub api_version: String,
    pub config_version: String,
    pub preparation_proof_ttl_seconds: u64,
    pub fuel: FuelInfo,
    pub chains: Vec<ChainSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRoute {
    pub chain_id: u64,
    pub token_address: Option<String>,
    pub token_decimals: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub asset_id: String,
    pub symbol: String,
    pub fuel_decimals: u64,
    pub routes: Vec<AssetRoute>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsResponse {
    pub config_version: String,
    pub assets: Vec<Asset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositAssetInfo {
    pub asset_id: String,
    pub token_address: Option<String>,
    pub token_decimals: u64,
    pub fuel_decimals: u64,
    pub whitelisted: bool,
    pub deposit_cap: Option<String>,
    pub deposited_amount: String,
    pub remaining_capacity: Option<String>,
    pub requires_allowance: bool,
    pub allowance_spender: Option<String>,
    pub permit_supported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_eligible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ineligibility_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositInfoResponse {
    pub source_chain_id: u64,
    pub route_enabled: bool,
    pub messenger_address: String,
    pub paused: bool,
    pub assets: Vec<DepositAssetInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositPermit {
    pub deadline: String,
    pub v: u64,
    pub r: String,
    pub s: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositPrepareRequest {
    pub source_chain_id: u64,
    #[serde(rename = "from")]
    pub from_address: String,
    pub to: String,
    pub to_type: RecipientType,
    pub asset_id: String,
    pub amount: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permit: Option<DepositPermit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositPrepareResponse {
    pub unsigned_transaction: String,
    pub preparation_proof: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitRequest {
    pub preparation_proof: String,
    pub unsigned_transaction: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositSubmitResponse {
    pub source_chain_id: u64,
    pub evm_tx_hash: String,
    pub status: DepositSubmitResponseStatus,
    pub submitted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositSourceStatus {
    pub status: DepositSourceState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmations: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableStatus {
    pub status: RelayState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositStatusResponse {
    pub source_chain_id: u64,
    pub evm_tx_hash: String,
    pub source: DepositSourceStatus,
    pub fuel: UnavailableStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitInfo {
    pub transaction_limit: Option<String>,
    pub daily_limit: Option<String>,
    pub withdrawn_today: String,
    pub remaining_today: Option<String>,
    pub resets_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawAssetInfo {
    pub asset_id: String,
    pub token_address: Option<String>,
    pub fuel_decimals: u64,
    pub token_decimals: u64,
    pub withdraw_enabled: bool,
    pub fee: String,
    pub fee_quote_block_height: String,
    pub fee_observed_at: String,
    pub rate_limit: RateLimitInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_eligible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ineligibility_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawInfoResponse {
    pub destination_chain_id: u64,
    pub route_enabled: bool,
    pub messenger_address: String,
    pub outpost_address: String,
    pub fuel_contracts: WithdrawalFuelContracts,
    pub paused: bool,
    pub recipient_format: RecipientFormat,
    pub assets: Vec<WithdrawAssetInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawFeeResponse {
    pub destination_chain_id: u64,
    pub asset_id: String,
    pub fee: String,
    pub fuel_block_height: String,
    pub observed_at: String,
    pub config_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawPrepareRequest {
    pub destination_chain_id: u64,
    #[serde(rename = "from")]
    pub from_address: String,
    pub to: String,
    pub asset_id: String,
    pub amount: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawPrepareResponse {
    pub unsigned_transaction: String,
    pub fuel_chain_id: String,
    pub preparation_proof: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawSubmitResponse {
    pub fuel_tx_id: String,
    pub status: WithdrawSubmitResponseStatus,
    pub submitted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuelStatus {
    pub status: FuelTransactionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_height: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawStatusResponse {
    pub fuel_tx_id: String,
    pub fuel: FuelStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_chain_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<UnavailableStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum RecipientType {
    #[serde(rename = "address")]
    Address,
    #[serde(rename = "contract")]
    Contract,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum DepositSubmitResponseStatus {
    #[serde(rename = "submitted")]
    Submitted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum DepositSourceState {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "confirmed")]
    Confirmed,
    #[serde(rename = "reverted")]
    Reverted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum RelayState {
    #[serde(rename = "unavailable")]
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum RecipientFormat {
    #[serde(rename = "evm-address")]
    EvmAddress,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum WithdrawSubmitResponseStatus {
    #[serde(rename = "submitted")]
    Submitted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum FuelTransactionState {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "success")]
    Success,
    #[serde(rename = "reverted")]
    Reverted,
}
