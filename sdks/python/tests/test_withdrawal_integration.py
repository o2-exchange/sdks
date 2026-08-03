"""Live withdrawal regression tests against the configured O2 devnet."""

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
    raise AssertionError("Devnet faucet balance did not arrive within 120 seconds")


async def test_withdraw_to_address_and_contract_id():
    source_client = O2Client(network=Network.DEVNET)
    recipient_client = O2Client(network=Network.DEVNET)
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
            if asset.symbol == "USDC"
        )
        before = await _wait_for_balance(
            source_client,
            str(source_account.trade_account_id),
            str(asset.asset),
        )

        atomic_amount = 10.0 ** (-asset.decimals)
        assert int(atomic_amount * (10**asset.decimals)) == 1

        address_result = await source_client.withdraw(
            source_wallet,
            asset.asset,
            atomic_amount,
            source_wallet.b256_address,
        )
        assert address_result.success, address_result.message

        contract_result = await source_client.withdraw(
            source_wallet,
            asset.asset,
            atomic_amount,
            ContractIdentity(str(recipient.trade_account_id)),
        )
        assert contract_result.success, contract_result.message

        after = await source_client.api.get_balance(
            asset_id=str(asset.asset),
            contract=str(source_account.trade_account_id),
        )
        assert int(after.trading_account_balance) == before - 2
    finally:
        await source_client.close()
        await recipient_client.close()
