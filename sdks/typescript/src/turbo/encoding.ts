/**
 * Byte-exact call derivation for margin ("Turbo") actions.
 *
 * THIS FILE IS THE LOAD-BEARING ONE. The backend does not take the client's
 * word for what a typed action means: it re-derives the contract call from
 * the action itself and verifies the session signature against ITS
 * derivation. So the SDK cannot send intent — every byte below has to match
 * what `SessionCallRequest::to_call` produces, or the batch is rejected
 * after the user has signed.
 *
 * The encodings are Sway ABI v1 and were verified against the deployed
 * margin ABIs rather than read off a spec:
 *
 * - `u64` → 8 bytes big-endian
 * - `u256` → 32 bytes big-endian
 * - `b256` / `AssetId` / `ContractId` → 32 bytes (no wrapper)
 * - `Identity` → `u64` discriminant (0 = Address, 1 = ContractId) + 32 bytes
 * - a unit enum variant → `u64` discriminant, no payload
 * - `Option<T>` → `u64(0)`, or `u64(1)` + encoded `T`
 * - `Vec<T>` → `u64(len)` + each element inline
 * - a struct → its fields concatenated, no header
 *
 * @module
 */

import type { ContractCall } from "../encoding.js";
import { concat, functionSelector, GAS_MAX, hexToBytes, u64BE } from "../encoding.js";
import type { Identity } from "../models.js";
import type { MarginAction } from "./actions.js";
import { marginActionKind } from "./actions.js";
import type { Hex, OrderBookCleanup, ProlongPeriod } from "./wire.js";
import { prolongPeriodIndex } from "./wire.js";

/** The 32 zero bytes used as the asset id when a call forwards nothing. */
const ZERO_ASSET = new Uint8Array(32);

/**
 * The deployment's margin wiring.
 *
 * Every contract id that is not the named child is resolved from here, the
 * same way the backend resolves it server-side — a client that guessed one
 * would produce a call the signature check rejects.
 */
export interface MarginWiring {
  /** The margin pool contract. */
  poolId: Hex;
  /** The trade-account registry, which `RegisterMarginAccount` targets. */
  registryId: Hex;
  /** The asset the credit line is denominated in. */
  collateralAssetId: Hex;
  /**
   * The PARENT trade account.
   *
   * `RegisterMarginAccount` encodes it as the parent identity, and the
   * backend always uses the signing account rather than anything the client
   * supplies — so passing a different one only produces a rejected batch.
   */
  parentAccountId: Hex;
  /**
   * The margin child this batch is submitted AS.
   *
   * Required only for pool actions ({@link isMarginPoolAction}), which the
   * child signs for itself; `AddCollateral` encodes it as the funded
   * account.
   */
  marginAccountId?: Hex;
}

/** Encode a `u256` as 32 big-endian bytes. */
export function u256BE(value: bigint | string): Uint8Array {
  let n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n) throw new Error("u256 cannot be negative");
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0n; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n > 0n) throw new Error("value does not fit in u256");
  return out;
}

/** Encode a Fuel `Identity`: discriminant + 32 bytes. */
export function encodeWireIdentity(identity: Identity): Uint8Array {
  const asRecord = identity as unknown as Record<string, unknown>;
  const isContract = "ContractId" in asRecord;
  const raw = (asRecord.ContractId ?? asRecord.Address) as unknown;
  if (raw === undefined || raw === null) {
    throw new Error(`Identity must carry an Address or ContractId: ${JSON.stringify(identity)}`);
  }
  // Accept both the bare wire shape (`{ Address: "0x…" }`) and the SDK's
  // wrapped one (`{ Address: { bits: "0x…" } }`) — callers hold one or the
  // other depending on where the identity came from.
  const hex = typeof raw === "string" ? raw : ((raw as { bits?: string }).bits ?? "");
  if (!hex) {
    throw new Error(`Identity payload is not a hex string: ${JSON.stringify(identity)}`);
  }
  return concat([u64BE(isContract ? 1 : 0), hexToBytes(hex)]);
}

/** Encode a unit enum variant: just its discriminant. */
function encodePeriod(period: ProlongPeriod): Uint8Array {
  return u64BE(prolongPeriodIndex(period));
}

/** Encode `Option<ProlongPeriod>`. */
function encodeOptionalPeriod(period: ProlongPeriod | null | undefined): Uint8Array {
  if (period === null || period === undefined) return u64BE(0);
  return concat([u64BE(1), encodePeriod(period)]);
}

/** Encode `Vec<PropOrderBookCleanup>`. */
function encodeCleanups(cleanups: OrderBookCleanup[]): Uint8Array {
  const parts: Uint8Array[] = [u64BE(cleanups.length)];
  for (const cleanup of cleanups) {
    parts.push(hexToBytes(cleanup.order_book_id));
    parts.push(u64BE(cleanup.order_ids.length));
    for (const id of cleanup.order_ids) parts.push(hexToBytes(id));
  }
  return concat(parts);
}

/**
 * Derive the contract call for one margin action.
 *
 * Mirrors `SessionCallRequest::to_call` exactly, including which calls
 * forward coins and which do not — the distinction is not incidental. A
 * `Repay` hands the coins over; a `RepayFromCollateral` moves none at all,
 * because it is two pool-side ledgers falling together rather than a
 * transfer.
 *
 * @throws if the wiring lacks a field this action needs.
 */
export function marginActionToCall(action: MarginAction, wiring: MarginWiring): ContractCall {
  const kind = marginActionKind(action);
  const pool = hexToBytes(wiring.poolId);
  const collateral = hexToBytes(wiring.collateralAssetId);
  const free = { amount: 0n, assetId: ZERO_ASSET };

  const call = (
    contractId: Uint8Array,
    name: string,
    callData: Uint8Array,
    coins: { amount: bigint; assetId: Uint8Array },
  ): ContractCall => ({
    contractId,
    functionSelector: functionSelector(name),
    amount: coins.amount,
    assetId: coins.assetId,
    gas: GAS_MAX,
    callData,
  });

  // Narrowed with `in` rather than a cast: each branch then reads its own
  // fields with the compiler checking them.
  if ("Draw" in action) {
    return call(pool, "draw", u64BE(BigInt(action.Draw.amount)), free);
  }

  // No call data: the amount IS the forwarded coins.
  if ("ReturnQuote" in action) {
    return call(pool, "return_quote", new Uint8Array(0), {
      amount: BigInt(action.ReturnQuote.amount),
      assetId: collateral,
    });
  }

  if ("Borrow" in action) {
    return call(
      pool,
      "borrow",
      concat([hexToBytes(action.Borrow.asset_id), u64BE(BigInt(action.Borrow.amount))]),
      free,
    );
  }

  if ("Repay" in action) {
    return call(pool, "repay", new Uint8Array(0), {
      amount: BigInt(action.Repay.amount),
      assetId: hexToBytes(action.Repay.asset_id),
    });
  }

  // No coins ride it: the netting is two pool-side ledgers falling together.
  if ("RepayFromCollateral" in action) {
    return call(
      pool,
      "repay_from_collateral",
      u64BE(BigInt(action.RepayFromCollateral.amount)),
      free,
    );
  }

  // No coins either: the pool takes the quote out of collateral.
  if ("RepayBaseFromCollateral" in action) {
    return call(
      pool,
      "repay_base_from_collateral",
      concat([
        hexToBytes(action.RepayBaseFromCollateral.asset_id),
        u64BE(BigInt(action.RepayBaseFromCollateral.amount)),
      ]),
      free,
    );
  }

  if ("ProlongSession" in action) {
    return call(
      pool,
      "prolong_session",
      concat([
        encodePeriod(action.ProlongSession.period),
        u64BE(BigInt(action.ProlongSession.times)),
      ]),
      free,
    );
  }

  if ("SetAutoProlong" in action) {
    return call(pool, "set_auto_prolong", encodeOptionalPeriod(action.SetAutoProlong.period), free);
  }

  if ("AddCollateral" in action) {
    // The funded account is the child signing this batch — the pool's
    // `add_collateral` is permissionless for a funder holding no session of
    // its own, so the id is always the caller's own.
    if (!wiring.marginAccountId) {
      throw new Error("AddCollateral needs wiring.marginAccountId");
    }
    return call(pool, "add_collateral", hexToBytes(wiring.marginAccountId), {
      amount: BigInt(action.AddCollateral.amount),
      assetId: collateral,
    });
  }

  if ("WithdrawFromMargin" in action) {
    return call(
      pool,
      "withdraw",
      concat([
        hexToBytes(action.WithdrawFromMargin.asset_id),
        u64BE(BigInt(action.WithdrawFromMargin.amount)),
      ]),
      free,
    );
  }

  // ── Child actions — signed as the PARENT ───────────────────────────
  if ("StartMarginSession" in action) {
    const s = action.StartMarginSession;
    return call(
      hexToBytes(s.margin_account_id),
      "start_session",
      concat([u64BE(BigInt(s.tier_id)), u64BE(BigInt(s.amount)), encodePeriod(s.period)]),
      { amount: BigInt(s.amount), assetId: collateral },
    );
  }

  // Straight to the POOL, never touching the child.
  if ("AddMarginCollateral" in action) {
    const s = action.AddMarginCollateral;
    return call(pool, "add_collateral", hexToBytes(s.margin_account_id), {
      amount: BigInt(s.amount),
      assetId: collateral,
    });
  }

  if ("CloseMarginSession" in action) {
    const s = action.CloseMarginSession;
    return call(
      hexToBytes(s.margin_account_id),
      "close_session",
      encodeCleanups(s.cleanups ?? []),
      free,
    );
  }

  if ("WithdrawFromMarginAccount" in action) {
    const s = action.WithdrawFromMarginAccount;
    return call(
      hexToBytes(s.margin_account_id),
      "withdraw",
      concat([hexToBytes(s.asset_id), u64BE(BigInt(s.amount))]),
      free,
    );
  }

  if ("SetMarginAccountSession" in action) {
    const s = action.SetMarginAccountSession;
    return call(
      hexToBytes(s.margin_account_id),
      "set_session",
      concat([
        u256BE(s.margin_nonce),
        encodeWireIdentity(s.session_id),
        u64BE(BigInt(s.expiry)),
        // The contract overwrites the contract list with "empty"; this is
        // sent for ABI shape only.
        u64BE(0),
      ]),
      free,
    );
  }

  if ("RevokeMarginAccountSession" in action) {
    const s = action.RevokeMarginAccountSession;
    return call(hexToBytes(s.margin_account_id), "revoke_session", u256BE(s.margin_nonce), free);
  }

  if ("RegisterMarginAccount" in action) {
    const s = action.RegisterMarginAccount;
    // The parent identity is always the signing account. The registry also
    // requires the caller to BE the named parent, so a payload cannot bind
    // a proxy to someone else.
    return call(
      hexToBytes(wiring.registryId),
      "prop_register_contract",
      concat([
        hexToBytes(s.margin_account_id),
        u64BE(1), // Identity::ContractId
        hexToBytes(wiring.parentAccountId),
        u64BE(BigInt(s.index)),
      ]),
      free,
    );
  }

  throw new Error(`Not a margin action: ${kind}`);
}
