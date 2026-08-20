"""Official asynchronous CCXT interface backed by :class:`o2_sdk.O2Client`."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import replace
from decimal import Decimal, InvalidOperation
from typing import Any, TypeVar, cast

import ccxt.async_support as ccxt

from o2_sdk.client import O2Client
from o2_sdk.config import Network, NetworkConfig
from o2_sdk.crypto import Signer
from o2_sdk.errors import ERROR_CODE_MAP, O2Error, OnChainRevert
from o2_sdk.models import (
    ActionsResponse,
    Id,
    Market,
    MarketActionGroup,
    MarketActions,
    OrderSide,
    OrderType,
    SessionInfo,
)

from .errors import (
    ArgumentsRequired,
    AuthenticationError,
    BadRequest,
    BadSymbol,
    InvalidOrder,
    NotSupported,
    O2AmbiguousSubmission,
    OperationFailed,
    map_o2_error,
)
from .parsers import (
    CCXT_TIMEFRAMES,
    json_compatible,
    native_market,
    number_or_none,
    parse_balance,
    parse_market,
    parse_ohlcv,
    parse_order,
    parse_order_book,
    parse_ticker,
    parse_trade,
)
from .types import CCXTObject, Params

T = TypeVar("T")


def _optional_bool(params: Params, key: str, fallback: bool) -> bool:
    value = params.get(key, fallback)
    if not isinstance(value, bool):
        raise InvalidOrder(f"{key} must be a boolean")
    return value


def _positive_numeric(params: Params, key: str) -> str:
    value = params.get(key)
    try:
        parsed = Decimal(str(value))
    except InvalidOperation:
        parsed = Decimal(0)
    if not parsed.is_finite() or parsed <= 0:
        raise ArgumentsRequired(
            f"create_order market orders require a positive params.{key} O2 price bound"
        )
    return str(value)


def _protected_price_to_precision(value: str, side: str, precision: int) -> str:
    truncated = cast(
        str,
        ccxt.decimal_to_precision(
            value,
            ccxt.TRUNCATE,
            precision,
            ccxt.DECIMAL_PLACES,
        ),
    )
    truncated_decimal = Decimal(truncated)
    if side == "buy":
        if truncated_decimal <= 0:
            raise InvalidOrder("create_order market maxPrice is below the minimum price precision")
        return truncated
    input_decimal = Decimal(value)
    if truncated_decimal >= input_decimal:
        return truncated
    step = Decimal(1).scaleb(-precision)
    return format(truncated_decimal + step, "f")


def _network(value: Network | str | None) -> Network:
    if value is None:
        return Network.TESTNET
    if isinstance(value, Network):
        return value
    try:
        return Network(value.lower())
    except ValueError as error:
        raise BadRequest(f"Unknown O2 network: {value}") from error


class O2CCXT(ccxt.Exchange):
    """O2-maintained public-alpha CCXT exchange implementation."""

    def __init__(self, config: Params | None = None) -> None:
        options = dict(config or {})
        client = options.pop("client", options.pop("o2_client", None))
        network = options.pop("network", None)
        custom_config = options.pop("custom_config", options.pop("o2_config", None))
        private_key = options.pop("privateKey", options.pop("private_key", None))
        signer = options.pop("signer", None)
        session = options.pop("session", None)
        account = options.pop("tradeAccountId", options.pop("trade_account_id", None))
        if private_key is not None and signer is not None:
            raise AuthenticationError("Provide privateKey or signer, not both")
        super().__init__(options)
        if client is not None and not isinstance(client, O2Client):
            raise BadRequest("client must be an O2Client")
        if custom_config is not None and not isinstance(custom_config, NetworkConfig):
            raise BadRequest("custom_config must be an O2 NetworkConfig")
        self.o2_client = client or O2Client(
            network=_network(network),
            custom_config=custom_config,
        )
        self._owner_signer: Signer | None = signer or (
            O2Client.load_wallet(private_key) if private_key else None
        )
        self._trade_account_id = Id(str(account)) if account is not None else None
        if session is not None:
            self.restore_session(session)

    def describe(self) -> CCXTObject:
        return cast(
            CCXTObject,
            self.deep_extend(
                super().describe(),
                {
                    "id": "o2",
                    "name": "O2 Exchange",
                    "version": "v1",
                    "countries": [],
                    "rateLimit": 0,
                    "enableRateLimit": False,
                    "precisionMode": ccxt.DECIMAL_PLACES,
                    "dex": True,
                    "has": {
                        "fetchMarkets": True,
                        "fetchOrderBook": True,
                        "fetchL2OrderBook": True,
                        "fetchTrades": True,
                        "fetchTicker": True,
                        "fetchOHLCV": True,
                        "fetchBalance": True,
                        "createOrder": True,
                        "createMarketOrder": True,
                        "cancelOrder": True,
                        "cancelAllOrders": True,
                        "fetchOrder": True,
                        "fetchOrders": True,
                        "fetchOpenOrders": True,
                        "fetchClosedOrders": True,
                        "fetchMyTrades": True,
                        "withdraw": True,
                        "watchOrderBook": False,
                        "watchTrades": False,
                        "watchOrders": False,
                    },
                    "timeframes": {key: key for key in CCXT_TIMEFRAMES},
                },
            ),
        )

    async def fetch_markets(self, params: Params | None = None) -> list[CCXTObject]:
        del params
        return await self._read(self._fetch_markets)

    async def _fetch_markets(self) -> list[CCXTObject]:
        # CCXT keys markets by symbol. Test/private O2 books without public
        # asset symbols would otherwise collapse into the same "/" market.
        return [
            parse_market(market)
            for market in await self.o2_client.get_markets()
            if market.base.symbol.strip() and market.quote.symbol.strip()
        ]

    async def fetch_ticker(self, symbol: str, params: Params | None = None) -> CCXTObject:
        del params
        market = await self._resolve_market(symbol)
        return await self._read(lambda: self._fetch_ticker(market))

    async def _fetch_ticker(self, market: CCXTObject) -> CCXTObject:
        raw = await self.o2_client.get_ticker(native_market(market))
        return parse_ticker(raw, market, self.milliseconds())

    async def fetch_order_book(
        self, symbol: str, limit: int | None = None, params: Params | None = None
    ) -> CCXTObject:
        requested = (params or {}).get("precision", 1)
        if isinstance(requested, bool):
            raise BadRequest("fetch_order_book params.precision must be an integer from 1 to 18")
        try:
            precision = int(requested)
        except (TypeError, ValueError) as error:
            raise BadRequest(
                "fetch_order_book params.precision must be an integer from 1 to 18"
            ) from error
        if precision < 1 or precision > 18 or precision != number_or_none(requested):
            raise BadRequest("fetch_order_book params.precision must be an integer from 1 to 18")
        market = await self._resolve_market(symbol)
        return await self._read(lambda: self._fetch_order_book(market, precision, limit))

    async def _fetch_order_book(
        self, market: CCXTObject, precision: int, limit: int | None
    ) -> CCXTObject:
        depth = await self.o2_client.get_depth(native_market(market), precision, limit)
        return parse_order_book(depth, market)

    async def fetch_l2_order_book(
        self, symbol: str, limit: int | None = None, params: Params | None = None
    ) -> CCXTObject:
        return await self.fetch_order_book(symbol, limit, params)

    async def fetch_trades(
        self,
        symbol: str,
        since: int | None = None,
        limit: int | None = None,
        params: Params | None = None,
    ) -> list[CCXTObject]:
        del params
        count = limit or 50
        market = await self._resolve_market(symbol)

        async def operation() -> list[CCXTObject]:
            trades = await self.o2_client.get_trades(native_market(market), min(count, 50))
            parsed = [parse_trade(trade, market) for trade in trades]
            filtered = [trade for trade in parsed if since is None or trade["timestamp"] >= since]
            return sorted(filtered, key=lambda trade: trade["timestamp"])[-count:]

        return await self._read(operation)

    async def fetch_ohlcv(
        self,
        symbol: str,
        timeframe: str = "1m",
        since: int | None = None,
        limit: int | None = None,
        params: Params | None = None,
    ) -> list[list[float | int]]:
        duration = CCXT_TIMEFRAMES.get(timeframe)
        if duration is None:
            raise NotSupported(f"Unsupported OHLCV timeframe: {timeframe}")
        count = limit or 100
        market = await self._resolve_market(symbol)
        until = int(number_or_none((params or {}).get("until")) or self.milliseconds())
        start = since if since is not None else until - duration * count
        end = until if since is None else min(until, start + duration * count)

        async def operation() -> list[list[float | int]]:
            bars = await self.o2_client.get_bars(native_market(market), timeframe, start, end)
            parsed = sorted((parse_ohlcv(bar) for bar in bars), key=lambda bar: bar[0])
            return [bar for bar in parsed if start <= bar[0] <= end][:count]

        return await self._read(operation)

    async def fetch_balance(self, params: Params | None = None) -> CCXTObject:
        del params
        account = self._resolve_account_id()

        async def operation() -> CCXTObject:
            balances = await self.o2_client.get_balances(account)
            decimals: dict[str, int] = {}
            for market in (await self.load_markets()).values():
                native = native_market(market)
                decimals[market["base"]] = native.base.decimals
                decimals[market["quote"]] = native.quote.decimals
            return parse_balance(balances, decimals)

        return await self._read(operation)

    async def fetch_order(
        self, id: str, symbol: str | None = None, params: Params | None = None
    ) -> CCXTObject:
        del params
        if symbol is None:
            raise ArgumentsRequired("fetch_order requires symbol for O2")
        market = await self._resolve_market(symbol)
        return await self._read(lambda: self._fetch_order(id, market))

    async def _fetch_order(self, id: str, market: CCXTObject) -> CCXTObject:
        return parse_order(await self.o2_client.get_order(native_market(market), Id(id)), market)

    async def fetch_orders(
        self,
        symbol: str | None = None,
        since: int | None = None,
        limit: int | None = None,
        params: Params | None = None,
    ) -> list[CCXTObject]:
        return await self._fetch_orders_by_status(symbol, since, limit or 20, params or {})

    async def fetch_open_orders(
        self,
        symbol: str | None = None,
        since: int | None = None,
        limit: int | None = None,
        params: Params | None = None,
    ) -> list[CCXTObject]:
        return await self._fetch_orders_by_status(
            symbol, since, limit or 20, {**(params or {}), "isOpen": True}
        )

    async def fetch_closed_orders(
        self,
        symbol: str | None = None,
        since: int | None = None,
        limit: int | None = None,
        params: Params | None = None,
    ) -> list[CCXTObject]:
        return await self._fetch_orders_by_status(
            symbol, since, limit or 20, {**(params or {}), "isOpen": False}
        )

    async def fetch_my_trades(
        self,
        symbol: str | None = None,
        since: int | None = None,
        limit: int | None = None,
        params: Params | None = None,
    ) -> list[CCXTObject]:
        del params
        account = self._resolve_account_id()
        count = limit or 50
        selected = (
            [await self._resolve_market(symbol)]
            if symbol
            else list((await self.load_markets()).values())
        )

        async def operation() -> list[CCXTObject]:
            parsed: list[CCXTObject] = []
            for market in selected:
                raw = await self.o2_client.get_trades(
                    native_market(market), min(count, 50), account
                )
                parsed.extend(parse_trade(trade, market, True) for trade in raw)
            filtered = [trade for trade in parsed if since is None or trade["timestamp"] >= since]
            return sorted(filtered, key=lambda trade: trade["timestamp"])[-count:]

        return await self._read(operation)

    async def create_order(
        self,
        symbol: str,
        type: str,
        side: str,
        amount: float,
        price: float | None = None,
        params: Params | None = None,
    ) -> CCXTObject:
        options = params or {}
        normalized_type = type.lower()
        normalized_side = side.lower()
        if normalized_type not in ("limit", "market"):
            raise NotSupported(f"The O2 CCXT alpha does not support order type: {type}")
        if normalized_side not in ("buy", "sell"):
            raise InvalidOrder(f"Invalid order side: {side}")
        market = await self._resolve_market(symbol)
        native_amount = self.amount_to_precision(symbol, amount)
        if normalized_type == "limit":
            if price is None:
                raise ArgumentsRequired("create_order requires a limit price")
            native_price = self.price_to_precision(symbol, price)
            requested_type = options.get("orderType", OrderType.SPOT)
            if isinstance(requested_type, str):
                try:
                    order_type: OrderType = OrderType(requested_type)
                except ValueError as error:
                    raise InvalidOrder(f"Invalid O2 orderType: {requested_type}") from error
            elif isinstance(requested_type, OrderType):
                order_type = requested_type
            else:
                raise InvalidOrder("params.orderType must be an O2 OrderType or string")
        else:
            max_price = _positive_numeric(options, "maxPrice")
            min_price = _positive_numeric(options, "minPrice")
            if float(min_price) > float(max_price):
                raise InvalidOrder("create_order market orders require minPrice <= maxPrice")
            if price is not None and not float(min_price) <= price <= float(max_price):
                raise InvalidOrder(
                    "create_order market price must be between minPrice and maxPrice"
                )
            protected_price = (
                str(price)
                if price is not None
                else max_price
                if normalized_side == "buy"
                else min_price
            )
            native_price = _protected_price_to_precision(
                protected_price,
                normalized_side,
                int(market["precision"]["price"]),
            )
            # O2 BoundedMarket is a resting trigger-style order, not an immediate
            # CCXT market order. Emulate bounded execution with a protected FOK.
            order_type = OrderType.FILL_OR_KILL
        response = self._ensure_action_response(
            await self._submit(
                lambda: self.o2_client.create_order(
                    native_market(market),
                    OrderSide.BUY if normalized_side == "buy" else OrderSide.SELL,
                    native_price,
                    native_amount,
                    order_type=order_type,
                    settle_first=_optional_bool(options, "settleFirst", True),
                    collect_orders=True,
                )
            )
        )
        if not response.orders:
            raise O2AmbiguousSubmission(
                "O2 accepted create_order but returned no order. Reconcile orders and account "
                "nonce before retrying.",
                transaction_id=str(response.tx_id) if response.tx_id else None,
            )
        # Native create_order appends CreateOrder after its optional SettleBalance
        # action, so the collected create-order result is the final entry.
        parsed = parse_order(response.orders[-1], market)
        if normalized_type == "market":
            parsed["type"] = "market"
        if parsed["amount"] == 0 and amount > 0:
            parsed["amount"] = amount
            parsed["filled"] = 0.0
            parsed["remaining"] = amount
            parsed["cost"] = 0.0
        return parsed

    async def cancel_order(
        self, id: str, symbol: str | None = None, params: Params | None = None
    ) -> CCXTObject:
        del params
        if symbol is None:
            raise ArgumentsRequired("cancel_order requires symbol for O2")
        market = await self._resolve_market(symbol)
        raw = await self._read(lambda: self.o2_client.get_order(native_market(market), Id(id)))
        self._ensure_action_response(
            await self._submit(lambda: self.o2_client.cancel_order(Id(id), native_market(market)))
        )
        return parse_order(replace(raw, cancel=True, close=True), market)

    async def cancel_all_orders(
        self, symbol: str | None = None, params: Params | None = None
    ) -> list[CCXTObject]:
        del params
        if symbol is None:
            await self.load_markets()
        selected = [symbol] if symbol else list(self.symbols)
        canceled: list[CCXTObject] = []
        for market_symbol in selected:
            open_orders = await self.fetch_open_orders(market_symbol, limit=200)
            if not open_orders:
                continue

            async def cancel_selected(
                selected_symbol: str = market_symbol,
            ) -> list[ActionsResponse]:
                return await self.o2_client.cancel_all_orders(selected_symbol)

            responses = await self._submit(cancel_selected)
            for response in responses:
                self._ensure_action_response(response)
            canceled.extend({**order, "status": "canceled"} for order in open_orders)
        return canceled

    async def setup_account(self, signer: Signer | None = None) -> Any:
        owner = signer or self._require_signer()
        result = await self._submit(lambda: self.o2_client.setup_account(owner))
        self._trade_account_id = result.trade_account_id
        return result

    async def create_session(
        self,
        markets: list[str | Market],
        expiry_days: int = 30,
        signer: Signer | None = None,
        nonce_strategy: str = "sequential",
        nonce_session_id: int = 0,
    ) -> SessionInfo:
        owner = signer or self._require_signer()
        session = await self._submit(
            lambda: self.o2_client.create_session(
                owner,
                markets,
                expiry_days,
                nonce_strategy,
                nonce_session_id,
            )
        )
        self._trade_account_id = session.trade_account_id
        return session

    def restore_session(self, session: SessionInfo) -> None:
        self.o2_client.set_session(session)
        self._trade_account_id = session.trade_account_id

    async def settle_balance(
        self, market: str | Market, params: Params | None = None
    ) -> ActionsResponse:
        del params
        return self._ensure_action_response(
            await self._submit(lambda: self.o2_client.settle_balance(market))
        )

    async def withdraw(
        self,
        code: str,
        amount: float,
        address: str,
        tag: str | None = None,
        params: Params | None = None,
    ) -> CCXTObject:
        signer = (params or {}).get("signer") or self._require_signer()
        response = await self._submit(
            lambda: self.o2_client.withdraw(signer, code, amount, address)
        )
        now = self.milliseconds()
        transaction_id = str(response.tx_id) if response.tx_id else None
        return {
            "info": json_compatible(response),
            "id": transaction_id,
            "txid": transaction_id,
            "timestamp": now,
            "datetime": self.iso8601(now),
            "address": address,
            "addressFrom": None,
            "addressTo": address,
            "tag": tag,
            "tagFrom": None,
            "tagTo": tag,
            "type": "withdrawal",
            "amount": amount,
            "currency": code,
            "status": "pending",
            "updated": None,
            "fee": None,
            "network": None,
            "comment": None,
            "internal": False,
        }

    async def batch_actions(
        self,
        actions: Sequence[MarketActions | MarketActionGroup],
        collect_orders: bool = False,
        session: SessionInfo | None = None,
    ) -> ActionsResponse:
        return self._ensure_action_response(
            await self._submit(
                lambda: self.o2_client.batch_actions(actions, collect_orders, session)
            )
        )

    async def close(self) -> Any:
        await self.o2_client.close()
        return await super().close()

    async def _fetch_orders_by_status(
        self, symbol: str | None, since: int | None, limit: int, params: Params
    ) -> list[CCXTObject]:
        account = self._resolve_account_id()
        selected = (
            [await self._resolve_market(symbol)]
            if symbol
            else list((await self.load_markets()).values())
        )
        is_open = params.get("isOpen") if isinstance(params.get("isOpen"), bool) else None

        async def operation() -> list[CCXTObject]:
            parsed: list[CCXTObject] = []
            for market in selected:
                raw = await self.o2_client.get_orders(
                    native_market(market), account, is_open, limit
                )
                parsed.extend(parse_order(order, market) for order in raw)
            filtered = [
                order
                for order in parsed
                if since is None or (order["timestamp"] is not None and order["timestamp"] >= since)
            ]
            return sorted(filtered, key=lambda order: order["timestamp"] or 0)[-limit:]

        return await self._read(operation)

    async def _resolve_market(self, symbol: str) -> CCXTObject:
        markets = await self.load_markets()
        market = markets.get(symbol)
        if market is None:
            by_id = getattr(self, "markets_by_id", {}).get(symbol)
            market = by_id[0] if isinstance(by_id, list) and by_id else by_id
        if market is None:
            raise BadSymbol(f"Unknown O2 market: {symbol}")
        return cast(CCXTObject, market)

    def _resolve_account_id(self) -> Id:
        session = self.o2_client.session
        account = self._trade_account_id or (session.trade_account_id if session else None)
        if account is None:
            raise ArgumentsRequired(
                "A tradeAccountId or active O2 session is required for this private method"
            )
        return account

    def _require_signer(self) -> Signer:
        if self._owner_signer is None:
            raise AuthenticationError(
                "An O2 signer or privateKey is required for this lifecycle extension"
            )
        return self._owner_signer

    def _ensure_action_response(self, response: ActionsResponse) -> ActionsResponse:
        if response.code is not None:
            error_class = ERROR_CODE_MAP.get(response.code, O2Error)
            native = error_class(
                message=response.message or "O2 action rejected",
                code=response.code,
                reason=response.reason,
                receipts=response.receipts,
            )
            raise map_o2_error(native, "private_submission")
        # A reverted transaction can have a tx_id. ActionsResponse.success only
        # checks for that ID, so reason must take precedence over success here.
        if response.reason is not None:
            raise map_o2_error(
                OnChainRevert(
                    message=response.message or "O2 action reverted",
                    reason=response.reason,
                    receipts=response.receipts,
                ),
                "private_submission",
            )
        if not response.success:
            raise OperationFailed("O2 action failed without a transaction or structured error")
        return response

    async def _read(self, operation: Callable[[], Awaitable[T]]) -> T:
        try:
            return await operation()
        except Exception as error:
            raise map_o2_error(error, "read") from error

    async def _submit(self, operation: Callable[[], Awaitable[T]]) -> T:
        try:
            return await operation()
        except Exception as error:
            raise map_o2_error(error, "private_submission") from error


__all__ = ["O2CCXT"]
