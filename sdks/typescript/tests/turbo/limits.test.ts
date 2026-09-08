/**
 * The gate stack. These exercise the rules the pool actually enforces, so
 * a change that makes the SDK offer sizes the chain refuses fails here.
 */

import { describe, expect, it } from "vitest";
import { scaleDecimalString, scaleFor, value, valueCeil } from "../../src/turbo/formulas.js";
import {
  marginBorrowableBase,
  marginDrawAmount,
  marginLimits,
  marginSellableBase,
  marginShortableBase,
} from "../../src/turbo/limits.js";
import type { Hex, MarginStateWire } from "../../src/turbo/wire.js";

const COLLATERAL = "0xcccc000000000000000000000000000000000000000000000000000000000000" as Hex;
const ETH = "0xeeee000000000000000000000000000000000000000000000000000000000000" as Hex;
const CHILD = "0x1111000000000000000000000000000000000000000000000000000000000000" as Hex;

/** 6-decimal collateral (USDC-shaped), 9-decimal base, 1e18 prices. */
const CD = 6;

function wire(overrides: Partial<MarginStateWire> = {}): MarginStateWire {
  return {
    margin_account: CHILD,
    parent: { ContractId: CHILD },
    index: 0,
    pool: "0xpool" as unknown as Hex,
    now: 1_700_000_000,
    collateral_decimals: CD,
    session: {
      session_id: 1,
      tier_id: 1,
      tier_version: 1,
      parent: { ContractId: CHILD },
      collateral: "500000000", // 500 units at 1e6
      credit_line: "5000000000", // 5,000
      drawn_quote: "0",
      debt: null,
      fees_accrued: "0",
      capitalised: "0",
      expires_at: 1_700_003_600,
    },
    tier: {
      tier_id: 1,
      version: 1,
      line: "5000000000",
      leverage: "10",
      duration: "86400",
      required_collateral: "500000000",
      k: "0",
      maintenance_bps: 100,
      open_buffer_bps: 200,
      liq_price_factor: 9900,
      maintenance: "50000000",
      open_buffer: "100000000",
      threshold: "50000000",
      open_fee: "0",
      prolong_fee: ["0", "0", "0", "0"],
      prolong_seconds: ["21600", "86400", "604800", "2592000"],
      auto_prolong_periods: [],
      profit_share_bps: 0,
      price_band_bps: 0,
      max_credit_line_bps: 20_000,
      max_price_age: 60,
      books: [],
      assets: [ETH],
    },
    balances: [
      {
        asset_id: COLLATERAL,
        on_account: "0",
        received: "0",
        locked: "0",
        settled: "0",
        debt: "0",
      },
    ],
    prices: [
      {
        asset_id: ETH,
        // $2,000 with 9-dec base against 6-dec collateral.
        bid: (2000n * 10n ** 18n).toString(),
        ask: (2000n * 10n ** 18n).toString(),
        asset_decimals: 9,
        timestamp: 1_700_000_000,
        stale: false,
      },
    ],
    ...overrides,
  };
}

describe("value scaling", () => {
  it("floors what is owned and ceils what is owed", () => {
    const price = 2000n * 10n ** 18n;
    // 1 ETH at 9 decimals.
    const one = 10n ** 9n;
    expect(value(one, price, 9, CD)).toBe(2000n * 10n ** BigInt(CD));
    expect(valueCeil(one, price, 9, CD)).toBe(2000n * 10n ** BigInt(CD));
    // A product that does not divide evenly rounds opposite ways — this
    // is the asymmetry the chain relies on, not a rounding detail.
    const ragged = price + 1n;
    expect(value(1n, ragged, 9, CD)).toBe(2n);
    expect(valueCeil(1n, ragged, 9, CD)).toBe(3n);
    // And zero stays zero on both sides.
    expect(valueCeil(0n, ragged, 9, CD)).toBe(0n);
  });

  it("scales by 18 + assetDecimals - collateralDecimals", () => {
    expect(scaleFor(9, 6)).toBe(10n ** 21n);
    expect(scaleFor(6, 6)).toBe(10n ** 18n);
  });
});

describe("marginLimits", () => {
  it("returns null without a live session", () => {
    expect(marginLimits({ ...wire(), session: undefined }, null, 0, COLLATERAL)).toBeNull();
    expect(marginLimits(null, null, 0, COLLATERAL)).toBeNull();
  });

  it("counts the UNDRAWN line as collateral holdings", () => {
    // A fresh account holds no coins at all — the collateral went to the
    // pool — yet its equity is the whole line, because `holdings` carries
    // the undrawn line and the collateral posted above it.
    const limits = marginLimits(wire(), null, 0, COLLATERAL);
    expect(limits).not.toBeNull();
    // line (5,000) + collateral (500) + k (0) - line = 500 + 5000 - 5000...
    // holdings = line - drawn + collateral + k - line = collateral.
    expect(limits?.equity).toBe(500_000000n);
    expect(limits?.cash).toBe(0n);
  });

  it("caps drawable by the pool float, and treats an unknown float as uncapped", () => {
    const capped = marginLimits(wire(), 1_000000n, 0, COLLATERAL);
    expect(capped?.drawable).toBe(1_000000n);
    const uncapped = marginLimits(wire(), null, 0, COLLATERAL);
    expect(uncapped?.drawable).toBe(5000_000000n);
  });

  it("charges drawn quote and in-kind debt against the loan cap", () => {
    const w = wire();
    (w.session as Record<string, string>).drawn_quote = "1000000000"; // 1,000
    const limits = marginLimits(w, null, 0, COLLATERAL);
    expect(limits?.loanHeadroom).toBe(4000_000000n);
  });

  it("reserves the buy-back cost of an open short, and refuses to call it spendable", () => {
    const w = wire({
      balances: [
        {
          asset_id: COLLATERAL,
          on_account: "2000000000", // 2,000 cash
          received: "0",
          locked: "0",
          settled: "0",
          debt: "0",
        },
        {
          asset_id: ETH,
          on_account: "0",
          received: "0",
          locked: "0",
          settled: "0",
          debt: (10n ** 9n).toString(), // owes 1 ETH
        },
      ],
    });
    const limits = marginLimits(w, null, 0, COLLATERAL);
    // Buying 1 ETH back at $2,000 costs 2,000 collateral units.
    expect(limits?.reserve).toBe(2000_000000n);
    expect(limits?.cash).toBe(2000_000000n);
    // Every dollar is committed to the buy-back, so none is spendable.
    expect(limits?.spendableCash).toBe(0n);
  });

  it("bounds returnableQuote by drawn, on-account cash AND the reserve", () => {
    const w = wire({
      balances: [
        {
          asset_id: COLLATERAL,
          on_account: "300000000",
          received: "0",
          locked: "0",
          settled: "700000000", // settled cash is not payable
          debt: "0",
        },
      ],
    });
    (w.session as Record<string, string>).drawn_quote = "900000000";
    const limits = marginLimits(w, null, 0, COLLATERAL);
    // min(drawn 900, onAccount 300, spendable 1000) = 300.
    expect(limits?.returnableQuote).toBe(300_000000n);
  });
});

describe("marginDrawAmount", () => {
  const base = {
    cash: 0n,
    onAccountCash: 0n,
    reserve: 0n,
    spendableCash: 0n,
    drawable: 10_000n,
    spendable: 10_000n,
    stressFrozen: false,
    stressedEquity: 0n,
    equity: 0n,
    giveawayAllowance: 0n,
    openBuffer: 0n,
    bandBps: 0,
    grossExposure: 0n,
    exposureHeadroom: 0n,
    loanHeadroom: 0n,
    returnableQuote: 0n,
    collateralHeadroom: 0n,
  };

  it("draws the whole escrow when the account holds nothing", () => {
    expect(marginDrawAmount(base, 5_000n)).toBe(5_000n);
  });

  it("draws only the shortfall when cash covers part of it", () => {
    expect(
      marginDrawAmount(
        { ...base, cash: 2_000n, onAccountCash: 2_000n, spendableCash: 2_000n },
        5_000n,
      ),
    ).toBe(3_000n);
  });

  it("draws nothing when spendable cash already covers the escrow", () => {
    expect(
      marginDrawAmount({ ...base, onAccountCash: 9_000n, spendableCash: 9_000n }, 5_000n),
    ).toBe(0n);
  });

  it("draws the WHOLE escrow when the cash is reserved behind a short", () => {
    // This is the rule that keeps both the custody and the reserve check
    // passing: cash committed to a buy-back is not the buyer's to spend.
    expect(
      marginDrawAmount({ ...base, cash: 9_000n, onAccountCash: 9_000n, spendableCash: 0n }, 5_000n),
    ).toBe(5_000n);
  });

  it("takes the BINDING constraint, never a re-derivation of one", () => {
    // On-account is authoritative for "forwardable", spendable for "not
    // committed" — the smaller wins.
    expect(
      marginDrawAmount({ ...base, onAccountCash: 1_000n, spendableCash: 4_000n }, 5_000n),
    ).toBe(4_000n);
    expect(
      marginDrawAmount({ ...base, onAccountCash: 4_000n, spendableCash: 1_000n }, 5_000n),
    ).toBe(4_000n);
  });
});

describe("marginBorrowableBase", () => {
  const inventory = new Map<Hex, bigint>([[ETH, 10n * 10n ** 9n]]);

  it("is zero for an asset the tier does not list", () => {
    const w = wire();
    const limits = marginLimits(w, null, 0, COLLATERAL);
    const other = "0xdddd000000000000000000000000000000000000000000000000000000000000" as Hex;
    expect(marginBorrowableBase(w, limits, other, inventory)).toBe(0n);
  });

  it("is zero when the pool holds none of it — a line is not a promise of coins", () => {
    const w = wire();
    const limits = marginLimits(w, null, 0, COLLATERAL);
    expect(marginBorrowableBase(w, limits, ETH, new Map())).toBe(0n);
  });

  it("is bounded by the pool's inventory", () => {
    const w = wire();
    const limits = marginLimits(w, null, 0, COLLATERAL);
    // The line would allow 2.5 ETH at $2,000; the pool holds 10, so the
    // line binds. Cap the inventory at 1 and the inventory binds instead.
    expect(marginBorrowableBase(w, limits, ETH, inventory)).toBe(2n * 10n ** 9n + 500_000_000n);
    expect(marginBorrowableBase(w, limits, ETH, new Map([[ETH, 10n ** 9n]]))).toBe(10n ** 9n);
  });

  it("is zero on an account with no session", () => {
    expect(marginBorrowableBase(wire(), null, ETH, inventory)).toBe(0n);
  });
});

describe("marginSellableBase / marginShortableBase", () => {
  it("counts only coins that are on the account or settled", () => {
    const w = wire({
      balances: [
        {
          asset_id: ETH,
          on_account: "300",
          received: "1000",
          locked: "1000",
          settled: "700",
          debt: "0",
        },
      ],
    });
    expect(marginSellableBase(w, ETH)).toBe(1000n);
  });

  it("adds what can be borrowed — a fresh account holds nothing but can still short", () => {
    const w = wire();
    const limits = marginLimits(w, null, 0, COLLATERAL);
    const inventory = new Map<Hex, bigint>([[ETH, 10n * 10n ** 9n]]);
    expect(marginSellableBase(w, ETH)).toBe(0n);
    expect(marginShortableBase(w, limits, ETH, inventory)).toBeGreaterThan(0n);
  });
});

describe("scaleDecimalString", () => {
  it("parses without a float round trip", () => {
    // `Number("0.1") * 10 ** 18` is not 10n ** 17n. On a credit line that
    // difference is money.
    expect(scaleDecimalString("0.1", 18)).toBe(10n ** 17n);
    expect(scaleDecimalString("2000", 6)).toBe(2_000_000000n);
    expect(scaleDecimalString("0.000001", 6)).toBe(1n);
    expect(scaleDecimalString("1.5", 6)).toBe(1_500000n);
    expect(scaleDecimalString(".5", 6)).toBe(500000n);
    expect(scaleDecimalString("7.", 6)).toBe(7_000000n);
  });

  it("TRUNCATES excess precision rather than rounding up", () => {
    // Rounding a notional up sizes an order the line cannot fund.
    expect(scaleDecimalString("1.9999999", 6)).toBe(1_999999n);
  });

  it("rejects anything that is not a decimal number", () => {
    for (const bad of ["", ".", "abc", "1e6", "1,000", "0x10"]) {
      expect(() => scaleDecimalString(bad, 6)).toThrow(/Not a decimal number/);
    }
  });
});
