//! Fast Bridge: all proxy v1 endpoints and offline inspection helpers.
//!
//! Run: cargo run --example fast_bridge
//! Required env: BRIDGE_PROXY_URL (root URL, no /v1), BRIDGE_EVM_CHAIN_ID.
//! Optional: BRIDGE_ASSET_ID (full Fuel AssetId), BRIDGE_AMOUNT (integer string),
//! BRIDGE_EVM_TX_HASH / BRIDGE_FUEL_TX_ID to query existing transfers.
//! main only reads. Call deposit/withdraw explicitly to send funds.
//! No trading session, additional crypto crate, or Worker secret is needed.
//! Parsers target proxy unsigned EIP-1559 and fuels 0.103.0 single-CALL scripts,
//! not arbitrary transactions. Unsupported scripts, predicates, signed envelopes,
//! nonempty owner witnesses, malformed or trailing bytes are rejected.

use o2_sdk::bridge::{
    parse_evm_unsigned_transaction, parse_fuel_unsigned_transaction, parse_preparation_proof,
    BridgeError, DepositPrepareRequest, DepositSubmitResponse, EvmDepositInspection,
    FastBridgeClient, FuelWithdrawalInspection, PreparationProofClaims, SubmitRequest,
    WithdrawPrepareRequest, WithdrawSubmitResponse,
};
use o2_sdk::crypto::{fuel_compact_sign, parse_hex_32, to_hex_string};
use std::{
    env,
    error::Error,
    fmt::Debug,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Prepare, inspect, explicitly approve, sign, submit, and read deposit status.
///
/// Example request (addresses/IDs come from your application):
/// DepositPrepareRequest {
///     source_chain_id: 11155111, from_address: evm_address, to: fuel_recipient,
///     to_type: RecipientType::Address, asset_id: full_fuel_asset_id,
///     amount: "1000000".into(), permit: None,
/// }
/// from_address is a 20-byte EVM sender (wire key "from"); to is a Fuel B256.
/// Use RecipientType::Contract for receiving contracts. asset_id is the full Fuel
/// AssetId, NOT the asset sub-ID or EVM token address. amount uses Fuel decimals:
/// "1000000" is 0.001 of a nine-decimal asset. No floats/human-unit conversion.
///
/// The route selects depositETH (native ETH) vs deposit (ERC-20). ERC-20 needs
/// an existing allowance or optional permit for depositWithPermit:
/// Some(DepositPermit { deadline: "<Unix seconds>".into(), v: 27,
///                      r: "0x<32 bytes>".into(), s: "0x<32 bytes>".into() })
/// Import RecipientType/DepositPermit from o2_sdk::bridge. Permit is a separately
/// signed EIP-2612 token approval, NOT the transaction signature. Use trusted
/// token domain/nonce/spender/value; approval/permit creation is outside this API.
pub async fn deposit(
    client: &FastBridgeClient,
    request: &DepositPrepareRequest,
    private_key: &[u8; 32],
    approve: impl FnOnce(&DepositPrepareRequest, &EvmDepositInspection) -> bool,
) -> Result<DepositSubmitResponse, Box<dyn Error>> {
    // POST /v1/deposit/prepare: exact unsigned bytes and opaque submission proof.
    let prepared = client.prepare_deposit(request).await?;
    let claims = show_proof(&prepared.preparation_proof)?;
    let tx = parse_evm_unsigned_transaction(&prepared.unsigned_transaction)?;
    println!("{tx:#?}");
    // Inspect chain_id, nonce, messenger_address, method, recipient/type,
    // token_address, amount, value, gas_limit, both fee caps, data and permit.
    // EVM quantities are decimal strings (lossless uint256), in EVM token units
    // or wei, unlike API Fuel-unit amounts. Do not compare strings lexically.
    // estimated_network_fee = gas_limit * max_fee_per_gas: maximum execution gas
    // budget in wei, not actual cost; excludes rollup L1 data fees. Convert units.
    // approve MUST compare the parsed transaction with the request AND trusted
    // deployments/token metadata/fee limits. Parsing is not economic approval.
    if !approve(request, &tx) {
        return Err("Deposit not approved".into());
    }
    check_expiry(&claims)?;

    // Sign the locally derived raw digest, not personal_sign/raw_sign (rehashes).
    // Expand compact secp256k1 recovery bit into EVM r || s || v (65 bytes).
    let mut signature =
        fuel_compact_sign(private_key, &parse_hex_32(&tx.signing_digest)?)?.to_vec();
    signature.push(27 + (signature[32] >> 7));
    signature[32] &= 0x7f;
    // POST /v1/deposit/submit: exact unsigned bytes, proof, separate signature.
    let submitted = client
        .submit_deposit(&SubmitRequest {
            unsigned_transaction: prepared.unsigned_transaction,
            preparation_proof: prepared.preparation_proof,
            signature: to_hex_string(&signature),
        })
        .await?;
    println!("Submitted (not confirmed): {submitted:#?}");
    // GET /v1/deposit/status: source inclusion/revert; fuel unavailable != mint.
    show_status(
        client
            .get_deposit_status(submitted.source_chain_id, &submitted.evm_tx_hash)
            .await,
    )?;
    Ok(submitted)
}

/// Prepare, inspect, explicitly approve, sign, submit, and read withdrawal status.
///
/// Request: WithdrawPrepareRequest {
///     destination_chain_id: 11155111, from_address: fuel_address, to: evm_recipient,
///     asset_id: full_fuel_asset_id, amount: "1000000".into(),
/// }
/// from_address: Fuel B256 address; to: EVM 20-byte address; amount: Fuel units.
/// Spends a funded Fuel wallet, not an O2 account/session. Obtain chain ID and
/// consensus maxInputs independently, not from the proxy or prepared bytes.
pub async fn withdraw(
    client: &FastBridgeClient,
    request: &WithdrawPrepareRequest,
    private_key: &[u8; 32],
    trusted_fuel_chain_id: u64,
    trusted_max_inputs: u16,
    approve: impl FnOnce(&WithdrawPrepareRequest, &FuelWithdrawalInspection) -> bool,
) -> Result<WithdrawSubmitResponse, Box<dyn Error>> {
    // POST /v1/withdraw/prepare. Do not use prepare to poll status or balances.
    let prepared = client.prepare_withdraw(request).await?;
    if prepared.fuel_chain_id.parse::<u64>()? != trusted_fuel_chain_id {
        return Err("Wrong Fuel chain".into());
    }
    let claims = show_proof(&prepared.preparation_proof)?;
    // maxInputs is not encoded in the tx; it determines FuelVM absolute pointers.
    let tx = parse_fuel_unsigned_transaction(
        &prepared.unsigned_transaction,
        trusted_fuel_chain_id,
        trusted_max_inputs,
    )?;
    println!("{tx:#?}");
    // Includes asset_id, asset_sub_id (asset sub-ID), asset_registry_contract_id,
    // destination_chain_id, recipient, gross_amount, bridge_fee, net_amount,
    // network_fee.max_fee, expiration_block_height, script_gas_limit, policies,
    // inputs, outputs, locally computed transaction_id. Fuel amounts use u64.
    // bridge_fee is the embedded quote; net_amount = gross_amount - bridge_fee is
    // expected, not guaranteed: the current oracle fee may move within tolerance.
    // max_fee is a cap in Fuel's base asset, not necessarily the withdrawn asset.
    // Block expiry is separate from proof expiry. Check every input owner/asset,
    // all contracts and outputs against trusted config and your transfer intent.
    // Change/Variable amounts and Variable to/asset_id are execution results excluded
    // from the signing ID, NOT signed guarantees. Parsers make no RPC calls/certification.
    if !approve(request, &tx) {
        return Err("Withdrawal not approved".into());
    }
    check_expiry(&claims)?;

    let signature = fuel_compact_sign(private_key, &parse_hex_32(&tx.transaction_id)?)?;
    println!(
        "Fuel transaction ID (save for status after a timeout): {}",
        tx.transaction_id
    );
    // POST /v1/withdraw/submit: only these three fields, not fuel_chain_id.
    let submitted = client
        .submit_withdraw(&SubmitRequest {
            unsigned_transaction: prepared.unsigned_transaction,
            preparation_proof: prepared.preparation_proof,
            signature: to_hex_string(&signature),
        })
        .await?;
    println!("Submitted (not confirmed): {submitted:#?}");
    // GET /v1/withdraw/status: Fuel success/revert; destination unavailable != delivery.
    show_status(client.get_withdraw_status(&tx.transaction_id).await)?;
    Ok(submitted)
}

fn show_proof(proof: &str) -> Result<PreparationProofClaims, BridgeError> {
    let claims = parse_preparation_proof(proof)?;
    println!("Unauthenticated claims: {claims:#?}"); // version, key_id, expires_at, signer
                                                     // expires_at: Unix seconds. Signer is merely claimed; forged/expired proofs
                                                     // can parse. Only the proxy authenticates HMAC + operation + exact tx bytes.
                                                     // Never distribute the Worker secret. There is deliberately no verify helper.
    Ok(claims)
}

fn check_expiry(claims: &PreparationProofClaims) -> Result<(), Box<dyn Error>> {
    if claims.expires_at <= SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() {
        return Err("Prepare again: proof expired".into());
    }
    Ok(())
}

fn show_status<T: Debug>(result: Result<T, BridgeError>) -> Result<(), BridgeError> {
    match result {
        Ok(status) => println!("{status:#?}"),
        Err(BridgeError::Api {
            status: 404,
            code,
            details,
            ..
        }) => println!("Not found yet (404), not fabricated pending: {code}, {details:?}"),
        Err(error) => return Err(error),
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let chain_id = env::var("BRIDGE_EVM_CHAIN_ID")?.parse::<u64>()?;
    let client =
        FastBridgeClient::with_timeout(&env::var("BRIDGE_PROXY_URL")?, Duration::from_secs(30))?;
    // GET /v1/info: chains/contracts/proof lifetime, NOT a trust anchor.
    println!("{:#?}", client.get_info().await?);
    // GET /v1/assets: full Fuel IDs, decimals and chain-specific EVM token routes.
    println!("{:#?}", client.get_assets(None).await?);
    println!("{:#?}", client.get_assets(Some(chain_id)).await?); // optional chain filter
    let asset_id = env::var("BRIDGE_ASSET_ID").ok();
    let amount = env::var("BRIDGE_AMOUNT").ok(); // optional eligibility check, not a float
                                                 // GET /v1/deposit/info: route, pause, caps/capacity, whitelist, allowance/permit.
    println!(
        "{:#?}",
        client
            .get_deposit_info(chain_id, asset_id.as_deref(), amount.as_deref())
            .await?
    );
    // GET /v1/withdraw/info: route, contracts, fees/freshness, limits, eligibility.
    println!(
        "{:#?}",
        client
            .get_withdraw_info(chain_id, asset_id.as_deref(), amount.as_deref())
            .await?
    );
    if let Some(asset_id) = asset_id {
        // GET /v1/withdraw/fee: Fuel-asset fee, observation time and block height.
        println!("{:#?}", client.get_withdraw_fee(chain_id, &asset_id).await?);
    }
    if let Ok(hash) = env::var("BRIDGE_EVM_TX_HASH") {
        show_status(client.get_deposit_status(chain_id, &hash).await)?;
    }
    if let Ok(id) = env::var("BRIDGE_FUEL_TX_ID") {
        show_status(client.get_withdraw_status(&id).await)?;
    }
    // Re-run status reads with bounded backoff to track inclusion, not prepare.
    // No automatic retries or redirects. Submit timeouts can mean acceptance:
    // reconcile before resubmitting. Fuel ID is locally available; for EVM,
    // recover the signed hash via wallet/chain sender+nonce, NOT signing_digest.
    // Other errors propagate: BridgeError::Api preserves status/code/message/details;
    // Transport/Json report HTTP/decoding problems, Invalid reports parser failures.
    Ok(())
}
