/**
 * Type-safe action definitions for O2 Exchange session actions.
 *
 * Provides a discriminated union {@link Action} for building session actions,
 * with dual-mode numeric types: pass human-readable decimal strings (auto-scaled)
 * or raw bigint chain integers (pass-through).
 *
 * @module
 */

import type { Identity, OrderId, OrderType, Side } from "./models.js";

/**
 * Dual-mode numeric type for prices and quantities.
 *
 * - `string` — Human-readable decimal (e.g., `"0.02"`, `"100.5"`). Auto-scaled
 *   using market decimals via precise string parsing (no float intermediary).
 * - `bigint` — Raw chain integer (e.g., `20000000n`). Passed through directly.
 *
 * @example
 * ```ts
 * // Human-readable (auto-scaled):
 * createOrderAction("buy", "0.02", "100")
 *
 * // Raw chain integer (pass-through):
 * createOrderAction("buy", 20000000n, 100000000000n)
 *
 * // Mix modes:
 * createOrderAction("buy", "0.02", 100000000000n)
 * ```
 */
export type Numeric = string | bigint;

/**
 * A type-safe action for session batch submission.
 *
 * Use with {@link O2Client.batchActions} and {@link MarketActionGroup}.
 * Factory functions ({@link createOrderAction}, {@link cancelOrderAction},
 * {@link settleBalanceAction}) are optional sugar — plain objects with the
 * correct `type` discriminant also work.
 */
export type Action =
  | {
      type: "createOrder";
      side: Side;
      price: Numeric;
      quantity: Numeric;
      orderType?: OrderType;
    }
  | { type: "cancelOrder"; orderId: OrderId }
  | { type: "settleBalance" }
  | { type: "registerReferer"; to: Identity };

/**
 * Create a CreateOrder action.
 *
 * @param side - Order side (`"buy"` or `"sell"`)
 * @param price - Price as human-readable string or raw bigint
 * @param quantity - Quantity as human-readable string or raw bigint
 * @param orderType - Order type (default: `"Spot"`)
 *
 * @example
 * ```ts
 * // Human-readable strings (auto-scaled by SDK):
 * createOrderAction("buy", "0.02", "100")
 * createOrderAction("sell", "0.05", "50", "PostOnly")
 *
 * // Raw bigints (pass-through, already scaled):
 * createOrderAction("buy", 20000000n, 100000000000n)
 * ```
 */
export function createOrderAction(
  side: Side,
  price: Numeric,
  quantity: Numeric,
  orderType?: OrderType,
): Action {
  return { type: "createOrder", side, price, quantity, orderType };
}

/**
 * Create a CancelOrder action.
 *
 * @param orderId - The order ID to cancel (0x-prefixed hex)
 */
export function cancelOrderAction(orderId: OrderId): Action {
  return { type: "cancelOrder", orderId };
}

/**
 * Create a SettleBalance action.
 *
 * The `to` destination defaults to the session's trade account automatically.
 */
export function settleBalanceAction(): Action {
  return { type: "settleBalance" };
}

/**
 * Create a RegisterReferer action.
 *
 * @param to - The referrer identity
 */
export function registerRefererAction(to: Identity): Action {
  return { type: "registerReferer", to };
}

/**
 * A group of actions targeting a specific market.
 *
 * Used with {@link O2Client.batchActions}. The `market` field accepts
 * a symbol pair string (e.g., `"fFUEL/fUSDC"`) which is resolved
 * internally by the SDK.
 *
 * @example
 * ```ts
 * const groups: MarketActionGroup[] = [
 *   {
 *     market: "fFUEL/fUSDC",
 *     actions: [
 *       settleBalanceAction(),
 *       createOrderAction("buy", "0.02", "100"),
 *       createOrderAction("sell", "0.05", "50", "PostOnly"),
 *     ],
 *   },
 * ];
 * await client.batchActions(session, groups, true);
 * ```
 */
export interface MarketActionGroup {
  /** Market symbol pair (e.g., `"fFUEL/fUSDC"`) or hex market ID. */
  market: string;
  /** Actions to execute on this market (max 5 per group). */
  actions: Action[];
}
