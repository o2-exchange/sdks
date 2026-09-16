"""Read-only integration test for the deployed Fast Bridge testnet proxy.

Run with: pytest tests/test_bridge_integration.py -m integration -v
"""

import pytest

from o2_sdk import (
    FAST_BRIDGE_TESTNET_URL,
    BridgeApiError,
    FastBridgeClient,
)

pytestmark = pytest.mark.integration

UNKNOWN_TRANSACTION_ID = "0x" + "00" * 32


async def test_reads_every_fast_bridge_get_endpoint() -> None:
    async with FastBridgeClient(FAST_BRIDGE_TESTNET_URL) as client:
        info = await client.get_info()
        assert info.environment == "testnet"
        assert info.api_version.startswith("1.")
        assert info.chains

        assets = await client.get_assets()
        assert assets.assets

        configured_chain_ids = {chain.chain_id for chain in info.chains}
        selected = next(
            (
                (asset, route)
                for asset in assets.assets
                for route in asset.routes
                if route.chain_id in configured_chain_ids
            ),
            None,
        )
        assert selected is not None, "Testnet proxy returned no asset on a configured chain"
        asset, route = selected
        chain = next(chain for chain in info.chains if chain.chain_id == route.chain_id)

        filtered_assets = await client.get_assets(route.chain_id)
        assert any(
            candidate.asset_id == asset.asset_id
            and any(
                candidate_route.chain_id == route.chain_id for candidate_route in candidate.routes
            )
            for candidate in filtered_assets.assets
        )

        deposit = await client.get_deposit_info(route.chain_id, asset.asset_id)
        assert deposit.source_chain_id == route.chain_id
        assert deposit.messenger_address == chain.messenger_address
        assert asset.asset_id in {candidate.asset_id for candidate in deposit.assets}

        withdraw = await client.get_withdraw_info(route.chain_id, asset.asset_id)
        assert withdraw.destination_chain_id == route.chain_id
        assert withdraw.messenger_address == chain.messenger_address
        assert withdraw.outpost_address == chain.outpost_address
        assert asset.asset_id in {candidate.asset_id for candidate in withdraw.assets}

        fee = await client.get_withdraw_fee(route.chain_id, asset.asset_id)
        assert fee.destination_chain_id == route.chain_id
        assert fee.asset_id == asset.asset_id
        assert int(fee.fee) >= 0

        with pytest.raises(BridgeApiError) as deposit_error:
            await client.get_deposit_status(route.chain_id, UNKNOWN_TRANSACTION_ID)
        assert deposit_error.value.status == 404
        assert deposit_error.value.bridge_code == "TRANSACTION_NOT_FOUND"

        with pytest.raises(BridgeApiError) as withdraw_error:
            await client.get_withdraw_status(UNKNOWN_TRANSACTION_ID)
        assert withdraw_error.value.status == 404
        assert withdraw_error.value.bridge_code == "TRANSACTION_NOT_FOUND"
