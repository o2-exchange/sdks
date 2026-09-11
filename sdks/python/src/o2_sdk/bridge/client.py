"""Async single-attempt Fast Bridge API client. No trading sessions or implicit retries."""

from __future__ import annotations

import json
import math
from typing import Any, TypeVar
from urllib.parse import urlsplit

import aiohttp

from ..errors import O2Error
from . import models as m

T = TypeVar("T", bound=m.BridgeModel)


class BridgeApiError(O2Error):
    def __init__(self, status: int, bridge_code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status = status
        self.bridge_code = bridge_code
        self.details = details


class FastBridgeClient:
    """Proxy root URL is explicit. Borrowed sessions are not closed by this client."""

    def __init__(
        self,
        base_url: str,
        *,
        session: aiohttp.ClientSession | None = None,
        timeout_seconds: float = 30,
    ):
        url = urlsplit(base_url)
        if (
            url.scheme not in ("http", "https")
            or not url.netloc
            or url.query
            or url.fragment
            or url.username
            or url.password
        ):
            raise ValueError("Invalid bridge base URL")
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("Invalid bridge timeout")
        self._base_url = base_url.rstrip("/")
        self._session = session
        self._owns_session = session is None
        self._timeout = aiohttp.ClientTimeout(total=timeout_seconds)

    async def close(self) -> None:
        if self._owns_session and self._session is not None:
            await self._session.close()

    async def __aenter__(self) -> FastBridgeClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def _request(
        self,
        method: str,
        path: str,
        model: type[T],
        *,
        body: m.BridgeModel | None = None,
        query: dict[str, Any] | None = None,
    ) -> T:
        if self._session is None:
            self._session = aiohttp.ClientSession()
        async with self._session.request(
            method,
            self._base_url + path,
            params={k: str(v) for k, v in (query or {}).items() if v is not None},
            json=body.to_dict() if body is not None else None,
            timeout=self._timeout,
            allow_redirects=False,
        ) as response:
            try:
                payload = json.loads(await response.text())
            except ValueError as e:
                raise BridgeApiError(
                    response.status, "INVALID_RESPONSE", "Bridge returned non-JSON response"
                ) from e
            if not 200 <= response.status < 300:
                error = payload.get("error", {}) if isinstance(payload, dict) else {}
                if not isinstance(error, dict):
                    error = {}
                code, message = error.get("code"), error.get("message")
                raise BridgeApiError(
                    response.status,
                    code if isinstance(code, str) else "HTTP_ERROR",
                    message if isinstance(message, str) else "Bridge request failed",
                    error.get("details"),
                )
            if not isinstance(payload, dict):
                raise BridgeApiError(
                    response.status, "INVALID_RESPONSE", "Bridge response must be an object"
                )
            try:
                return model.from_dict(payload)
            except (TypeError, KeyError, ValueError, AttributeError) as e:
                raise BridgeApiError(
                    response.status, "INVALID_RESPONSE", "Malformed bridge response"
                ) from e

    async def get_info(self) -> m.InfoResponse:
        """GET /v1/info."""
        return await self._request("GET", "/v1/info", m.InfoResponse)

    async def get_assets(self, chain_id: int | None = None) -> m.AssetsResponse:
        """GET /v1/assets."""
        return await self._request(
            "GET", "/v1/assets", m.AssetsResponse, query={"chainId": chain_id}
        )

    async def get_deposit_info(
        self, source_chain_id: int, asset_id: str | None = None, amount: str | None = None
    ) -> m.DepositInfoResponse:
        """GET /v1/deposit/info."""
        return await self._request(
            "GET",
            "/v1/deposit/info",
            m.DepositInfoResponse,
            query={"sourceChainId": source_chain_id, "assetId": asset_id, "amount": amount},
        )

    async def prepare_deposit(self, request: m.DepositPrepareRequest) -> m.DepositPrepareResponse:
        """POST /v1/deposit/prepare."""
        return await self._request(
            "POST", "/v1/deposit/prepare", m.DepositPrepareResponse, body=request
        )

    async def submit_deposit(self, request: m.SubmitRequest) -> m.DepositSubmitResponse:
        """POST /v1/deposit/submit."""
        return await self._request(
            "POST", "/v1/deposit/submit", m.DepositSubmitResponse, body=request
        )

    async def get_deposit_status(
        self, source_chain_id: int, evm_tx_hash: str
    ) -> m.DepositStatusResponse:
        """GET /v1/deposit/status."""
        return await self._request(
            "GET",
            "/v1/deposit/status",
            m.DepositStatusResponse,
            query={"sourceChainId": source_chain_id, "evmTxHash": evm_tx_hash},
        )

    async def get_withdraw_info(
        self, destination_chain_id: int, asset_id: str | None = None, amount: str | None = None
    ) -> m.WithdrawInfoResponse:
        """GET /v1/withdraw/info."""
        return await self._request(
            "GET",
            "/v1/withdraw/info",
            m.WithdrawInfoResponse,
            query={
                "destinationChainId": destination_chain_id,
                "assetId": asset_id,
                "amount": amount,
            },
        )

    async def get_withdraw_fee(
        self, destination_chain_id: int, asset_id: str
    ) -> m.WithdrawFeeResponse:
        """GET /v1/withdraw/fee."""
        return await self._request(
            "GET",
            "/v1/withdraw/fee",
            m.WithdrawFeeResponse,
            query={"destinationChainId": destination_chain_id, "assetId": asset_id},
        )

    async def prepare_withdraw(
        self, request: m.WithdrawPrepareRequest
    ) -> m.WithdrawPrepareResponse:
        """POST /v1/withdraw/prepare."""
        return await self._request(
            "POST", "/v1/withdraw/prepare", m.WithdrawPrepareResponse, body=request
        )

    async def submit_withdraw(self, request: m.SubmitRequest) -> m.WithdrawSubmitResponse:
        """POST /v1/withdraw/submit."""
        return await self._request(
            "POST", "/v1/withdraw/submit", m.WithdrawSubmitResponse, body=request
        )

    async def get_withdraw_status(self, fuel_tx_id: str) -> m.WithdrawStatusResponse:
        """GET /v1/withdraw/status."""
        return await self._request(
            "GET", "/v1/withdraw/status", m.WithdrawStatusResponse, query={"fuelTxId": fuel_tx_id}
        )
