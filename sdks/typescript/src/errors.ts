/**
 * Error types mapping all O2 Exchange error codes.
 *
 * The SDK defines a typed error class for every API error code, all
 * extending the base {@link O2Error} class. Two distinct error formats
 * exist for `POST /v1/session/actions`:
 *
 * - **Pre-flight validation error** — Has a numeric `code` field
 * - **On-chain revert error** — Has `message` + `reason` + `receipts`, no `code`
 *
 * Use {@link parseApiError} to convert raw API responses into typed errors,
 * and {@link isActionsSuccess} to check if a response was successful.
 *
 * @module
 */

/**
 * Base error class for all O2 Exchange errors.
 *
 * All API errors extend this class. Check `code` for pre-flight errors
 * and `reason` for on-chain revert details.
 *
 * @example
 * ```ts
 * try {
 *   await client.createOrder(session, "fFUEL/fUSDC", "buy", 0.02, 100.0);
 * } catch (error) {
 *   if (error instanceof O2Error) {
 *     console.log(error.code, error.message, error.reason);
 *   }
 * }
 * ```
 */
export class O2Error extends Error {
  /** API error code (present for pre-flight validation errors). */
  readonly code: number | undefined;
  /** On-chain revert reason string (e.g., `"NotEnoughBalance"`). */
  readonly reason: string | undefined;
  /** Transaction receipts from on-chain reverts. */
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

/** Unexpected server error (code 1000). Retry with exponential backoff. */
export class InternalError extends O2Error {
  constructor(message = "Unexpected server error") {
    super(message, 1000);
    this.name = "InternalError";
  }
}

/** Malformed or invalid request (code 1001). */
export class InvalidRequest extends O2Error {
  constructor(message = "Malformed or invalid request") {
    super(message, 1001);
    this.name = "InvalidRequest";
  }
}

/** Failed to parse request body (code 1002). */
export class ParseError extends O2Error {
  constructor(message = "Failed to parse request body") {
    super(message, 1002);
    this.name = "ParseError";
  }
}

/** Too many requests (code 1003). The SDK auto-retries with exponential backoff. */
export class RateLimitExceeded extends O2Error {
  constructor(message = "Too many requests") {
    super(message, 1003);
    this.name = "RateLimitExceeded";
  }
}

/** Region not allowed (code 1004). */
export class GeoRestricted extends O2Error {
  constructor(message = "Region not allowed") {
    super(message, 1004);
    this.name = "GeoRestricted";
  }
}

// ── Market (2xxx) ───────────────────────────────────────────────────

/** Market not found (code 2000). Check the market_id. */
export class MarketNotFound extends O2Error {
  constructor(message = "Market not found") {
    super(message, 2000);
    this.name = "MarketNotFound";
  }
}

/** Market is currently paused (code 2001). Wait for the market to resume. */
export class MarketPaused extends O2Error {
  constructor(message = "Market is currently paused") {
    super(message, 2001);
    this.name = "MarketPaused";
  }
}

/** Market already exists (code 2002). */
export class MarketAlreadyExists extends O2Error {
  constructor(message = "Market already exists") {
    super(message, 2002);
    this.name = "MarketAlreadyExists";
  }
}

// ── Order (3xxx) ────────────────────────────────────────────────────

/** Order not found (code 3000). The order may have been filled or cancelled. */
export class OrderNotFound extends O2Error {
  constructor(message = "Order not found") {
    super(message, 3000);
    this.name = "OrderNotFound";
  }
}

/** Order is not in active state (code 3001). */
export class OrderNotActive extends O2Error {
  constructor(message = "Order is not in active state") {
    super(message, 3001);
    this.name = "OrderNotActive";
  }
}

/** Invalid order parameters (code 3002). Check price and quantity. */
export class InvalidOrderParams extends O2Error {
  constructor(message = "Invalid order parameters") {
    super(message, 3002);
    this.name = "InvalidOrderParams";
  }
}

// ── Account/Session (4xxx) ──────────────────────────────────────────

/** Signature verification failed (code 4000). Check signing method and key. */
export class InvalidSignature extends O2Error {
  constructor(message = "Signature verification failed") {
    super(message, 4000);
    this.name = "InvalidSignature";
  }
}

/** Session is invalid or expired (code 4001). Create a new session. */
export class InvalidSession extends O2Error {
  constructor(message = "Session is invalid or expired") {
    super(message, 4001);
    this.name = "InvalidSession";
  }
}

/** Trading account not found (code 4002). Call {@link O2Client.setupAccount}. */
export class AccountNotFound extends O2Error {
  constructor(message = "Trading account not found") {
    super(message, 4002);
    this.name = "AccountNotFound";
  }
}

/** Whitelist not configured (code 4003). Whitelist the account first. */
export class WhitelistNotConfigured extends O2Error {
  constructor(message = "Whitelist not configured") {
    super(message, 4003);
    this.name = "WhitelistNotConfigured";
  }
}

// ── Trade (5xxx) ────────────────────────────────────────────────────

/** Trade not found (code 5000). */
export class TradeNotFound extends O2Error {
  constructor(message = "Trade not found") {
    super(message, 5000);
    this.name = "TradeNotFound";
  }
}

/** Invalid trade count (code 5001). */
export class InvalidTradeCount extends O2Error {
  constructor(message = "Invalid trade count") {
    super(message, 5001);
    this.name = "InvalidTradeCount";
  }
}

// ── Subscription/WebSocket (6xxx) ───────────────────────────────────

/** Already subscribed to this topic (code 6000). */
export class AlreadySubscribed extends O2Error {
  constructor(message = "Already subscribed to this topic") {
    super(message, 6000);
    this.name = "AlreadySubscribed";
  }
}

/** Subscription limit exceeded (code 6001). Unsubscribe from unused streams. */
export class TooManySubscriptions extends O2Error {
  constructor(message = "Subscription limit exceeded") {
    super(message, 6001);
    this.name = "TooManySubscriptions";
  }
}

/** General subscription error (code 6002). Try reconnecting the WebSocket. */
export class SubscriptionError extends O2Error {
  constructor(message = "General subscription error") {
    super(message, 6002);
    this.name = "SubscriptionError";
  }
}

// ── Validation (7xxx) ───────────────────────────────────────────────

/** Invalid amount specified (code 7000). */
export class InvalidAmount extends O2Error {
  constructor(message = "Invalid amount specified") {
    super(message, 7000);
    this.name = "InvalidAmount";
  }
}

/** Invalid time range (code 7001). */
export class InvalidTimeRange extends O2Error {
  constructor(message = "Invalid time range") {
    super(message, 7001);
    this.name = "InvalidTimeRange";
  }
}

/** Invalid pagination params (code 7002). */
export class InvalidPagination extends O2Error {
  constructor(message = "Invalid pagination params") {
    super(message, 7002);
    this.name = "InvalidPagination";
  }
}

/** No actions in request (code 7003). Add at least one action. */
export class NoActionsProvided extends O2Error {
  constructor(message = "No actions in request") {
    super(message, 7003);
    this.name = "NoActionsProvided";
  }
}

/** Too many actions (max 5 per batch) (code 7004). Split into multiple batches. */
export class TooManyActions extends O2Error {
  constructor(message = "Too many actions (max 5)") {
    super(message, 7004);
    this.name = "TooManyActions";
  }
}

// ── Block/Events (8xxx) ─────────────────────────────────────────────

/** Block not found (code 8000). The block may not be indexed yet. */
export class BlockNotFound extends O2Error {
  constructor(message = "Block not found") {
    super(message, 8000);
    this.name = "BlockNotFound";
  }
}

/** Events not found for block (code 8001). */
export class EventsNotFound extends O2Error {
  constructor(message = "Events not found for block") {
    super(message, 8001);
    this.name = "EventsNotFound";
  }
}

// ── Client-side errors ──────────────────────────────────────────────

/**
 * Client-side error raised when a session has expired.
 *
 * Create a new session via {@link O2Client.createSession} to continue trading.
 */
export class SessionExpired extends O2Error {
  constructor(message = "Session has expired. Create a new session before submitting actions.") {
    super(message);
    this.name = "SessionExpired";
  }
}

// ── On-chain revert error ───────────────────────────────────────────

/**
 * Error raised when an on-chain transaction reverts.
 *
 * Has no `code` field. Check `reason` for the revert name (e.g.,
 * `"NotEnoughBalance"`, `"TraderNotWhiteListed"`, `"PricePrecision"`).
 */
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
