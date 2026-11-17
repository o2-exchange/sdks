"""Regression tests for direct canonical and Turbo venue routing."""

from __future__ import annotations

import asyncio
from dataclasses import asdict, replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from o2_sdk import (
    ActionsResponse,
    AddressIdentity,
    BoundedMarketOrder,
    Id,
    MarketActions,
    MarketsResponse,
    O2Client,
    O2Error,
    OrderSide,
    ParallelNonceManager,
    SessionInfo,
    SessionResponse,
    SettleBalanceAction,
    StreamResyncRequired,
    TurboDiscoveryUnavailable,
    TurboMarket,
    WindowResponse,
)
from o2_sdk.websocket import O2WebSocket

MARKET_ID = Id("01" * 32)
CANONICAL_BOOK = Id("02" * 32)
TURBO_BOOK = Id("03" * 32)
NEW_TURBO_BOOK = Id("04" * 32)
ACCOUNT_ID = Id("05" * 32)
ORDER_ID = Id("06" * 32)
PAIR = "FUEL/USDC"


@pytest.fixture
def catalogs():
    market = {
        "market_id": MARKET_ID,
        "contract_id": CANONICAL_BOOK,
        "min_order": "1000",
        "base": {"symbol": "FUEL", "asset": Id("07" * 32), "decimals": 6, "max_precision": 6},
        "quote": {"symbol": "USDC", "asset": Id("08" * 32), "decimals": 6, "max_precision": 6},
    }
    sidecar = {
        **market,
        "contract_id": TURBO_BOOK,
        "canonical_contract_id": CANONICAL_BOOK,
        "turbo": True,
    }
    return {"markets": [market]}, {"markets": [sidecar]}


@pytest.fixture
async def venue_client(monkeypatch, catalogs):
    async with O2Client() as client:

        async def request(method, path, *, params=None):
            assert (method, path) == ("GET", "/v1/markets")
            return catalogs[int(bool(params and params.get("turbo") == "true"))]

        monkeypatch.setattr(client.api, "_request", AsyncMock(side_effect=request))
        yield client


@pytest.fixture
def submission(venue_client, monkeypatch):
    session = SessionInfo(
        session_id=AddressIdentity(Id("09" * 32)),
        trade_account_id=ACCOUNT_ID,
        contract_ids=[CANONICAL_BOOK, TURBO_BOOK],
        session_expiry="9999999999",
        session_private_key=b"\x01" * 32,
        owner_address=Id("0a" * 32),
    )
    venue_client.set_session(session)
    venue_client._nonce_cache[ACCOUNT_ID] = 4
    submit = AsyncMock(return_value=ActionsResponse(tx_id=Id("0b" * 32)))
    monkeypatch.setattr(venue_client.api, "submit_actions", submit)
    return session, submit


async def test_market_catalogs_are_separate_and_return_independent_models(venue_client):
    client = venue_client
    sidecar, canonical = await asyncio.gather(
        client.get_market(PAIR, turbo=True), client.get_market(PAIR)
    )
    assert isinstance(sidecar, TurboMarket)
    assert sidecar.canonical_contract_id == canonical.contract_id == CANONICAL_BOOK
    assert sidecar.contract_id == TURBO_BOOK
    assert sidecar.market_id == canonical.market_id == MARKET_ID
    assert "turbo" not in asdict(canonical)
    assert asdict(sidecar)["turbo"] is True

    canonical.quote.max_precision = 1
    sidecar.min_order = "9999999999999"
    assert (await client.get_markets())[0].quote.max_precision == 6
    assert (await client.get_markets(turbo=True))[0].min_order == "1000"
    assert client.api._request.await_count == 2


async def test_turbo_refresh_keeps_last_good_catalog_and_deduplicates_requests(
    venue_client, catalogs, monkeypatch
):
    client = venue_client
    assert (await client.get_market(PAIR, turbo=True)).contract_id == TURBO_BOOK
    client._turbo_markets_updated_at -= 61
    started, ready = asyncio.Event(), asyncio.Event()

    async def request(*_, **__):
        started.set()
        await ready.wait()
        return {"markets": [{**catalogs[1]["markets"][0], "contract_id": NEW_TURBO_BOOK}]}

    fetch = AsyncMock(side_effect=request)
    monkeypatch.setattr(client.api, "_request", fetch)
    assert (await client.get_market(PAIR, turbo=True)).contract_id == TURBO_BOOK
    await asyncio.wait_for(started.wait(), timeout=2)
    assert (await client.get_market(PAIR, turbo=True)).contract_id == TURBO_BOOK
    fetch.assert_awaited_once()
    ready.set()
    await client._turbo_markets_refresh
    assert (await client.get_market(PAIR, turbo=True)).contract_id == NEW_TURBO_BOOK


async def test_turbo_discovery_rejects_legacy_catalog_without_falling_back(
    venue_client, catalogs, monkeypatch
):
    fetch = AsyncMock(return_value=catalogs[0])
    monkeypatch.setattr(venue_client.api, "_request", fetch)
    with pytest.raises(TurboDiscoveryUnavailable):
        await venue_client.get_market(PAIR, turbo=True)
    fetch.assert_awaited_once_with("GET", "/v1/markets", params={"turbo": "true"})

    fetch.side_effect = O2Error("Temporary catalog failure")
    with pytest.raises(O2Error, match="Temporary catalog failure"):
        await venue_client.get_market(PAIR, turbo=True)


@pytest.mark.parametrize("parallel", [False, True], ids=["sequential", "parallel"])
async def test_mixed_batch_signs_for_each_book(venue_client, submission, monkeypatch, parallel):
    client = venue_client
    session, submit = submission
    signer = "build_actions_signing_bytes"
    nonce_field = "nonce"
    if parallel:
        fetch_window = AsyncMock(return_value=WindowResponse(nonce_session_id=0, base=0, slots=[]))
        session.nonce_manager = ParallelNonceManager(window_fetcher=fetch_window)
        await session.nonce_manager.init()
        signer = "build_parallel_actions_signing_bytes"
        nonce_field = "parallel_nonce"
    encoded_contracts = []

    def signing_bytes(_nonce, calls):
        encoded_contracts.extend(Id(call["contract_id"].hex()) for call in calls)
        return b"batch"

    monkeypatch.setattr(f"o2_sdk.client.{signer}", signing_bytes)
    sidecar = await client.get_market(PAIR, turbo=True)
    canonical = MarketActions(MARKET_ID, [SettleBalanceAction(to=ACCOUNT_ID)])
    await client.batch_actions([canonical, client.actions_for(sidecar).settle_balance().build()])

    request = submit.await_args.args[1]
    assert nonce_field in request
    assert [group["market_id"] for group in request["actions"]] == [MARKET_ID, MARKET_ID]
    assert [group.get("turbo") for group in request["actions"]] == [None, True]
    assert "turbo" not in request["actions"][0]
    assert encoded_contracts == [CANONICAL_BOOK, TURBO_BOOK]


async def test_create_order_pins_the_resolved_book_across_refresh(
    venue_client, submission, catalogs, monkeypatch
):
    client = venue_client
    _, submit = submission
    sidecar = await client.get_market(PAIR, turbo=True)
    original_batch = client.batch_actions
    signing = []

    def signing_bytes(_, calls):
        signing.extend(Id(call["contract_id"].hex()) for call in calls)
        return b"order"

    async def batch_after_refresh(*args, **kwargs):
        client._turbo_markets_cache = MarketsResponse.from_dict(
            {"markets": [{**catalogs[1]["markets"][0], "contract_id": NEW_TURBO_BOOK}]}
        )
        return await original_batch(*args, **kwargs)

    monkeypatch.setattr(client, "batch_actions", batch_after_refresh)
    monkeypatch.setattr("o2_sdk.client.build_actions_signing_bytes", signing_bytes)
    await client.create_order(sidecar, OrderSide.SELL, "2", "1", BoundedMarketOrder("2.1", "1.9"))

    group = submit.await_args.args[1]["actions"][0]
    assert group["turbo"] is True
    order = group["actions"][1]["CreateOrder"]
    assert order["order_type"] == {
        "BoundedMarket": {"max_price": "2100000", "min_price": "1900000"}
    }
    assert signing == [TURBO_BOOK, TURBO_BOOK]
    with pytest.raises(O2Error, match="refresh before submitting"):
        await client.create_order(sidecar, OrderSide.SELL, "2", "1")
    assert submit.await_count == 1


async def test_canonical_orders_use_catalog_metadata_and_reject_stale_contract(
    venue_client, submission
):
    client = venue_client
    _, submit = submission
    market = await client.get_market(PAIR)
    market.quote.max_precision = 1
    market.min_order = "9999999999999"
    await client.create_order(market, OrderSide.BUY, "1.234567", "1", settle_first=False)
    order = submit.await_args.args[1]["actions"][0]["actions"][0]["CreateOrder"]
    assert order["price"] == "1234567"

    stale = replace(market, contract_id=TURBO_BOOK)
    with pytest.raises(O2Error, match="refresh before submitting"):
        await client.batch_actions([client.actions_for(stale).settle_balance().build()])
    assert submit.await_count == 1


@pytest.mark.parametrize("parallel", [False, True], ids=["sequential", "parallel"])
async def test_session_authorizes_selected_books_and_probes_the_sidecar(
    venue_client, submission, monkeypatch, parallel
):
    client = venue_client
    _, submit = submission
    sidecar = await client.get_market(PAIR, turbo=True)
    monkeypatch.setattr(
        client.api,
        "get_account",
        AsyncMock(return_value=SimpleNamespace(exists=True, trade_account_id=ACCOUNT_ID, nonce=5)),
    )
    request_contracts = []

    async def register(owner, request):
        request_contracts.extend(request["contract_ids"])
        return SessionResponse.from_dict(
            {
                "tx_id": Id("0c" * 32),
                "trade_account_id": ACCOUNT_ID,
                **request,
                "session_expiry": request["expiry"],
            }
        )

    monkeypatch.setattr(client.api, "create_session", register)
    monkeypatch.setattr(
        client.api, "get_account_window", AsyncMock(return_value={"nonce_session_id": 0, "base": 0})
    )
    create = client.ensure_parallel_session if parallel else client.create_session
    session = await create(client.generate_wallet(), [sidecar, PAIR, sidecar])

    assert request_contracts == session.contract_ids == [TURBO_BOOK, CANONICAL_BOOK]
    if parallel:
        group = submit.await_args.args[1]["actions"][0]
        assert group["turbo"] is True
        assert "SettleBalance" in group["actions"][0]
    else:
        submit.assert_not_awaited()


async def test_cancel_all_reads_and_submits_on_the_same_venue(
    venue_client, submission, monkeypatch
):
    client = venue_client
    _, submit = submission
    sidecar = await client.get_market(PAIR, turbo=True)
    await client.get_market(PAIR)
    orders = [{"order_id": Id(f"{number:064x}")} for number in range(1, 7)]
    read = AsyncMock(return_value={"turbo": True, "market_id": MARKET_ID, "orders": orders})
    monkeypatch.setattr(client.api, "_request", read)

    assert len(await client.cancel_all_orders(sidecar)) == 2
    assert read.await_args.kwargs["params"]["turbo"] == "true"
    assert read.await_args.kwargs["params"]["is_open"] == "true"
    groups = [call.args[1]["actions"][0] for call in submit.await_args_list]
    assert [len(group["actions"]) for group in groups] == [5, 1]
    assert all(group["turbo"] is True for group in groups)
    assert [action["CancelOrder"] for group in groups for action in group["actions"]] == orders


@pytest.mark.parametrize(
    ("method", "args", "kwargs", "path", "body", "bare"),
    [
        ("get_depth", (), {}, "/v1/depth", {}, False),
        ("get_ticker", (), {}, "/v1/markets/ticker", {}, False),
        ("get_trades", (), {}, "/v1/trades", {"trades": []}, True),
        ("get_trades", (), {"account": ACCOUNT_ID}, "/v1/trades_by_account", {"trades": []}, True),
        ("get_bars", ("1m", 0, 60_000), {}, "/v1/bars", {"bars": []}, True),
        ("get_orders", (ACCOUNT_ID,), {}, "/v1/orders", {"orders": []}, False),
        ("get_order", (ORDER_ID,), {}, "/v1/order", {"order": {"order_id": ORDER_ID}}, False),
    ],
)
async def test_high_level_reads_forward_and_verify_the_venue(
    venue_client, monkeypatch, method, args, kwargs, path, body, bare
):
    client = venue_client
    sidecar = await client.get_market(PAIR, turbo=True)
    canonical = await client.get_market(PAIR)
    envelope = {"market_id": MARKET_ID, **body}
    fetch = AsyncMock(return_value=envelope)
    monkeypatch.setattr(client.api, "_request", fetch)
    read = getattr(client, method)

    await read(canonical, *args, **kwargs)
    assert "turbo" not in fetch.await_args.kwargs["params"]
    with pytest.raises(O2Error, match="requested trading market"):
        await read(sidecar, *args, **kwargs)

    fetch.return_value = {**envelope, "turbo": True}
    await read(sidecar, *args, **kwargs)
    assert fetch.await_args.args == ("GET", path)
    assert fetch.await_args.kwargs["params"]["turbo"] == "true"
    with pytest.raises(O2Error, match="requested trading market"):
        await read(canonical, *args, **kwargs)
    if bare:
        fetch.return_value = []
        assert await read(sidecar, *args, **kwargs) == []


@pytest.mark.parametrize("kind", ["summary", "ticker"])
async def test_market_stats_accept_turbo_list_responses(venue_client, monkeypatch, kind):
    fetch = AsyncMock(return_value=[{"market_id": MARKET_ID, "turbo": True}])
    monkeypatch.setattr(venue_client.api, "_request", fetch)
    read = getattr(venue_client.api, f"get_market_{kind}")

    assert (await read(MARKET_ID, turbo=True)).market_id == MARKET_ID
    fetch.assert_awaited_once_with(
        "GET", f"/v1/markets/{kind}", params={"market_id": MARKET_ID, "turbo": "true"}
    )


@pytest.mark.parametrize("topic", ["depth", "orders", "trades"])
async def test_streams_are_isolated_by_venue_and_replay_selected_subscriptions(
    venue_client, monkeypatch, topic
):
    client = venue_client
    sidecar = await client.get_market(PAIR, turbo=True)
    ws = O2WebSocket(client._config)
    ws._should_run = True
    client._ws = ws
    sent = asyncio.Event()

    async def send(_):
        if wire.await_count == 2:
            sent.set()

    wire = AsyncMock(side_effect=send)
    monkeypatch.setattr(ws, "_send", wire)
    if topic == "orders":
        canonical_stream = client.stream_orders(ACCOUNT_ID)
        turbo_stream = client.stream_orders(ACCOUNT_ID, turbo=True)
        unsubscribe_args = ()
    else:
        stream = getattr(client, f"stream_{topic}")
        canonical_stream, turbo_stream = stream(PAIR), stream(sidecar)
        unsubscribe_args = (MARKET_ID,)
    results = [asyncio.create_task(anext(stream)) for stream in (canonical_stream, turbo_stream)]
    await asyncio.wait_for(sent.wait(), timeout=2)
    initial = [call.args[0] for call in wire.await_args_list]
    action = f"subscribe_{topic}"
    ws._dispatch(action, {"action": action, "market_id": MARKET_ID, "onchain_timestamp": "1"})
    ws._dispatch(
        action, {"action": action, "market_id": MARKET_ID, "onchain_timestamp": "2", "turbo": True}
    )
    canonical, turbo = await asyncio.wait_for(asyncio.gather(*results), timeout=2)
    assert (canonical.onchain_timestamp, turbo.onchain_timestamp) == ("1", "2")

    wire.reset_mock()
    connect = AsyncMock(return_value=SimpleNamespace(close=AsyncMock()))
    monkeypatch.setattr("o2_sdk.websocket.websockets.connect", connect)
    await ws._do_connect()
    assert [call.args[0] for call in wire.await_args_list] == initial
    unsubscribe = getattr(ws, f"unsubscribe_{topic}")
    await unsubscribe(*unsubscribe_args, turbo=True)
    assert wire.await_args.args[0]["turbo"] is True
    assert ws._subscriptions == [sub for sub in initial if "turbo" not in sub]
    await canonical_stream.aclose()
    await turbo_stream.aclose()


async def test_resync_stops_only_matching_turbo_trades(venue_client, monkeypatch):
    ws = O2WebSocket(venue_client._config)
    ws._should_run = True
    other_market = Id("0d" * 32)
    sent = asyncio.Event()

    async def send(_):
        if wire.await_count == 3:
            sent.set()

    wire = AsyncMock(side_effect=send)
    monkeypatch.setattr(ws, "_send", wire)
    canonical = ws.stream_trades(MARKET_ID)
    turbo = ws.stream_trades(MARKET_ID, turbo=True)
    other = ws.stream_trades(other_market, turbo=True)
    tasks = [asyncio.create_task(anext(stream)) for stream in (canonical, turbo, other)]
    await asyncio.wait_for(sent.wait(), timeout=2)
    ws._dispatch("error", {"market_id": MARKET_ID, "turbo": True, "resync_required": True})
    ws._dispatch("trades", {"market_id": MARKET_ID})
    ws._dispatch("trades", {"market_id": other_market, "turbo": True})

    with pytest.raises(StreamResyncRequired):
        await asyncio.wait_for(tasks[1], timeout=2)
    assert (await asyncio.wait_for(tasks[0], timeout=2)).market_id == MARKET_ID
    assert (await asyncio.wait_for(tasks[2], timeout=2)).market_id == other_market
    assert len(ws._subscriptions) == 2
    await canonical.aclose()
    await other.aclose()
