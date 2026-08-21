import {
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
} from "ccxt";
import {
  InvalidOrderParams,
  InvalidSession,
  InvalidSignature,
  MarketNotFound,
  AccountNotFound as O2AccountNotFound,
  O2Error,
  InvalidAmount as O2InvalidAmount,
  OrderNotFound as O2OrderNotFound,
  RateLimitExceeded as O2RateLimitExceeded,
  OnChainRevertError,
  SessionExpired,
} from "../errors.js";

export {
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
};

export type O2MappedError = BaseError & {
  readonly originalError?: unknown;
  readonly cause?: unknown;
};

function withOriginalError<T extends BaseError>(error: T, originalError: unknown): T {
  Object.defineProperties(error, {
    originalError: { configurable: true, enumerable: false, value: originalError },
    cause: { configurable: true, enumerable: false, value: originalError },
  });
  return error;
}

export class O2AmbiguousSubmission extends OperationFailed {
  readonly transactionId: string | null;
  readonly nonce: string | null;

  constructor(
    message: string,
    options: { originalError?: unknown; transactionId?: string | null; nonce?: string | null } = {},
  ) {
    super(message);
    this.name = new.target.name;
    if (options.originalError !== undefined) withOriginalError(this, options.originalError);
    this.transactionId = options.transactionId ?? null;
    this.nonce = options.nonce ?? null;
  }
}

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    /network|fetch failed|socket|connection|response (?:was )?lost|timeout/i.test(error.message)
  );
}

function hasInsufficientFundsReason(error: O2Error): boolean {
  return /not.?enough.?balance|insufficient.?funds/i.test(`${error.reason ?? ""} ${error.message}`);
}

function isNamedNativeError<T extends Error>(
  error: unknown,
  ErrorClass: abstract new (...args: never[]) => T,
  name: string,
): error is T {
  return error instanceof ErrorClass || (error instanceof Error && error.name === name);
}

function isO2ErrorLike(error: unknown): error is O2Error {
  return (
    error instanceof O2Error ||
    (error instanceof Error && "code" in error && "reason" in error && "receipts" in error)
  );
}

function hasInvalidOrderReason(error: O2Error): boolean {
  return /min_order|order value below|invalid (?:order|price|quantity)|order(?:not|partially)filled|post.?only order|fill.?or.?kill order/i.test(
    error.message,
  );
}

export function mapO2Error(
  error: unknown,
  context: "read" | "privateSubmission" = "read",
): O2MappedError {
  if (error instanceof BaseError) return error;
  if (context === "privateSubmission" && isNetworkFailure(error)) {
    return new O2AmbiguousSubmission(
      "O2 submission outcome is unknown. Reconcile orders and account nonce before retrying.",
      { originalError: error },
    );
  }
  if (isNetworkFailure(error)) {
    return withOriginalError(new NetworkError("O2 network request failed"), error);
  }
  if (
    isNamedNativeError(error, InvalidSession, "InvalidSession") ||
    isNamedNativeError(error, InvalidSignature, "InvalidSignature") ||
    isNamedNativeError(error, SessionExpired, "SessionExpired") ||
    isNamedNativeError(error, O2AccountNotFound, "AccountNotFound")
  ) {
    return withOriginalError(new AuthenticationError(error.message), error);
  }
  if (isNamedNativeError(error, O2RateLimitExceeded, "RateLimitExceeded")) {
    return withOriginalError(new RateLimitExceeded(error.message), error);
  }
  if (isNamedNativeError(error, MarketNotFound, "MarketNotFound")) {
    return withOriginalError(new BadSymbol(error.message), error);
  }
  if (isNamedNativeError(error, O2OrderNotFound, "OrderNotFound")) {
    return withOriginalError(new OrderNotFound(error.message), error);
  }
  if (
    isNamedNativeError(error, InvalidOrderParams, "InvalidOrderParams") ||
    isNamedNativeError(error, O2InvalidAmount, "InvalidAmount")
  ) {
    return withOriginalError(new InvalidOrder(error.message), error);
  }
  if (isO2ErrorLike(error) && hasInsufficientFundsReason(error)) {
    return withOriginalError(new InsufficientFunds(error.message), error);
  }
  if (isNamedNativeError(error, OnChainRevertError, "OnChainRevertError")) {
    return withOriginalError(new InvalidOrder(error.message), error);
  }
  if (isO2ErrorLike(error) && hasInvalidOrderReason(error)) {
    return withOriginalError(new InvalidOrder(error.message), error);
  }
  if (error instanceof O2Error || error instanceof Error) {
    return withOriginalError(new ExchangeError(error.message), error);
  }
  return withOriginalError(new ExchangeError("Unknown O2 error"), error);
}
