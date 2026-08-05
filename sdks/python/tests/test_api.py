"""Transport-policy regressions for the low-level O2 API client."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

import aiohttp
import pytest

from o2_sdk.api import O2Api
from o2_sdk.config import NetworkConfig
from o2_sdk.errors import O2Error, RateLimitExceeded


class _Response:
    def __init__(self, status: int, data: Any):
        self.status = status
        self._data = data

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return None

    async def json(self, *, content_type=None):
        return self._data

    async def text(self):
        return str(self._data)


class _RequestFailure:
    def __init__(self, exc: BaseException):
        self._exc = exc

    async def __aenter__(self):
        raise self._exc

    async def __aexit__(self, *_exc):
        return None


class _Session:
    def __init__(self, outcomes: Iterable[Any]):
        self.closed = False
        self.timeout = aiohttp.ClientTimeout(total=300)
        self._outcomes = iter(outcomes)
        self.calls: list[dict[str, Any]] = []

    def request(self, method: str, url: str, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        outcome = next(self._outcomes)
        if isinstance(outcome, BaseException):
            return _RequestFailure(outcome)
        return outcome


_CONFIG = NetworkConfig(
    api_base="https://api.invalid",
    ws_url="wss://api.invalid/v1/ws",
    fuel_rpc="https://fuel.invalid",
    faucet_url=None,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [200, 429])
async def test_submit_actions_surfaces_rate_limit_without_retry(status: int):
    session = _Session([_Response(status, {"code": 1003, "message": "Rate limit exceeded"})])
    api = O2Api(_CONFIG, session=session, action_timeout_seconds=0.25)

    with pytest.raises(RateLimitExceeded):
        await api.submit_actions("owner", {"actions": []})

    assert len(session.calls) == 1
    timeout = session.calls[0]["timeout"]
    assert isinstance(timeout, aiohttp.ClientTimeout)
    assert timeout.total == 0.25


@pytest.mark.asyncio
async def test_submit_actions_does_not_retry_transport_failure():
    session = _Session([aiohttp.ClientConnectionError("disconnected")])
    api = O2Api(_CONFIG, session=session)

    with pytest.raises(O2Error, match="disconnected"):
        await api.submit_actions("owner", {"actions": []})

    assert len(session.calls) == 1


@pytest.mark.asyncio
async def test_non_action_request_keeps_rate_limit_backoff(monkeypatch):
    session = _Session(
        [
            _Response(429, {"code": 1003, "message": "Rate limit exceeded"}),
            _Response(429, {"code": 1003, "message": "Rate limit exceeded"}),
            _Response(200, {"ok": True}),
        ]
    )
    api = O2Api(_CONFIG, session=session)
    sleeps: list[int] = []

    async def fake_sleep(delay: int):
        sleeps.append(delay)

    monkeypatch.setattr("o2_sdk.api.asyncio.sleep", fake_sleep)

    assert await api._request("GET", "/v1/markets") == {"ok": True}
    assert len(session.calls) == 3
    assert sleeps == [2, 4]


def test_action_timeout_must_be_positive():
    with pytest.raises(ValueError, match="greater than zero"):
        O2Api(_CONFIG, action_timeout_seconds=0)
