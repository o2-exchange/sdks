/**
 * Fast Bridge: all proxy v1 endpoints and offline inspection helpers.
 * Run from this SDK after npm run build: npx tsx examples/fast-bridge.ts
 * Required env: BRIDGE_PROXY_URL (root URL, no /v1), BRIDGE_EVM_CHAIN_ID.
 * Optional: BRIDGE_ASSET_ID (full Fuel AssetId), BRIDGE_AMOUNT (integer string),
 * BRIDGE_EVM_TX_HASH / BRIDGE_FUEL_TX_ID to query existing transfers.
 * The entry point only reads. Import deposit/withdraw to explicitly send funds.
 * No trading session, additional crypto package, or Worker secret is needed.
 * Parsers target proxy unsigned EIP-1559 and fuels 0.103.0 single-CALL scripts,
 * not arbitrary transactions. Unsupported scripts, predicates, signed envelopes,
 * nonempty owner witnesses, malformed or trailing bytes are rejected.
 */

import { pathToFileURL } from "node:url";
import {
  BridgeApiError,
  type bridge,
  FastBridgeClient,
  parseEvmUnsignedTransaction,
  parseFuelUnsignedTransaction,
  parsePreparationProof,
} from "@o2exchange/sdk";
import { bytesToHex, fuelCompactSign, hexToBytes } from "@o2exchange/sdk/internals";

/**
 * Example request (all addresses/IDs come from your application):
 * { sourceChainId: 11155111, from: evmAddress, to: fuelRecipient,
 *   toType: "address", assetId: fullFuelAssetId, amount: "1000000" }
 * from: 20-byte EVM sender; to: 32-byte Fuel identity. For a receiving contract,
 * set toType: "contract". assetId is NOT the asset sub-ID or EVM token address.
 * amount uses Fuel decimals: "1000000" is 0.001 of a nine-decimal asset.
 *
 * The selected route determines depositETH (native ETH) vs deposit (ERC-20).
 * ERC-20 needs an existing allowance, or optional permit for depositWithPermit:
 * permit: { deadline: "<Unix seconds>", v: 27, r: "0x<32 bytes>", s: "0x<32 bytes>" }
 * This is an independently signed EIP-2612 token approval, NOT the tx signature;
 * obtain its domain/nonce/spender/value from the token and your trusted config.
 * Approvals/permit creation happen in your wallet, outside the proxy API.
 */
export async function deposit(
  client: FastBridgeClient,
  request: bridge.DepositPrepareRequest,
  privateKey: Uint8Array,
  approve: (
    request: bridge.DepositPrepareRequest,
    tx: bridge.EvmDepositInspection,
  ) => Promise<boolean>,
) {
  // POST /v1/deposit/prepare: exact unsigned bytes and an opaque submission proof.
  const prepared = await client.prepareDeposit(request);
  const claims = showProof(prepared.preparationProof);
  const tx = parseEvmUnsignedTransaction(prepared.unsignedTransaction);
  console.dir(tx, { depth: null });
  // Inspect chainId, nonce, messengerAddress, method, recipient/type, tokenAddress,
  // amount, value, gasLimit, both fee caps, calldata, and any embedded permit.
  // bigint amounts use EVM token units/wei, unlike the API's Fuel-unit amount.
  // estimatedNetworkFee = gasLimit * maxFeePerGas: maximum execution gas budget
  // in wei, not actual cost; excludes rollup L1 data fees. Convert units explicitly.
  // approve MUST check these against the request AND independently trusted
  // deployments/token metadata and fee limits. Parsing alone is not approval.
  if (!(await approve(request, tx))) throw new Error("Deposit not approved");
  checkExpiry(claims);

  // Sign the locally computed raw digest, never personalSign/rawSign (rehashes).
  // Expand the existing compact secp256k1 signature to EVM r || s || v (65 bytes).
  const compact = fuelCompactSign(privateKey, hexToBytes(tx.signingDigest));
  const signature = new Uint8Array(65);
  signature.set(compact);
  signature[64] = 27 + (compact[32] >>> 7);
  signature[32] &= 0x7f;
  // With ethers already installed, an alternative is Transaction.from(unsigned),
  // inspect, wallet.signTransaction(tx), then Transaction.from(signed).signature.
  // serialized. Do not submit a signed envelope or sign an API-supplied digest.

  // POST /v1/deposit/submit: preserve the exact prepared bytes and proof.
  const submitted = await client.submitDeposit({
    unsignedTransaction: prepared.unsignedTransaction,
    preparationProof: prepared.preparationProof,
    signature: bytesToHex(signature),
  });
  console.log("Submitted (not confirmed):", submitted);
  // GET /v1/deposit/status: source inclusion/revert; fuel: unavailable is NOT mint.
  await showStatus(() => client.getDepositStatus(submitted.sourceChainId, submitted.evmTxHash));
  return submitted;
}

/**
 * Request: { destinationChainId: 11155111, from: fuelAddress, to: evmRecipient,
 *            assetId: fullFuelAssetId, amount: "1000000" }
 * from: Fuel B256 address; to: EVM 20-byte address; amount: Fuel base units.
 * This spends a funded Fuel wallet, not an O2 trading account/session.
 * trustedFuelChainId and trustedMaxInputs must come from independently trusted
 * chain configuration/consensus parameters, not the proxy or prepared bytes.
 */
export async function withdraw(
  client: FastBridgeClient,
  request: bridge.WithdrawPrepareRequest,
  privateKey: Uint8Array,
  trustedFuelChainId: bigint,
  trustedMaxInputs: number,
  approve: (
    request: bridge.WithdrawPrepareRequest,
    tx: bridge.FuelWithdrawalInspection,
  ) => Promise<boolean>,
) {
  // POST /v1/withdraw/prepare. Never use prepare as a status/balance poll.
  const prepared = await client.prepareWithdraw(request);
  if (BigInt(prepared.fuelChainId) !== trustedFuelChainId) throw new Error("Wrong Fuel chain");
  const claims = showProof(prepared.preparationProof);
  // maxInputs is not encoded in the tx; it determines FuelVM absolute pointers.
  const tx = parseFuelUnsignedTransaction(
    prepared.unsignedTransaction,
    trustedFuelChainId,
    trustedMaxInputs,
  );
  console.dir(tx, { depth: null });
  // Includes assetId, assetSubId (asset sub-ID), assetRegistryContractId,
  // destinationChainId, recipient, grossAmount, bridgeFee, netAmount,
  // networkFee.maxFee, expirationBlockHeight, scriptGasLimit, policies, inputs,
  // outputs, and locally computed transactionId. Quantities are bigint.
  // bridgeFee is the embedded quote; netAmount = grossAmount - bridgeFee is
  // expected, not guaranteed: the current oracle fee may change within tolerance.
  // maxFee is a cap in Fuel's base asset, not necessarily the withdrawn asset.
  // Block expiry is independent of proof expiry. Check every input owner/asset,
  // all contracts and outputs against trusted config and your transfer intent.
  // Change/Variable amounts and Variable to/assetId are execution results excluded
  // from the signing ID, NOT signed guarantees. Parsers make no RPC calls or safety approvals.
  if (!(await approve(request, tx))) throw new Error("Withdrawal not approved");
  checkExpiry(claims);

  const signature = fuelCompactSign(privateKey, hexToBytes(tx.transactionId));
  console.log("Fuel transaction ID (save for status after a timeout):", tx.transactionId);
  // POST /v1/withdraw/submit. Only these three fields; do not spread fuelChainId.
  const submitted = await client.submitWithdraw({
    unsignedTransaction: prepared.unsignedTransaction,
    preparationProof: prepared.preparationProof,
    signature: bytesToHex(signature),
  });
  console.log("Submitted (not confirmed):", submitted);
  // GET /v1/withdraw/status: Fuel success/revert; destination unavailable != delivered.
  await showStatus(() => client.getWithdrawStatus(tx.transactionId));
  return submitted;
}

function showProof(proof: string) {
  const claims = parsePreparationProof(proof);
  console.log("Unauthenticated claims:", claims); // version, keyId, expiresAt, signer
  // expiresAt is Unix seconds; signer is merely claimed. Forged/expired proofs
  // can parse. Only the proxy authenticates HMAC + operation + exact tx bytes.
  // Never give clients the Worker secret. There is deliberately no verify helper.
  return claims;
}

function checkExpiry(claims: bridge.PreparationProofClaims) {
  if (claims.expiresAt <= Date.now() / 1000) throw new Error("Prepare again: proof expired");
}

async function showStatus(read: () => Promise<unknown>) {
  try {
    console.dir(await read(), { depth: null });
  } catch (error) {
    if (!(error instanceof BridgeApiError) || error.status !== 404) throw error;
    console.log("Not found yet (404), not fabricated pending:", error.bridgeCode, error.details);
  }
}

async function main() {
  const baseUrl = process.env.BRIDGE_PROXY_URL;
  const chainId = Number(process.env.BRIDGE_EVM_CHAIN_ID);
  if (!baseUrl || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("Set BRIDGE_PROXY_URL and BRIDGE_EVM_CHAIN_ID");
  }
  const client = new FastBridgeClient({ baseUrl, timeoutMs: 30_000 });
  // GET /v1/info: chains/contracts/proof lifetime; discovery is NOT a trust anchor.
  console.dir(await client.getInfo(), { depth: null });
  // GET /v1/assets: full Fuel IDs, decimals, and chain-specific EVM token routes.
  console.dir(await client.getAssets(), { depth: null });
  console.dir(await client.getAssets(chainId), { depth: null }); // optional chain filter
  const assetId = process.env.BRIDGE_ASSET_ID;
  const amount = process.env.BRIDGE_AMOUNT; // optional eligibility check, not a float
  // GET /v1/deposit/info: route, pause, caps/capacity, whitelist, allowance/permit.
  console.dir(await client.getDepositInfo(chainId, assetId, amount), { depth: null });
  // GET /v1/withdraw/info: route, contracts, fee/freshness, limits, eligibility.
  console.dir(await client.getWithdrawInfo(chainId, assetId, amount), { depth: null });
  if (assetId) {
    // GET /v1/withdraw/fee: Fuel-asset fee with observation time and block height.
    console.log(await client.getWithdrawFee(chainId, assetId));
  }
  const evmTxHash = process.env.BRIDGE_EVM_TX_HASH;
  const fuelTxId = process.env.BRIDGE_FUEL_TX_ID;
  if (evmTxHash) await showStatus(() => client.getDepositStatus(chainId, evmTxHash));
  if (fuelTxId) await showStatus(() => client.getWithdrawStatus(fuelTxId));
  // Re-run status reads with bounded backoff to track inclusion, not prepare.
  // No automatic retries or redirects. A submit timeout can mean acceptance:
  // reconcile status before resubmitting. Fuel ID is locally available; for EVM,
  // recover the signed tx hash via your wallet/chain using the sender and nonce,
  // not signingDigest (which is NOT the signed transaction hash).
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof BridgeApiError) {
      console.error(error.status, error.bridgeCode, error.message, error.details);
    } else {
      console.error(error); // parser errors or native fetch/timeout errors
    }
    process.exitCode = 1;
  });
}
