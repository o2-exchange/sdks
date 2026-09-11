"""Fast Bridge: all proxy v1 endpoints and offline inspection helpers.

Run: python examples/fast_bridge.py
Required env: BRIDGE_PROXY_URL (root URL, no /v1), BRIDGE_EVM_CHAIN_ID.
Optional: BRIDGE_ASSET_ID (full Fuel AssetId), BRIDGE_AMOUNT (integer string),
BRIDGE_EVM_TX_HASH / BRIDGE_FUEL_TX_ID to query existing transfers.
The entry point only reads. Import deposit/withdraw to explicitly send funds.
No trading session, additional crypto package, or Worker secret is needed.
Parsers target proxy unsigned EIP-1559 and fuels 0.103.0 single-CALL scripts,
not arbitrary transactions. Unsupported scripts, predicates, signed envelopes,
nonempty owner witnesses, malformed or trailing bytes are rejected.
"""

import asyncio
import os
import time
from collections.abc import Awaitable, Callable
from pprint import pprint
from typing import Any

from o2_sdk import (
    BridgeApiError,
    FastBridgeClient,
    fuel_compact_sign,
    parse_evm_unsigned_transaction,
    parse_fuel_unsigned_transaction,
    parse_preparation_proof,
)
from o2_sdk.bridge.inspection import (
    EvmDepositInspection,
    FuelWithdrawalInspection,
    PreparationProofClaims,
)
from o2_sdk.bridge.models import (
    DepositPrepareRequest,
    DepositSubmitResponse,
    SubmitRequest,
    WithdrawPrepareRequest,
    WithdrawSubmitResponse,
)


async def deposit(
    client: FastBridgeClient,
    request: DepositPrepareRequest,
    private_key: bytes,
    approve: Callable[[DepositPrepareRequest, EvmDepositInspection], bool],
) -> DepositSubmitResponse:
    """Prepare, inspect, explicitly approve, sign, submit, and read deposit status.

    Example request (addresses/IDs come from your application):
        DepositPrepareRequest(
            source_chain_id=11155111, from_address=evm_address, to=fuel_recipient,
            to_type="address", asset_id=full_fuel_asset_id, amount="1000000",
        )
    from_address is a 20-byte EVM sender (wire key "from"); to is a Fuel B256.
    Use to_type="contract" for a receiving contract. asset_id is the full Fuel
    AssetId, NOT the asset sub-ID or EVM token address. amount uses Fuel decimals:
    "1000000" is 0.001 of a nine-decimal asset. No floats/human-unit conversion.

    The route selects depositETH (native ETH) vs deposit (ERC-20). ERC-20 needs
    an existing allowance or optional permit for depositWithPermit:
        permit=DepositPermit(deadline="<Unix seconds>", v=27,
                             r="0x<32 bytes>", s="0x<32 bytes>")
    Import DepositPermit from o2_sdk.bridge.models. This is a separately signed
    EIP-2612 token approval, NOT the transaction signature. Use trusted token
    domain/nonce/spender/value; approval/permit creation is outside this API.
    """
    # POST /v1/deposit/prepare: exact unsigned bytes and an opaque submission proof.
    prepared = await client.prepare_deposit(request)
    claims = show_proof(prepared.preparation_proof)
    tx = parse_evm_unsigned_transaction(prepared.unsigned_transaction)
    pprint(tx)
    # Inspect chain_id, nonce, messenger_address, method, recipient/type,
    # token_address, amount, value, gas_limit, both fee caps, data and permit.
    # Python int quantities use EVM token units/wei, unlike API Fuel-unit amounts.
    # estimated_network_fee = gas_limit * max_fee_per_gas: maximum execution gas
    # budget in wei, not actual cost; excludes rollup L1 data fees. Convert units.
    # approve MUST compare the parsed transaction with the request AND trusted
    # deployments/token metadata/fee limits. Parsing is not economic approval.
    if not approve(request, tx):
        raise ValueError("Deposit not approved")
    check_expiry(claims)

    # Sign the locally derived raw digest; personal_sign/raw_sign would rehash it.
    # Expand compact secp256k1 recovery bit into EVM r || s || v (65 bytes).
    signature = bytearray(fuel_compact_sign(private_key, bytes.fromhex(tx.signing_digest[2:])))
    signature.append(27 + (signature[32] >> 7))
    signature[32] &= 0x7F
    # POST /v1/deposit/submit: exact unsigned bytes, proof, and separate signature.
    submitted = await client.submit_deposit(
        SubmitRequest(
            unsigned_transaction=prepared.unsigned_transaction,
            preparation_proof=prepared.preparation_proof,
            signature="0x" + signature.hex(),
        )
    )
    print("Submitted (not confirmed):", submitted)
    # GET /v1/deposit/status: source inclusion/revert; fuel unavailable != mint.
    await show_status(
        lambda: client.get_deposit_status(submitted.source_chain_id, submitted.evm_tx_hash)
    )
    return submitted


async def withdraw(
    client: FastBridgeClient,
    request: WithdrawPrepareRequest,
    private_key: bytes,
    trusted_fuel_chain_id: int,
    trusted_max_inputs: int,
    approve: Callable[[WithdrawPrepareRequest, FuelWithdrawalInspection], bool],
) -> WithdrawSubmitResponse:
    """Prepare, inspect, explicitly approve, sign, submit, and read withdrawal status.

    Request: WithdrawPrepareRequest(
        destination_chain_id=11155111, from_address=fuel_address, to=evm_recipient,
        asset_id=full_fuel_asset_id, amount="1000000",
    )
    from_address: Fuel B256 address; to: EVM 20-byte address; amount: Fuel units.
    Spends a funded Fuel wallet, not an O2 account/session. Obtain chain ID and
    consensus maxInputs independently, not from the proxy or prepared bytes.
    """
    # POST /v1/withdraw/prepare. Do not use prepare to poll status or balances.
    prepared = await client.prepare_withdraw(request)
    if int(prepared.fuel_chain_id) != trusted_fuel_chain_id:
        raise ValueError("Wrong Fuel chain")
    claims = show_proof(prepared.preparation_proof)
    # maxInputs is not encoded in the tx; it determines FuelVM absolute pointers.
    tx = parse_fuel_unsigned_transaction(
        prepared.unsigned_transaction, trusted_fuel_chain_id, trusted_max_inputs
    )
    pprint(tx)
    # Includes asset_id, asset_sub_id (asset sub-ID), asset_registry_contract_id,
    # destination_chain_id, recipient, gross_amount, bridge_fee, net_amount,
    # network_fee.max_fee, expiration_block_height, script_gas_limit, policies,
    # inputs, outputs, and locally computed transaction_id. Quantities are int.
    # bridge_fee is the embedded quote; net_amount = gross_amount - bridge_fee is
    # expected, not guaranteed: the current oracle fee may move within tolerance.
    # max_fee is a cap in Fuel's base asset, not necessarily the withdrawn asset.
    # Block expiry is separate from proof expiry. Check every input owner/asset,
    # all contracts and outputs against trusted config and your transfer intent.
    # Change/Variable amounts and Variable to/asset_id are execution results excluded
    # from the signing ID, NOT signed guarantees. Parsers make no RPC calls/certification.
    if not approve(request, tx):
        raise ValueError("Withdrawal not approved")
    check_expiry(claims)

    signature = fuel_compact_sign(private_key, bytes.fromhex(tx.transaction_id[2:]))
    print("Fuel transaction ID (save for status after a timeout):", tx.transaction_id)
    # Existing wallets/external signers with sign_digest can sign this raw ID too.
    # POST /v1/withdraw/submit: only these three fields, not fuel_chain_id.
    submitted = await client.submit_withdraw(
        SubmitRequest(
            unsigned_transaction=prepared.unsigned_transaction,
            preparation_proof=prepared.preparation_proof,
            signature="0x" + signature.hex(),
        )
    )
    print("Submitted (not confirmed):", submitted)
    # GET /v1/withdraw/status: Fuel success/revert; destination unavailable != delivery.
    await show_status(lambda: client.get_withdraw_status(tx.transaction_id))
    return submitted


def show_proof(proof: str) -> PreparationProofClaims:
    claims = parse_preparation_proof(proof)
    print("Unauthenticated claims:", claims)  # version, key_id, expires_at, signer
    # expires_at: Unix seconds. Signer is merely claimed; forged/expired proofs
    # can parse. Only the proxy authenticates HMAC + operation + exact tx bytes.
    # Never distribute the Worker secret. There is deliberately no verify helper.
    return claims


def check_expiry(claims: PreparationProofClaims) -> None:
    if claims.expires_at <= time.time():
        raise ValueError("Prepare again: proof expired")


async def show_status(read: Callable[[], Awaitable[Any]]) -> None:
    try:
        pprint(await read())
    except BridgeApiError as error:
        if error.status != 404:
            raise
        print("Not found yet (404), not fabricated pending:", error.bridge_code, error.details)


async def main() -> None:
    chain_id = int(os.environ["BRIDGE_EVM_CHAIN_ID"])
    async with FastBridgeClient(os.environ["BRIDGE_PROXY_URL"], timeout_seconds=30) as client:
        # GET /v1/info: chains/contracts/proof lifetime, NOT a trust anchor.
        pprint(await client.get_info())
        # GET /v1/assets: full Fuel IDs, decimals and chain-specific EVM token routes.
        pprint(await client.get_assets())
        pprint(await client.get_assets(chain_id))  # optional chain filter
        asset_id = os.getenv("BRIDGE_ASSET_ID")
        amount = os.getenv("BRIDGE_AMOUNT")  # optional eligibility check, not a float
        # GET /v1/deposit/info: route, pause, caps/capacity, whitelist, allowance/permit.
        pprint(await client.get_deposit_info(chain_id, asset_id, amount))
        # GET /v1/withdraw/info: route, contracts, fees/freshness, limits, eligibility.
        pprint(await client.get_withdraw_info(chain_id, asset_id, amount))
        if asset_id:
            # GET /v1/withdraw/fee: Fuel-asset fee, observation time and block height.
            pprint(await client.get_withdraw_fee(chain_id, asset_id))
        if evm_tx_hash := os.getenv("BRIDGE_EVM_TX_HASH"):
            await show_status(lambda: client.get_deposit_status(chain_id, evm_tx_hash))
        if fuel_tx_id := os.getenv("BRIDGE_FUEL_TX_ID"):
            await show_status(lambda: client.get_withdraw_status(fuel_tx_id))
        # Re-run status reads with bounded backoff to track inclusion, not prepare.
        # No automatic retries or redirects. Submit timeouts can mean acceptance:
        # reconcile before resubmitting. Fuel ID is locally available; for EVM,
        # recover the signed hash via wallet/chain sender+nonce, NOT signing_digest.
    # The context manager closes owned aiohttp sessions, not borrowed session= ones.


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except BridgeApiError as error:
        print(error.status, error.bridge_code, str(error), error.details)
        raise SystemExit(1) from error
    # Parser ValueErrors and native aiohttp/asyncio transport/timeouts propagate.
