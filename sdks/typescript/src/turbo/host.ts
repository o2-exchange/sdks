/**
 * The seam between {@link O2Client} and {@link TurboClient}.
 *
 * `TurboClient` needs to reach a few things the client keeps protected —
 * the active session, the markets cache, the batch signer. Rather than
 * widening those to public (and making them part of the SDK's surface
 * forever), the client hands over exactly this bundle.
 *
 * @module
 */

import type { O2Api } from "../api.js";
import type { ContractCall } from "../encoding.js";
import type {
  Market,
  MarketsResponse,
  Numeric,
  SessionActionsResponse,
  SessionState,
} from "../models.js";

export type { SessionState };

/** One market's group of actions, as `/v1/session/actions` takes them. */
export interface PreparedMarketActions {
  market_id: string;
  actions: Record<string, unknown>[];
}

/** A batch whose calls the caller has already derived. */
export interface PreparedBatch {
  marketActions: PreparedMarketActions[];
  /**
   * The calls the backend must re-derive identically.
   *
   * Passed explicitly because margin actions do not derive from market
   * metadata the way spot ones do — they target the pool, the child or the
   * registry, and the wiring that names those is resolved separately.
   */
  calls: ContractCall[];
  /**
   * Which account signs and executes.
   *
   * Trading and pool actions run AS the margin CHILD; the lifecycle
   * actions that drive a child run AS the PARENT.
   */
  tradeAccountId: string;
  collectOrders?: boolean;
  /**
   * The `O2-Owner-Id` this batch is authorised under.
   *
   * Defaults to the session's owner wallet. A margin CHILD's owner is the
   * PARENT CONTRACT, not the wallet — the backend compares the header
   * against the account's own owner and refuses "the wallet's owner id"
   * driving a child — so Turbo trading passes the parent's contract id.
   */
  ownerId?: string;
  /**
   * Sign with a PARALLEL nonce (packed u256, decimal string) instead of the
   * account's sequential counter.
   *
   * Margin-account batches are accepted under no other kind — the backend
   * answers "margin account actions support only parallel_nonce" — and a
   * parallel nonce requires the TYPED signature variant.
   */
  parallelNonce?: string;
  /**
   * `"marginAccounts"` routes to `/v1/margin/accounts`, which deploys the
   * proxies before running the signed batch. Defaults to
   * `/v1/session/actions`.
   */
  endpoint?: "session" | "marginAccounts";
}

/** What {@link TurboClient} needs from its host client. */
export interface TurboHost {
  readonly api: O2Api;
  /** The active session, or a thrown {@link NoActiveSession}. */
  ensureSession(): SessionState;
  /** The markets payload, cached by the host. */
  fetchMarkets(): Promise<MarketsResponse>;
  /** Resolve a `"BASE/QUOTE"` pair to a market. */
  resolveMarket(data: MarketsResponse, symbolPair: string): Market;
  /** Scale dual-mode price/quantity values against a market. */
  normalizeCreateOrderValues(
    market: Market,
    price: Numeric,
    quantity: Numeric,
    priceFieldName: string,
    quantityFieldName: string,
  ): { scaledPrice: bigint; scaledQuantity: bigint };
  /** Derive the call for an ordinary spot action. */
  spotActionToCall(action: Record<string, unknown>, market: Market): ContractCall;
  /** Sign and submit a batch whose calls are already derived. */
  submitPrepared(batch: PreparedBatch): Promise<SessionActionsResponse>;
}
