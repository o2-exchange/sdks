"""Error types for the O2 Exchange SDK.

Maps all error codes from Section 8 of the O2 integration guide.
Handles two distinct error formats for POST /v1/session/actions:
  - Pre-flight validation error (has `code` field)
  - On-chain revert error (has `message` + `reason`, NO `code` field)
"""

from __future__ import annotations

from typing import Any, Optional


class O2Error(Exception):
    """Base error for all O2 Exchange API errors."""

    def __init__(
        self,
        message: str,
        code: Optional[int] = None,
        reason: Optional[str] = None,
        receipts: Optional[list] = None,
    ):
        self.message = message
        self.code = code
        self.reason = reason
        self.receipts = receipts
        super().__init__(message)


# General errors (1xxx)
class InternalError(O2Error):
    """1000: Unexpected server error."""
    pass


class InvalidRequest(O2Error):
    """1001: Malformed or invalid request."""
    pass


class ParseError(O2Error):
    """1002: Failed to parse request body."""
    pass


class RateLimitExceeded(O2Error):
    """1003: Too many requests."""
    pass


class GeoRestricted(O2Error):
    """1004: Region not allowed."""
    pass


# Market errors (2xxx)
class MarketNotFound(O2Error):
    """2000: Market does not exist."""
    pass


class MarketPaused(O2Error):
    """2001: Market is currently paused."""
    pass


class MarketAlreadyExists(O2Error):
    """2002: Market already exists."""
    pass


# Order errors (3xxx)
class OrderNotFound(O2Error):
    """3000: Order does not exist."""
    pass


class OrderNotActive(O2Error):
    """3001: Order is not in active state."""
    pass


class InvalidOrderParams(O2Error):
    """3002: Invalid order parameters."""
    pass


# Account/Session errors (4xxx)
class InvalidSignature(O2Error):
    """4000: Signature verification failed."""
    pass


class InvalidSession(O2Error):
    """4001: Session is invalid or expired."""
    pass


class AccountNotFound(O2Error):
    """4002: Trading account not found."""
    pass


class WhitelistNotConfigured(O2Error):
    """4003: Whitelist not configured."""
    pass


# Trade errors (5xxx)
class TradeNotFound(O2Error):
    """5000: Trade does not exist."""
    pass


class InvalidTradeCount(O2Error):
    """5001: Invalid trade count."""
    pass


# WebSocket/Subscription errors (6xxx)
class AlreadySubscribed(O2Error):
    """6000: Already subscribed to this topic."""
    pass


class TooManySubscriptions(O2Error):
    """6001: Subscription limit exceeded."""
    pass


class SubscriptionError(O2Error):
    """6002: General subscription error."""
    pass


# Validation errors (7xxx)
class InvalidAmount(O2Error):
    """7000: Invalid amount specified."""
    pass


class InvalidTimeRange(O2Error):
    """7001: Invalid time range."""
    pass


class InvalidPagination(O2Error):
    """7002: Invalid pagination params."""
    pass


class NoActionsProvided(O2Error):
    """7003: No actions in request."""
    pass


class TooManyActions(O2Error):
    """7004: Too many actions (max 5)."""
    pass


# Block/Events errors (8xxx)
class BlockNotFound(O2Error):
    """8000: Block not found."""
    pass


class EventsNotFound(O2Error):
    """8001: Events not found for block."""
    pass


# On-chain revert error (no code, has message + reason)
class OnChainRevert(O2Error):
    """On-chain transaction revert (no error code)."""
    pass


ERROR_CODE_MAP: dict[int, type[O2Error]] = {
    1000: InternalError,
    1001: InvalidRequest,
    1002: ParseError,
    1003: RateLimitExceeded,
    1004: GeoRestricted,
    2000: MarketNotFound,
    2001: MarketPaused,
    2002: MarketAlreadyExists,
    3000: OrderNotFound,
    3001: OrderNotActive,
    3002: InvalidOrderParams,
    4000: InvalidSignature,
    4001: InvalidSession,
    4002: AccountNotFound,
    4003: WhitelistNotConfigured,
    5000: TradeNotFound,
    5001: InvalidTradeCount,
    6000: AlreadySubscribed,
    6001: TooManySubscriptions,
    6002: SubscriptionError,
    7000: InvalidAmount,
    7001: InvalidTimeRange,
    7002: InvalidPagination,
    7003: NoActionsProvided,
    7004: TooManyActions,
    8000: BlockNotFound,
    8001: EventsNotFound,
}


def raise_for_error(data: dict[str, Any]) -> None:
    """Raise an appropriate O2Error if the response contains an error.

    Handles both pre-flight validation errors (with `code`) and
    on-chain revert errors (with `message` + `reason`, no `code`).

    Success is indicated by the presence of `tx_id` in the response.
    """
    # Success case
    if "tx_id" in data:
        return

    code = data.get("code")
    message = data.get("message", "Unknown error")
    reason = data.get("reason")
    receipts = data.get("receipts")

    if code is not None:
        error_cls = ERROR_CODE_MAP.get(code, O2Error)
        raise error_cls(message=message, code=code, reason=reason, receipts=receipts)

    if "message" in data:
        raise OnChainRevert(
            message=message, reason=reason, receipts=receipts
        )
