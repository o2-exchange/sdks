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
      auto_prolong_periods: ["Week", "Month"],
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
      // The child is armed with the session key this host signs with, so
      // `ensureArmed` is a no-op. The stale case has its own tests.
      session: { session_id: { Address: "0xsession" }, contract_ids: [], expiry: "4102444800" },
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
          stress_band_bps: opts.stressBandBps ?? "0",
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

  hostSubmissions.set(host, submitted);
  return { host, submitted, api };
}

/** The submitted-batch array a host was built with. */
const hostSubmissions = new WeakMap<TurboHost, PreparedBatch[]>();
const makeHostRef = (host: TurboHost) => ({
  submitted: hostSubmissions.get(host) as PreparedBatch[],
});

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

// ── Regressions from review (PR #76) ────────────────────────────────

describe("regression: sell funding counts settled base", () => {
  it("emits NO borrow when settled base the sweep will bring home covers the sale", async () => {
    // The batch settles BEFORE it sells, so settled base is on the account
    // by the time custody is checked. Sizing against `on_account` alone
    // borrowed over the top of coins the account already owned and left an
    // in-kind debt behind every close of a filled long.
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
          settled: (10n ** 9n).toString(), // 1 ETH settled on the book
          debt: "0",
        },
      ],
    });
    const { host, submitted } = makeHost({ wire });
    await new TurboClient(host).use(CHILD).short(MARKET, { quantity: "1" }, { price: "2000" });
    expect(kindsOf(submitted[0])).toEqual(["SettleBalance", "CreateOrder"]);
  });

  it("borrows only what settled plus on-account cannot cover", async () => {
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
          on_account: (3n * 10n ** 8n).toString(),
          received: "0",
          locked: "0",
          settled: (4n * 10n ** 8n).toString(),
          debt: "0",
        },
      ],
    });
    const { host, submitted } = makeHost({ wire });
    await new TurboClient(host).use(CHILD).short(MARKET, { quantity: "1" }, { price: "2000" });
    const borrow = submitted[0].marketActions[0].actions.find((a) => "Borrow" in a) as {
      Borrow: { amount: string };
    };
    expect(borrow.Borrow.amount).toBe((3n * 10n ** 8n).toString());
  });
});

describe("regression: a clamped close shrinks the ORDER too", () => {
  it("reduces a buy-to-close to what the line can actually draw", async () => {
    // Clamping the funding while leaving the order full size signs a batch
    // the custody check reverts — the exact failure the open/close split
    // was written to avoid.
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
          debt: (10n ** 9n).toString(), // short 1 ETH
        },
      ],
    });
    // The pool holds only $500 of collateral float, so a $2,000 buy-back
    // cannot be fully drawn.
    const { host, submitted } = makeHost({
      wire,
      inventory: [{ asset_id: COLLATERAL, amount: "500000000" }],
    });
    await new TurboClient(host).use(CHILD).closePosition(MARKET, { price: "2000" });

    const draw = submitted[0].marketActions[0].actions.find((a) => "Draw" in a) as {
      Draw: { amount: string };
    };
    const order = submitted[0].marketActions[0].actions.at(-1) as {
      CreateOrder: { quantity: string; side: string };
    };
    expect(order.CreateOrder.side).toBe("Buy");
    expect(draw.Draw.amount).toBe("500000000");
    // $500 of draw at $2,000 buys 0.25 ETH, not the full 1.
    expect(order.CreateOrder.quantity).toBe((25n * 10n ** 7n).toString());
  });

  it("reduces a sell-to-close to what the pool will lend", async () => {
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
          on_account: (2n * 10n ** 8n).toString(), // holds 0.2
          received: "0",
          locked: "0",
          settled: "0",
          debt: "0",
        },
      ],
    });
    const { host, submitted } = makeHost({
      wire,
      inventory: [
        { asset_id: COLLATERAL, amount: "100000000000" },
        { asset_id: ETH, amount: (1n * 10n ** 8n).toString() }, // pool lends 0.1
      ],
    });
    await new TurboClient(host).use(CHILD).closePosition(MARKET, { price: "2000", quantity: "1" });
    const order = submitted[0].marketActions[0].actions.at(-1) as {
      CreateOrder: { quantity: string };
    };
    // 0.2 held + 0.1 borrowable = 0.3 sellable.
    expect(order.CreateOrder.quantity).toBe((3n * 10n ** 8n).toString());
  });

  it("still REFUSES an under-funded open rather than silently shrinking it", async () => {
    const { host } = makeHost({ inventory: [{ asset_id: COLLATERAL, amount: "1000000" }] });
    await expect(
      new TurboClient(host).use(CHILD).long(MARKET, { quantity: "1" }, { price: "2000" }),
    ).rejects.toThrow(/available credit/);
  });
});

describe("regression: snapshot flags come from the gate stack", () => {
  it("reports frozen from the pool's STRESSED freeze test, not raw equity", async () => {
    // A 50% adverse band against a long puts stressed equity under the
    // freeze line while unstressed equity still looks comfortable. The old
    // comparison read `false` here and a caller topping up on `frozen`
    // would have missed the window entirely.
    const wire = state({
      tier: {
        ...(state().tier as NonNullable<MarginStateWire["tier"]>),
        price_band_bps: 5000,
        open_buffer: "9000000000",
        maintenance: "8000000000",
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
        {
          asset_id: ETH,
          on_account: (5n * 10n ** 9n).toString(),
          received: "0",
          locked: "0",
          settled: "0",
          debt: "0",
        },
      ],
    });
    // The DEPLOYMENT's stress band is what the pool shocks by, and it
    // overrides the tier's (much smaller) concession band — so the test
    // states the band it means rather than inheriting a zero.
    const { host } = makeHost({ wire, stressBandBps: "5000" });
    const turbo = new TurboClient(host).use(CHILD);
    const limits = await turbo.limits();
    const snapshot = await turbo.snapshot();
    expect(snapshot.frozen).toBe(limits?.stressFrozen);
    expect(snapshot.frozen).toBe(true);
    // And the UNSTRESSED comparison this replaced would have read false.
    expect((limits as NonNullable<typeof limits>).equity).toBeGreaterThan(
      (limits as NonNullable<typeof limits>).openBuffer,
    );
  });

  it("reports liquidatable in V against the live line, not equity against maintenance", async () => {
    const { host } = makeHost();
    const turbo = new TurboClient(host).use(CHILD);
    const limits = await turbo.limits();
    const snapshot = await turbo.snapshot();
    expect(snapshot.liquidatable).toBe(
      (limits as NonNullable<typeof limits>).markToMarket <=
        (limits as NonNullable<typeof limits>).liquidationThreshold,
    );
  });
});

describe("regression: session scope", () => {
  it("includes the accounts REGISTRY — RegisterMarginAccount targets it", async () => {
    const { api } = makeHost();
    api.getMarkets.mockResolvedValue({
      margin: { margin_pool_id: POOL },
      accounts_registry_id: REGISTRY,
    });
    api.getNextMarginAccount.mockResolvedValue(null);
    const scope = await TurboClient.sessionScope(api as never, "0xowner");
    // Without it, turbo.open() is refused with MarginAccountNotInSessionScope
    // and no retry helps — the scope is part of what was signed.
    expect(scope).toContain(REGISTRY);
    expect(scope).toContain(POOL);
  });

  it("predicts from the NEXT index, not from absolute zero", async () => {
    const { api } = makeHost();
    api.getMarkets.mockResolvedValue({
      margin: { margin_pool_id: POOL },
      accounts_registry_id: REGISTRY,
    });
    api.getAccount.mockResolvedValue({
      trade_account_id: PARENT,
      margin_accounts: [{ contract_id: CHILD, index: 0 }],
      next_margin_account: { contract_id: "0xnext", index: 1 },
    });
    api.getNextMarginAccount.mockResolvedValue(null);

    await TurboClient.sessionScope(api as never, "0xowner", 3);
    const asked = api.getNextMarginAccount.mock.calls.map((c: unknown[]) => c[1]);
    // Slots 0 is already taken; asking for it again just re-adds an id
    // already in scope and leaves the trader needing a fresh signature.
    expect(asked).toEqual([1, 2, 3]);
  });
});

describe("regression: every emitted quantity satisfies the fractional-price rule", () => {
  /**
   * `create_order` reverts `OrderCreationError::FractionalPrice` unless
   * `price * quantity` divides by `10^base_decimals`.
   *
   * Asserted as the INVARIANT rather than against a fixed number: the
   * earlier clamp tests priced at 2000, where the quantum works out to 1
   * and every quantity trivially passes — so they could not have caught a
   * path that skips the adjustment. This price makes the quantum 2.
   */
  const PRICE = "2000.5"; // 2_000_500_000 raw → quantum 2
  const SCALED_PRICE = 2_000_500_000n;
  const FACTOR = 10n ** 9n; // base decimals

  const divides = (quantity: bigint) => (SCALED_PRICE * quantity) % FACTOR === 0n;

  const quantityOf = (batch: PreparedBatch): bigint =>
    BigInt(
      (batch.marketActions[0].actions.at(-1) as { CreateOrder: { quantity: string } }).CreateOrder
        .quantity,
    );

  it("holds for a CLAMPED BUY — the path that was missing the adjustment", async () => {
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
          debt: (10n ** 9n).toString(), // short 1 ETH, so closing is a BUY
        },
      ],
    });
    // A float that cannot fund the whole buy-back forces the clamp.
    const { host, submitted } = makeHost({
      wire,
      inventory: [{ asset_id: COLLATERAL, amount: "333333333" }],
    });
    await new TurboClient(host).use(CHILD).closePosition(MARKET, { price: PRICE });

    const quantity = quantityOf(submitted[0]);
    expect(quantity).toBeGreaterThan(0n);
    expect(divides(quantity)).toBe(true);
    expect(quantity % 2n).toBe(0n);
  });

  it("holds for a CLAMPED SELL", async () => {
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
          on_account: "333333333",
          received: "0",
          locked: "0",
          settled: "0",
          debt: "0",
        },
      ],
    });
    const { host, submitted } = makeHost({
      wire,
      inventory: [
        { asset_id: COLLATERAL, amount: "100000000000" },
        { asset_id: ETH, amount: "111111111" },
      ],
    });
    await new TurboClient(host).use(CHILD).closePosition(MARKET, { price: PRICE, quantity: "1" });
    expect(divides(quantityOf(submitted[0]))).toBe(true);
  });

  it("holds for a NOTIONAL-sized open, which never went through normalize()", async () => {
    const { host, submitted } = makeHost();
    await new TurboClient(host).use(CHILD).long(MARKET, { notional: "4001" }, { price: PRICE });
    expect(divides(quantityOf(submitted[0]))).toBe(true);
  });

  it("refuses outright when no quantity at this price can satisfy the rule", async () => {
    const { host } = makeHost();
    // One raw base unit at a quantum of 2 rounds down to zero.
    await expect(
      new TurboClient(host).use(CHILD).long(MARKET, { quantity: 1n }, { price: PRICE }),
    ).rejects.toThrow(/fractional-price rule/);
  });
});

describe("regression: extend and auto-extend consult the tier", () => {
  /**
   * A PREPAID tier publishes `prolong_seconds` of zero for every period —
   * it sells one fixed term and rolls over instead — and the pool reverts
   * `prolong_session` on it. Live testnet answered with an undecodable
   * `require` log, which tells a caller nothing.
   */
  const prepaidTier = (base: NonNullable<MarginStateWire["tier"]>) => ({
    ...base,
    prolong_seconds: ["0", "0", "0", "0"],
    auto_prolong_periods: [],
    turbo: {
      max_loss_bps: ["150", "200", "250", "300"] as [string, string, string, string],
      rollover_profit_bps: "900",
      max_rollovers: "3",
      term_seconds: "604800",
    },
  });

  it("refuses to extend a tier that sells no extensions", async () => {
    const wire = state();
    wire.tier = prepaidTier(wire.tier as NonNullable<MarginStateWire["tier"]>) as never;
    const { host, submitted } = makeHost({ wire });
    await expect(new TurboClient(host).use(CHILD).extend("Week")).rejects.toThrow(
      /does not sell extensions/,
    );
    // Refused BEFORE signing — nothing was submitted.
    expect(submitted).toHaveLength(0);
  });

  it("refuses auto-extend when the tier offers none", async () => {
    const wire = state();
    wire.tier = prepaidTier(wire.tier as NonNullable<MarginStateWire["tier"]>) as never;
    const { host, submitted } = makeHost({ wire });
    await expect(new TurboClient(host).use(CHILD).setAutoExtend("Week")).rejects.toThrow(
      /does not offer auto-extension/,
    );
    expect(submitted).toHaveLength(0);
  });

  it("refuses a period the tier does not auto-extend at, naming the ones it does", async () => {
    const { host } = makeHost(); // offers Week, Month
    await expect(new TurboClient(host).use(CHILD).setAutoExtend("Day")).rejects.toThrow(
      /auto-extends at Week, Month — not Day/,
    );
  });

  it("always allows DISARMING, whatever the tier offers", async () => {
    const wire = state();
    wire.tier = prepaidTier(wire.tier as NonNullable<MarginStateWire["tier"]>) as never;
    const { host, submitted } = makeHost({ wire });
    await new TurboClient(host).use(CHILD).setAutoExtend(null);
    expect(kindsOf(submitted[0])).toEqual(["SetAutoProlong"]);
  });
});

describe("regression: repayInKind sweeps before it repays", () => {
  /**
   * Buying a short back leaves the base SETTLED on the book, not on the
   * account. Sizing the repay off `on_account` alone repaid nothing, fell
   * through to collateral netting, and the pool refused that too when the
   * collateral was worth less than the debt — so `closeAccount` was stuck
   * on "still carries 1 in-kind debt(s)" with the coins sitting right there.
   */
  const withDebt = () =>
    state({
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
          settled: "3999600",
          debt: "4000000",
        },
      ],
    });

  it("settles the book in the same batch as the repay", async () => {
    const { host, submitted } = makeHost({ wire: withDebt() });
    await new TurboClient(host).use(CHILD).repayInKind({ marginAccountId: CHILD });
    expect(kindsOf(submitted[0])).toEqual(["SettleBalance", "Repay"]);
    const repay = submitted[0].marketActions[0].actions[1] as {
      Repay: { asset_id: string; amount: string };
    };
    // Repays the SETTLED coins, which `on_account` alone could not see.
    expect(repay.Repay.amount).toBe("3999600");
    expect(repay.Repay.asset_id).toBe(ETH);
  });

  it("converts the remainder out of collateral", async () => {
    const { host, submitted } = makeHost({ wire: withDebt() });
    await new TurboClient(host).use(CHILD).repayInKind({ marginAccountId: CHILD });
    const last = submitted.at(-1) as PreparedBatch;
    expect(kindsOf(last)).toEqual(["RepayBaseFromCollateral"]);
    const conv = last.marketActions[0].actions[0] as {
      RepayBaseFromCollateral: { amount: string };
    };
    expect(conv.RepayBaseFromCollateral.amount).toBe("400");
  });

  it("never tries to repay the collateral asset in kind", async () => {
    const wire = state({
      balances: [
        {
          asset_id: COLLATERAL,
          on_account: "0",
          received: "0",
          locked: "0",
          settled: "0",
          debt: "5000",
        },
      ],
    });
    const { host, submitted } = makeHost({ wire });
    await new TurboClient(host).use(CHILD).repayInKind({ marginAccountId: CHILD });
    // The collateral is DRAWN, not borrowed — its obligation is
    // `drawn_quote` and settles through repayDrawn.
    expect(submitted).toHaveLength(0);
  });
});

describe("regression: a rotated session key orphans the child", () => {
  /**
   * A margin child validates against whatever key was armed when it was
   * opened. Rotating the PARENT's session — any `createSession` call —
   * leaves it pointed at a key nobody signs with, and the account goes
   * untradeable until it is re-armed.
   *
   * Checked PROACTIVELY rather than on an error string: a stale
   * `set_session` surfaces as `InvalidUserSig`, but a `settle_balance` on
   * the same stale session comes back as a bare `Revert(FAILED_REQUIRE)`
   * with nothing to match on.
   */
  it("re-arms before trading when the armed key is stale", async () => {
    const { host, api } = makeHost();
    api.getAccount.mockResolvedValue({
      trade_account_id: PARENT,
      margin_accounts: [{ contract_id: CHILD, index: 0 }],
      next_margin_account: null,
      session: { session_id: { Address: "0xSOMEOLDKEY" }, contract_ids: [], expiry: "1" },
    });
    const { submitted } = makeHostRef(host);
    await new TurboClient(host).use(CHILD).long(MARKET, { quantity: "1" }, { price: "2000" });

    // The re-arm goes first, as the PARENT, and only then the trade.
    expect(kindsOf(submitted[0])).toEqual(["SetMarginAccountSession"]);
    expect(submitted[0].tradeAccountId).toBe(PARENT);
    expect(kindsOf(submitted[1])).toEqual(["SettleBalance", "Draw", "CreateOrder"]);
    expect(submitted[1].tradeAccountId).toBe(CHILD);
  });

  it("does NOT re-arm when the child already holds the live key", async () => {
    const { host, submitted } = makeHost();
    await new TurboClient(host).use(CHILD).long(MARKET, { quantity: "1" }, { price: "2000" });
    expect(submitted).toHaveLength(1);
    expect(kindsOf(submitted[0])).toEqual(["SettleBalance", "Draw", "CreateOrder"]);
  });

  it("checks once per child, not once per batch", async () => {
    const { host, api } = makeHost();
    const turbo = new TurboClient(host).use(CHILD);
    await turbo.long(MARKET, { quantity: "1" }, { price: "2000" });
    const after = api.getAccount.mock.calls.length;
    await turbo.long(MARKET, { quantity: "1" }, { price: "2000" });
    expect(api.getAccount.mock.calls.length).toBe(after);
  });
});
