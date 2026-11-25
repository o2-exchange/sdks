"""Tests for the paper (Turbo Instant Pro) market catalog."""

from __future__ import annotations

from dataclasses import asdict
from unittest.mock import AsyncMock

import pytest

from o2_sdk import Id, Market, O2Client, O2Error, TurboMarket
from o2_sdk.api import O2Api
from o2_sdk.config import Network, get_config

MARKET_ID = Id("01" * 32)
CANONICAL_BOOK = Id("02" * 32)
PAPER_MARKET_ID = Id("0c" * 32)
PAPER_BOOK = Id("0d" * 32)
PAIR = "FUEL/USDC"


def _row(market_id: str, contract_id: str, **extra: object) -> dict:
    return {
        "market_id": market_id,
        "contract_id": contract_id,
        "min_order": "1000",
        "base": {"symbol": "FUEL", "asset": Id("07" * 32), "decimals": 6, "max_precision": 6},
        "quote": {"symbol": "USDC", "asset": Id("08" * 32), "decimals": 6, "max_precision": 6},
        **extra,
    }


CANONICAL = {"chain_id": "0x0", "markets": [_row(MARKET_ID, CANONICAL_BOOK)]}
PAPER = {"chain_id": "0x0", "markets": [_row(PAPER_MARKET_ID, PAPER_BOOK, paper=True)]}


async def _catalog_request(method, path, *, params=None):
    assert (method, path) == ("GET", "/v1/markets")
    return PAPER if params == {"paper": "true"} else CANONICAL


@pytest.fixture
async def api(monkeypatch):
    api = O2Api(get_config(Network.TESTNET))
    monkeypatch.setattr(api, "_request", AsyncMock(side_effect=_catalog_request))
    yield api
    await api.close()


def test_market_paper_flag_defaults_false_and_parses_true():
    canonical = Market.from_dict(_row(MARKET_ID, CANONICAL_BOOK))
    assert canonical.paper is False
    assert Market.from_dict(_row(MARKET_ID, CANONICAL_BOOK, paper=False)).paper is False
    paper = Market.from_dict(_row(PAPER_MARKET_ID, PAPER_BOOK, paper=True))
    assert type(paper) is Market
    assert paper.paper is True
    assert asdict(paper)["paper"] is True

    sidecar = Market.from_dict(
        _row(MARKET_ID, Id("03" * 32), turbo=True, canonical_contract_id=CANONICAL_BOOK)
    )
    assert isinstance(sidecar, TurboMarket)
    assert sidecar.paper is False


async def test_default_catalog_request_is_unchanged(api):
    resp = await api.get_markets()
    api._request.assert_awaited_once_with("GET", "/v1/markets")
    assert [m.paper for m in resp.markets] == [False]


async def test_paper_catalog_sends_paper_query(api):
    resp = await api.get_markets(paper=True)
    api._request.assert_awaited_once_with("GET", "/v1/markets", params={"paper": "true"})
    assert [(m.contract_id, m.paper) for m in resp.markets] == [(PAPER_BOOK, True)]


async def test_paper_catalog_rejects_api_without_paper_support(api):
    # An o2-api without paper support ignores ?paper=true and returns the
    # canonical list; trading it from a paper caller must fail, not proceed.
    api._request.side_effect = None
    api._request.return_value = CANONICAL
    with pytest.raises(O2Error, match="paper market catalog"):
        await api.get_markets(paper=True)


async def test_paper_and_turbo_are_mutually_exclusive(api):
    with pytest.raises(ValueError, match="not both"):
        await api.get_markets(turbo=True, paper=True)
    api._request.assert_not_awaited()


@pytest.fixture
async def paper_client(monkeypatch):
    async with O2Client(paper_markets=True) as client:
        monkeypatch.setattr(client.api, "_request", AsyncMock(side_effect=_catalog_request))
        yield client


async def test_paper_client_resolves_markets_from_paper_catalog(paper_client):
    client = paper_client
    market = await client.get_market(PAIR)
    assert (market.market_id, market.contract_id, market.paper) == (
        PAPER_MARKET_ID,
        PAPER_BOOK,
        True,
    )
    assert [m.contract_id for m in await client.get_markets()] == [PAPER_BOOK]
    assert (await client._resolve_trading_market(market)).contract_id == PAPER_BOOK
    assert (await client._resolve_trading_market(PAIR)).contract_id == PAPER_BOOK
    client.api._request.assert_awaited_once_with("GET", "/v1/markets", params={"paper": "true"})


async def test_paper_client_rejects_canonical_market_objects(paper_client):
    canonical = Market.from_dict(_row(MARKET_ID, CANONICAL_BOOK))
    with pytest.raises(O2Error, match="Trading market unavailable"):
        await paper_client._resolve_trading_market(canonical)


async def test_paper_client_has_no_turbo_catalog(paper_client):
    with pytest.raises(ValueError, match="no Turbo sidecar"):
        await paper_client.get_markets(turbo=True)
    with pytest.raises(ValueError, match="no Turbo sidecar"):
        await paper_client.get_market(PAIR, turbo=True)
    paper_client.api._request.assert_not_awaited()


async def test_default_client_never_requests_paper_catalog(monkeypatch):
    async with O2Client() as client:
        monkeypatch.setattr(client.api, "_request", AsyncMock(side_effect=_catalog_request))
        assert (await client.get_market(PAIR)).contract_id == CANONICAL_BOOK
        client.api._request.assert_awaited_once_with("GET", "/v1/markets")
