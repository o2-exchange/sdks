"""Evaluation purchase compatibility and submission regressions."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from o2_sdk import (
    ActionsResponse,
    AddressIdentity,
    MarketsResponse,
    Network,
    O2Client,
    O2Error,
    SessionInfo,
)
from o2_sdk.config import get_config
from o2_sdk.crypto import generate_wallet, raw_sign
from o2_sdk.encoding import (
    GAS_MAX,
    build_actions_signing_bytes,
    build_eval_purchase_call,
    build_session_signing_bytes,
)
from o2_sdk.models import AccountInfo, SessionResponse
from o2_sdk.nonce import ParallelNonceManager

VECTOR = json.loads((Path(__file__).parents[3] / "fixtures/evals/purchase.json").read_text())
SHOP = VECTOR["shop_id"]
ASSET = VECTOR["asset_id"]
ACCOUNT = "0x" + "33" * 32
OWNER = "0x" + "44" * 32


def session() -> SessionInfo:
    return SessionInfo(
        session_id=AddressIdentity("0x" + "88" * 32),
        trade_account_id=ACCOUNT,
        contract_ids=[SHOP.upper().replace("0X", "0x")],
        session_expiry="9999999999",
        session_private_key=bytes([1]) * 32,
        owner_address=OWNER,
        nonce=7,
    )


def client(monkeypatch, shop=SHOP):
    result = O2Client(network=Network.MAINNET)
    monkeypatch.setattr(
        result.api,
        "get_markets",
        AsyncMock(return_value=MarketsResponse.from_dict({"eval_shop_id": shop})),
    )
    monkeypatch.setattr(
        result.api,
        "submit_actions",
        AsyncMock(return_value=ActionsResponse.from_dict({"tx_id": "0x" + "99" * 32})),
    )
    result.set_session(session())
    result._nonce_cache[ACCOUNT] = 7
    return result


def test_eval_network():
    config = get_config(Network.EVAL)
    assert config.api_base == "https://api.eval.o2.app"
    assert config.ws_url == "wss://api.eval.o2.app/v1/ws"
    assert config.fuel_rpc == "https://testnet.fuel.network/v1/graphql"
    assert config.faucet_url is None


@pytest.mark.parametrize("shop", [SHOP, None])
def test_discovery(shop):
    assert MarketsResponse.from_dict({"eval_shop_id": shop}).eval_shop_id == shop
    assert MarketsResponse.from_dict({}).eval_shop_id is None


def test_shared_purchase_vector():
    call = build_eval_purchase_call(SHOP, int(VECTOR["tier_id"]), ASSET, int(VECTOR["amount"]))
    assert call["function_selector"].hex() == VECTOR["function_selector"][2:]
    assert call["call_data"].hex() == VECTOR["call_data"][2:]
    assert call["gas"] == GAS_MAX
    payload = build_actions_signing_bytes(int(VECTOR["nonce"]), [call])
    assert "0x" + payload.hex() == VECTOR["signing_bytes"]
    assert "0x" + raw_sign(bytes([1]) * 32, payload).hex() == VECTOR["signature"]


@pytest.mark.parametrize(
    "tier,amount", [(-1, 1), (2**64, 1), (1, -1), (1, 2**64), (1.0, 1), (1, True)]
)
def test_invalid_integers(tier, amount):
    with pytest.raises(ValueError, match="64-bit"):
        build_eval_purchase_call(SHOP, tier, ASSET, amount)


@pytest.mark.parametrize("shop,asset", [("0x123", ASSET), (SHOP, "0xgg"), (SHOP[2:], ASSET)])
def test_invalid_ids(shop, asset):
    with pytest.raises(ValueError, match="32-byte"):
        build_eval_purchase_call(shop, 1, asset, 1)


@pytest.mark.parametrize("explicit", [False, True])
async def test_purchase_wire_and_nonce(monkeypatch, explicit):
    checkout = client(monkeypatch)
    active = session() if explicit else checkout.session
    try:
        result = await checkout.buy_eval_account(
            20, ASSET, int(VECTOR["amount"]), session=active if explicit else None
        )
        assert result.success
        owner, request = checkout.api.submit_actions.call_args.args
        assert owner == OWNER
        assert request == {
            "actions": [
                {
                    "actions": [
                        {
                            "BuyEvalAccount": {
                                "tier_id": "20",
                                "asset_id": ASSET,
                                "amount": VECTOR["amount"],
                            }
                        }
                    ]
                }
            ],
            "signature": {"Secp256k1": VECTOR["signature"]},
            "nonce": "7",
            "trade_account_id": ACCOUNT,
            "session_id": active.session_id.to_dict(),
            "collect_orders": False,
        }
        assert active.nonce == 8
        checkout.api.submit_actions.assert_awaited_once()
    finally:
        await checkout.close()


@pytest.mark.parametrize("shop", [None, "0x" + "00" * 32])
async def test_unavailable_shop(monkeypatch, shop):
    checkout = client(monkeypatch, shop)
    try:
        with pytest.raises(O2Error, match="unavailable"):
            await checkout.buy_eval_account(1, ASSET, 1)
        checkout.api.submit_actions.assert_not_awaited()
    finally:
        await checkout.close()


@pytest.mark.parametrize("failure", ["scope", "expired", "missing"])
async def test_invalid_session_never_submits(monkeypatch, failure):
    checkout = client(monkeypatch)
    active = session()
    if failure == "scope":
        active.contract_ids = []
    elif failure == "expired":
        active.session_expiry = "1"
    else:
        checkout.clear_session()
    try:
        with pytest.raises(O2Error):
            await checkout.buy_eval_account(
                1, ASSET, 1, session=None if failure == "missing" else active
            )
        checkout.api.submit_actions.assert_not_awaited()
    finally:
        await checkout.close()


@pytest.mark.parametrize("refresh_fails", [False, True])
async def test_purchase_does_not_retry_and_preserves_submit_error(monkeypatch, refresh_fails):
    checkout = client(monkeypatch)
    checkout.api.submit_actions.side_effect = O2Error(message="connection reset after submit")
    monkeypatch.setattr(
        checkout,
        "refresh_nonce",
        AsyncMock(side_effect=O2Error(message="refresh failed"))
        if refresh_fails
        else AsyncMock(return_value=7),
    )
    try:
        with pytest.raises(O2Error, match="connection reset"):
            await checkout.buy_eval_account(1, ASSET, 1)
        checkout.api.submit_actions.assert_awaited_once()
        checkout.refresh_nonce.assert_awaited_once()
    finally:
        await checkout.close()


async def test_purchase_parallel_nonce(monkeypatch):
    checkout = client(monkeypatch)
    active = session()
    active.nonce_manager = ParallelNonceManager(window_fetcher=AsyncMock())
    try:
        await checkout.buy_eval_account(1, ASSET, 1, session=active)
        request = checkout.api.submit_actions.call_args.args[1]
        assert "parallel_nonce" in request
        assert "nonce" not in request
        checkout.api.submit_actions.assert_awaited_once()
    finally:
        await checkout.close()


async def test_purchase_only_session_includes_shop_in_signing_bytes(monkeypatch):
    checkout = client(monkeypatch)
    owner = generate_wallet()
    monkeypatch.setattr(
        checkout.api,
        "get_account",
        AsyncMock(
            return_value=AccountInfo.from_dict(
                {
                    "trade_account_id": ACCOUNT,
                    "trade_account": {
                        "nonce": "3",
                        "owner": {"Address": OWNER},
                        "last_modification": "0",
                    },
                }
            )
        ),
    )

    async def create(_owner, request):
        assert request["contract_ids"] == [SHOP]
        payload = build_session_signing_bytes(
            nonce=3,
            chain_id=0,
            session_address=bytes.fromhex(request["session_id"]["Address"][2:]),
            contract_ids=[bytes.fromhex(SHOP[2:])],
            expiry=int(request["expiry"]),
        )
        assert request["signature"] == {"Secp256k1": "0x" + owner.personal_sign(payload).hex()}
        return SessionResponse.from_dict(
            {
                "tx_id": "0x99",
                "trade_account_id": ACCOUNT,
                "session_id": request["session_id"],
                "contract_ids": request["contract_ids"],
                "session_expiry": request["expiry"],
            }
        )

    monkeypatch.setattr(checkout.api, "create_session", AsyncMock(side_effect=create))
    try:
        active = await checkout.create_session(
            owner, [], extra_contract_ids=[SHOP, SHOP.upper().replace("0X", "0x")]
        )
        assert active.contract_ids == [SHOP]
        assert active.nonce == 4
    finally:
        await checkout.close()


async def test_invalid_extra_contract_rejected_before_network(monkeypatch):
    checkout = client(monkeypatch)
    try:
        with pytest.raises(ValueError, match="32-byte"):
            await checkout.create_session(generate_wallet(), [], extra_contract_ids=["0x123"])
        checkout.api.get_markets.assert_not_awaited()
    finally:
        await checkout.close()
