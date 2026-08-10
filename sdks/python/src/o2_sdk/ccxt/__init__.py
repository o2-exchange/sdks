"""O2-maintained asynchronous CCXT public alpha.

Install the optional dependency with ``pip install 'o2-sdk[ccxt]'``.
"""

from .errors import (
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
    O2AmbiguousSubmission,
    OperationFailed,
    OrderNotFound,
    RateLimitExceeded,
    map_o2_error,
)
from .exchange import O2CCXT

__all__ = [
    "O2CCXT",
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
