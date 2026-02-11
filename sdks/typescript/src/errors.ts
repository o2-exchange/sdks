/**
 * Error types mapping all O2 Exchange error codes.
 *
 * Handles two distinct error formats for POST /v1/session/actions:
 * - Pre-flight validation error (has `code` field)
 * - On-chain revert error (has `message` + `reason` + `receipts`, NO `code` field)
 *
 * Success detection: check for `tx_id` in response.
 */

export class O2Error extends Error {
  readonly code: number | undefined;
  readonly reason: string | undefined;
  readonly receipts: unknown[] | undefined;

  constructor(message: string, code?: number, reason?: string, receipts?: unknown[]) {
    super(message);
    this.name = "O2Error";
    this.code = code;
    this.reason = reason;
    this.receipts = receipts;
  }
}

// ── General (1xxx) ──────────────────────────────────────────────────

export class InternalError extends O2Error {
  constructor(message = "Unexpected server error") {
    super(message, 1000);
    this.name = "InternalError";
  }
}

export class InvalidRequest extends O2Error {
  constructor(message = "Malformed or invalid request") {
    super(message, 1001);
    this.name = "InvalidRequest";
  }
}

export class ParseError extends O2Error {
  constructor(message = "Failed to parse request body") {
    super(message, 1002);
    this.name = "ParseError";
  }
}

export class RateLimitExceeded extends O2Error {
  constructor(message = "Too many requests") {
    super(message, 1003);
    this.name = "RateLimitExceeded";
  }
}

export class GeoRestricted extends O2Error {
  constructor(message = "Region not allowed") {
    super(message, 1004);
    this.name = "GeoRestricted";
  }
}

// ── Market (2xxx) ───────────────────────────────────────────────────

export class MarketNotFound extends O2Error {
  constructor(message = "Market not found") {
    super(message, 2000);
    this.name = "MarketNotFound";
  }
}

export class MarketPaused extends O2Error {
  constructor(message = "Market is currently paused") {
    super(message, 2001);
    this.name = "MarketPaused";
  }
}

export class MarketAlreadyExists extends O2Error {
  constructor(message = "Market already exists") {
    super(message, 2002);
    this.name = "MarketAlreadyExists";
  }
}

// ── Order (3xxx) ────────────────────────────────────────────────────

export class OrderNotFound extends O2Error {
  constructor(message = "Order not found") {
    super(message, 3000);
    this.name = "OrderNotFound";
  }
}

export class OrderNotActive extends O2Error {
  constructor(message = "Order is not in active state") {
    super(message, 3001);
    this.name = "OrderNotActive";
  }
}

export class InvalidOrderParams extends O2Error {
  constructor(message = "Invalid order parameters") {
    super(message, 3002);
    this.name = "InvalidOrderParams";
  }
}

// ── Account/Session (4xxx) ──────────────────────────────────────────

export class InvalidSignature extends O2Error {
  constructor(message = "Signature verification failed") {
    super(message, 4000);
    this.name = "InvalidSignature";
  }
}

export class InvalidSession extends O2Error {
  constructor(message = "Session is invalid or expired") {
    super(message, 4001);
    this.name = "InvalidSession";
  }
}

export class AccountNotFound extends O2Error {
  constructor(message = "Trading account not found") {
    super(message, 4002);
    this.name = "AccountNotFound";
  }
}

export class WhitelistNotConfigured extends O2Error {
  constructor(message = "Whitelist not configured") {
    super(message, 4003);
    this.name = "WhitelistNotConfigured";
  }
}

// ── Trade (5xxx) ────────────────────────────────────────────────────

export class TradeNotFound extends O2Error {
  constructor(message = "Trade not found") {
    super(message, 5000);
    this.name = "TradeNotFound";
  }
}

export class InvalidTradeCount extends O2Error {
  constructor(message = "Invalid trade count") {
    super(message, 5001);
    this.name = "InvalidTradeCount";
  }
}

// ── Subscription/WebSocket (6xxx) ───────────────────────────────────

export class AlreadySubscribed extends O2Error {
  constructor(message = "Already subscribed to this topic") {
    super(message, 6000);
    this.name = "AlreadySubscribed";
  }
}

export class TooManySubscriptions extends O2Error {
  constructor(message = "Subscription limit exceeded") {
    super(message, 6001);
    this.name = "TooManySubscriptions";
  }
}

export class SubscriptionError extends O2Error {
  constructor(message = "General subscription error") {
    super(message, 6002);
    this.name = "SubscriptionError";
  }
}

// ── Validation (7xxx) ───────────────────────────────────────────────

export class InvalidAmount extends O2Error {
  constructor(message = "Invalid amount specified") {
    super(message, 7000);
    this.name = "InvalidAmount";
  }
}

export class InvalidTimeRange extends O2Error {
  constructor(message = "Invalid time range") {
    super(message, 7001);
    this.name = "InvalidTimeRange";
  }
}

export class InvalidPagination extends O2Error {
  constructor(message = "Invalid pagination params") {
    super(message, 7002);
    this.name = "InvalidPagination";
  }
}

export class NoActionsProvided extends O2Error {
  constructor(message = "No actions in request") {
    super(message, 7003);
    this.name = "NoActionsProvided";
  }
}

export class TooManyActions extends O2Error {
  constructor(message = "Too many actions (max 5)") {
    super(message, 7004);
    this.name = "TooManyActions";
  }
}

// ── Block/Events (8xxx) ─────────────────────────────────────────────

export class BlockNotFound extends O2Error {
  constructor(message = "Block not found") {
    super(message, 8000);
    this.name = "BlockNotFound";
  }
}

export class EventsNotFound extends O2Error {
  constructor(message = "Events not found for block") {
    super(message, 8001);
    this.name = "EventsNotFound";
  }
}

// ── On-chain revert error ───────────────────────────────────────────

export class OnChainRevertError extends O2Error {
  constructor(message: string, reason?: string, receipts?: unknown[]) {
    super(message, undefined, reason, receipts);
    this.name = "OnChainRevertError";
  }
}

// ── Error mapping ───────────────────────────────────────────────────

const ERROR_MAP: Record<number, new (message: string) => O2Error> = {
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
};

/**
 * Parse an API error response and return the appropriate typed error.
 * Handles both pre-flight (code-based) and on-chain revert formats.
 */
export function parseApiError(body: Record<string, unknown>): O2Error {
  const code = body.code as number | undefined;
  const message = (body.message as string) ?? "Unknown error";
  const reason = body.reason as string | undefined;
  const receipts = body.receipts as unknown[] | undefined;

  // Pre-flight validation error: has code
  if (code !== undefined) {
    const ErrorClass = ERROR_MAP[code];
    if (ErrorClass) {
      return new ErrorClass(message);
    }
    return new O2Error(message, code);
  }

  // On-chain revert: no code, has message (and possibly reason/receipts)
  return new OnChainRevertError(message, reason, receipts);
}

/**
 * Check if a session/actions response is successful.
 * Success: has tx_id. Error: has message but no tx_id.
 */
export function isActionsSuccess(
  body: Record<string, unknown>,
): body is { tx_id: string } & Record<string, unknown> {
  return "tx_id" in body && body.tx_id != null;
}
