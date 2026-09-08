/**
 * The session's RISK LINES — where liquidation sits, and where the pool
 * stops admitting new exposure.
 *
 * Two regimes. A LEGACY session reads the tier's static `threshold` and
 * `k + open_buffer`. A PREPAID ("Turbo cohort") session replaces both with
 * an ANCHORED floor derived from the tier's drawdown allowance — it is
 * allowed to reach below `k + maintenance`, and below `k` itself.
 *
 * Reading the wrong regime is not cosmetic: these lines produce the
 * per-order concession budget, so getting them wrong either blocks orders
 * the chain would take or signs orders it then rejects.
 *
 * @module
 */

import { big } from "./formulas.js";
import type {
  MarginRolloverWire,
  MarginStateWire,
  MarginTierWire,
  TurboTermsWire,
} from "./wire.js";
import { marginSession } from "./wire.js";

/** The session's parsed rollover position, or null when it has none. */
export interface TurboRollover {
  anchor: bigint;
  withdrawn: bigint;
  outside: bigint;
  rolloversUsed: bigint;
  maxRollovers: bigint;
  profitRequired: bigint;
  eligibleNow: boolean;
}

/** Parse the rollover block off the wire. */
export function marginRolloverOf(wire: MarginStateWire | null | undefined): TurboRollover | null {
  const raw: MarginRolloverWire | undefined = wire?.rollover;
  if (!raw) return null;
  return {
    anchor: big(raw.anchor),
    withdrawn: big(raw.withdrawn),
    outside: big(raw.outside),
    rolloversUsed: big(raw.rollovers_used),
    maxRollovers: big(raw.max_rollovers),
    profitRequired: big(raw.profit_required),
    eligibleNow: raw.eligible_now === true,
  };
}

/** The tier's prepaid terms, when it has them. */
export function turboTermsOf(tier: MarginTierWire | null | undefined): TurboTermsWire | null {
  return tier?.turbo ?? null;
}

/** Whether the tier actually offers a drawdown allowance. */
function drawdownOffered(terms: TurboTermsWire | null): boolean {
  if (!terms) return false;
  return terms.max_loss_bps.some((bps) => big(bps) > 0n);
}

/** The drawdown allowance in bps for a given number of rollovers used. */
function drawdownBps(terms: TurboTermsWire, rolloversUsed: bigint): bigint {
  const table = terms.max_loss_bps;
  const index = rolloversUsed < 0n ? 0 : Number(rolloversUsed);
  const clamped = index >= table.length ? table.length - 1 : index;
  return big(table[clamped]);
}

/**
 * Which regime this session is on.
 *
 * The session states it outright when it can; otherwise the tier carrying
 * prepaid terms is what decides.
 */
export function marginCohortOf(wire: MarginStateWire | null | undefined): "legacy" | "turbo" {
  const session = marginSession(wire);
  if (session?.cohort === "Turbo") return "turbo";
  if (session?.cohort === "Legacy") return "legacy";
  return turboTermsOf(wire?.tier) ? "turbo" : "legacy";
}

/**
 * The anchored loss floor, or null when this session has none.
 *
 * `line - line * drawdown_bps / 10_000`, never below zero.
 */
export function turboLossFloor(
  tier: MarginTierWire | null | undefined,
  terms: TurboTermsWire | null,
  rollover: TurboRollover | null,
): bigint | null {
  if (!tier || !terms || !rollover) return null;
  if (!drawdownOffered(terms)) return null;
  const line = big(tier.line);
  const allowance = (line * drawdownBps(terms, rollover.rolloversUsed)) / 10_000n;
  const floor = line - allowance;
  return floor < 0n ? 0n : floor;
}

/**
 * The LIVE liquidation threshold, in `V`.
 *
 * The anchored line where one applies, else the tier's static `threshold`.
 * Every legacy session reads the static value bit for bit.
 */
export function marginLiquidationLine(wire: MarginStateWire | null | undefined): bigint {
  const tier = wire?.tier;
  if (!tier) return 0n;
  const floor = turboLossFloor(tier, turboTermsOf(tier), marginRolloverOf(wire));
  return floor ?? big(tier.threshold);
}

/**
 * The LIVE freeze line, in `V` — below it no new risk is admitted.
 *
 * Under the anchored regime it sits one `open_buffer - maintenance` gap
 * above whatever the threshold turned out to be, which is what keeps
 * `freeze > threshold` true in both regimes and at every price. The legacy
 * branch is `k + open_buffer`, untouched.
 */
export function marginFreezeLine(wire: MarginStateWire | null | undefined): bigint {
  const tier = wire?.tier;
  if (!tier) return 0n;
  const floor = turboLossFloor(tier, turboTermsOf(tier), marginRolloverOf(wire));
  if (floor === null) return big(tier.k) + big(tier.open_buffer);
  return floor + (big(tier.open_buffer) - big(tier.maintenance));
}
