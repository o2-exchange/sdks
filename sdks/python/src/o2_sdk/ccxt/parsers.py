"""CCXT normalization helpers shared with the TypeScript fixture contract."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from enum import Enum
from typing import Any

from o2_sdk.models import Balance, Bar, DepthSnapshot, Market, Order, Trade

from .types import CCXTObject

CCXT_TIMEFRAMES: dict[str, int] = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}


def json_compatible(value: Any) -> Any:
    """Convert native O2 models into JSON-compatible diagnostic payloads."""
    if is_dataclass(value) and not isinstance(value, type):
        return json_compatible(asdict(value))
    if isinstance(value, Enum):
        return json_compatible(value.value)
    if isinstance(value, Mapping):
        return {str(key): json_compatible(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_compatible(item) for item in value]
    if isinstance(value, bytes):
        return "0x" + value.hex()
    if isinstance(value, Decimal):
        return str(value)
    return value


def native_market(market: Mapping[str, Any]) -> Market:
    """Rebuild the native market used for exact scaling from CCXT ``info``."""
    info = market["info"]
    return info if isinstance(info, Market) else Market.from_dict(dict(info))


def number_or_none(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return float(parsed) if parsed.is_finite() else None


def timestamp_ms(value: object) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, str) and not value.isdigit():
        try:
            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return None
    if not isinstance(value, (int, float, str)):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed * 1000 if parsed < 1_000_000_000_000 else parsed


def _iso8601(timestamp: int | None) -> str | None:
    if timestamp is None:
        return None
    value = datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).isoformat(
        timespec="milliseconds"
    )
    return value.replace("+00:00", "Z")


def parse_market(market: Market) -> CCXTObject:
    return {
        "id": str(market.market_id),
        "symbol": market.pair,
        "base": market.base.symbol,
        "quote": market.quote.symbol,
        "baseId": market.base.asset,
        "quoteId": market.quote.asset,
        "type": "spot",
        "spot": True,
        "margin": False,
        "swap": False,
        "future": False,
        "option": False,
        "active": True,
        "contract": False,
        "maker": None,
        "taker": None,
        "percentage": True,
        "precision": {"amount": market.base.max_precision, "price": market.quote.max_precision},
        "limits": {
            "amount": {"min": None, "max": None},
            "price": {"min": None, "max": None},
            "cost": {
                "min": float(Decimal(market.min_order) / (Decimal(10) ** market.quote.decimals)),
                "max": None,
            },
        },
        "info": json_compatible(market),
    }


def parse_order_book(
    depth: DepthSnapshot, market: Mapping[str, Any], timestamp: int | None = None
) -> CCXTObject:
    native = native_market(market)
    return {
        "symbol": market["symbol"],
        "bids": [
            [native.format_price(int(level.price)), native.format_quantity(int(level.quantity))]
            for level in depth.bids
        ],
        "asks": [
            [native.format_price(int(level.price)), native.format_quantity(int(level.quantity))]
            for level in depth.asks
        ],
        "timestamp": timestamp,
        "datetime": _iso8601(timestamp),
        "nonce": None,
    }


def _opposite_side(side: str) -> str:
    return "sell" if side.lower() == "buy" else "buy"


def parse_trade(
    trade: Trade, market: Mapping[str, Any], account_relative: bool = False
) -> CCXTObject:
    native = native_market(market)
    timestamp = timestamp_ms(trade.timestamp) or 0
    price = native.format_price(int(trade.price))
    amount = native.format_quantity(int(trade.quantity))
    taker_or_maker: str | None = None
    if not account_relative:
        side: str | None = _opposite_side(trade.side)
    elif trade.trader_side == "both":
        side = None
    elif trade.trader_side == "maker":
        side = trade.side.lower()
        taker_or_maker = "maker"
    else:
        side = _opposite_side(trade.side)
        taker_or_maker = "taker" if trade.trader_side == "taker" else None
    return {
        "id": trade.trade_id,
        "timestamp": timestamp,
        "datetime": _iso8601(timestamp),
        "symbol": market["symbol"],
        "order": None,
        "type": None,
        "side": side,
        "takerOrMaker": taker_or_maker,
        "price": price,
        "amount": amount,
        "cost": price * amount,
        "fee": None,
        "info": json_compatible(trade),
    }


def parse_ticker(
    ticker: Mapping[str, Any], market: Mapping[str, Any], timestamp: int
) -> CCXTObject:
    last = number_or_none(ticker.get("last_price"))
    return {
        "symbol": market["symbol"],
        "timestamp": timestamp,
        "datetime": _iso8601(timestamp),
        "high": None,
        "low": None,
        "bid": number_or_none(ticker.get("best_bid")),
        "bidVolume": None,
        "ask": number_or_none(ticker.get("best_ask")),
        "askVolume": None,
        "vwap": None,
        "open": None,
        "close": last,
        "last": last,
        "previousClose": None,
        "change": None,
        "percentage": None,
        "average": None,
        "baseVolume": number_or_none(ticker.get("base_volume")),
        "quoteVolume": number_or_none(ticker.get("quote_volume")),
        "info": json_compatible(ticker),
    }


def parse_ohlcv(bar: Bar) -> list[float | int]:
    return [
        timestamp_ms(bar.time) or 0,
        float(bar.open),
        float(bar.high),
        float(bar.low),
        float(bar.close),
        float(bar.volume),
    ]


def parse_balance(balances: Mapping[str, Balance], decimals: Mapping[str, int]) -> CCXTObject:
    result: CCXTObject = {
        "free": {},
        "used": {},
        "total": {},
        "info": json_compatible(balances),
    }
    for currency, balance in balances.items():
        scale = Decimal(10) ** decimals.get(currency, 0)
        free = float(Decimal(balance.total_unlocked) / scale)
        used = float(Decimal(balance.total_locked) / scale)
        total = free + used
        result["free"][currency] = free
        result["used"][currency] = used
        result["total"][currency] = total
        result[currency] = {"free": free, "used": used, "total": total}
    return result


def _order_type_info(value: object) -> tuple[str, str | None, bool]:
    label = next(iter(value), "Spot") if isinstance(value, dict) else getattr(value, "value", value)
    if label in ("Market", "BoundedMarket"):
        return "market", None, False
    if label == "FillOrKill":
        return "limit", "FOK", False
    if label == "PostOnly":
        return "limit", "PO", True
    return "limit", "GTC", False


def parse_order(order: Order, market: Mapping[str, Any]) -> CCXTObject:
    native = native_market(market)
    timestamp = timestamp_ms(order.timestamp)
    amount = native.format_quantity(int(order.quantity))
    filled = native.format_quantity(int(order.quantity_fill or "0"))
    price = native.format_price(int(order.price))
    average = native.format_price(int(order.price_fill)) if int(order.price_fill or "0") else None
    order_type, time_in_force, post_only = _order_type_info(order.order_type)
    status = "canceled" if order.cancel else "closed" if order.close else "open"
    return {
        "id": str(order.order_id),
        "clientOrderId": None,
        "timestamp": timestamp,
        "datetime": _iso8601(timestamp),
        "lastTradeTimestamp": None,
        "lastUpdateTimestamp": None,
        "symbol": market["symbol"],
        "type": order_type,
        "timeInForce": time_in_force,
        "postOnly": post_only,
        "reduceOnly": False,
        "side": order.side.lower(),
        "price": price,
        "triggerPrice": None,
        "amount": amount,
        "cost": (average if average is not None else price) * filled,
        "average": average,
        "filled": filled,
        "remaining": max(0.0, amount - filled),
        "status": status,
        "fee": None,
        "trades": None,
        "info": json_compatible(order),
    }
