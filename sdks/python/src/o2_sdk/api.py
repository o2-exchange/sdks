"""REST API client for the O2 Exchange.

Typed wrappers for every endpoint from the O2 API. All methods return
typed response objects and raise O2Error on failures.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

import aiohttp

from .config import NetworkConfig
from .errors import O2Error, RateLimitExceeded, raise_for_error
from .models import (
    AccountCreateResponse,
    AccountInfo,
    ActionsResponse,
    AggregatedAsset,
    Balance,
    Bar,
    DepthSnapshot,
    FaucetResponse,
    Market,
    MarketSummary,
    MarketTicker,
    MarketsResponse,
    Order,
    OrdersResponse,
    ReferralInfo,
    SessionResponse,
    Trade,
    WhitelistResponse,
    WithdrawResponse,
)

logger = logging.getLogger("o2_sdk.api")


class O2Api:
    """Low-level REST API client for the O2 Exchange."""

    def __init__(self, config: NetworkConfig, session: Optional[aiohttp.ClientSession] = None):
        self._config = config
        self._session = session
        self._owns_session = session is None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
            self._owns_session = True
        return self._session

    async def close(self) -> None:
        if self._owns_session and self._session and not self._session.closed:
            await self._session.close()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[dict] = None,
        params: Optional[dict] = None,
        headers: Optional[dict] = None,
        base_url: Optional[str] = None,
        max_retries: int = 3,
    ) -> Any:
        session = await self._ensure_session()
        url = (base_url or self._config.api_base) + path
        hdrs = {"Content-Type": "application/json"}
        if headers:
            hdrs.update(headers)

        for attempt in range(max_retries):
            try:
                async with session.request(
                    method, url, json=json, params=params, headers=hdrs
                ) as resp:
                    data = await resp.json(content_type=None)

                    # Rate limit: check both code 1003 and HTTP 429
                    is_rate_limited = (
                        (isinstance(data, dict) and data.get("code") == 1003)
                        or resp.status == 429
                    )
                    if is_rate_limited:
                        if attempt < max_retries - 1:
                            wait = 2 ** (attempt + 1)
                            logger.warning("Rate limited, retrying in %ds", wait)
                            await asyncio.sleep(wait)
                            continue
                        raise RateLimitExceeded(
                            message=(data.get("message", "Rate limit exceeded")
                                     if isinstance(data, dict) else "Rate limit exceeded"),
                            code=1003,
                        )

                    if resp.status >= 400 and isinstance(data, dict):
                        code = data.get("code")
                        message = data.get("message", f"HTTP {resp.status}")
                        if code is not None:
                            from .errors import ERROR_CODE_MAP
                            error_cls = ERROR_CODE_MAP.get(code, O2Error)
                            raise error_cls(message=message, code=code)
                        if "message" in data and "tx_id" not in data:
                            reason = data.get("reason", "")
                            full_msg = f"{message}: {reason}" if reason else message
                            raise O2Error(message=full_msg)

                    return data
            except aiohttp.ClientError as e:
                if attempt < max_retries - 1:
                    await asyncio.sleep(2 ** attempt)
                    continue
                raise O2Error(message=str(e))

    # -----------------------------------------------------------------------
    # Market Data
    # -----------------------------------------------------------------------

    async def get_markets(self) -> MarketsResponse:
        data = await self._request("GET", "/v1/markets")
        return MarketsResponse.from_dict(data)

    async def get_market_summary(self, market_id: str) -> MarketSummary:
        data = await self._request(
            "GET", "/v1/markets/summary", params={"market_id": market_id}
        )
        return MarketSummary.from_dict(data)

    async def get_market_ticker(self, market_id: str) -> MarketTicker:
        data = await self._request(
            "GET", "/v1/markets/ticker", params={"market_id": market_id}
        )
        return MarketTicker.from_dict(data)

    async def get_depth(self, market_id: str, precision: int = 10) -> DepthSnapshot:
        data = await self._request(
            "GET", "/v1/depth", params={"market_id": market_id, "precision": precision}
        )
        return DepthSnapshot.from_dict(data)

    async def get_trades(
        self,
        market_id: str,
        direction: str = "desc",
        count: int = 50,
        start_timestamp: Optional[int] = None,
        start_trade_id: Optional[str] = None,
    ) -> list[Trade]:
        params: dict[str, Any] = {
            "market_id": market_id,
            "direction": direction,
            "count": count,
        }
        if start_timestamp is not None:
            params["start_timestamp"] = start_timestamp
        if start_trade_id is not None:
            params["start_trade_id"] = start_trade_id
        data = await self._request("GET", "/v1/trades", params=params)
        if isinstance(data, list):
            return [Trade.from_dict(t) for t in data]
        return [Trade.from_dict(t) for t in data.get("trades", [])]

    async def get_trades_by_account(
        self,
        market_id: str,
        contract: str,
        direction: str = "desc",
        count: int = 50,
    ) -> list[Trade]:
        params: dict[str, Any] = {
            "market_id": market_id,
            "contract": contract,
            "direction": direction,
            "count": count,
        }
        data = await self._request("GET", "/v1/trades_by_account", params=params)
        if isinstance(data, list):
            return [Trade.from_dict(t) for t in data]
        return [Trade.from_dict(t) for t in data.get("trades", [])]

    async def get_bars(
        self,
        market_id: str,
        from_ts: int,
        to_ts: int,
        resolution: str = "1h",
    ) -> list[Bar]:
        params: dict[str, Any] = {
            "market_id": market_id,
            "from": from_ts,
            "to": to_ts,
            "resolution": resolution,
        }
        data = await self._request("GET", "/v1/bars", params=params)
        if isinstance(data, list):
            return [Bar.from_dict(b) for b in data]
        return [Bar.from_dict(b) for b in data.get("bars", [])]

    # -----------------------------------------------------------------------
    # Account & Balance
    # -----------------------------------------------------------------------

    async def create_account(self, owner_address: str) -> AccountCreateResponse:
        data = await self._request(
            "POST",
            "/v1/accounts",
            json={"identity": {"Address": owner_address}},
        )
        return AccountCreateResponse.from_dict(data)

    async def get_account(
        self,
        owner: Optional[str] = None,
        trade_account_id: Optional[str] = None,
    ) -> AccountInfo:
        params: dict[str, str] = {}
        if owner:
            params["owner"] = owner
        elif trade_account_id:
            params["trade_account_id"] = trade_account_id
        data = await self._request("GET", "/v1/accounts", params=params)
        return AccountInfo.from_dict(data)

    async def get_balance(
        self,
        asset_id: str,
        contract: Optional[str] = None,
        address: Optional[str] = None,
    ) -> Balance:
        params: dict[str, str] = {"asset_id": asset_id}
        if contract:
            params["contract"] = contract
        elif address:
            params["address"] = address
        data = await self._request("GET", "/v1/balance", params=params)
        return Balance.from_dict(data)

    # -----------------------------------------------------------------------
    # Orders
    # -----------------------------------------------------------------------

    async def get_orders(
        self,
        market_id: str,
        contract: Optional[str] = None,
        account: Optional[str] = None,
        direction: str = "desc",
        count: int = 20,
        is_open: Optional[bool] = None,
        start_timestamp: Optional[int] = None,
        start_order_id: Optional[str] = None,
    ) -> OrdersResponse:
        params: dict[str, Any] = {
            "market_id": market_id,
            "direction": direction,
            "count": count,
        }
        if contract:
            params["contract"] = contract
        elif account:
            params["account"] = account
        if is_open is not None:
            params["is_open"] = str(is_open).lower()
        if start_timestamp is not None:
            params["start_timestamp"] = start_timestamp
        if start_order_id is not None:
            params["start_order_id"] = start_order_id
        data = await self._request("GET", "/v1/orders", params=params)
        return OrdersResponse.from_dict(data)

    async def get_order(self, market_id: str, order_id: str) -> Order:
        data = await self._request(
            "GET", "/v1/order", params={"market_id": market_id, "order_id": order_id}
        )
        # API wraps order in an "order" key
        order_data = data.get("order", data) if isinstance(data, dict) else data
        return Order.from_dict(order_data)

    # -----------------------------------------------------------------------
    # Session Management
    # -----------------------------------------------------------------------

    async def create_session(
        self, owner_id: str, session_request: dict
    ) -> SessionResponse:
        data = await self._request(
            "PUT",
            "/v1/session",
            json=session_request,
            headers={"O2-Owner-Id": owner_id},
        )
        return SessionResponse.from_dict(data)

    async def submit_actions(
        self, owner_id: str, actions_request: dict
    ) -> ActionsResponse:
        data = await self._request(
            "POST",
            "/v1/session/actions",
            json=actions_request,
            headers={"O2-Owner-Id": owner_id},
        )
        result = ActionsResponse.from_dict(data)
        if not result.success:
            raise_for_error(data)
        return result

    # -----------------------------------------------------------------------
    # Account Operations
    # -----------------------------------------------------------------------

    async def withdraw(self, owner_id: str, withdraw_request: dict) -> WithdrawResponse:
        data = await self._request(
            "POST",
            "/v1/accounts/withdraw",
            json=withdraw_request,
            headers={"O2-Owner-Id": owner_id},
        )
        return WithdrawResponse.from_dict(data)

    # -----------------------------------------------------------------------
    # Analytics
    # -----------------------------------------------------------------------

    async def whitelist_account(self, trade_account_id: str) -> WhitelistResponse:
        data = await self._request(
            "POST",
            "/analytics/v1/whitelist",
            json={"tradeAccount": trade_account_id},
        )
        return WhitelistResponse.from_dict(data)

    async def get_referral_info(self, code: str) -> ReferralInfo:
        data = await self._request(
            "GET", "/analytics/v1/referral/code-info", params={"code": code}
        )
        return ReferralInfo.from_dict(data)

    # -----------------------------------------------------------------------
    # Aggregated endpoints
    # -----------------------------------------------------------------------

    async def get_aggregated_assets(self) -> list[AggregatedAsset]:
        data = await self._request("GET", "/v1/aggregated/assets")
        if isinstance(data, list):
            return [AggregatedAsset.from_dict(a) for a in data]
        return [AggregatedAsset.from_dict(a) for a in data.get("assets", [])]

    async def get_aggregated_orderbook(
        self, market_pair: str, depth: int = 500, level: int = 2
    ) -> dict:
        return await self._request(
            "GET",
            "/v1/aggregated/orderbook",
            params={"market_pair": market_pair, "depth": depth, "level": level},
        )

    async def get_aggregated_summary(self) -> list[dict]:
        data = await self._request("GET", "/v1/aggregated/summary")
        return data if isinstance(data, list) else data.get("summary", [])

    async def get_aggregated_ticker(self) -> list[dict]:
        data = await self._request("GET", "/v1/aggregated/ticker")
        return data if isinstance(data, list) else data.get("ticker", [])

    async def get_aggregated_trades(self, market_pair: str) -> list[Trade]:
        data = await self._request(
            "GET", "/v1/aggregated/trades", params={"market_pair": market_pair}
        )
        items = data if isinstance(data, list) else data.get("trades", [])
        return [Trade.from_dict(t) for t in items]

    # -----------------------------------------------------------------------
    # Faucet (testnet/devnet/sandbox only)
    # -----------------------------------------------------------------------

    async def mint_to_address(self, address: str) -> FaucetResponse:
        if not self._config.faucet_url:
            raise O2Error(message="Faucet not available on this network")
        data = await self._request(
            "POST",
            "",
            json={"address": address},
            base_url=self._config.faucet_url,
        )
        return FaucetResponse.from_dict(data)

    async def mint_to_contract(self, contract_id: str) -> FaucetResponse:
        if not self._config.faucet_url:
            raise O2Error(message="Faucet not available on this network")
        data = await self._request(
            "POST",
            "",
            json={"contract": contract_id},
            base_url=self._config.faucet_url,
        )
        return FaucetResponse.from_dict(data)
