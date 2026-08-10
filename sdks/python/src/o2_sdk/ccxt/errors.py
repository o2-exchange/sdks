"""Map native O2 failures to official CCXT exception categories."""

from __future__ import annotations

import asyncio
import re
from typing import Literal

import aiohttp
from ccxt.base.errors import (
    ArgumentsRequired,
    AuthenticationError,
    BadRequest,
    BadSymbol,
    BaseError,
    ExchangeError,
    InsufficientFunds,
    InvalidOrder,
    NetworkError,
    NotSupported,
    OperationFailed,
    OrderNotFound,
    RateLimitExceeded,
)

from o2_sdk.errors import (
    AccountNotFound,
    InvalidAmount,
    InvalidOrderParams,
    InvalidSession,
    InvalidSignature,
    MarketNotFound,
    OnChainRevert,
    SessionExpired,
)
from o2_sdk.errors import (
    OrderNotFound as O2OrderNotFound,
)
from o2_sdk.errors import (
    RateLimitExceeded as O2RateLimitExceeded,
)

ErrorContext = Literal["read", "private_submission"]


class O2AmbiguousSubmission(OperationFailed):
    """A private request may have landed, but its response was not received."""

    def __init__(
        self,
        message: str,
        *,
        original_error: object | None = None,
        transaction_id: str | None = None,
        nonce: str | None = None,
    ) -> None:
        super().__init__(message)
        self.original_error = original_error
        self.transaction_id = transaction_id
        self.nonce = nonce
        if isinstance(original_error, BaseException):
            self.__cause__ = original_error


def _with_original(error: BaseError, original: object) -> BaseError:
    error.original_error = original  # type: ignore[attr-defined]
    if isinstance(original, BaseException):
        error.__cause__ = original
    return error


def _exception_chain(error: object) -> list[BaseException]:
    if not isinstance(error, BaseException):
        return []
    chain: list[BaseException] = []
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def _is_network_failure(error: object) -> bool:
    for candidate in _exception_chain(error):
        if isinstance(
            candidate,
            (asyncio.TimeoutError, aiohttp.ClientError, ConnectionError, OSError),
        ):
            return True
        if re.search(
            r"network|fetch failed|socket|connect(?:ion|ed|ing)?|disconnect(?:ed|ion)?|"
            r"response (?:was )?lost|broken pipe|connection reset|dns|name resolution|"
            r"temporary failure|timed? ?out|timeout|remote host",
            str(candidate),
            re.IGNORECASE,
        ):
            return True
    return False


def _has_insufficient_funds(error: OnChainRevert) -> bool:
    text = f"{error.reason or ''} {error.raw_reason or ''} {error.message}"
    return bool(re.search(r"not.?enough.?balance|insufficient.?funds", text, re.IGNORECASE))


def _has_invalid_order(error: BaseException) -> bool:
    return bool(
        re.search(
            r"min_order|order value below|invalid (?:order|price|quantity)|"
            r"PricePrecision|FractionalPrice",
            str(error),
            re.IGNORECASE,
        )
    )


def map_o2_error(error: object, context: ErrorContext = "read") -> BaseError:
    """Return an official CCXT error while retaining the native failure."""
    if isinstance(error, BaseError):
        return error
    if context == "private_submission" and _is_network_failure(error):
        return O2AmbiguousSubmission(
            "O2 submission outcome is unknown. Reconcile orders and account nonce before retrying.",
            original_error=error,
        )
    if _is_network_failure(error):
        return _with_original(NetworkError("O2 network request failed"), error)
    if isinstance(error, (InvalidSession, InvalidSignature, SessionExpired, AccountNotFound)):
        return _with_original(AuthenticationError(str(error)), error)
    if isinstance(error, O2RateLimitExceeded):
        return _with_original(RateLimitExceeded(str(error)), error)
    if isinstance(error, MarketNotFound):
        return _with_original(BadSymbol(str(error)), error)
    if isinstance(error, O2OrderNotFound):
        return _with_original(OrderNotFound(str(error)), error)
    if isinstance(error, (InvalidOrderParams, InvalidAmount)):
        return _with_original(InvalidOrder(str(error)), error)
    if isinstance(error, OnChainRevert) and _has_insufficient_funds(error):
        return _with_original(InsufficientFunds(str(error)), error)
    if isinstance(error, OnChainRevert):
        return _with_original(InvalidOrder(str(error)), error)
    if isinstance(error, BaseException) and _has_invalid_order(error):
        return _with_original(InvalidOrder(str(error)), error)
    if isinstance(error, BaseException):
        return _with_original(ExchangeError(str(error)), error)
    return _with_original(ExchangeError("Unknown O2 error"), error)


__all__ = [
    "ArgumentsRequired",
    "AuthenticationError",
    "BadRequest",
    "BadSymbol",
    "BaseError",
    "ExchangeError",
    "InsufficientFunds",
    "InvalidOrder",
    "NetworkError",
    "NotSupported",
    "O2AmbiguousSubmission",
    "OperationFailed",
    "OrderNotFound",
    "RateLimitExceeded",
    "map_o2_error",
]
