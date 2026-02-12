"""Data models for the O2 Exchange SDK.

All API request/response types as dataclasses with JSON parsing helpers.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

# ---------------------------------------------------------------------------
# Scalar wrappers
# ---------------------------------------------------------------------------


_HEX_CHARS = frozenset("0123456789abcdefABCDEF")


class Id(str):
    """Identifier that always displays with a ``0x`` prefix.

    The API returns hex identifiers inconsistently — sometimes with the
    ``0x`` prefix and sometimes without.  ``Id`` normalises the value on
    construction so that ``str(id)`` always starts with ``0x``.

    Raises :class:`ValueError` if the value contains non-hex characters
    or is empty.

    >>> Id("97edbbf5")
    Id('0x97edbbf5')
    >>> Id("0x97edbbf5")
    Id('0x97edbbf5')
    """

    def __new__(cls, value: str) -> Id:
        raw = value[2:] if value.lower().startswith("0x") else value
        if not raw or not _HEX_CHARS.issuperset(raw):
            raise ValueError(f"Id requires a non-empty hex string, got {value!r}")
        return super().__new__(cls, f"0x{raw}".lower())

    def __eq__(self, other: object) -> bool:
        if isinstance(other, str):
            normalized = other if other.lower().startswith("0x") else f"0x{other}"
            return super().__eq__(normalized.lower())
        return NotImplemented

    # This will return True on case-insensitive comparison, that is by design.
    # Id("abc") == "0xABC"
    # This is to account for EIP-55 encoded addresses.
    def __hash__(self) -> int:
        return super().__hash__()

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"Id({super().__repr__()})"


def _parse_id(raw: str | None) -> Id | None:
    """Convert an optional raw string to an :class:`Id`, or ``None``."""
    return Id(raw) if raw is not None else None


# ---------------------------------------------------------------------------
# Market models
# ---------------------------------------------------------------------------


@dataclass
class MarketAsset:
    symbol: str
    asset: str
    decimals: int
    max_precision: int

    @classmethod
    def from_dict(cls, d: dict) -> MarketAsset:
        return cls(
            symbol=d["symbol"],
            asset=d["asset"],
            decimals=int(d["decimals"]),
            max_precision=int(d["max_precision"]),
        )


@dataclass
class Market:
    contract_id: Id
    market_id: Id
    maker_fee: str
    taker_fee: str
    min_order: str
    dust: str
    price_window: int
    base: MarketAsset
    quote: MarketAsset

    @classmethod
    def from_dict(cls, d: dict) -> Market:
        return cls(
            contract_id=Id(d["contract_id"]),
            market_id=Id(d["market_id"]),
            maker_fee=d.get("maker_fee", "0"),
            taker_fee=d.get("taker_fee", "0"),
            min_order=d.get("min_order", "0"),
            dust=d.get("dust", "0"),
            price_window=int(d.get("price_window", 0)),
            base=MarketAsset.from_dict(d["base"]),
            quote=MarketAsset.from_dict(d["quote"]),
        )

    @property
    def pair(self) -> str:
        return f"{self.base.symbol}/{self.quote.symbol}"

    def format_price(self, chain_value: int) -> float:
        """Convert chain integer price to human-readable float."""
        return float(chain_value / (10**self.quote.decimals))

    def scale_price(self, human_value: float) -> int:
        """Convert human-readable price to chain integer, truncated to max_precision."""
        scaled = int(human_value * (10**self.quote.decimals))
        truncate_factor = 10 ** (self.quote.decimals - self.quote.max_precision)
        return int((scaled // truncate_factor) * truncate_factor)

    def format_quantity(self, chain_value: int) -> float:
        """Convert chain integer quantity to human-readable float."""
        return float(chain_value / (10**self.base.decimals))

    def scale_quantity(self, human_value: float) -> int:
        """Convert human-readable quantity to chain integer, truncated to max_precision."""
        scaled = int(human_value * (10**self.base.decimals))
        truncate_factor = 10 ** (self.base.decimals - self.base.max_precision)
        return int((scaled // truncate_factor) * truncate_factor)

    def validate_order(self, price: int, quantity: int) -> None:
        """Validate price/quantity against on-chain constraints.

        Raises ValueError if constraints are violated.
        """
        base_decimals = self.base.decimals
        min_order = int(self.min_order)

        # PricePrecision: price must be a multiple of truncate_factor
        price_trunc = 10 ** (self.quote.decimals - self.quote.max_precision)
        if price % price_trunc != 0:
            raise ValueError(f"PricePrecision: price {price} must be a multiple of {price_trunc}")

        # FractionalPrice: (price * quantity) % 10^base_decimals must equal 0
        quote_value = price * quantity
        if quote_value % (10**base_decimals) != 0:
            raise ValueError(
                f"FractionalPrice: (price * quantity) = {quote_value} "
                f"must be divisible by 10^{base_decimals}"
            )

        # min_order: (price * quantity) / 10^base_decimals >= min_order
        forwarded = quote_value // (10**base_decimals)
        if forwarded < min_order:
            raise ValueError(f"min_order: forwarded amount {forwarded} < min_order {min_order}")

    def adjust_quantity(self, price: int, quantity: int) -> int:
        """Adjust quantity to satisfy FractionalPrice constraint.

        Returns the largest quantity <= the input that satisfies
        (price * quantity) % 10^base_decimals == 0.
        """
        base_factor = 10**self.base.decimals
        remainder = (price * quantity) % base_factor
        if remainder == 0:
            return quantity
        return int(quantity - math.ceil(remainder / price))


_ZERO_ID = "0" * 64


@dataclass
class MarketsResponse:
    books_registry_id: Id
    accounts_registry_id: Id
    trade_account_oracle_id: Id
    chain_id: str
    base_asset_id: Id
    markets: list[Market]

    @classmethod
    def from_dict(cls, d: dict) -> MarketsResponse:
        return cls(
            books_registry_id=Id(d.get("books_registry_id") or _ZERO_ID),
            accounts_registry_id=Id(d.get("accounts_registry_id") or _ZERO_ID),
            trade_account_oracle_id=Id(d.get("trade_account_oracle_id") or _ZERO_ID),
            chain_id=d.get("chain_id", "0x0000000000000000"),
            base_asset_id=Id(d.get("base_asset_id") or _ZERO_ID),
            markets=[Market.from_dict(m) for m in d.get("markets", [])],
        )

    @property
    def chain_id_int(self) -> int:
        if self.chain_id.lower().startswith("0x"):
            return int(self.chain_id, 16)
        return int(self.chain_id)


# ---------------------------------------------------------------------------
# Account models
# ---------------------------------------------------------------------------


@dataclass
class Identity:
    variant: str  # "Address" or "ContractId"
    value: str  # 0x-prefixed hex

    def to_dict(self) -> dict:
        return {self.variant: self.value}

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"Identity({self.variant}={self.value})"

    @classmethod
    def from_dict(cls, d: dict) -> Identity:
        if "Address" in d:
            return cls(variant="Address", value=d["Address"])
        elif "ContractId" in d:
            return cls(variant="ContractId", value=d["ContractId"])
        raise ValueError(f"Unknown identity format: {d}")

    @property
    def address_bytes(self) -> bytes:
        return bytes.fromhex(self.value[2:])

    @property
    def discriminant(self) -> int:
        return 0 if self.variant == "Address" else 1


@dataclass
class TradeAccount:
    last_modification: int
    nonce: str
    owner: Identity
    synced_with_network: bool | None = None

    @classmethod
    def from_dict(cls, d: dict) -> TradeAccount:
        return cls(
            last_modification=int(d.get("last_modification", 0)),
            nonce=str(d.get("nonce", "0")),
            owner=Identity.from_dict(d["owner"]),
            synced_with_network=d.get("synced_with_network"),
        )


@dataclass
class AccountInfo:
    trade_account_id: Id | None
    trade_account: TradeAccount | None
    session: dict | None = None

    @classmethod
    def from_dict(cls, d: dict) -> AccountInfo:
        ta = d.get("trade_account")
        return cls(
            trade_account_id=_parse_id(d.get("trade_account_id")),
            trade_account=TradeAccount.from_dict(ta) if ta else None,
            session=d.get("session"),
        )

    @property
    def exists(self) -> bool:
        return self.trade_account_id is not None

    @property
    def nonce(self) -> int:
        if self.trade_account is None:
            return 0
        return int(self.trade_account.nonce)


@dataclass
class AccountCreateResponse:
    trade_account_id: Id
    nonce: str

    @classmethod
    def from_dict(cls, d: dict) -> AccountCreateResponse:
        return cls(
            trade_account_id=Id(d["trade_account_id"]),
            nonce=d.get("nonce", "0x0"),
        )


# ---------------------------------------------------------------------------
# Session models
# ---------------------------------------------------------------------------


@dataclass
class SessionInfo:
    session_id: Identity
    trade_account_id: Id
    contract_ids: list[Id]
    session_expiry: str
    session_private_key: bytes | None = None
    owner_address: str | None = None
    nonce: int = 0

    @classmethod
    def from_response(cls, d: dict, **kwargs: Any) -> SessionInfo:
        return cls(
            session_id=Identity.from_dict(d["session_id"]),
            trade_account_id=Id(d["trade_account_id"]),
            contract_ids=[Id(c) for c in d.get("contract_ids", [])],
            session_expiry=d.get("session_expiry", ""),
            **kwargs,
        )


@dataclass
class SessionResponse:
    tx_id: Id
    trade_account_id: Id
    contract_ids: list[Id]
    session_id: Identity
    session_expiry: str

    @classmethod
    def from_dict(cls, d: dict) -> SessionResponse:
        return cls(
            tx_id=Id(d["tx_id"]),
            trade_account_id=Id(d["trade_account_id"]),
            contract_ids=[Id(c) for c in d.get("contract_ids", [])],
            session_id=Identity.from_dict(d["session_id"]),
            session_expiry=d.get("session_expiry", ""),
        )


# ---------------------------------------------------------------------------
# Order models
# ---------------------------------------------------------------------------


@dataclass
class Order:
    order_id: Id
    side: str
    order_type: Any
    quantity: str
    quantity_fill: str
    price: str
    price_fill: str
    timestamp: str
    close: bool
    partially_filled: bool
    cancel: bool
    account: Identity | None = None
    desired_quantity: str | None = None
    fill: dict | None = None
    order_tx_history: list | None = None
    base_decimals: int | None = None
    market_id: Id | None = None
    owner: Identity | None = None
    history: list | None = None
    fills: list | None = None

    @classmethod
    def from_dict(cls, d: dict) -> Order:
        account = None
        if d.get("account"):
            account = Identity.from_dict(d["account"])
        owner = None
        if d.get("owner"):
            owner = Identity.from_dict(d["owner"])
        return cls(
            order_id=Id(d["order_id"]),
            side=d.get("side", ""),
            order_type=d.get("order_type", ""),
            quantity=str(d.get("quantity", "0")),
            quantity_fill=str(d.get("quantity_fill", "0")),
            price=str(d.get("price", "0")),
            price_fill=str(d.get("price_fill", "0")),
            timestamp=str(d.get("timestamp", "0")),
            close=d.get("close", False),
            partially_filled=d.get("partially_filled", False),
            cancel=d.get("cancel", False),
            account=account,
            desired_quantity=d.get("desired_quantity"),
            fill=d.get("fill"),
            order_tx_history=d.get("order_tx_history"),
            base_decimals=d.get("base_decimals"),
            market_id=_parse_id(d.get("market_id")),
            owner=owner,
            history=d.get("history"),
            fills=d.get("fills"),
        )

    @property
    def is_open(self) -> bool:
        return not self.close


@dataclass
class OrdersResponse:
    identity: Identity | None
    market_id: Id
    orders: list[Order]

    @classmethod
    def from_dict(cls, d: dict) -> OrdersResponse:
        identity = None
        if d.get("identity"):
            identity = Identity.from_dict(d["identity"])
        return cls(
            identity=identity,
            market_id=Id(d.get("market_id", "")),
            orders=[Order.from_dict(o) for o in d.get("orders", [])],
        )


# ---------------------------------------------------------------------------
# Trade models
# ---------------------------------------------------------------------------


@dataclass
class Trade:
    trade_id: Id
    side: str
    total: str
    quantity: str
    price: str
    timestamp: str
    maker: Identity | None = None
    taker: Identity | None = None
    market_id: Id | None = None

    @classmethod
    def from_dict(cls, d: dict) -> Trade:
        maker = Identity.from_dict(d["maker"]) if d.get("maker") else None
        taker = Identity.from_dict(d["taker"]) if d.get("taker") else None
        return cls(
            trade_id=Id(str(d.get("trade_id", ""))),
            side=d.get("side", ""),
            total=str(d.get("total", "0")),
            quantity=str(d.get("quantity", "0")),
            price=str(d.get("price", "0")),
            timestamp=str(d.get("timestamp", "0")),
            maker=maker,
            taker=taker,
            market_id=_parse_id(d.get("market_id")),
        )


# ---------------------------------------------------------------------------
# Balance models
# ---------------------------------------------------------------------------


@dataclass
class OrderBookBalance:
    locked: str
    unlocked: str

    @classmethod
    def from_dict(cls, d: dict) -> OrderBookBalance:
        return cls(locked=d.get("locked", "0"), unlocked=d.get("unlocked", "0"))


@dataclass
class Balance:
    order_books: dict[str, OrderBookBalance]
    total_locked: str
    total_unlocked: str
    trading_account_balance: str

    @classmethod
    def from_dict(cls, d: dict) -> Balance:
        obs = {}
        for k, v in d.get("order_books", {}).items():
            obs[k] = OrderBookBalance.from_dict(v)
        return cls(
            order_books=obs,
            total_locked=d.get("total_locked", "0"),
            total_unlocked=d.get("total_unlocked", "0"),
            trading_account_balance=d.get("trading_account_balance", "0"),
        )

    @property
    def available(self) -> int:
        """Total available balance for trading (trading_account_balance)."""
        return int(self.trading_account_balance)


# ---------------------------------------------------------------------------
# Depth models
# ---------------------------------------------------------------------------


@dataclass
class DepthLevel:
    price: str
    quantity: str

    @classmethod
    def from_dict(cls, d: dict) -> DepthLevel:
        return cls(price=d["price"], quantity=d["quantity"])


@dataclass
class DepthSnapshot:
    buys: list[DepthLevel]
    sells: list[DepthLevel]
    market_id: Id | None = None

    @classmethod
    def from_dict(cls, d: dict) -> DepthSnapshot:
        view = d.get("orders", d.get("view", d))
        return cls(
            buys=[DepthLevel.from_dict(x) for x in view.get("buys", [])],
            sells=[DepthLevel.from_dict(x) for x in view.get("sells", [])],
            market_id=_parse_id(d.get("market_id")),
        )

    @property
    def best_bid(self) -> DepthLevel | None:
        return self.buys[0] if self.buys else None

    @property
    def best_ask(self) -> DepthLevel | None:
        return self.sells[0] if self.sells else None


@dataclass
class DepthUpdate:
    changes: DepthSnapshot
    market_id: Id
    onchain_timestamp: str | None = None
    seen_timestamp: str | None = None
    is_snapshot: bool = False

    @classmethod
    def from_dict(cls, d: dict) -> DepthUpdate:
        action = d.get("action", "")
        is_snapshot = action == "subscribe_depth"
        if is_snapshot:
            changes = DepthSnapshot.from_dict(d)
        else:
            changes_data = d.get("changes", {})
            changes = DepthSnapshot(
                buys=[DepthLevel.from_dict(x) for x in changes_data.get("buys", [])],
                sells=[DepthLevel.from_dict(x) for x in changes_data.get("sells", [])],
            )
        return cls(
            changes=changes,
            market_id=Id(d.get("market_id", "")),
            onchain_timestamp=d.get("onchain_timestamp"),
            seen_timestamp=d.get("seen_timestamp"),
            is_snapshot=is_snapshot,
        )


# ---------------------------------------------------------------------------
# Bar / Candle models
# ---------------------------------------------------------------------------


@dataclass
class Bar:
    time: int
    open: str
    high: str
    low: str
    close: str
    volume: str

    @classmethod
    def from_dict(cls, d: dict) -> Bar:
        return cls(
            time=int(d.get("time", 0)),
            open=str(d.get("open", "0")),
            high=str(d.get("high", "0")),
            low=str(d.get("low", "0")),
            close=str(d.get("close", "0")),
            volume=str(d.get("volume", "0")),
        )


# ---------------------------------------------------------------------------
# Action request models
# ---------------------------------------------------------------------------


@dataclass
class ActionsResponse:
    tx_id: Id | None = None
    orders: list[Order] | None = None
    message: str | None = None
    reason: str | None = None
    receipts: list | None = None
    code: int | None = None

    @classmethod
    def from_dict(cls, d: dict) -> ActionsResponse:
        orders = None
        if d.get("orders"):
            orders = [Order.from_dict(o) for o in d["orders"]]
        return cls(
            tx_id=_parse_id(d.get("tx_id")),
            orders=orders,
            message=d.get("message"),
            reason=d.get("reason"),
            receipts=d.get("receipts"),
            code=d.get("code"),
        )

    @property
    def success(self) -> bool:
        return self.tx_id is not None


# ---------------------------------------------------------------------------
# Aggregated models
# ---------------------------------------------------------------------------


@dataclass
class AggregatedAsset:
    id: Id
    symbol: str
    name: str

    @classmethod
    def from_dict(cls, d: dict) -> AggregatedAsset:
        return cls(
            id=Id(d.get("id", "")),
            symbol=d.get("symbol", ""),
            name=d.get("name", ""),
        )


@dataclass
class MarketSummary:
    market_id: Id
    data: dict

    @classmethod
    def from_dict(cls, d: dict) -> MarketSummary:
        return cls(market_id=Id(d.get("market_id", "")), data=d)


@dataclass
class MarketTicker:
    market_id: Id
    data: dict

    @classmethod
    def from_dict(cls, d: dict) -> MarketTicker:
        return cls(market_id=Id(d.get("market_id", "")), data=d)


# ---------------------------------------------------------------------------
# WebSocket subscription models
# ---------------------------------------------------------------------------


@dataclass
class OrderUpdate:
    orders: list[Order]
    onchain_timestamp: str | None = None
    seen_timestamp: str | None = None

    @classmethod
    def from_dict(cls, d: dict) -> OrderUpdate:
        return cls(
            orders=[Order.from_dict(o) for o in d.get("orders", [])],
            onchain_timestamp=d.get("onchain_timestamp"),
            seen_timestamp=d.get("seen_timestamp"),
        )


@dataclass
class TradeUpdate:
    trades: list[Trade]
    market_id: Id
    onchain_timestamp: str | None = None
    seen_timestamp: str | None = None

    @classmethod
    def from_dict(cls, d: dict) -> TradeUpdate:
        return cls(
            trades=[Trade.from_dict(t) for t in d.get("trades", [])],
            market_id=Id(d.get("market_id", "")),
            onchain_timestamp=d.get("onchain_timestamp"),
            seen_timestamp=d.get("seen_timestamp"),
        )


@dataclass
class BalanceUpdate:
    balance: list[dict]
    onchain_timestamp: str | None = None
    seen_timestamp: str | None = None

    @classmethod
    def from_dict(cls, d: dict) -> BalanceUpdate:
        return cls(
            balance=d.get("balance", []),
            onchain_timestamp=d.get("onchain_timestamp"),
            seen_timestamp=d.get("seen_timestamp"),
        )


@dataclass
class NonceUpdate:
    contract_id: Id
    nonce: str
    onchain_timestamp: str | None = None
    seen_timestamp: str | None = None

    @classmethod
    def from_dict(cls, d: dict) -> NonceUpdate:
        return cls(
            contract_id=Id(d.get("contract_id", "")),
            nonce=d.get("nonce", "0"),
            onchain_timestamp=d.get("onchain_timestamp"),
            seen_timestamp=d.get("seen_timestamp"),
        )


# ---------------------------------------------------------------------------
# Withdraw models
# ---------------------------------------------------------------------------


@dataclass
class WithdrawResponse:
    tx_id: Id | None = None
    message: str | None = None

    @classmethod
    def from_dict(cls, d: dict) -> WithdrawResponse:
        return cls(tx_id=_parse_id(d.get("tx_id")), message=d.get("message"))

    @property
    def success(self) -> bool:
        return self.tx_id is not None


# ---------------------------------------------------------------------------
# Whitelist models
# ---------------------------------------------------------------------------


@dataclass
class WhitelistResponse:
    success: bool
    trade_account: str
    already_whitelisted: bool = False

    @classmethod
    def from_dict(cls, d: dict) -> WhitelistResponse:
        return cls(
            success=d.get("success", False),
            trade_account=d.get("tradeAccount", ""),
            already_whitelisted=d.get("alreadyWhitelisted", False),
        )


@dataclass
class ReferralInfo:
    valid: bool
    owner_address: str | None = None
    is_active: bool | None = None

    @classmethod
    def from_dict(cls, d: dict) -> ReferralInfo:
        return cls(
            valid=d.get("valid", False),
            owner_address=d.get("ownerAddress"),
            is_active=d.get("isActive"),
        )


@dataclass
class FaucetResponse:
    message: str | None = None
    error: str | None = None

    @classmethod
    def from_dict(cls, d: dict) -> FaucetResponse:
        return cls(message=d.get("message"), error=d.get("error"))

    @property
    def success(self) -> bool:
        return self.error is None and self.message is not None
