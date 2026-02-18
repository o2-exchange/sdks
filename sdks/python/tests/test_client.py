"""Unit tests for high-level O2Client ergonomics."""

from __future__ import annotations

import pytest

from o2_sdk import (
    ActionsResponse,
    AddressIdentity,
    ChainInt,
    Market,
    MarketActions,
    MarketsResponse,
    NetworkConfig,
    O2Client,
    O2Error,
    OrderSide,
    SessionInfo,
    SettleBalanceAction,
)


def _test_market() -> Market:
    return Market.from_dict(
        {
            "contract_id": "0x9ad52fb8a2be1c4603dfeeb8118a922c8cfafa8f260eeb41d68ade8d442be65b",
            "market_id": "0x09c17f779eb0a7658424e48935b2bef24013766f8b3da757becb2264406f9e96",
            "maker_fee": "0",
            "taker_fee": "100",
            "min_order": "1000",
            "dust": "1000",
            "price_window": 0,
            "base": {
                "symbol": "FUEL",
                "asset": "0xa1b2c3d4e5f60000000000000000000000000000000000000000000000000000",
                "decimals": 9,
                "max_precision": 3,
            },
            "quote": {
                "symbol": "USDC",
                "asset": "0xf6e5d4c3b2a10000000000000000000000000000000000000000000000000000",
                "decimals": 9,
                "max_precision": 9,
            },
        }
    )


def _test_markets_response(market: Market) -> MarketsResponse:
    return MarketsResponse.from_dict(
        {
            "books_registry_id": "0x" + "11" * 32,
            "accounts_registry_id": "0x" + "22" * 32,
            "trade_account_oracle_id": "0x" + "33" * 32,
            "chain_id": "0x0000000000002699",
            "base_asset_id": "0x" + "44" * 32,
            "markets": [
                {
                    "contract_id": str(market.contract_id),
                    "market_id": str(market.market_id),
                    "maker_fee": market.maker_fee,
                    "taker_fee": market.taker_fee,
                    "min_order": market.min_order,
                    "dust": market.dust,
                    "price_window": market.price_window,
                    "base": {
                        "symbol": market.base.symbol,
                        "asset": market.base.asset,
                        "decimals": market.base.decimals,
                        "max_precision": market.base.max_precision,
                    },
                    "quote": {
                        "symbol": market.quote.symbol,
                        "asset": market.quote.asset,
                        "decimals": market.quote.decimals,
                        "max_precision": market.quote.max_precision,
                    },
                }
            ],
        }
    )


def _test_session() -> SessionInfo:
    return SessionInfo(
        session_id=AddressIdentity("0x" + "55" * 32),
        trade_account_id="0x" + "66" * 32,
        contract_ids=["0x" + "77" * 32],
        session_expiry="9999999999",
        session_private_key=b"\x01" * 32,
        owner_address="0x" + "88" * 32,
        nonce=0,
    )


@pytest.mark.asyncio
async def test_batch_actions_normalizes_builder_group(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()
    market = _test_market()
    session = _test_session()
    client._markets_cache = _test_markets_response(market)
    client._nonce_cache[session.trade_account_id] = 7

    monkeypatch.setattr(
        "o2_sdk.client.action_to_call",
        lambda _action, _market_info: {"contract_id": b"", "asset_id": b"", "amount": 0},
    )
    monkeypatch.setattr("o2_sdk.client.build_actions_signing_bytes", lambda _nonce, _calls: b"x")
    monkeypatch.setattr("o2_sdk.client.raw_sign", lambda _key, _payload: b"\x99" * 64)

    captured: dict = {}

    async def fake_submit_actions(owner: str, request: dict) -> ActionsResponse:
        captured["owner"] = owner
        captured["request"] = request
        return ActionsResponse.from_dict({"tx_id": "0x" + "aa" * 32})

    monkeypatch.setattr(client.api, "submit_actions", fake_submit_actions)

    group = (
        client.actions_for(market.pair)
        .settle_balance()
        .create_order(OrderSide.BUY, "0.1", "5")
        .cancel_order("0x" + "09" * 32)
        .build()
    )

    result = await client.batch_actions([group], collect_orders=True, session=session)
    assert result.success
    req = captured["request"]
    assert captured["owner"] == session.owner_address
    assert req["nonce"] == "7"
    assert req["collect_orders"] is True
    actions = req["actions"][0]["actions"]
    assert "SettleBalance" in actions[0]
    assert actions[1]["CreateOrder"]["price"] == "100000000"
    assert actions[1]["CreateOrder"]["quantity"] == "5000000000"
    assert actions[1]["CreateOrder"]["order_type"] == "Spot"
    assert actions[2]["CancelOrder"]["order_id"] == "0x" + "09" * 32


@pytest.mark.asyncio
async def test_batch_actions_accepts_chain_int(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()
    market = _test_market()
    session = _test_session()
    client._markets_cache = _test_markets_response(market)
    client._nonce_cache[session.trade_account_id] = 3

    monkeypatch.setattr(
        "o2_sdk.client.action_to_call",
        lambda _action, _market_info: {"contract_id": b"", "asset_id": b"", "amount": 0},
    )
    monkeypatch.setattr("o2_sdk.client.build_actions_signing_bytes", lambda _nonce, _calls: b"x")
    monkeypatch.setattr("o2_sdk.client.raw_sign", lambda _key, _payload: b"\x99" * 64)

    captured: dict = {}

    async def fake_submit_actions(_owner: str, request: dict) -> ActionsResponse:
        captured["request"] = request
        return ActionsResponse.from_dict({"tx_id": "0x" + "bb" * 32})

    monkeypatch.setattr(client.api, "submit_actions", fake_submit_actions)

    group = (
        client.actions_for(market)
        .create_order(OrderSide.SELL, ChainInt(200000000), ChainInt(6000000000))
        .build()
    )

    await client.batch_actions([group], session=session)
    create_order = captured["request"]["actions"][0]["actions"][0]["CreateOrder"]
    assert create_order["price"] == "200000000"
    assert create_order["quantity"] == "6000000000"


@pytest.mark.asyncio
async def test_batch_actions_rejects_bad_chain_int_precision():
    client = O2Client()
    market = _test_market()
    session = _test_session()
    client._markets_cache = _test_markets_response(market)
    client._nonce_cache[session.trade_account_id] = 1

    group = (
        client.actions_for(market)
        .create_order(OrderSide.BUY, ChainInt(100000000), ChainInt(5000000001))
        .build()
    )

    with pytest.raises(O2Error, match="raw quantity precision"):
        await client._normalize_market_actions(session, [group])


@pytest.mark.asyncio
async def test_batch_actions_mixed_low_and_high_level(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()
    market = _test_market()
    session = _test_session()
    client._markets_cache = _test_markets_response(market)
    client._nonce_cache[session.trade_account_id] = 9

    monkeypatch.setattr(
        "o2_sdk.client.action_to_call",
        lambda _action, _market_info: {"contract_id": b"", "asset_id": b"", "amount": 0},
    )
    monkeypatch.setattr("o2_sdk.client.build_actions_signing_bytes", lambda _nonce, _calls: b"x")
    monkeypatch.setattr("o2_sdk.client.raw_sign", lambda _key, _payload: b"\x99" * 64)

    captured: dict = {}

    async def fake_submit_actions(_owner: str, request: dict) -> ActionsResponse:
        captured["request"] = request
        return ActionsResponse.from_dict({"tx_id": "0x" + "cc" * 32})

    monkeypatch.setattr(client.api, "submit_actions", fake_submit_actions)

    low_level = MarketActions(
        market_id=market.market_id,
        actions=[SettleBalanceAction(to=session.trade_account_id)],
    )
    high_level = client.actions_for(market.pair).create_order(OrderSide.BUY, "0.2", "6").build()

    await client.batch_actions([low_level, high_level], session=session)
    req_actions = captured["request"]["actions"]
    assert len(req_actions) == 2
    assert req_actions[0]["market_id"] == market.market_id
    assert "SettleBalance" in req_actions[0]["actions"][0]
    assert req_actions[1]["actions"][0]["CreateOrder"]["price"] == "200000000"


@pytest.mark.asyncio
async def test_batch_actions_uses_active_session(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()
    market = _test_market()
    session = _test_session()
    client.set_session(session)
    client._markets_cache = _test_markets_response(market)
    client._nonce_cache[session.trade_account_id] = 11

    monkeypatch.setattr(
        "o2_sdk.client.action_to_call",
        lambda _action, _market_info: {"contract_id": b"", "asset_id": b"", "amount": 0},
    )
    monkeypatch.setattr("o2_sdk.client.build_actions_signing_bytes", lambda _nonce, _calls: b"x")
    monkeypatch.setattr("o2_sdk.client.raw_sign", lambda _key, _payload: b"\x99" * 64)

    captured: dict = {}

    async def fake_submit_actions(owner: str, request: dict) -> ActionsResponse:
        captured["owner"] = owner
        captured["request"] = request
        return ActionsResponse.from_dict({"tx_id": "0x" + "dd" * 32})

    monkeypatch.setattr(client.api, "submit_actions", fake_submit_actions)

    group = client.actions_for(market).create_order(OrderSide.BUY, "0.1", "1").build()
    result = await client.batch_actions([group], collect_orders=True)
    assert result.success
    assert captured["owner"] == session.owner_address
    assert captured["request"]["nonce"] == "11"


@pytest.mark.asyncio
async def test_create_order_uses_active_session(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()
    market = _test_market()
    session = _test_session()
    client.set_session(session)
    client._markets_cache = _test_markets_response(market)

    captured: dict = {}

    async def fake_batch_actions(
        actions: list[MarketActions],
        collect_orders: bool = False,
        session: SessionInfo | None = None,
    ) -> ActionsResponse:
        captured["actions"] = actions
        captured["collect_orders"] = collect_orders
        captured["session"] = session
        return ActionsResponse.from_dict({"tx_id": "0x" + "ee" * 32})

    monkeypatch.setattr(client, "batch_actions", fake_batch_actions)

    result = await client.create_order(
        market=market,
        side=OrderSide.BUY,
        price="0.2",
        quantity="3",
        collect_orders=True,
    )
    assert result.success
    assert captured["collect_orders"] is True
    assert captured["session"] == session


@pytest.mark.asyncio
async def test_batch_actions_requires_session():
    client = O2Client()
    market = _test_market()
    low_level = MarketActions(market_id=market.market_id, actions=[])
    with pytest.raises(O2Error, match="No active session"):
        await client.batch_actions([low_level])


@pytest.mark.asyncio
async def test_create_session_accepts_market_model(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()
    market = _test_market()
    owner = client.generate_wallet()
    client._markets_cache = _test_markets_response(market)

    account = type(
        "Account",
        (),
        {"exists": True, "trade_account_id": "0x" + "11" * 32, "nonce": 5},
    )()

    async def fake_get_account(**_kwargs):
        return account

    session_resp = type(
        "SessionResp",
        (),
        {
            "session_id": AddressIdentity("0x" + "aa" * 32),
            "trade_account_id": "0x" + "11" * 32,
            "contract_ids": [market.contract_id],
            "session_expiry": "9999999999",
        },
    )()

    async def fake_create_session(_owner_id: str, _request: dict):
        return session_resp

    monkeypatch.setattr(client.api, "get_account", fake_get_account)
    monkeypatch.setattr(client.api, "create_session", fake_create_session)
    monkeypatch.setattr("o2_sdk.client.build_session_signing_bytes", lambda **_kwargs: b"x")

    session = await client.create_session(owner=owner, markets=[market], expiry_days=1)
    assert session.trade_account_id == session_resp.trade_account_id
    assert session.contract_ids[0] == market.contract_id


@pytest.mark.asyncio
async def test_cancel_order_accepts_id(monkeypatch: pytest.MonkeyPatch):
    client = O2Client()
    market = _test_market()
    session = _test_session()

    captured: dict = {}

    async def fake_batch_actions(
        actions: list[MarketActions],
        collect_orders: bool = False,
        session: SessionInfo | None = None,
    ) -> ActionsResponse:
        captured["actions"] = actions
        captured["session"] = session
        return ActionsResponse.from_dict({"tx_id": "0x" + "ff" * 32})

    monkeypatch.setattr(client, "batch_actions", fake_batch_actions)

    await client.cancel_order(order_id=market.market_id, market=market, session=session)
    action = captured["actions"][0].actions[0]
    assert isinstance(action, type(captured["actions"][0].actions[0]))
    assert action.order_id == market.market_id


@pytest.mark.asyncio
async def test_setup_account_fail_fast_when_whitelist_required(monkeypatch: pytest.MonkeyPatch):
    cfg = NetworkConfig(
        api_base="https://x",
        ws_url="wss://x",
        fuel_rpc="https://rpc",
        faucet_url=None,
        whitelist_required=True,
    )
    client = O2Client(custom_config=cfg)
    wallet = client.generate_wallet()

    account = type(
        "Account",
        (),
        {"exists": True, "trade_account_id": "0x" + "11" * 32},
    )()

    async def fake_get_account(**_kwargs):
        return account

    monkeypatch.setattr(client.api, "get_account", fake_get_account)

    async def fake_retry_whitelist(_trade_account_id: str) -> bool:
        return False

    monkeypatch.setattr(client, "_retry_whitelist_account", fake_retry_whitelist)
    with pytest.raises(O2Error, match="Failed to whitelist account"):
        await client.setup_account(wallet)


@pytest.mark.asyncio
async def test_setup_account_skips_whitelist_when_not_required(monkeypatch: pytest.MonkeyPatch):
    cfg = NetworkConfig(
        api_base="https://x",
        ws_url="wss://x",
        fuel_rpc="https://rpc",
        faucet_url=None,
        whitelist_required=False,
    )
    client = O2Client(custom_config=cfg)
    wallet = client.generate_wallet()

    account = type(
        "Account",
        (),
        {"exists": True, "trade_account_id": "0x" + "22" * 32},
    )()

    async def fake_get_account(**_kwargs):
        return account

    monkeypatch.setattr(client.api, "get_account", fake_get_account)

    called = {"whitelist": False}

    async def fake_retry_whitelist(_trade_account_id: str) -> bool:
        called["whitelist"] = True
        return True

    monkeypatch.setattr(client, "_retry_whitelist_account", fake_retry_whitelist)
    out = await client.setup_account(wallet)
    assert out.trade_account_id == account.trade_account_id
    assert called["whitelist"] is False


@pytest.mark.asyncio
async def test_setup_account_skips_faucet_when_balance_present(monkeypatch: pytest.MonkeyPatch):
    cfg = NetworkConfig(
        api_base="https://x",
        ws_url="wss://x",
        fuel_rpc="https://rpc",
        faucet_url="https://faucet",
        whitelist_required=False,
    )
    client = O2Client(custom_config=cfg)
    wallet = client.generate_wallet()

    account = type(
        "Account",
        (),
        {"exists": True, "trade_account_id": "0x" + "33" * 32},
    )()

    async def fake_get_account(**_kwargs):
        return account

    monkeypatch.setattr(client.api, "get_account", fake_get_account)

    async def fake_has_balance(_trade_account_id: str) -> bool:
        return True

    called = {"mint": False}

    async def fake_retry_mint(_trade_account_id: str) -> bool:
        called["mint"] = True
        return True

    monkeypatch.setattr(client, "_has_any_balance", fake_has_balance)
    monkeypatch.setattr(client, "_retry_mint_to_contract", fake_retry_mint)
    out = await client.setup_account(wallet)
    assert out.trade_account_id == account.trade_account_id
    assert called["mint"] is False
