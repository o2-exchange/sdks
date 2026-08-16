"""Live withdrawal regression tests against the configured O2 testnet."""

import asyncio

import pytest

from o2_sdk import ContractIdentity, Network, O2Client

pytestmark = pytest.mark.integration


async def _wait_for_balance(client: O2Client, trade_account_id: str, asset_id: str) -> int:
    for _ in range(24):
        balance = await client.api.get_balance(asset_id=asset_id, contract=trade_account_id)
        raw = int(balance.trading_account_balance)
        if raw >= 2:
            return raw
        await asyncio.sleep(5)
    raise AssertionError("Testnet faucet balance did not arrive within 120 seconds")


async def _wait_for_nonce(client: O2Client, trade_account_id: str, previous: int) -> None:
    for _ in range(24):
        if await client.get_nonce(trade_account_id) > previous:
            return
        await asyncio.sleep(5)
    raise AssertionError("Testnet account nonce did not advance within 120 seconds")


async def _wait_for_exact_balance(
    client: O2Client, trade_account_id: str, asset_id: str, expected: int
) -> None:
    for _ in range(24):
        balance = await client.api.get_balance(asset_id=asset_id, contract=trade_account_id)
        if int(balance.trading_account_balance) == expected:
            return
        await asyncio.sleep(5)
    raise AssertionError(f"Testnet balance did not reach {expected} within 120 seconds")


async def test_withdraw_to_address_and_contract_id():
    source_client = O2Client(network=Network.TESTNET)
    recipient_client = O2Client(network=Network.TESTNET)
    try:
        source_wallet = source_client.generate_wallet()
        source_account = await source_client.setup_account(source_wallet)
        assert source_account.trade_account_id is not None

        recipient_wallet = recipient_client.generate_wallet()
        recipient = await recipient_client.api.create_account(recipient_wallet.b256_address)

        markets = await source_client.api.get_markets()
        asset = next(
            asset
            for market in markets.markets
            for asset in (market.base, market.quote)
            if asset.symbol == "fUSDC"
        )
        before = await _wait_for_balance(
            source_client,
            str(source_account.trade_account_id),
            str(asset.asset),
        )
        nonce_before = await source_client.get_nonce(str(source_account.trade_account_id))

        atomic_amount = 10.0 ** (-asset.decimals)
        assert int(atomic_amount * (10**asset.decimals)) == 1

        address_result = await source_client.withdraw(
            source_wallet,
            asset.asset,
            atomic_amount,
            source_wallet.b256_address,
        )
        assert address_result.success, address_result.message
        await _wait_for_nonce(
            source_client,
            str(source_account.trade_account_id),
            nonce_before,
        )

        contract_result = await source_client.withdraw(
            source_wallet,
            asset.asset,
            atomic_amount,
            ContractIdentity(str(recipient.trade_account_id)),
        )
        assert contract_result.success, contract_result.message
        await _wait_for_exact_balance(
            source_client,
            str(source_account.trade_account_id),
            str(asset.asset),
            before - 2,
        )
    finally:
        await source_client.close()
        await recipient_client.close()
