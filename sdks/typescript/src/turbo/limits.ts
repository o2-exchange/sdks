/**
 * EVERY on-chain gate a Turbo order must clear, derived once from one wire
 * snapshot.
 *
 * The pool evaluates loan cap, pool float, exposure, the stress band and the
 * short reserve against a SINGLE state, so this does too — and the three
 * call sites (the account snapshot, the size ceiling, the funding prefix)
 * read the same answer. Modelling fewer gates than the pool enforces is how
 * a client signs a batch the chain refuses, one rejection at a time.
 *
 * The API serves inputs rather than conclusions precisely so a client can
 * reach the same verdict the validator will.
 *
 * @module
 */

import { abs, big, max, min, scaleFor, value, valueCeil } from "./formulas.js";
import { marginCohortOf, marginFreezeLine, marginLiquidationLine } from "./terms.js";
import type { Hex, MarginStateWire } from "./wire.js";
import { marginSession, normaliseHex } from "./wire.js";

/** One priced asset, reduced to the two signed quantities the formulas use. */
interface PricedLeg {
  /** `pos = holdings - debt`, signed. */
  pos: bigint;
  /** `eff_pos = pos - locked` — where a resting SELL would land it. */
  effPos: bigint;
  bid: bigint;
  ask: bigint;
  decimals: number;
}

/** The full gate stack, in raw collateral units unless stated. */
export interface MarginLimits {
  /** Collateral-asset cash on the account and settled on books. */
  cash: bigint;
  /**
   * Cash held AS COINS, excluding what is settled on a book — the figure
   * the chain's custody check counts.
   *
   * A batch sweeps only the market it names, so settled quote on ANOTHER
   * book is not home by the time the order runs.
   */
  onAccountCash: bigint;
  /**
   * `formulas::reserve` — what buying back EVERY short would cost at the
   * ask. Cash below this is committed, not available.
   */
  reserve: bigint;
  /** Cash that may actually be SPENT: `max(0, cash - reserve)`. */
  spendableCash: bigint;
  /** What a `Draw` may take: the loan cap, capped by the pool's float. */
  drawable: bigint;
  /**
   * The most a BUY may cost: loan cap, pool float and exposure line,
   * whichever binds first. The stress freeze is NOT applied — see
   * {@link MarginLimits.stressFrozen}.
   */
  spendable: bigint;
  /**
   * True when an adverse band puts `V - k` under the freeze line. The chain
   * then allows only NON-WORSENING batches: closes, repays and cancels
   * still work, but nothing may add exposure.
   *
   * Reported here, enforced by consumers — {@link MarginLimits.spendable}
   * stays unclamped so the figure remains the line the trader was sold.
   */
  stressFrozen: boolean;
  /** `V - k` under the worst stress direction. */
  stressedEquity: bigint;
  /** `V - k` at spot — the trader's own money. */
  equity: bigint;
  /**
   * `V` at spot: everything the account is worth, before `k`.
   *
   * Exposed because the pool's liquidation test is stated in `V`, not in
   * equity — comparing equity against the tier's `maintenance` is only the
   * same thing on a legacy tier whose floor happens to be `k + maintenance`.
   */
  markToMarket: bigint;
  /**
   * The LIVE liquidation line, in `V` — the anchored floor plus its
   * absorption cushion on a prepaid session, the tier's static `threshold`
   * on a legacy one. `liquidatable` is `markToMarket <= this`.
   */
  liquidationThreshold: bigint;
  /**
   * How much value the account may CONCEDE before the batch-level
   * liquidation line refuses it: `max(0, V - threshold - 1)`, strict
   * because the chain liquidates AT the threshold.
   */
  giveawayAllowance: bigint;
  /** The tier's open buffer, carried through for consumers. */
  openBuffer: bigint;
  /** The stress band actually used, bps. */
  bandBps: number;
  /** Gross exposure at whichever pass values the book highest. */
  grossExposure: bigint;
  /** `max(0, line - gross_exposure)`. */
  exposureHeadroom: bigint;
  /** `require_loan_cap`: `max(0, line - drawn - in-kind debt at the ask)`. */
  loanHeadroom: bigint;
  /**
   * Drawn quote a batch may hand BACK to reopen the line before it borrows.
   *
   * The loan cap gives NO credit for cash the account holds, so after
   * closing a long the proceeds sit on the account while `drawn_quote`
   * still consumes the line. A `ReturnQuote` leg ahead of a `Borrow`
   * converts that cash back into line; this is how much it can hand over.
   */
  returnableQuote: bigint;
  /** The most collateral that can still be ADDED and still buy line. */
  collateralHeadroom: bigint;
}

/**
 * Read the whole gate stack off one wire snapshot.
 *
 * @param wire - The margin state.
 * @param poolFloat - The pool's inventory of the COLLATERAL asset, or
 *   `null` when not fetched. Null means "unknown", which reads as
 *   uncapped — the chain refuses independently.
 * @param stressBandBps - The band to stress at. Defaults to the tier's
 *   `price_band_bps`.
 * @param collateralAssetId - The collateral asset, named rather than
 *   inferred from the absence of a price. Strongly recommended: on a feed
 *   that prints a collateral price, inferring it puts the collateral into
 *   `legs`, zeroes `cash`, and reports an account holding thousands as
 *   having no buying power.
 * @returns The limits, or `null` when there is no live session to judge.
 */
export function marginLimits(
  wire: MarginStateWire | null | undefined,
  poolFloat: bigint | null,
  stressBandBps?: number,
  collateralAssetId?: Hex | null,
): MarginLimits | null {
  const session = marginSession(wire);
  if (!wire || !session || !wire.tier) return null;

  const cd = wire.collateral_decimals;
  const k = big(wire.tier.k);
  const line = big(session.credit_line);
  const drawn = big(session.drawn_quote);
  const collateral = big(session.collateral);
  const fees = big(session.fees_accrued);
  const openBuffer = big(wire.tier.open_buffer);
  // Coerced ONCE, at the edge: the wire serves this as a string and every
  // use below is arithmetic.
  const bandBps = Number(stressBandBps ?? wire.tier.price_band_bps);

  const priceOf = new Map(wire.prices.map((p) => [normaliseHex(p.asset_id), p]));

  // `formulas::holdings` for the COLLATERAL asset carries two terms that
  // exist nowhere on the balance rows: the undrawn line, and collateral
  // posted above what the line converted into credit.
  let cash = 0n;
  let onAccountCash = 0n;
  let collateralHoldings = 0n;
  let inKindDebt = 0n;
  let quoteLocked = 0n;
  const legs: PricedLeg[] = [];

  for (const row of wire.balances) {
    const held = big(row.on_account) + big(row.received) + big(row.locked) + big(row.settled);
    const isCollateral = collateralAssetId
      ? normaliseHex(row.asset_id) === normaliseHex(collateralAssetId)
      : !priceOf.get(normaliseHex(row.asset_id));
    const price = isCollateral ? undefined : priceOf.get(normaliseHex(row.asset_id));
    if (isCollateral || !price) {
      // Everything is priced AGAINST the collateral, so it has no leg.
      cash += big(row.on_account) + big(row.settled);
      onAccountCash += big(row.on_account);
      collateralHoldings += held;
      // Quote escrowed under resting BUYS counts toward gross exposure at
      // PAR — it becomes base the moment those orders fill.
      quoteLocked += big(row.locked);
      continue;
    }
    const debt = big(row.debt);
    const pos = held - debt;
    if (pos === 0n && debt === 0n) continue;
    legs.push({
      pos,
      effPos: pos - big(row.locked),
      bid: big(price.bid),
      ask: big(price.ask),
      decimals: price.asset_decimals,
    });
    inKindDebt += valueCeil(debt, big(price.ask), price.asset_decimals, cd);
  }
  collateralHoldings += line - drawn;
  // `equity_above_cap(collateral, k, credit_line)`.
  collateralHoldings += collateral + k - line;

  /** Shocks one leg's mark the way the band moves AGAINST the position. */
  const shock = (price: bigint, isShort: boolean): bigint => {
    if (bandBps <= 0) return price;
    const factor = isShort ? BigInt(10_000 + bandBps) : BigInt(10_000 - Math.min(bandBps, 10_000));
    return (price * factor) / 10_000n;
  };

  /**
   * `formulas::v` and `formulas::g` over one price view. The chain runs
   * BOTH directions because `V` marks at `pos` while `G` bounds at
   * `eff_pos`, and a long resting an oversized sell makes them disagree.
   */
  const evaluate = (
    stressed: boolean,
    direction: "marked" | "filled",
  ): { v: bigint; g: bigint } => {
    let v = collateralHoldings;
    let g = quoteLocked;
    for (const leg of legs) {
      const sign = direction === "marked" ? leg.pos : leg.effPos;
      const isShort = sign < 0n;
      const bid = stressed ? shock(leg.bid, isShort) : leg.bid;
      const ask = stressed ? shock(leg.ask, isShort) : leg.ask;
      // Longs floored at the bid, debts CEILED at the ask — never the mid.
      const signedValue = (qty: bigint): bigint =>
        qty >= 0n ? value(qty, bid, leg.decimals, cd) : -valueCeil(-qty, ask, leg.decimals, cd);
      v += signedValue(leg.pos);
      g += max(abs(signedValue(leg.effPos)), abs(signedValue(leg.pos)));
    }
    return { v: v - fees, g };
  };

  /**
   * `formulas::absorption_cost` — what unwinding this basket would cost the
   * pool.
   *
   * ASYMMETRIC, and the asymmetry is the point: a net HOLDING fetches only
   * `liq_price_factor` of its mark in a forced sale, while a net DEBT costs
   * the RECIPROCAL more to buy back.
   */
  const liqPriceFactor = big(wire.tier.liq_price_factor);
  const absorption = (stressed: boolean): bigint => {
    const factor = liqPriceFactor;
    if (factor <= 0n) return 0n;
    let cost = 0n;
    for (const leg of legs) {
      const isShort = leg.pos < 0n;
      const bid = stressed ? shock(leg.bid, isShort) : leg.bid;
      const ask = stressed ? shock(leg.ask, isShort) : leg.ask;
      if (leg.pos > 0n) {
        const held = value(leg.pos, bid, leg.decimals, cd);
        cost += (held * (10_000n - factor)) / 10_000n;
      } else if (isShort) {
        const owed = valueCeil(-leg.pos, ask, leg.decimals, cd);
        const gap = owed * (10_000n - factor);
        cost += gap / factor + (gap % factor === 0n ? 0n : 1n);
      }
    }
    return cost;
  };

  const spot = evaluate(false, "marked");
  const marked = evaluate(true, "marked");
  const filled = evaluate(true, "filled");

  const equity = spot.v - k;

  // On a prepaid tier the pool ADDS the absorption cost to its floor rather
  // than max-ing it into a static one. Mirroring only the floor leaves
  // every gate here BELOW the chain's line by exactly this number — the
  // wrong side to be on, and the one that makes every close come back
  // `PriceBelowLiquidation`. Legacy is untouched: no cost is added.
  const anchored = marginCohortOf(wire) === "turbo";
  const absorptionCost = anchored ? absorption(false) : 0n;
  const threshold = marginLiquidationLine(wire) + absorptionCost;
  const giveawayAllowance = max(0n, spot.v - threshold - 1n);

  const stressedEquity = min(marked.v, filled.v) - k;
  // The freeze line takes the SAME cushion its threshold does — adding it
  // to the threshold alone inverts the pair and puts freeze below
  // liquidation. Stressed, like the equity it is compared against.
  const stressFrozen =
    stressedEquity < marginFreezeLine(wire) + (anchored ? absorption(true) : 0n) - k;

  // `allowed = pre_exposure.max(credit_line)`, evaluated at whichever pass
  // values the book highest, since all three must pass.
  const grossExposure = max(spot.g, max(marked.g, filled.g));
  const exposureHeadroom = max(0n, line - grossExposure);

  const loanHeadroom = max(0n, line - drawn - inKindDebt);
  // A line is permission to borrow, not a guarantee the float exists.
  const drawable = poolFloat === null ? loanHeadroom : min(loanHeadroom, max(0n, poolFloat));

  // `formulas::reserve`: the buy-back cost of every SHORT leg, at the ask,
  // ceiled. Priced off `pos`, not `debt` — an account mid-borrow holds base
  // against its own debt, and only the NET short must be bought back.
  let reserve = 0n;
  for (const leg of legs) {
    if (leg.pos >= 0n) continue;
    reserve += valueCeil(-leg.pos, leg.ask, leg.decimals, cd);
  }

  // Check (3) is NON-WORSENING on `reserve - cash_held`, and a batch moves
  // that gap by `escrow - draw`. So the most a buy may escrow is the draw
  // plus whatever cash stands ABOVE the reserve.
  const spendableCash = max(0n, cash - reserve);
  const spendable = min(spendableCash + drawable, exposureHeadroom);

  const returnableQuote = min(drawn, min(onAccountCash, spendableCash));

  // `max_credit_line_bps` is a multiple of the tier line (20_000 = 2x).
  const lineCap = (big(wire.tier.line) * big(wire.tier.max_credit_line_bps)) / 10_000n;
  const netCollateral = collateral - fees;
  const collateralHeadroom = max(0n, lineCap - k - max(0n, netCollateral));

  return {
    cash,
    onAccountCash,
    reserve,
    markToMarket: spot.v,
    liquidationThreshold: threshold,
    spendableCash,
    drawable,
    spendable,
    stressFrozen,
    stressedEquity,
    equity,
    giveawayAllowance,
    openBuffer,
    bandBps,
    grossExposure,
    exposureHeadroom,
    loanHeadroom,
    returnableQuote,
    collateralHeadroom,
  };
}

/**
 * How much a Turbo buy must DRAW, in raw collateral units.
 *
 * Draw whatever the account's own spendable, on-account cash cannot cover.
 * `spendableCash` is `cash - reserve`, so an account carrying shorts has
 * none of it and this returns the WHOLE escrow. That is the point rather
 * than an accident — it makes both chain checks pass with room to spare:
 *
 * - CUSTODY: coins on the account must cover the escrow. Drawing the whole
 *   escrow satisfies it however stale the cash figure.
 * - RESERVE: the batch may not widen `reserve - cash_held`. Draw the escrow
 *   and no cash leaves on net, so it cannot widen.
 *
 * Over-drawing is close to free — drawn quote is value-neutral, `drawable`
 * bounds it, and the repay after a close hands it straight back. A rule
 * that cannot be wrong by a few dollars is worth more than one that borrows
 * a few dollars less.
 *
 * Both constraints bind, whichever comes first: `spendableCash` is
 * authoritative for "not committed to a short buy-back", `onAccountCash`
 * for "actually forwardable".
 */
export function marginDrawAmount(limits: MarginLimits, quoteCost: bigint): bigint {
  const own = min(limits.spendableCash, limits.onAccountCash);
  return quoteCost > own ? quoteCost - own : 0n;
}

/** The base a session HOLDS of one asset and may sell outright. */
export function marginSellableBase(wire: MarginStateWire | null | undefined, assetId: Hex): bigint {
  const row = wire?.balances.find(
    (entry) => normaliseHex(entry.asset_id) === normaliseHex(assetId),
  );
  return row ? big(row.on_account) + big(row.settled) : 0n;
}

/**
 * The base a session may BORROW of one asset, in that asset's own units.
 *
 * A short on a Turbo account is not "sell what you hold" — the account
 * holds nothing until it buys, because the collateral went to the POOL. It
 * is `pool.borrow(asset, qty)` followed by a sell in the same batch. Three
 * pool gates bound it: the tier's asset set, the pool's actual inventory,
 * and the loan cap (which charges the borrow at the ASK, unshocked). The
 * exposure line applies too, priced at the shocked ask.
 *
 * A missing price or inventory row reads as ZERO, not unlimited: it means
 * the pool has nothing of this asset to lend, which is the answer.
 */
export function marginBorrowableBase(
  wire: MarginStateWire | null | undefined,
  limits: MarginLimits | null,
  assetId: Hex,
  poolInventory: ReadonlyMap<Hex, bigint> | null,
): bigint {
  if (!wire || !limits || !wire.tier) return 0n;
  const asset = normaliseHex(assetId);

  // The collateral asset is drawn, never borrowed — the contract says so
  // itself: `require(asset != COLLATERAL_ASSET, UseDrawInstead)`.
  const price = wire.prices.find((p) => normaliseHex(p.asset_id) === asset);
  if (!price) return 0n;

  if (!wire.tier.assets.some((a) => normaliseHex(a) === asset)) return 0n;

  const ask = big(price.ask);
  if (ask <= 0n) return 0n;

  const scale = scaleFor(price.asset_decimals, wire.collateral_decimals);
  // FLOOR both: borrowing the rounded-up quantity is the one that gets
  // refused, and a ceiling the trader cannot reach is worse than one a
  // shade under.
  //
  // `returnableQuote` counts toward the cap because the borrow prefix hands
  // that cash back in the SAME batch, so the line it frees is real headroom
  // at execution time.
  const byLoanCap = ((limits.loanHeadroom + limits.returnableQuote) * scale) / ask;

  const shockedAsk = limits.bandBps > 0 ? (ask * BigInt(10_000 + limits.bandBps)) / 10_000n : ask;
  const byExposure = (limits.exposureHeadroom * scale) / shockedAsk;

  const inventory = poolInventory?.get(asset) ?? 0n;

  return max(0n, min(min(byLoanCap, byExposure), inventory));
}

/**
 * The most of one asset a session may SELL: what it holds, plus what it can
 * borrow to sell short.
 *
 * This is the figure a "max sell" control must show. Holdings alone offer
 * zero on a fresh Turbo account — which holds nothing by construction —
 * while it advertises a full credit line.
 */
export function marginShortableBase(
  wire: MarginStateWire | null | undefined,
  limits: MarginLimits | null,
  assetId: Hex,
  poolInventory: ReadonlyMap<Hex, bigint> | null,
): bigint {
  return (
    marginSellableBase(wire, assetId) + marginBorrowableBase(wire, limits, assetId, poolInventory)
  );
}
