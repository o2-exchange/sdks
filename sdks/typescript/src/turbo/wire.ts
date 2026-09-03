/**
 * Wire types for the O2 margin ("Turbo") surface.
 *
 * These mirror the shapes served by `/v1/margin/*` on the O2 API. They are
 * transcribed rather than inferred: every figure below is RAW — quantities
 * in their own asset's base units, prices 1e18-scaled, and everything
 * collateral-denominated in the collateral asset's base units, whose scale
 * is `collateral_decimals` on the state wire.
 *
 * @module
 */

/** A 0x-prefixed hex string. */
export type Hex = `0x${string}`;

/** Identity as the margin wire serves it — a bare hex, not `{ bits }`. */
export type WireIdentity = { Address: Hex } | { ContractId: Hex };

/**
 * How much session life one purchase buys.
 *
 * The opener always buys a term on top of the tier's base `duration`, so a
 * tier with a week-long duration opened with `"Week"` runs a fortnight.
 */
export type ProlongPeriod = "SixHours" | "Day" | "Week" | "Month";

/** All four periods, in the order the tier's fee/seconds arrays use. */
export const PROLONG_PERIODS: readonly ProlongPeriod[] = [
  "SixHours",
  "Day",
  "Week",
  "Month",
] as const;

/** Index of a period in the tier's `prolong_fee` / `prolong_seconds` arrays. */
export function prolongPeriodIndex(period: ProlongPeriod): number {
  const index = PROLONG_PERIODS.indexOf(period);
  if (index < 0) throw new Error(`Unknown prolong period: ${period}`);
  return index;
}

/**
 * The prepaid ("Turbo cohort") terms a tier may carry.
 *
 * Absent on a legacy tier, and its absence is what puts a session on the
 * legacy branch of every risk line — see {@link marginCohortOf}.
 */
export interface TurboTermsWire {
  forfeit_collateral: boolean;
  /** Drawdown allowance in bps of the line, indexed by rollovers used. */
  max_loss_bps: [string, string, string, string];
  rollover_profit_bps: string;
  max_rollovers: string;
  rollover_window_seconds?: string;
  term_seconds?: string;
}

/** The session's rollover position. Absent on every legacy session. */
export interface MarginRolloverWire {
  anchor: string;
  withdrawn: string;
  outside: string;
  rollovers_used: string;
  max_rollovers: string;
  profit_required: string;
  eligible_now: boolean;
}

/** One published tier version — the product a Turbo account is opened onto. */
export interface MarginTierWire {
  tier_id: number;
  version: number;
  /** The credit line the tier sells, raw collateral units. */
  line: string;
  leverage: string;
  /** Base session life in seconds, before the opener's purchased period. */
  duration: string;
  /** Collateral required to open, raw collateral units. */
  required_collateral: string;
  /** The platform capital constant `k`. */
  k: string;
  maintenance_bps: string | number;
  open_buffer_bps: string | number;
  liq_price_factor: string | number;
  maintenance: string;
  open_buffer: string;
  threshold: string;
  open_fee: string;
  /** Per-period prolong fee, indexed by {@link prolongPeriodIndex}. */
  prolong_fee: [string, string, string, string];
  prolong_seconds: [string, string, string, string] | string[];
  auto_prolong_periods: ProlongPeriod[];
  profit_share_bps: string | number;
  /** The CONCESSION band, not the stress band. */
  price_band_bps: string | number;
  max_credit_line_bps: string | number;
  max_price_age: string | number;
  /** Order books this tier may trade. */
  books: Hex[];
  /** Assets this tier may hold, and the only ones it may short. */
  assets: Hex[];
  turbo?: TurboTermsWire;
  enabled?: boolean;
}

/** The live session on a margin account. */
export interface MarginSessionWire {
  session_id: string | number;
  tier_id: string | number;
  tier_version: string | number;
  parent: WireIdentity;
  /** Collateral posted, raw collateral units. */
  collateral: string;
  /** The credit line this session actually got. */
  credit_line: string;
  /** Quote drawn against the line and not yet returned. */
  drawn_quote: string;
  /** In-kind debts, per asset. */
  debt: [Hex, string][] | Record<string, string | number> | null;
  fees_accrued: string;
  /** Topped-up margin. */
  capitalised: string;
  decapitalised?: string;
  started_at?: string | number;
  expires_at?: string | number;
  auto_prolong?: ProlongPeriod | null;
  assets?: Hex[];
  cohort?: "Turbo" | "Legacy" | string;
}

/** Sessions arrive version-enveloped. */
export type MarginSessionEnvelope =
  | { V1: MarginSessionWire }
  | { V2: MarginSessionWire }
  | MarginSessionWire;

/** One asset's balances on a margin account. */
export interface MarginAssetBalanceWire {
  asset_id: Hex;
  /** Coins physically on the account — what the chain's custody check counts. */
  on_account: string;
  received: string;
  /** Escrowed under resting orders. */
  locked: string;
  /** Settled on a book, not yet swept home. */
  settled: string;
  /** In-kind debt to the pool. */
  debt: string;
}

/** One oracle print. Prices are 1e18-scaled. */
export interface MarginPriceWire {
  asset_id: Hex;
  bid: string;
  ask: string;
  asset_decimals: number;
  timestamp: number;
  stale: boolean;
}

/** Everything the API knows about one margin account. */
export interface MarginStateWire {
  margin_account: Hex;
  parent: WireIdentity;
  index: number;
  pool: Hex | null;
  /** Server time. Use this, never the client clock. */
  now: number;
  /**
   * The collateral asset's decimals, as the pool is configured.
   *
   * Served rather than inferred: it is per-deployment and getting it wrong
   * is silent and off by orders of magnitude.
   */
  collateral_decimals: number;
  session?: MarginSessionEnvelope;
  tier?: MarginTierWire;
  rollover?: MarginRolloverWire;
  balances: MarginAssetBalanceWire[];
  prices: MarginPriceWire[];
}

/** The pool's own inventory and pause flag. */
export interface MarginPoolWire {
  pool_id?: Hex;
  paused?: boolean;
  inventory: { asset_id: Hex; amount: string }[];
}

/** A predicted (or existing) margin child. */
export interface NextMarginAccount {
  contract_id: Hex;
  index: number;
}

/** One book still holding something of the account's, for a clean close. */
export interface OrderBookCleanup {
  order_book_id: Hex;
  order_ids: Hex[];
}

/**
 * Unwrap the session from whatever envelope it arrived in.
 *
 * Version-agnostic on purpose: the fields read here have been stable across
 * V1 and V2, so pinning a version costs a blank account on the next bump
 * and buys nothing.
 */
export function marginSession(wire: MarginStateWire | null | undefined): MarginSessionWire | null {
  const session = wire?.session;
  if (!session) return null;
  if ("V2" in session) return session.V2 as MarginSessionWire;
  if ("V1" in session) return session.V1 as MarginSessionWire;
  return session as MarginSessionWire;
}

/** Lowercase a hex id for comparison. */
export function normaliseHex(id: string): Hex {
  const value = id.startsWith("0x") ? id : `0x${id}`;
  return value.toLowerCase() as Hex;
}

/**
 * Compare two hex ids.
 *
 * Not decorative: tier asset lists come back as BARE hex while market ids
 * carry `0x`, so a plain `===` matches nothing and every market reads as
 * allowed.
 */
export function sameHex(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normaliseHex(a) === normaliseHex(b);
}
