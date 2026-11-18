"""REST API client for the O2 Exchange.

Typed wrappers for every endpoint from the O2 API. All methods return
typed response objects and raise O2Error on failures.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import aiohttp

from .config import NetworkConfig
from .errors import O2Error, RateLimitExceeded, TurboDiscoveryUnavailable, raise_for_error
from .models import (
    AccountCreateResponse,
    AccountInfo,
    ActionsResponse,
    AggregatedAsset,
    Balance,
    Bar,
    DepthSnapshot,
    FaucetResponse,
    MarketsResponse,
    MarketSummary,
    MarketTicker,
    Order,
    OrdersResponse,
    ReferralInfo,
    SessionResponse,
    Trade,
    WhitelistResponse,
    WithdrawResponse,
)

logger = logging.getLogger("o2_sdk.api")


def _assert_market_venue(data: Any, turbo: bool) -> None:
    rows = data if isinstance(data, list) else [data]
    for row in rows:
        is_turbo = isinstance(row, dict) and row.get("turbo") is True
        if is_turbo != turbo:
            raise O2Error(message="The API did not return the requested trading market")


def _market_stats_row(data: Any, market_id: str, kind: str) -> dict[str, Any]:
    # The live endpoints return a list even when a market ID is supplied.
    if isinstance(data, list):
        if not data:
            raise O2Error(message=f"No {kind} returned for market {market_id}")
        data = data[0]
    if not isinstance(data, dict):
        raise O2Error(message=f"Invalid {kind} response for market {market_id}")
    return {"market_id": market_id, **data}


class O2Api:
    """Low-level REST API client for the O2 Exchange."""

    def __init__(
        self,
        config: NetworkConfig,
        session: aiohttp.ClientSession | None = None,
        action_timeout_seconds: float = 30.0,
    ):
        if action_timeout_seconds <= 0:
            raise ValueError("action_timeout_seconds must be greater than zero")
        self._config = config
        self._session = session
        self._owns_session = session is None
        self._action_timeout_seconds = action_timeout_seconds

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
        json: dict | None = None,
        params: dict | None = None,
        headers: dict | None = None,
        base_url: str | None = None,
        timeout_seconds: float | None = None,
        max_retries: int = 3,
    ) -> Any:
        session = await self._ensure_session()
        url = (base_url or self._config.api_base) + path
        hdrs = {"Content-Type": "application/json"}
        if headers:
            hdrs.update(headers)

        for attempt in range(max_retries):
            if params:
                logger.debug("%s %s params=%s", method, path, params)
            elif json is not None:
                logger.debug("%s %s body=%s", method, path, json)
            else:
                logger.debug("%s %s", method, path)

            t0 = time.monotonic()
            request_timeout = (
                aiohttp.ClientTimeout(total=timeout_seconds)
                if timeout_seconds is not None
                else session.timeout
            )
            try:
                request = session.request(
                    method,
                    url,
                    json=json,
                    params=params,
                    headers=hdrs,
                    timeout=request_timeout,
                )
                async with request as resp:
                    try:
                        data = await resp.json(content_type=None)
                    except ValueError as err:
                        # Not JSON at all. An infrastructure error in front of
                        # the API (load balancer 502/503, a redirect to an error
                        # page) answers with plain text, and letting the decoder
                        # error escape gives the caller a JSONDecodeError with no
                        # status and no body to act on.
                        body = (await resp.text())[:200]
                        raise O2Error(
                            message=(
                                f"Non-JSON response from {method} {path} "
                                f"(HTTP {resp.status}): {body}"
                            )
                        ) from err
                    elapsed_ms = (time.monotonic() - t0) * 1000

                    # Rate limit: check both code 1003 and HTTP 429
                    is_rate_limited = (
                        isinstance(data, dict) and data.get("code") == 1003
                    ) or resp.status == 429
                    if is_rate_limited:
                        if attempt < max_retries - 1:
                            wait = 2 ** (attempt + 1)
                            logger.warning(
                                "Rate limited on %s %s, retrying in %ds (attempt %d/%d)",
                                method,
                                path,
                                wait,
                                attempt + 1,
                                max_retries,
                            )
                            await asyncio.sleep(wait)
                            continue
                        raise RateLimitExceeded(
                            message=(
                                data.get("message", "Rate limit exceeded")
                                if isinstance(data, dict)
                                else "Rate limit exceeded"
                            ),
                            code=1003,
                        )

                    if resp.status >= 400 and isinstance(data, dict):
                        code = data.get("code")
                        message = data.get("message") or data.get("error") or f"HTTP {resp.status}"
                        logger.debug(
                            "%s %s -> %d error (code=%s) %.0fms: %s",
                            method,
                            path,
                            resp.status,
                            code,
                            elapsed_ms,
                            message,
                        )
                        if code is not None:
                            from .errors import ERROR_CODE_MAP

                            error_cls = ERROR_CODE_MAP.get(code, O2Error)
                            # Augment revert messages even on code-based errors —
                            # the backend sometimes returns code=1000 (InternalError)
                            # with the revert info buried in the message field.
                            reason = data.get("reason")
                            receipts = data.get("receipts")
                            if "Revert" in message or "revert" in message or "Panic" in message:
                                from .onchain_revert import augment_revert_reason

                                message = augment_revert_reason(message, reason, receipts)
                            # Carry reason and receipts through: a code-based
                            # error can still be an on-chain revert, and callers
                            # classify those from the untouched fields (see
                            # onchain_revert.is_selector_mismatch_revert).
                            raise error_cls(
                                message=message, code=code, reason=reason, receipts=receipts
                            )
                        if ("message" in data or "error" in data) and "tx_id" not in data:
                            raise_for_error(data)
                    else:
                        logger.debug("%s %s -> %d %.0fms", method, path, resp.status, elapsed_ms)

                    return data
            except asyncio.TimeoutError as e:
                raise O2Error(
                    message=f"{method} {path} timed out after {request_timeout.total}s"
                ) from e
            except aiohttp.ClientError as e:
                elapsed_ms = (time.monotonic() - t0) * 1000
                if attempt < max_retries - 1:
                    logger.debug(
                        "%s %s -> network error, retrying (attempt %d/%d, %.0fms): %s",
                        method,
                        path,
                        attempt + 1,
                        max_retries,
                        elapsed_ms,
                        e,
                    )
                    await asyncio.sleep(2**attempt)
                    continue
                raise O2Error(message=str(e)) from e

    # -----------------------------------------------------------------------
    # Market Data
    # -----------------------------------------------------------------------

    async def _request_market_data(
        self,
        path: str,
        params: dict[str, Any],
        *,
        turbo: bool,
        allow_bare_list: bool = False,
    ) -> Any:
        if turbo:
            params["turbo"] = "true"
        data = await self._request("GET", path, params=params)
        if not (allow_bare_list and isinstance(data, list)):
            _assert_market_venue(data, turbo)
        return data

    async def get_markets(self, *, turbo: bool = False) -> MarketsResponse:
        """Fetch the canonical or Turbo market catalog."""
        if turbo:
            data = await self._request("GET", "/v1/markets", params={"turbo": "true"})
            if any(
                market.get("turbo") is not True or not market.get("canonical_contract_id")
                for market in data.get("markets", [])
            ):
                raise TurboDiscoveryUnavailable()
        else:
            data = await self._request("GET", "/v1/markets")
            _assert_market_venue(data.get("markets", []), turbo=False)
        return MarketsResponse.from_dict(data)

    async def get_market_summary(self, market_id: str, *, turbo: bool = False) -> MarketSummary:
        data = await self._request_market_data(
            "/v1/markets/summary", {"market_id": market_id}, turbo=turbo
        )
        return MarketSummary.from_dict(_market_stats_row(data, market_id, "summary"))

    async def get_market_ticker(self, market_id: str, *, turbo: bool = False) -> MarketTicker:
        data = await self._request_market_data(
            "/v1/markets/ticker", {"market_id": market_id}, turbo=turbo
        )
        return MarketTicker.from_dict(_market_stats_row(data, market_id, "ticker"))

    async def get_depth(
        self,
        market_id: str,
        precision: int = 10,
        limit: int | None = None,
        *,
        turbo: bool = False,
    ) -> DepthSnapshot:
        params: dict[str, Any] = {"market_id": market_id, "precision": precision}
        if limit is not None:
            params["limit"] = limit
        data = await self._request_market_data("/v1/depth", params, turbo=turbo)
        snapshot = DepthSnapshot.from_dict(data)
        # Client-side truncation: even if the backend doesn't support the
        # limit parameter yet, we honour it here so callers always get the
        # expected number of levels.
        if limit is not None:
            snapshot = DepthSnapshot(
                bids=snapshot.bids[:limit],
                asks=snapshot.asks[:limit],
                market_id=snapshot.market_id,
            )
        return snapshot

    async def get_trades(
        self,
        market_id: str,
        direction: str = "desc",
        count: int = 50,
        start_timestamp: int | None = None,
        start_trade_id: str | None = None,
        contract: str | None = None,
        *,
        turbo: bool = False,
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
        if contract is not None:
            params["contract"] = contract
        data = await self._request_market_data(
            "/v1/trades", params, turbo=turbo, allow_bare_list=True
        )
        if isinstance(data, list):
            return [Trade.from_dict(t) for t in data]
        return [Trade.from_dict(t) for t in data.get("trades", [])]

    async def get_trades_by_account(
        self,
        market_id: str,
        contract: str,
        direction: str = "desc",
        count: int = 50,
        start_timestamp: int | None = None,
        start_trade_id: str | None = None,
        *,
        turbo: bool = False,
    ) -> list[Trade]:
        params: dict[str, Any] = {
            "market_id": market_id,
            "contract": contract,
            "direction": direction,
            "count": count,
        }
        if start_timestamp is not None:
            params["start_timestamp"] = start_timestamp
        if start_trade_id is not None:
            params["start_trade_id"] = start_trade_id
        data = await self._request_market_data(
            "/v1/trades_by_account", params, turbo=turbo, allow_bare_list=True
        )
        if isinstance(data, list):
            return [Trade.from_dict(t) for t in data]
        return [Trade.from_dict(t) for t in data.get("trades", [])]

    _VALID_RESOLUTIONS = frozenset(
        {
            "1s",
            "1m",
            "2m",
            "3m",
            "5m",
            "15m",
            "30m",
            "1h",
            "2h",
            "4h",
            "6h",
            "8h",
            "12h",
            "1d",
            "3d",
            "1w",
            "1M",
            "3M",
        }
    )

    async def get_bars(
        self,
        market_id: str,
        from_ts: int,
        to_ts: int,
        resolution: str = "1h",
        *,
        turbo: bool = False,
    ) -> list[Bar]:
        """Fetch OHLCV candle bars.

        Args:
            market_id: Market identifier.
            from_ts: Start timestamp in **milliseconds** (not seconds).
            to_ts: End timestamp in **milliseconds** (not seconds).
            resolution: Bar resolution. Valid values:
                ``1s``, ``1m``, ``2m``, ``3m``, ``5m``, ``15m``, ``30m``,
                ``1h``, ``2h``, ``4h``, ``6h``, ``8h``, ``12h``,
                ``1d``, ``3d``, ``1w``, ``1M``, ``3M``.
            turbo: Read from the Turbo venue.

        Raises:
            ValueError: If *resolution* is not one of the valid values.
        """
        if resolution not in self._VALID_RESOLUTIONS:
            raise ValueError(
                f"Invalid bar resolution {resolution!r}. "
                f"Valid values: {sorted(self._VALID_RESOLUTIONS)}"
            )
        params: dict[str, Any] = {
            "market_id": market_id,
            "from": from_ts,
            "to": to_ts,
            "resolution": resolution,
        }
        data = await self._request_market_data(
            "/v1/bars", params, turbo=turbo, allow_bare_list=True
        )
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
        owner: str | None = None,
        trade_account_id: str | None = None,
    ) -> AccountInfo:
        params: dict[str, str] = {}
        if owner:
            params["owner"] = owner
        elif trade_account_id:
            params["trade_account_id"] = trade_account_id
        data = await self._request("GET", "/v1/accounts", params=params)
        return AccountInfo.from_dict(data)

    async def get_account_window(self, trade_account_id: str, nonce_session_id: int = 0) -> dict:
        """Fetch the parallel-nonce sliding window for one (account, lane).

        Returns the raw JSON (``nonce_session_id``, ``base``, ``slots`` of
        ``{word_position, bitmap}`` as decimal strings) — parse with
        ``o2_sdk.nonce.WindowResponse.from_dict``.
        """
        data: dict = await self._request(
            "GET",
            "/v1/accounts/window",
            params={
                "trade_account_id": trade_account_id,
                "nonce_session_id": str(nonce_session_id),
            },
        )
        return data

    async def upgrade_account(self, owner_id: str, request: dict) -> dict:
        """Upgrade a trade account to the latest implementation (owner-signed,
        sequential nonce). ``request``: ``{trade_account_id, nonce, signature}``.
        The handler extracts the owner from the ``O2-Owner-Id`` header. Returns
        ``{tx_id}``."""
        data: dict = await self._request(
            "POST",
            "/v1/accounts/upgrade",
            json=request,
            headers={"O2-Owner-Id": owner_id},
        )
        return data

    async def get_balance(
        self,
        asset_id: str,
        contract: str | None = None,
        address: str | None = None,
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
        contract: str | None = None,
        account: str | None = None,
        direction: str = "desc",
        count: int = 20,
        is_open: bool | None = None,
        start_timestamp: int | None = None,
        start_order_id: str | None = None,
        *,
        turbo: bool = False,
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
        data = await self._request_market_data("/v1/orders", params, turbo=turbo)
        return OrdersResponse.from_dict(data)

    async def get_order(self, market_id: str, order_id: str, *, turbo: bool = False) -> Order:
        data = await self._request_market_data(
            "/v1/order", {"market_id": market_id, "order_id": order_id}, turbo=turbo
        )
        # API wraps order in an "order" key
        order_data = data.get("order", data) if isinstance(data, dict) else data
        return Order.from_dict(order_data)

    # -----------------------------------------------------------------------
    # Session Management
    # -----------------------------------------------------------------------

    async def create_session(self, owner_id: str, session_request: dict) -> SessionResponse:
        data = await self._request(
            "PUT",
            "/v1/session",
            json=session_request,
            headers={"O2-Owner-Id": owner_id},
            # The signed owner nonce makes an accepted-but-lost response
            # ambiguous. Never replay the same session registration.
            max_retries=1,
        )
        return SessionResponse.from_dict(data)

    async def submit_actions(self, owner_id: str, actions_request: dict) -> ActionsResponse:
        data = await self._request(
            "POST",
            "/v1/session/actions",
            json=actions_request,
            headers={"O2-Owner-Id": owner_id},
            # Action payloads carry prices, quantities, signatures, and nonces
            # fixed before dispatch. Transport-owned retries can submit stale
            # intent; the caller must reconcile state and build a fresh action.
            max_retries=1,
            timeout_seconds=self._action_timeout_seconds,
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
            # A withdrawal can be accepted before its response is lost.
            # Callers must reconcile the owner nonce instead of replaying it.
            max_retries=1,
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
        data = await self._request("GET", "/analytics/v1/referral/code-info", params={"code": code})
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
        return dict(
            await self._request(
                "GET",
                "/v1/aggregated/orderbook",
                params={"market_pair": market_pair, "depth": depth, "level": level},
            )
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
