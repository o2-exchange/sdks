import { O2Error } from "../errors.js";
import type * as T from "./types.js";

/** The proxy uses string error codes, unlike O2's numeric trading codes. */
export class BridgeApiError extends O2Error {
  constructor(
    readonly status: number,
    readonly bridgeCode: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "BridgeApiError";
  }
}
export interface FastBridgeClientOptions {
  /** Proxy root URL, without /v1. No deployment URL is assumed. */
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}
/** Independent, stateless bridge client. Requests are single-attempt, including submissions.
 * An ambiguous submit timeout must be reconciled using the appropriate status endpoint. */
export class FastBridgeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  constructor(options: FastBridgeClientOptions) {
    const url = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("Invalid bridge base URL");
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0)
      throw new Error("Invalid bridge timeout");
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await this.fetchFn(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BridgeApiError(
        response.status,
        "INVALID_RESPONSE",
        "Bridge returned non-JSON response",
      );
    }
    if (!response.ok) {
      const error = (
        payload as { error?: { code?: string; message?: string; details?: unknown } } | null
      )?.error;
      throw new BridgeApiError(
        response.status,
        typeof error?.code === "string" ? error.code : "HTTP_ERROR",
        typeof error?.message === "string" ? error.message : "Bridge request failed",
        error?.details,
      );
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new BridgeApiError(
        response.status,
        "INVALID_RESPONSE",
        "Bridge response must be an object",
      );
    }
    return payload as T;
  }
  /** GET /v1/info */
  getInfo(): Promise<T.InfoResponse> {
    return this.request("GET", "/v1/info", undefined);
  }
  /** GET /v1/assets */
  getAssets(chainId?: number): Promise<T.AssetsResponse> {
    return this.request("GET", "/v1/assets", undefined, { chainId });
  }
  /** GET /v1/deposit/info */
  getDepositInfo(
    sourceChainId: number,
    assetId?: string,
    amount?: string,
  ): Promise<T.DepositInfoResponse> {
    return this.request("GET", "/v1/deposit/info", undefined, { sourceChainId, assetId, amount });
  }
  /** POST /v1/deposit/prepare */
  prepareDeposit(request: T.DepositPrepareRequest): Promise<T.DepositPrepareResponse> {
    return this.request("POST", "/v1/deposit/prepare", request);
  }
  /** POST /v1/deposit/submit */
  submitDeposit(request: T.SubmitRequest): Promise<T.DepositSubmitResponse> {
    return this.request("POST", "/v1/deposit/submit", request);
  }
  /** GET /v1/deposit/status */
  getDepositStatus(sourceChainId: number, evmTxHash: string): Promise<T.DepositStatusResponse> {
    return this.request("GET", "/v1/deposit/status", undefined, { sourceChainId, evmTxHash });
  }
  /** GET /v1/withdraw/info */
  getWithdrawInfo(
    destinationChainId: number,
    assetId?: string,
    amount?: string,
  ): Promise<T.WithdrawInfoResponse> {
    return this.request("GET", "/v1/withdraw/info", undefined, {
      destinationChainId,
      assetId,
      amount,
    });
  }
  /** GET /v1/withdraw/fee */
  getWithdrawFee(destinationChainId: number, assetId: string): Promise<T.WithdrawFeeResponse> {
    return this.request("GET", "/v1/withdraw/fee", undefined, { destinationChainId, assetId });
  }
  /** POST /v1/withdraw/prepare */
  prepareWithdraw(request: T.WithdrawPrepareRequest): Promise<T.WithdrawPrepareResponse> {
    return this.request("POST", "/v1/withdraw/prepare", request);
  }
  /** POST /v1/withdraw/submit */
  submitWithdraw(request: T.SubmitRequest): Promise<T.WithdrawSubmitResponse> {
    return this.request("POST", "/v1/withdraw/submit", request);
  }
  /** GET /v1/withdraw/status */
  getWithdrawStatus(fuelTxId: string): Promise<T.WithdrawStatusResponse> {
    return this.request("GET", "/v1/withdraw/status", undefined, { fuelTxId });
  }
}
