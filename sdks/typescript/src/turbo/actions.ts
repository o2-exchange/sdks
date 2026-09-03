/**
 * Typed margin ("Turbo") session actions.
 *
 * These ride the SAME per-market action list every O2 client speaks, and
 * the batch is what makes the single-button contract possible: "long ETH"
 * is `[SettleBalance, Draw, CreateOrder(buy)]` in ONE signed, atomic
 * submission.
 *
 * Two families, and the difference decides both the call target and which
 * account the batch is submitted AS:
 *
 * - **pool actions** ({@link DrawAction} … {@link WithdrawFromMarginAction})
 *   target the POOL and are submitted as the margin CHILD.
 * - **child actions** ({@link StartMarginSessionAction} …
 *   {@link RegisterMarginAccountAction}) target the child, the pool or the
 *   registry, and are submitted as the PARENT.
 *
 * @module
 */

import type { Identity } from "../models.js";
import type { Hex, OrderBookCleanup, ProlongPeriod } from "./wire.js";

/** Draw quote (the pool's collateral asset) against the credit line. */
export interface DrawAction {
  Draw: { amount: string };
}

/** Return drawn quote to the pool. Forwards the coins. */
export interface ReturnQuoteAction {
  ReturnQuote: { amount: string };
}

/** Borrow an asset in kind from the pool's inventory. */
export interface BorrowAction {
  Borrow: { asset_id: Hex; amount: string };
}

/** Repay an in-kind debt. Forwards the coins. */
export interface RepayAction {
  Repay: { asset_id: Hex; amount: string };
}

/**
 * Settle drawn quote against the session's OWN posted collateral.
 *
 * Moves NO coins: `collateral` and `drawn_quote` are two pool-side ledgers
 * over the same pot and both fall by `amount`. The only exit for a trader
 * whose position moved against them — they cannot return quote they no
 * longer have, and a clean close demands `drawn_quote == 0`.
 */
export interface RepayFromCollateralAction {
  RepayFromCollateral: { amount: string };
}

/**
 * Close a BORROWED-ASSET debt out of posted collateral.
 *
 * The in-kind sibling of {@link RepayFromCollateralAction}. Priced at the
 * ask, rounded up, and charged a fee — unlike the quote netting this is not
 * value-neutral for the pool.
 */
export interface RepayBaseFromCollateralAction {
  RepayBaseFromCollateral: { asset_id: Hex; amount: string };
}

/** Buy `times` periods of extra session life. */
export interface ProlongSessionAction {
  ProlongSession: { period: ProlongPeriod; times: string };
}

/** Arm (a period) or disarm (`null`) auto-extension. */
export interface SetAutoProlongAction {
  SetAutoProlong: { period: ProlongPeriod | null };
}

/** Move coins already on the margin account into posted collateral. */
export interface AddCollateralAction {
  AddCollateral: { amount: string };
}

/** Mid-session withdrawal to the parent. */
export interface WithdrawFromMarginAction {
  WithdrawFromMargin: { asset_id: Hex; amount: string };
}

/**
 * Open a margin session on a child. The collateral rides the call as the
 * forwarded element.
 *
 * The entry BUYS ITS FIRST TERM: it costs `open_fee + prolong_fee[period]`
 * and runs for `duration + period`, so one tier sells four products and the
 * opener picks which.
 */
export interface StartMarginSessionAction {
  StartMarginSession: {
    margin_account_id: Hex;
    tier_id: string;
    amount: string;
    period: ProlongPeriod;
  };
}

/** Top a live child session up straight at the pool. */
export interface AddMarginCollateralAction {
  AddMarginCollateral: { margin_account_id: Hex; amount: string };
}

/**
 * The clean, price-free session close.
 *
 * Requires all debts repaid and the books settled. `cleanups` names every
 * book still holding anything of the account's; the chain re-verifies
 * completeness, so a stale list reverts rather than stranding value.
 */
export interface CloseMarginSessionAction {
  CloseMarginSession: { margin_account_id: Hex; cleanups: OrderBookCleanup[] };
}

/** Withdraw an asset from the child to the parent. */
export interface WithdrawFromMarginAccountAction {
  WithdrawFromMarginAccount: { margin_account_id: Hex; asset_id: Hex; amount: string };
}

/** Arm a session key on the child. */
export interface SetMarginAccountSessionAction {
  SetMarginAccountSession: {
    margin_account_id: Hex;
    margin_nonce: string;
    session_id: Identity;
    expiry: string;
  };
}

/** Revoke the child's session key. */
export interface RevokeMarginAccountSessionAction {
  RevokeMarginAccountSession: { margin_account_id: Hex; margin_nonce: string };
}

/** Register a predicted margin child against the parent. */
export interface RegisterMarginAccountAction {
  RegisterMarginAccount: { margin_account_id: Hex; index: string };
}

/** Actions that target the POOL and are submitted as the margin CHILD. */
export type MarginPoolAction =
  | DrawAction
  | ReturnQuoteAction
  | BorrowAction
  | RepayAction
  | RepayFromCollateralAction
  | RepayBaseFromCollateralAction
  | ProlongSessionAction
  | SetAutoProlongAction
  | AddCollateralAction
  | WithdrawFromMarginAction;

/** Actions submitted as the PARENT that drive one of its margin children. */
export type MarginChildAction =
  | StartMarginSessionAction
  | AddMarginCollateralAction
  | CloseMarginSessionAction
  | WithdrawFromMarginAccountAction
  | SetMarginAccountSessionAction
  | RevokeMarginAccountSessionAction
  | RegisterMarginAccountAction;

/** Any margin action. */
export type MarginAction = MarginPoolAction | MarginChildAction;

/** The discriminant key of a margin action. */
export function marginActionKind(action: MarginAction): string {
  const keys = Object.keys(action);
  if (keys.length !== 1) {
    throw new Error(`A margin action must have exactly one variant key, got ${keys.length}`);
  }
  return keys[0] as string;
}

const POOL_ACTION_KINDS = new Set([
  "Draw",
  "ReturnQuote",
  "Borrow",
  "Repay",
  "RepayFromCollateral",
  "RepayBaseFromCollateral",
  "ProlongSession",
  "SetAutoProlong",
  "AddCollateral",
  "WithdrawFromMargin",
]);

const CHILD_ACTION_KINDS = new Set([
  "StartMarginSession",
  "AddMarginCollateral",
  "CloseMarginSession",
  "WithdrawFromMarginAccount",
  "SetMarginAccountSession",
  "RevokeMarginAccountSession",
  "RegisterMarginAccount",
]);

/** Whether this action targets the pool and rides as the margin child. */
export function isMarginPoolAction(action: MarginAction): action is MarginPoolAction {
  return POOL_ACTION_KINDS.has(marginActionKind(action));
}

/** Whether this action is parent-driven against a named child. */
export function isMarginChildAction(action: MarginAction): action is MarginChildAction {
  return CHILD_ACTION_KINDS.has(marginActionKind(action));
}

// ── Factories ───────────────────────────────────────────────────────

/** Draw `amount` raw collateral units against the line. */
export function drawAction(amount: bigint | string): DrawAction {
  return { Draw: { amount: amount.toString() } };
}

/** Hand `amount` raw collateral units of drawn quote back to the pool. */
export function returnQuoteAction(amount: bigint | string): ReturnQuoteAction {
  return { ReturnQuote: { amount: amount.toString() } };
}

/** Borrow `amount` base units of `assetId` in kind. */
export function borrowAction(assetId: Hex, amount: bigint | string): BorrowAction {
  return { Borrow: { asset_id: assetId, amount: amount.toString() } };
}

/** Repay `amount` base units of an in-kind debt. */
export function repayAction(assetId: Hex, amount: bigint | string): RepayAction {
  return { Repay: { asset_id: assetId, amount: amount.toString() } };
}

/** Net `amount` of drawn quote against posted collateral. */
export function repayFromCollateralAction(amount: bigint | string): RepayFromCollateralAction {
  return { RepayFromCollateral: { amount: amount.toString() } };
}

/** Convert an in-kind debt directly out of collateral. */
export function repayBaseFromCollateralAction(
  assetId: Hex,
  amount: bigint | string,
): RepayBaseFromCollateralAction {
  return { RepayBaseFromCollateral: { asset_id: assetId, amount: amount.toString() } };
}

/** Buy `times` extra periods of session life. */
export function prolongSessionAction(
  period: ProlongPeriod,
  times: bigint | string | number = 1,
): ProlongSessionAction {
  return { ProlongSession: { period, times: times.toString() } };
}

/** Arm or disarm auto-extension. */
export function setAutoProlongAction(period: ProlongPeriod | null): SetAutoProlongAction {
  return { SetAutoProlong: { period } };
}

/** Move `amount` of on-account coins into posted collateral. */
export function addCollateralAction(amount: bigint | string): AddCollateralAction {
  return { AddCollateral: { amount: amount.toString() } };
}

/** Withdraw `amount` of `assetId` from the margin account to the parent. */
export function withdrawFromMarginAction(
  assetId: Hex,
  amount: bigint | string,
): WithdrawFromMarginAction {
  return { WithdrawFromMargin: { asset_id: assetId, amount: amount.toString() } };
}

/** Open a session on `marginAccountId`, forwarding `collateral`. */
export function startMarginSessionAction(
  marginAccountId: Hex,
  tierId: number | string,
  collateral: bigint | string,
  period: ProlongPeriod,
): StartMarginSessionAction {
  return {
    StartMarginSession: {
      margin_account_id: marginAccountId,
      tier_id: tierId.toString(),
      amount: collateral.toString(),
      period,
    },
  };
}

/** Top up a live child session, straight at the pool. */
export function addMarginCollateralAction(
  marginAccountId: Hex,
  amount: bigint | string,
): AddMarginCollateralAction {
  return {
    AddMarginCollateral: { margin_account_id: marginAccountId, amount: amount.toString() },
  };
}

/** Close a child session cleanly. */
export function closeMarginSessionAction(
  marginAccountId: Hex,
  cleanups: OrderBookCleanup[] = [],
): CloseMarginSessionAction {
  return { CloseMarginSession: { margin_account_id: marginAccountId, cleanups } };
}

/** Withdraw from the child to the parent. */
export function withdrawFromMarginAccountAction(
  marginAccountId: Hex,
  assetId: Hex,
  amount: bigint | string,
): WithdrawFromMarginAccountAction {
  return {
    WithdrawFromMarginAccount: {
      margin_account_id: marginAccountId,
      asset_id: assetId,
      amount: amount.toString(),
    },
  };
}

/** Arm a session key on the child. */
export function setMarginAccountSessionAction(params: {
  marginAccountId: Hex;
  marginNonce: string;
  sessionId: Identity;
  expiry: number | string;
}): SetMarginAccountSessionAction {
  return {
    SetMarginAccountSession: {
      margin_account_id: params.marginAccountId,
      margin_nonce: params.marginNonce,
      session_id: params.sessionId,
      expiry: params.expiry.toString(),
    },
  };
}

/** Revoke the child's session key. */
export function revokeMarginAccountSessionAction(
  marginAccountId: Hex,
  marginNonce: string,
): RevokeMarginAccountSessionAction {
  return {
    RevokeMarginAccountSession: {
      margin_account_id: marginAccountId,
      margin_nonce: marginNonce,
    },
  };
}

/** Register a predicted child at `index`. */
export function registerMarginAccountAction(
  marginAccountId: Hex,
  index: number | string,
): RegisterMarginAccountAction {
  return {
    RegisterMarginAccount: { margin_account_id: marginAccountId, index: index.toString() },
  };
}
