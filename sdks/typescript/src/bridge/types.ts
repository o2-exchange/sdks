/** Proxy v1 wire models. Amount strings use Fuel asset base units unless explicitly documented otherwise. */

export interface FuelContracts {
  fastBridge: string;
  assetRegistry: string;
  wrappedAssetsMinter: string;
  gasOracle: string;
  rateLimiter: string;
}

export interface WithdrawalFuelContracts {
  assetRegistry: string;
  wrappedAssetsMinter: string;
  gasOracle: string;
  rateLimiter: string;
}

export interface ChainSummary {
  chainId: number;
  name: string;
  messengerAddress: string;
  outpostAddress: string;
}

export interface FuelInfo {
  chainId: string;
  network: string;
  contracts: FuelContracts;
}

export interface InfoResponse {
  environment: string;
  apiVersion: string;
  configVersion: string;
  preparationProofTtlSeconds: number;
  fuel: FuelInfo;
  chains: ChainSummary[];
}

export interface AssetRoute {
  chainId: number;
  tokenAddress: string | null;
  tokenDecimals: number;
}

export interface Asset {
  assetId: string;
  symbol: string;
  fuelDecimals: number;
  routes: AssetRoute[];
}

export interface AssetsResponse {
  configVersion: string;
  assets: Asset[];
}

export interface DepositAssetInfo {
  assetId: string;
  tokenAddress: string | null;
  tokenDecimals: number;
  fuelDecimals: number;
  whitelisted: boolean;
  depositCap: string | null;
  depositedAmount: string;
  remainingCapacity: string | null;
  requiresAllowance: boolean;
  allowanceSpender: string | null;
  permitSupported: boolean;
  amountEligible?: boolean;
  ineligibilityReason?: string;
}

export interface DepositInfoResponse {
  sourceChainId: number;
  routeEnabled: boolean;
  messengerAddress: string;
  paused: boolean;
  assets: DepositAssetInfo[];
}

export interface DepositPermit {
  deadline: string;
  v: number;
  r: string;
  s: string;
}

export interface DepositPrepareRequest {
  sourceChainId: number;
  from: string;
  to: string;
  toType: "address" | "contract";
  assetId: string;
  amount: string;
  permit?: DepositPermit;
}

export interface DepositPrepareResponse {
  unsignedTransaction: string;
  preparationProof: string;
}

export interface SubmitRequest {
  preparationProof: string;
  unsignedTransaction: string;
  signature: string;
}

export interface DepositSubmitResponse {
  sourceChainId: number;
  evmTxHash: string;
  status: "submitted";
  submittedAt: string;
}

export interface DepositSourceStatus {
  status: "pending" | "confirmed" | "reverted";
  blockNumber?: string;
  confirmations?: string;
}

export interface UnavailableStatus {
  status: "unavailable";
}

export interface DepositStatusResponse {
  sourceChainId: number;
  evmTxHash: string;
  source: DepositSourceStatus;
  fuel: UnavailableStatus;
  requestHash?: string;
}

export interface RateLimitInfo {
  transactionLimit: string | null;
  dailyLimit: string | null;
  withdrawnToday: string;
  remainingToday: string | null;
  resetsAt: string;
}

export interface WithdrawAssetInfo {
  assetId: string;
  tokenAddress: string | null;
  fuelDecimals: number;
  tokenDecimals: number;
  withdrawEnabled: boolean;
  fee: string;
  feeQuoteBlockHeight: string;
  feeObservedAt: string;
  rateLimit: RateLimitInfo;
  amountEligible?: boolean;
  ineligibilityReason?: string;
}

export interface WithdrawInfoResponse {
  destinationChainId: number;
  routeEnabled: boolean;
  messengerAddress: string;
  outpostAddress: string;
  fuelContracts: WithdrawalFuelContracts;
  paused: boolean;
  recipientFormat: "evm-address";
  assets: WithdrawAssetInfo[];
}

export interface WithdrawFeeResponse {
  destinationChainId: number;
  assetId: string;
  fee: string;
  fuelBlockHeight: string;
  observedAt: string;
  configVersion: string;
}

export interface WithdrawPrepareRequest {
  destinationChainId: number;
  from: string;
  to: string;
  assetId: string;
  amount: string;
}

export interface WithdrawPrepareResponse {
  unsignedTransaction: string;
  fuelChainId: string;
  preparationProof: string;
}

export interface WithdrawSubmitResponse {
  fuelTxId: string;
  status: "submitted";
  submittedAt: string;
}

export interface FuelStatus {
  status: "pending" | "success" | "reverted";
  blockHeight?: string;
  failureReason?: string;
}

export interface WithdrawStatusResponse {
  fuelTxId: string;
  fuel: FuelStatus;
  requestHash?: string;
  destinationChainId?: number;
  destination?: UnavailableStatus;
}
