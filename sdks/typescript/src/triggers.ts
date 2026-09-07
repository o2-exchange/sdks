/**
 * Trigger orders — take-profit and stop-loss.
 *
 * A trigger order rests off-book until the market reaches its
 * `trigger_price`, then becomes a real order of the type it names. Three
 * ways to create one:
 *
 * - **attached at placement** ({@link createOrderWithTriggersAction}) — one
 *   atomic call creates the spot order and hangs one or two protective
 *   legs off it. This is what a UI's "TP/SL" fields do.
 * - **standalone** ({@link createTriggerOrderAction}) — an entry stop, or
 *   protection sized explicitly rather than inherited.
 * - **paired** ({@link createTriggerOrdersAction}) — two legs that
 *   auto-link as OCO siblings: one firing cancels the other.
 *
 * @module
 */

import type { Numeric, Side } from "./models.js";

/** What a trigger becomes once it fires. */
export type TriggerOrderKind =
  /** An unbounded market order. Rejected on margin accounts — see remarks. */
  | "Market"
  /** A market order with slippage bounds. */
  | { MarketBounded: { max_price: string; min_price: string } }
  /** A limit order at `price`. */
  | { Spot: { price: string } };

/** How much a trigger is for. */
export type TriggerQuantity =
  /** An explicit amount. */
  | { Quantity: { quantity: string } }
  /**
   * Inherited from a parent spot order.
   *
   * Use {@link PARENT_ORDER_PLACEHOLDER} when attaching at placement — the
   * contract resolves it to the order created in the same call.
   */
  | { ParentOrder: { parent_order_id: string } };

/** One trigger leg, as the wire takes it. */
export interface TriggerOrderArgs {
  order_type: TriggerOrderKind;
  quantity: TriggerQuantity;
  /** The price that arms it, raw. */
  trigger_price: string;
  /**
   * The side the resulting order takes — the CLOSING side of whatever it
   * protects.
   *
   * CAPITALISED, because the wire's enum is `Buy`/`Sell` and a lowercase
   * value is rejected outright ("unknown variant `sell`"). It is not part
   * of the contract call DATA at all: the contract reads the side off the
   * forwarded asset, so this decides which asset is escrowed.
   */
  side: WireSide;
}

/** The side as the wire spells it. */
export type WireSide = "Buy" | "Sell";

/** Normalise a side to the wire's capitalisation. */
export function wireSide(side: Side | WireSide): WireSide {
  return side.toString().toLowerCase() === "buy" ? "Buy" : "Sell";
}

/** Binds a standalone trigger to a resting parent order. */
export interface ParentOrderRef {
  order_id: string;
  /**
   * The parent's INITIAL quantity, which the backend checks against the
   * order it finds. It is what stops a signed payload attaching to a
   * different order than the one it was audited against.
   */
  expected_quantity: string;
}

/**
 * The parent id to use when attaching triggers at placement.
 *
 * The order does not exist yet when the call is signed, so the contract
 * takes a zero id and substitutes the one it creates.
 */
export const PARENT_ORDER_PLACEHOLDER = `0x${"00".repeat(32)}`;

/** Discriminants, in the contract's own order. */
const TRIGGER_KIND_DISCRIMINANT = { Market: 0, MarketBounded: 1, Spot: 2 } as const;
const TRIGGER_QUANTITY_DISCRIMINANT = { Quantity: 0, ParentOrder: 1 } as const;

/** The discriminant for a trigger's resulting order type. */
export function triggerKindDiscriminant(kind: TriggerOrderKind): number {
  if (kind === "Market") return TRIGGER_KIND_DISCRIMINANT.Market;
  if ("MarketBounded" in kind) return TRIGGER_KIND_DISCRIMINANT.MarketBounded;
  return TRIGGER_KIND_DISCRIMINANT.Spot;
}

/** The discriminant for a trigger's quantity variant. */
export function triggerQuantityDiscriminant(quantity: TriggerQuantity): number {
  return "ParentOrder" in quantity
    ? TRIGGER_QUANTITY_DISCRIMINANT.ParentOrder
    : TRIGGER_QUANTITY_DISCRIMINANT.Quantity;
}

/**
 * The price a trigger escrows against.
 *
 * A limit leg locks at its own price, a bounded market at its worst bound,
 * and a bare market at the trigger price — because that is the only price
 * known when the funds are taken.
 */
export function triggerLockPrice(args: TriggerOrderArgs): bigint {
  if (args.order_type === "Market") return BigInt(args.trigger_price);
  if ("MarketBounded" in args.order_type) return BigInt(args.order_type.MarketBounded.max_price);
  return BigInt(args.order_type.Spot.price);
}

/**
 * What a trigger leg escrows, and in which asset.
 *
 * Mirrors the backend's `required_lock_amount_with_config`. A leg whose
 * quantity is inherited from a parent escrows NOTHING — the parent's own
 * funds cover it.
 *
 * Getting this wrong is not a soft failure: the backend rebuilds the same
 * figure into the call it verifies the signature against, so a client that
 * forwards a different amount has signed different call data and the batch
 * is rejected before it reaches the book.
 */
export function triggerLockAmount(
  args: TriggerOrderArgs,
  baseDecimals: number,
): { amount: bigint; side: WireSide } {
  if ("ParentOrder" in args.quantity) return { amount: 0n, side: args.side };
  const quantity = BigInt(args.quantity.Quantity.quantity);
  const isBuy = args.side.toLowerCase() === "buy";
  // A buy escrows quote — what it will pay. A sell escrows the base itself.
  const amount = isBuy
    ? (quantity * triggerLockPrice(args)) / 10n ** BigInt(baseDecimals)
    : quantity;
  return { amount, side: args.side };
}

// ── Factories ───────────────────────────────────────────────────────

/** A trigger that becomes a limit order at `price`. */
export function stopLimit(price: Numeric): TriggerOrderKind {
  return { Spot: { price: price.toString() } };
}

/** A trigger that becomes a market order bounded by `maxPrice`/`minPrice`. */
export function stopMarketBounded(maxPrice: Numeric, minPrice: Numeric): TriggerOrderKind {
  return {
    MarketBounded: { max_price: maxPrice.toString(), min_price: minPrice.toString() },
  };
}

/**
 * A trigger that becomes an unbounded market order.
 *
 * Spot only — a margin account refuses it, because an unpriced order
 * cannot be walked for risk.
 */
export const stopMarket: TriggerOrderKind = "Market";

/** A leg sized explicitly. */
export function triggerQuantity(quantity: Numeric): TriggerQuantity {
  return { Quantity: { quantity: quantity.toString() } };
}

/** A leg that inherits its size from a parent order. */
export function triggerFromParent(
  parentOrderId: string = PARENT_ORDER_PLACEHOLDER,
): TriggerQuantity {
  return { ParentOrder: { parent_order_id: parentOrderId } };
}

/** Assemble one trigger leg. */
export function triggerLeg(params: {
  side: Side | WireSide;
  triggerPrice: Numeric;
  kind: TriggerOrderKind;
  quantity: TriggerQuantity;
}): TriggerOrderArgs {
  return {
    order_type: params.kind,
    quantity: params.quantity,
    trigger_price: params.triggerPrice.toString(),
    side: wireSide(params.side),
  };
}

/**
 * Order a pair so the leg escrowing MORE comes first.
 *
 * The chain takes `first`'s lock to cover both legs, so leading with the
 * cheaper one under-funds the pair. A no-op when neither leg escrows
 * anything (both inherited) or both lock the same asset at the same price.
 */
export function orderPairByLock(
  first: TriggerOrderArgs,
  second: TriggerOrderArgs,
  baseDecimals: number,
): [TriggerOrderArgs, TriggerOrderArgs] {
  const a = triggerLockAmount(first, baseDecimals).amount;
  const b = triggerLockAmount(second, baseDecimals).amount;
  return b > a ? [second, first] : [first, second];
}

// ── Friendly protection specs ───────────────────────────────────────

/**
 * A take-profit or stop-loss, in the terms a trader thinks in.
 *
 * Give a `triggerPrice` and, optionally, how it should execute:
 * - nothing → an unbounded market order (spot only; margin refuses it)
 * - `limitPrice` → a limit order at that price
 * - `slippageBps` → a market order bounded that far either side
 */
export interface ProtectionSpec {
  /** The price that arms it, raw chain units. */
  triggerPrice: Numeric;
  /** Execute as a limit order at this price. */
  limitPrice?: Numeric;
  /** Execute as a market order bounded this far from the trigger, in bps. */
  slippageBps?: number;
  /** Size explicitly instead of inheriting from the order it protects. */
  quantity?: Numeric;
}

/**
 * The tick a market prices on: `10^(quoteDecimals - quoteMaxPrecision)`.
 *
 * Every price the contract sees must be a multiple of it, or the order is
 * refused with `OrderCreationError::PricePrecision`.
 */
export function priceTick(quoteDecimals: number, quoteMaxPrecision: number): bigint {
  const exponent = quoteDecimals - quoteMaxPrecision;
  return exponent > 0 ? 10n ** BigInt(exponent) : 1n;
}

/** Snap a price DOWN to the tick. */
export function floorToTick(price: bigint, tick: bigint): bigint {
  return tick <= 1n ? price : (price / tick) * tick;
}

/** Snap a price UP to the tick. */
export function ceilToTick(price: bigint, tick: bigint): bigint {
  if (tick <= 1n) return price;
  const remainder = price % tick;
  return remainder === 0n ? price : price + (tick - remainder);
}

/**
 * Turn a {@link ProtectionSpec} into the kind the wire takes.
 *
 * @param tick - The market's tick. Slippage bounds are derived here, so
 *   they are the prices most likely to land off-tick — a 1% band on an
 *   arbitrary trigger almost never does. Without alignment the chain
 *   answers `PricePrecision` after the batch is signed.
 */
export function protectionKind(spec: ProtectionSpec, tick = 1n): TriggerOrderKind {
  if (spec.limitPrice !== undefined) {
    return stopLimit(floorToTick(BigInt(spec.limitPrice.toString()), tick));
  }
  if (spec.slippageBps !== undefined) {
    const trigger = BigInt(spec.triggerPrice.toString());
    const band = (trigger * BigInt(Math.round(spec.slippageBps))) / 10_000n;
    // Rounded INWARD, so an aligned bound can never be WIDER than the
    // band asked for and trip the contract's own slippage cap.
    return stopMarketBounded(floorToTick(trigger + band, tick), ceilToTick(trigger - band, tick));
  }
  return stopMarket;
}

/**
 * Build a protective leg for an order on `side`.
 *
 * The leg always takes the CLOSING side — protection on a buy sells, and
 * protection on a sell buys — which is also what the chain requires:
 * a trigger on the same side as its parent is refused.
 */
export function protectionLeg(
  spec: ProtectionSpec,
  parentSide: Side | WireSide,
  parentOrderId: string = PARENT_ORDER_PLACEHOLDER,
  tick = 1n,
): TriggerOrderArgs {
  const closing: WireSide = wireSide(parentSide) === "Buy" ? "Sell" : "Buy";
  return triggerLeg({
    side: closing,
    triggerPrice: floorToTick(BigInt(spec.triggerPrice.toString()), tick),
    kind: protectionKind(spec, tick),
    quantity:
      spec.quantity !== undefined
        ? triggerQuantity(spec.quantity)
        : triggerFromParent(parentOrderId),
  });
}

// ── Active orders ───────────────────────────────────────────────────

/** One live trigger order, as `/v1/orders/active` reports it. */
export interface ActiveTriggerOrder {
  kind: "trigger";
  order_id: string;
  market_id?: string;
  side?: string;
  trigger_price?: string;
  [key: string]: unknown;
}

/** One live spot order, with any child triggers nested. */
export interface ActiveSpotOrder {
  kind: "order";
  order_id: string;
  triggers?: ActiveTriggerOrder[];
  [key: string]: unknown;
}

/** An entry from `/v1/orders/active`. */
export type ActiveOrderEntry = ActiveSpotOrder | ActiveTriggerOrder;

/** The `/v1/orders/active` payload. */
export interface ActiveOrdersResponse {
  identity: { ContractId: string };
  market_id: string;
  entries: ActiveOrderEntry[];
}

/** Every live trigger id in an active-orders payload, nested ones included. */
export function activeTriggerIds(response: ActiveOrdersResponse): string[] {
  const ids: string[] = [];
  for (const entry of response.entries ?? []) {
    if (entry.kind === "trigger") {
      ids.push(entry.order_id);
      continue;
    }
    for (const child of (entry as ActiveSpotOrder).triggers ?? []) ids.push(child.order_id);
  }
  return ids;
}
