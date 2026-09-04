import { sha256 } from "@noble/hashes/sha2.js";
import * as secp from "@noble/secp256k1";
import { describe, expect, it } from "vitest";
import { TESTNET } from "../../src/config.js";
import { hexToBytes } from "../../src/encoding.js";
import {
  addCollateralAction,
  borrowAction,
  drawAction,
  isMarginChildAction,
  isMarginPoolAction,
  marginActionKind,
  prolongSessionAction,
  registerMarginAccountAction,
  startMarginSessionAction,
} from "../../src/turbo/actions.js";
import {
  decodeParallelNonce,
  encodeParallelNonce,
  newMarginAccountNonce,
} from "../../src/turbo/parallelNonce.js";
import {
  buildReferralPayload,
  buildSignedReferralEnvelope,
  signReferralPayload,
} from "../../src/turbo/referral.js";
import { marginCohortOf, marginFreezeLine, marginLiquidationLine } from "../../src/turbo/terms.js";
import type { Hex, MarginStateWire } from "../../src/turbo/wire.js";
import { normaliseHex, prolongPeriodIndex, sameHex } from "../../src/turbo/wire.js";

const CHILD = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const ASSET = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

describe("action classification", () => {
  it("splits pool actions from parent-driven child actions", () => {
    expect(isMarginPoolAction(drawAction(1n))).toBe(true);
    expect(isMarginPoolAction(borrowAction(ASSET, 1n))).toBe(true);
    expect(isMarginPoolAction(addCollateralAction(1n))).toBe(true);
    expect(isMarginChildAction(drawAction(1n))).toBe(false);

    expect(isMarginChildAction(startMarginSessionAction(CHILD, 1, 1n, "Day"))).toBe(true);
    expect(isMarginChildAction(registerMarginAccountAction(CHILD, 0))).toBe(true);
    expect(isMarginPoolAction(startMarginSessionAction(CHILD, 1, 1n, "Day"))).toBe(false);
  });

  it("refuses an action carrying more than one variant", () => {
    expect(() => marginActionKind({ Draw: { amount: "1" }, Borrow: {} } as never)).toThrow(
      /exactly one variant/,
    );
  });

  it("serialises every amount as a decimal string, never a number", () => {
    // The wire takes u64 as strings; a JS number silently loses precision
    // above 2^53, which on a 6-decimal collateral is only $9 billion away.
    const action = drawAction(9_007_199_254_740_993n);
    expect(action.Draw.amount).toBe("9007199254740993");
  });
});

describe("prolong periods", () => {
  it("indexes in the order the tier's fee arrays use", () => {
    expect(prolongPeriodIndex("SixHours")).toBe(0);
    expect(prolongPeriodIndex("Day")).toBe(1);
    expect(prolongPeriodIndex("Week")).toBe(2);
    expect(prolongPeriodIndex("Month")).toBe(3);
  });

  it("throws on an unknown period rather than encoding a wrong discriminant", () => {
    expect(() => prolongPeriodIndex("Fortnight" as never)).toThrow(/Unknown prolong period/);
  });

  it("defaults `times` to one", () => {
    expect(prolongSessionAction("Week").ProlongSession.times).toBe("1");
  });
});

describe("hex comparison", () => {
  it("matches a bare tier asset against a 0x-prefixed market id", () => {
    // `tier.assets` comes back BARE while a market id carries `0x`; a plain
    // `===` matches nothing and every market reads as allowed.
    expect(sameHex("1111", "0x1111")).toBe(true);
    expect(sameHex("0xAABB", "0xaabb")).toBe(true);
    expect(sameHex(null, "0x1")).toBe(false);
    expect(normaliseHex("AABB")).toBe("0xaabb");
  });
});

describe("parallel nonce", () => {
  it("round-trips every field", () => {
    const parts = {
      nonceSessionId: 3,
      timestamp: 1_700_000_000,
      wordPosition: 42n,
      bitmapPosition: 7,
    };
    expect(decodeParallelNonce(encodeParallelNonce(parts))).toEqual(parts);
  });

  it("rejects out-of-range lanes and bitmap positions", () => {
    const base = { nonceSessionId: 0, timestamp: 0, wordPosition: 0n, bitmapPosition: 0 };
    expect(() => encodeParallelNonce({ ...base, bitmapPosition: 128 })).toThrow(/bitmap position/);
    expect(() => encodeParallelNonce({ ...base, bitmapPosition: -1 })).toThrow(/bitmap position/);
    expect(() => encodeParallelNonce({ ...base, nonceSessionId: 5 })).toThrow(/nonce session id/);
  });

  it("mints the one coordinate a brand-new child admits", () => {
    // A new account's window base is 0, so (word 0, bit 0) on lane 0 is
    // the only position it accepts. It must not be zero, though — the
    // backend expiry-checks it.
    const parts = decodeParallelNonce(newMarginAccountNonce(1_700_000_000));
    expect(parts.wordPosition).toBe(0n);
    expect(parts.bitmapPosition).toBe(0);
    expect(parts.nonceSessionId).toBe(0);
    expect(parts.timestamp).toBeGreaterThan(1_700_000_000);
    expect(newMarginAccountNonce(1_700_000_000)).not.toBe("0");
  });
});

describe("risk lines", () => {
  const tier = {
    tier_id: 1,
    version: 1,
    line: "1000",
    leverage: "10",
    duration: "1",
    required_collateral: "1",
    k: "100",
    maintenance_bps: 0,
    open_buffer_bps: 0,
    liq_price_factor: 10_000,
    maintenance: "20",
    open_buffer: "50",
    threshold: "120",
    open_fee: "0",
    prolong_fee: ["0", "0", "0", "0"] as [string, string, string, string],
    prolong_seconds: ["0", "0", "0", "0"],
    auto_prolong_periods: [],
    profit_share_bps: 0,
    price_band_bps: 0,
    max_credit_line_bps: 10_000,
    max_price_age: 0,
    books: [],
    assets: [],
  };

  const base = {
    margin_account: CHILD,
    parent: { ContractId: CHILD },
    index: 0,
    pool: CHILD,
    now: 0,
    collateral_decimals: 6,
    balances: [],
    prices: [],
  } as unknown as MarginStateWire;

  it("reads the tier's static pair on a legacy session", () => {
    const wire = { ...base, tier, session: { cohort: "Legacy" } } as unknown as MarginStateWire;
    expect(marginCohortOf(wire)).toBe("legacy");
    expect(marginLiquidationLine(wire)).toBe(120n);
    // Legacy freeze is `k + open_buffer`.
    expect(marginFreezeLine(wire)).toBe(150n);
  });

  it("replaces both with the anchored floor on a prepaid session", () => {
    const wire = {
      ...base,
      tier: {
        ...tier,
        turbo: {
          forfeit_collateral: false,
          max_loss_bps: ["1500", "1000", "500", "0"],
          rollover_profit_bps: "0",
          max_rollovers: "3",
        },
      },
      rollover: {
        anchor: "0",
        withdrawn: "0",
        outside: "0",
        rollovers_used: "0",
        max_rollovers: "3",
        profit_required: "0",
        eligible_now: false,
      },
      session: { cohort: "Turbo" },
    } as unknown as MarginStateWire;
    expect(marginCohortOf(wire)).toBe("turbo");
    // 1000 - 1000*1500/10000 = 850. This sits BELOW k + maintenance, which
    // is the whole point of the prepaid regime.
    expect(marginLiquidationLine(wire)).toBe(850n);
    // freeze = floor + (open_buffer - maintenance) = 850 + 30.
    expect(marginFreezeLine(wire)).toBe(880n);
    // freeze must stay strictly above liquidation in BOTH regimes.
    expect(marginFreezeLine(wire)).toBeGreaterThan(marginLiquidationLine(wire));
  });

  it("walks the drawdown table as rollovers are used", () => {
    const mk = (used: string) =>
      ({
        ...base,
        tier: {
          ...tier,
          turbo: {
            forfeit_collateral: false,
            max_loss_bps: ["1500", "1000", "500", "0"],
            rollover_profit_bps: "0",
            max_rollovers: "3",
          },
        },
        rollover: {
          anchor: "0",
          withdrawn: "0",
          outside: "0",
          rollovers_used: used,
          max_rollovers: "3",
          profit_required: "0",
          eligible_now: false,
        },
        session: { cohort: "Turbo" },
      }) as unknown as MarginStateWire;
    expect(marginLiquidationLine(mk("1"))).toBe(900n);
    expect(marginLiquidationLine(mk("3"))).toBe(1000n);
    // Past the end of the table the last entry repeats rather than throwing.
    expect(marginLiquidationLine(mk("9"))).toBe(1000n);
  });

  it("falls back to legacy when the tier offers no drawdown at all", () => {
    const wire = {
      ...base,
      tier: {
        ...tier,
        turbo: {
          forfeit_collateral: false,
          max_loss_bps: ["0", "0", "0", "0"],
          rollover_profit_bps: "0",
          max_rollovers: "0",
        },
      },
      rollover: {
        anchor: "0",
        withdrawn: "0",
        outside: "0",
        rollovers_used: "0",
        max_rollovers: "0",
        profit_required: "0",
        eligible_now: false,
      },
      session: {},
    } as unknown as MarginStateWire;
    expect(marginLiquidationLine(wire)).toBe(120n);
  });
});

describe("referral envelopes", () => {
  const key = hexToBytes(`0x${"11".repeat(32)}`);

  it("puts the code INSIDE the signed payload", () => {
    // If the code travelled beside the envelope, anything in between could
    // swap it and bind the referee to a different referrer while the
    // signature still verified — and attribution cannot be changed later.
    const payload = buildReferralPayload({
      action: "turbo_referral_activate",
      traderId: "0xabc",
      code: "FRIEND",
    });
    expect(JSON.parse(payload).code).toBe("FRIEND");
    expect(JSON.parse(payload).action).toBe("turbo_referral_activate");
  });

  it("omits `code` entirely when none was given", () => {
    const payload = JSON.parse(
      buildReferralPayload({ action: "turbo_referral_code", traderId: "0xabc" }),
    );
    expect("code" in payload).toBe(false);
  });

  it("carries a fresh nonce and an issuedAt on every call", () => {
    const a = JSON.parse(buildReferralPayload({ action: "turbo_referral_code", traderId: "0x1" }));
    const b = JSON.parse(buildReferralPayload({ action: "turbo_referral_code", traderId: "0x1" }));
    expect(a.nonce).not.toBe(b.nonce);
    expect(() => new Date(a.issuedAt).toISOString()).not.toThrow();
  });

  it("signs sha256(payload) with no message prefix, which is what the server recovers from", () => {
    const payload = buildReferralPayload({
      action: "turbo_referral_code",
      traderId: "0xabc",
      nonce: "fixed",
      issuedAt: "2026-01-01T00:00:00.000Z",
    });
    const envelope = signReferralPayload(key, payload);
    expect(envelope.payload).toBe(payload);

    // VERIFY AGAINST THE BARE DIGEST. The claim under test is that the
    // message is `sha256(payload-bytes)` with NO Fuel prefix — a prefixed
    // digest would fail here, which is exactly what would happen against
    // the server.
    const sig = hexToBytes(envelope.signature);
    const normalised = new Uint8Array(sig);
    normalised[32] &= 0x7f; // strip the embedded recovery bit
    const digest = sha256(new TextEncoder().encode(payload));
    const publicKey = secp.getPublicKey(key, false);
    expect(
      secp.verify(normalised, digest, publicKey, {
        prehash: false,
        format: "compact",
      } as Parameters<typeof secp.verify>[3]),
    ).toBe(true);

    // And a Fuel-prefixed digest must NOT verify — the two signing modes
    // are not interchangeable here.
    const prefixed = sha256(
      new TextEncoder().encode(`\x19Fuel Signed Message:\n${payload.length}${payload}`),
    );
    expect(
      secp.verify(normalised, prefixed, publicKey, {
        prehash: false,
        format: "compact",
      } as Parameters<typeof secp.verify>[3]),
    ).toBe(false);
  });

  it("builds and signs in one step", () => {
    const envelope = buildSignedReferralEnvelope(key, {
      action: "turbo_referral_activate",
      traderId: "0xabc",
      code: "X",
    });
    expect(envelope.signature).toMatch(/^0x[0-9a-f]{128}$/);
    expect(JSON.parse(envelope.payload).code).toBe("X");
  });
});

describe("regression: /v1/markets margin wiring survives parsing", () => {
  it("keeps the `margin` block that the whole Turbo surface keys off", async () => {
    // `getMarkets` rebuilds the response from an EXPLICIT field list, so
    // anything not named there vanishes. `margin` vanishing made
    // `turbo.wiring()` and `sessionScope()` report Turbo as unavailable on
    // every deployment — including testnet, where it is wired. Every unit
    // test still passed, because the fake host supplied `margin` itself.
    const payload = {
      books_registry_id: `0x${"1".repeat(64)}`,
      accounts_registry_id: `0x${"2".repeat(64)}`,
      trade_account_oracle_id: `0x${"3".repeat(64)}`,
      chain_id: "0x0",
      base_asset_id: `0x${"4".repeat(64)}`,
      markets: [],
      margin: {
        collateral_asset_id: `0x${"5".repeat(64)}`,
        margin_pool_id: `0x${"6".repeat(64)}`,
        margin_oracle_id: `0x${"7".repeat(64)}`,
        price_feed_id: `0x${"8".repeat(64)}`,
        price_band_bps: "1000",
        stress_band_bps: "0",
      },
    };

    const { O2Api } = await import("../../src/api.js");
    const api = new O2Api({ config: TESTNET });
    (api as unknown as { get: (p: string) => Promise<unknown> }).get = async () => payload;

    const markets = await api.getMarkets();
    expect(markets.margin?.margin_pool_id).toBe(payload.margin.margin_pool_id);
    expect(markets.margin?.collateral_asset_id).toBe(payload.margin.collateral_asset_id);
    expect(markets.margin?.stress_band_bps).toBe("0");
  });

  it("leaves `margin` undefined when the deployment has no Turbo", async () => {
    const { O2Api } = await import("../../src/api.js");
    const api = new O2Api({ config: TESTNET });
    (api as unknown as { get: (p: string) => Promise<unknown> }).get = async () => ({
      books_registry_id: `0x${"1".repeat(64)}`,
      accounts_registry_id: `0x${"2".repeat(64)}`,
      trade_account_oracle_id: `0x${"3".repeat(64)}`,
      chain_id: "0x0",
      base_asset_id: `0x${"4".repeat(64)}`,
      markets: [],
    });
    const markets = await api.getMarkets();
    expect(markets.margin).toBeUndefined();
  });
});
