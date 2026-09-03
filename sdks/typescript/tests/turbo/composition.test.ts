/**
 * What a "long" and a "short" actually submit.
 *
 * These drive {@link TurboClient} against a fake host, so the assertions
 * are about the BATCH — its order, its funding leg, and which account it
 * executes as. That composition is the whole product: everything else in
 * the module exists to make it correct.
 */

import { describe, expect, it, vi } from "vitest";
import { TurboClient } from "../../src/turbo/client.js";
import type { PreparedBatch, TurboHost } from "../../src/turbo/host.js";
import type { Hex, MarginStateWire } from "../../src/turbo/wire.js";

const POOL = "0xa000000000000000000000000000000000000000000000000000000000000001" as Hex;
const REGISTRY = "0xa000000000000000000000000000000000000000000000000000000000000002" as Hex;
const COLLATERAL = "0xa000000000000000000000000000000000000000000000000000000000000003" as Hex;
const PARENT = "0xa000000000000000000000000000000000000000000000000000000000000004" as Hex;
const CHILD = "0xa000000000000000000000000000000000000000000000000000000000000005" as Hex;
const ETH = "0xa000000000000000000000000000000000000000000000000000000000000006" as Hex;
const BOOK = "0xa000000000000000000000000000000000000000000000000000000000000007" as Hex;

const MARKET = {
  market_id: "eth-usdc",
  contract_id: BOOK,
  base: { asset: ETH, decimals: 9, max_precision: 4, symbol: "fETH" },
  quote: { asset: COLLATERAL, decimals: 6, max_precision: 4, symbol: "fUSDC" },
} as never;

/** 6-dec collateral, 9-dec base, $2,000 flat. */
function state(overrides: Partial<MarginStateWire> = {}): MarginStateWire {
  return {
    margin_account: CHILD,
    parent: { ContractId: PARENT },
    index: 0,
    pool: POOL,
    now: 1_700_000_000,
    collateral_decimals: 6,
    session: {
      session_id: 1,
      tier_id: 1,
      tier_version: 1,
      parent: { ContractId: PARENT },
      collateral: "1000000000",
      credit_line: "10000000000",
      drawn_quote: "0",
      debt: null,
      fees_accrued: "0",
      capitalised: "0",
      expires_at: 1_700_090_000,
    },
    tier: {
      tier_id: 1,
      version: 1,
      line: "10000000000",
      leverage: "10",
      duration: "86400",
      required_collateral: "1000000000",
      k: "0",
      maintenance_bps: 100,
      open_buffer_bps: 200,
      liq_price_factor: 10_000,
      maintenance: "100000000",
      open_buffer: "200000000",
      threshold: "100000000",
      open_fee: "0",
      prolong_fee: ["0", "0", "0", "0"],
      prolong_seconds: ["21600", "86400", "604800", "2592000"],
      auto_prolong_periods: [],
      profit_share_bps: 0,
      price_band_bps: 0,
      max_credit_line_bps: 20_000,
      max_price_age: 60,
      books: [BOOK],
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

function makeHost(
  opts: { wire?: MarginStateWire; inventory?: { asset_id: Hex; amount: string }[] } = {},
) {
  const submitted: PreparedBatch[] = [];
  const api = {
    getMarkets: vi.fn(),
    getAccount: vi.fn().mockResolvedValue({
      trade_account_id: PARENT,
      margin_accounts: [{ contract_id: CHILD, index: 0 }],
      next_margin_account: null,
    }),
    getMarginState: vi.fn().mockResolvedValue(opts.wire ?? state()),
    getMarginPool: vi.fn().mockResolvedValue({
      inventory: opts.inventory ?? [
        { asset_id: COLLATERAL, amount: "100000000000" },
        { asset_id: ETH, amount: (100n * 10n ** 9n).toString() },
      ],
    }),
    getNextMarginAccount: vi.fn().mockResolvedValue(null),
    getMarginTiers: vi.fn().mockResolvedValue([]),
    getMarginCloseCleanups: vi.fn().mockResolvedValue([]),
    getDepth: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
  };

  const host: TurboHost = {
    api: api as never,
    ensureSession: () => ({
      ownerAddress: "0xowner",
      tradeAccountId: PARENT as never,
      sessionPrivateKey: new Uint8Array(32).fill(7),
      sessionAddress: "0xsession",
      contractIds: [],
      expiry: 2_000_000_000,
      nonce: 1n,
    }),
    fetchMarkets: async () =>
      ({
        markets: [MARKET],
        accounts_registry_id: REGISTRY,
        chain_id: "0x0",
        margin: {
          margin_pool_id: POOL,
          collateral_asset_id: COLLATERAL,
          stress_band_bps: "0",
        },
      }) as never,
    resolveMarket: () => MARKET,
    normalizeCreateOrderValues: (market, price, quantity) => ({
      scaledPrice:
        typeof price === "bigint"
          ? price
          : BigInt(
              Math.round(
                Number(price) *
                  10 ** (market as never as { quote: { decimals: number } }).quote.decimals,
              ),
            ),
      scaledQuantity:
        typeof quantity === "bigint"
          ? quantity
          : BigInt(
              Math.round(
                Number(quantity) *
                  10 ** (market as never as { base: { decimals: number } }).base.decimals,
              ),
            ),
    }),
    spotActionToCall: () => ({
      contractId: new Uint8Array(32),
      functionSelector: new Uint8Array(0),
      amount: 0n,
      assetId: new Uint8Array(32),
      gas: 0n,
      callData: null,
    }),
    submitPrepared: async (batch) => {
      submitted.push(batch);
      return { txId: "0xtx", isPreflightError: false } as never;
    },
  };

  return { host, submitted, api };
}

const kindsOf = (batch: PreparedBatch) =>
  batch.marketActions[0].actions.map((a) => Object.keys(a)[0]);

describe("long", () => {
  it("submits sweep → draw → buy, in that order, as the CHILD", async () => {
    const { host, submitted } = makeHost();
    const turbo = new TurboClient(host).use(CHILD);
    await turbo.long(MARKET, { quantity: "1" }, { price: "2000" });

    expect(submitted).toHaveLength(1);
    // The sweep is not housekeeping: custody counts only coins ON the
    // account, while settled funds sit on the book until swept home.
    expect(kindsOf(submitted[0])).toEqual(["SettleBalance", "Draw", "CreateOrder"]);
    // Trading runs as the margin child — settling to the parent would move
    // the session's money out of the session.
    expect(submitted[0].tradeAccountId).toBe(CHILD);
  });

  it("draws the whole escrow when the account holds no cash", async () => {
    const { host, submitted } = makeHost();
    await new TurboClient(host).use(CHILD).long(MARKET, { quantity: "1" }, { price: "2000" });
    const draw = submitted[0].marketActions[0].actions.find((a) => "Draw" in a) as {
      Draw: { amount: string };
    };
    // 1 ETH at $2,000 escrows 2,000 collateral units (6 decimals).
    expect(draw.Draw.amount).toBe("2000000000");
  });

  it("settles to the CHILD, never the parent", async () => {
    const { host, submitted } = makeHost();
    await new TurboClient(host).use(CHILD).long(MARKET, { quantity: "1" }, { price: "2000" });
    const settle = submitted[0].marketActions[0].actions[0] as {
      SettleBalance: { to: { ContractId: string } };
    };
    expect(settle.SettleBalance.to).toEqual({ ContractId: CHILD });
  });

  it("emits NO draw when the account's own cash already covers the escrow", async () => {
    const wire = state({
      balances: [
        {
          asset_id: COLLATERAL,
          on_account: "5000000000",
          received: "0",
          locked: "0",
          settled: "0",
          debt: "0",
        },
      ],
    });
    const { host, submitted } = makeHost({ wire });
    await new TurboClient(host).use(CHILD).long(MARKET, { quantity: "1" }, { price: "2000" });
    expect(kindsOf(submitted[0])).toEqual(["SettleBalance", "CreateOrder"]);
  });

  it("REFUSES rather than under-funding when the line cannot cover the escrow", async () => {
    // An open has no second round: a clamped leg behind a full-size order
    // is a custody revert with extra steps, after the user has signed.
    const { host } = makeHost({ inventory: [{ asset_id: COLLATERAL, amount: "1000000" }] });
    await expect(
      new TurboClient(host).use(CHILD).long(MARKET, { quantity: "1" }, { price: "2000" }),
    ).rejects.toThrow(/available credit/);
  });

  it("sizes by notional as well as by quantity", async () => {
    const { host, submitted } = makeHost();
    await new TurboClient(host).use(CHILD).long(MARKET, { notional: "4000" }, { price: "2000" });
    const order = submitted[0].marketActions[0].actions.at(-1) as {
      CreateOrder: { quantity: string; side: string };
    };
    expect(order.CreateOrder.quantity).toBe((2n * 10n ** 9n).toString());
    expect(order.CreateOrder.side).toBe("Buy");
  });
});

describe("short", () => {
  it("submits sweep → borrow → sell, as the CHILD", async () => {
    const { host, submitted } = makeHost();
    await new TurboClient(host).use(CHILD).short(MARKET, { quantity: "1" }, { price: "2000" });
    expect(kindsOf(submitted[0])).toEqual(["SettleBalance", "Borrow", "CreateOrder"]);
    expect(submitted[0].tradeAccountId).toBe(CHILD);
  });

  it("borrows the base asset in kind, because the account holds none", async () => {
    const { host, submitted } = makeHost();
    await new TurboClient(host).use(CHILD).short(MARKET, { quantity: "1" }, { price: "2000" });
    const borrow = submitted[0].marketActions[0].actions.find((a) => "Borrow" in a) as {
      Borrow: { asset_id: string; amount: string };
    };
    expect(borrow.Borrow.asset_id).toBe(ETH);
    expect(borrow.Borrow.amount).toBe((10n ** 9n).toString());
  });

  it("borrows only the SHORTFALL when the account already holds some base", async () => {
    const wire = state({
      balances: [
        {
          asset_id: COLLATERAL,
          on_account: "0",
          received: "0",
          locked: "0",
          settled: "0",
          debt: "0",
        },
        {
          asset_id: ETH,
          on_account: (4n * 10n ** 8n).toString(), // 0.4 ETH on hand
          received: "0",
          locked: "0",
          settled: "0",
          debt: "0",
        },
      ],
    });
    const { host, submitted } = makeHost({ wire });
    await new TurboClient(host).use(CHILD).short(MARKET, { quantity: "1" }, { price: "2000" });
    const borrow = submitted[0].marketActions[0].actions.find((a) => "Borrow" in a) as {
      Borrow: { amount: string };
    };
    expect(borrow.Borrow.amount).toBe((6n * 10n ** 8n).toString());
  });

  it("refuses to short the collateral asset — it is drawn, never borrowed", async () => {
    const inverted = {
      ...MARKET,
      base: { asset: COLLATERAL, decimals: 6, max_precision: 4, symbol: "fUSDC" },
    } as never;
    const { host } = makeHost();
    await expect(
      new TurboClient(host).use(CHILD).short(inverted, { quantity: "1" }, { price: "1" }),
    ).rejects.toThrow(/drawn, never borrowed/);
  });

  it("refuses when the pool holds no inventory to lend", async () => {
    const { host } = makeHost({ inventory: [{ asset_id: COLLATERAL, amount: "100000000000" }] });
    await expect(
      new TurboClient(host).use(CHILD).short(MARKET, { quantity: "1" }, { price: "2000" }),
    ).rejects.toThrow(/Size unavailable/);
  });

  it("emits no borrow at all when holdings already cover the sale", async () => {
    const wire = state({
      balances: [
        {
          asset_id: COLLATERAL,
          on_account: "0",
          received: "0",
          locked: "0",
          settled: "0",
          debt: "0",
        },
        {
          asset_id: ETH,
          on_account: (2n * 10n ** 9n).toString(),
          received: "0",
          locked: "0",
          settled: "0",
          debt: "0",
        },
      ],
    });
    const { host, submitted } = makeHost({ wire });
    await new TurboClient(host).use(CHILD).short(MARKET, { quantity: "1" }, { price: "2000" });
    expect(kindsOf(submitted[0])).toEqual(["SettleBalance", "CreateOrder"]);
  });
});

describe("lifecycle routing", () => {
  it("runs addMargin as the PARENT — the pool action names the child", async () => {
    const { host, submitted } = makeHost();
    await new TurboClient(host).use(CHILD).addMargin(500n);
    expect(submitted[0].tradeAccountId).toBe(PARENT);
    expect(kindsOf(submitted[0])).toEqual(["AddMarginCollateral"]);
  });

  it("runs extend and setAutoExtend as the CHILD — they are pool actions", async () => {
    const { host, submitted } = makeHost();
    const turbo = new TurboClient(host).use(CHILD);
    await turbo.extend("Week", 2);
    await turbo.setAutoExtend("Month");
    expect(submitted[0].tradeAccountId).toBe(CHILD);
    expect(kindsOf(submitted[0])).toEqual(["ProlongSession"]);
    expect(submitted[1].tradeAccountId).toBe(CHILD);
    expect(kindsOf(submitted[1])).toEqual(["SetAutoProlong"]);
  });

  it("runs closeAccount as the PARENT, carrying the freshly fetched cleanups", async () => {
    const { host, submitted, api } = makeHost();
    api.getMarginCloseCleanups.mockResolvedValue([{ order_book_id: BOOK, order_ids: [] }]);
    await new TurboClient(host).use(CHILD).closeAccount();
    expect(submitted[0].tradeAccountId).toBe(PARENT);
    const close = submitted[0].marketActions[0].actions[0] as {
      CloseMarginSession: { cleanups: unknown[] };
    };
    expect(close.CloseMarginSession.cleanups).toHaveLength(1);
    // Fetched at call time: the chain re-verifies the list, so a stale one
    // reverts rather than stranding value.
    expect(api.getMarginCloseCleanups).toHaveBeenCalledWith(CHILD);
  });
});

describe("snapshot and positions", () => {
  it("reads a short as a negative quantity", async () => {
    const wire = state({
      balances: [
        {
          asset_id: COLLATERAL,
          on_account: "0",
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
          debt: (10n ** 9n).toString(),
        },
      ],
    });
    const { host } = makeHost({ wire });
    const positions = await new TurboClient(host).use(CHILD).positions();
    expect(positions).toHaveLength(1);
    expect(positions[0].side).toBe("short");
    expect(positions[0].quantity).toBe(-(10n ** 9n));
    expect(positions[0].debt).toBe(10n ** 9n);
  });

  it("reports the credit line and time remaining from SERVER time", async () => {
    const { host } = makeHost();
    const snapshot = await new TurboClient(host).use(CHILD).snapshot();
    expect(snapshot.creditLine).toBe(10_000_000000n);
    // 1_700_090_000 - 1_700_000_000, from the wire's own `now`.
    expect(snapshot.secondsRemaining).toBe(90_000);
    expect(snapshot.frozen).toBe(false);
    expect(snapshot.liquidatable).toBe(false);
  });
});

describe("session scope", () => {
  it("gathers the pool, existing children AND unopened predictions", async () => {
    const { api } = makeHost();
    const predicted = "0xa00000000000000000000000000000000000000000000000000000000000000f";
    api.getMarkets.mockResolvedValue({
      margin: { margin_pool_id: POOL },
    });
    api.getNextMarginAccount.mockResolvedValue({ contract_id: predicted, index: 1 });

    const scope = await TurboClient.sessionScope(api as never, "0xowner");
    expect(scope).toContain(POOL);
    expect(scope).toContain(CHILD);
    expect(scope).toContain(predicted);
  });

  it("degrades to an empty scope rather than failing a plain session", async () => {
    const { api } = makeHost();
    api.getMarkets.mockRejectedValue(new Error("margin not wired here"));
    await expect(TurboClient.sessionScope(api as never, "0xowner")).resolves.toEqual([]);
  });
});
