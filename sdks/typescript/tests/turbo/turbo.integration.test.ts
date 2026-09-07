/**
 * End-to-end Turbo round trip against a live network.
 *
 * NOT part of `npm run test:integration` — it opens a real margin account,
 * trades it and tears it down, which takes minutes and depends on testnet
 * book liquidity and faucet funding. Run it deliberately:
 *
 *   npm run test:integration:turbo
 *
 * VERIFIED against O2 testnet. The open, the long, the position read, the
 * close and the draw settlement all execute end to end; the short leg
 * submits and is accepted on chain, though whether it becomes a position
 * depends on the book. `closeAccount` can still be refused over a small
 * drawn-quote residue — see the note at the call site.
 *
 * Optionally set `O2_PRIVATE_KEY` to reuse a funded wallet, and
 * `O2_TURBO_MARKET` to pick the market.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { Network, O2Client, stopLimit, triggerLeg, triggerQuantity } from "../../src/index.js";
import type { WalletState } from "../../src/models.js";
import type { MarginTierWire } from "../../src/turbo/wire.js";

const RUN = process.env.O2_INTEGRATION === "1";

/**
 * Poll until a position of `side` shows up.
 *
 * The margin state is served from an indexer, so reading positions in the
 * same breath as the order that opened them routinely finds nothing yet.
 */
async function waitForPosition(turbo: O2Client["turbo"], side: "long" | "short"): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const positions = await turbo.positions();
    if (positions.some((p) => p.side === side)) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}
const PRIVATE_KEY = process.env.O2_PRIVATE_KEY;
const MARKET = process.env.O2_TURBO_MARKET ?? "fETH/fUSDC";

describe.skipIf(!RUN)("Turbo integration", () => {
  let client: O2Client;
  let wallet: WalletState;
  let tier: MarginTierWire;

  beforeAll(async () => {
    client = new O2Client({ network: Network.TESTNET });
    wallet = PRIVATE_KEY ? O2Client.loadWallet(PRIVATE_KEY) : O2Client.generateWallet();

    await client.setupAccount(wallet);

    // THE SCOPE MUST BE SIGNED UP FRONT. A session created without
    // `turbo: true` can do nothing with a margin account, and the only
    // repair is a new session — the scope is part of what was signed.
    await client.createSession(wallet, [MARKET], { turbo: true });

    // The CHEAPEST tier that is actually on sale. `/v1/margin/tiers` serves
    // retired versions too, and on testnet the first entry is disabled —
    // the pool only says so after the batch has been signed.
    const cheapest = await client.turbo.cheapestTier();
    expect(cheapest).not.toBeNull();
    tier = cheapest as MarginTierWire;
  }, 120_000);

  it("resolves the deployment's margin wiring", async () => {
    const wiring = await client.turbo.wiring();
    expect(wiring.poolId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(wiring.collateralAssetId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(wiring.collateralDecimals).toBeGreaterThan(0);
  });

  it("scopes the session to the margin pool", async () => {
    // Without this the first margin action comes back
    // `MarginAccountNotInSessionScope`, and no retry can fix it — the
    // scope is part of what was signed.
    const wiring = await client.turbo.wiring();
    const session = (client as unknown as { _session: { contractIds: string[] } })._session;
    expect(session.contractIds.map((id) => id.toLowerCase())).toContain(wiring.poolId);
  });

  it("opens an account, then trades both ways and closes", async () => {
    // Margin PLUS premium — `required_collateral` is only the floor.
    const collateral = client.turbo.openingCost(tier);

    // A testnet faucet account may simply not hold enough of the collateral
    // asset for the cheapest tier on offer. Say so and stop rather than
    // reporting an underfunded wallet as an SDK failure.
    const wiring = await client.turbo.wiring();
    const balance = await client.api.getBalance(wiring.collateralAssetId as never, {
      contract: (await client.api.getAccount({ owner: wallet.b256Address })).trade_account_id,
    });
    if (balance.trading_account_balance < collateral) {
      console.warn(
        `[turbo] skipping: need ${collateral} of collateral, account holds ${balance.trading_account_balance}`,
      );
      return;
    }

    const opened = await client.turbo.open({
      tierId: tier.tier_id,
      collateral,
      // Period omitted on purpose: a prepaid tier sells exactly one term
      // and the SDK reads it off the tier.
      onProgress: (stage) => console.log(`[turbo] ${stage}`),
    });
    expect(opened.marginAccountId).toMatch(/^0x[0-9a-f]{64}$/);

    const snapshot = await client.turbo.snapshot();
    expect(snapshot.creditLine).toBeGreaterThan(0n);
    expect(snapshot.frozen).toBe(false);

    // LONG — one batch: sweep, draw, buy.
    const long = await client.turbo.long(MARKET, { notional: "10" });
    expect(long.success ?? true).toBeTruthy();

    expect(await waitForPosition(client.turbo, "long")).toBe(true);

    await client.turbo.closePosition(MARKET);
    await client.turbo.repayDrawn();

    // SHORT — one batch: sweep, borrow, sell.
    //
    // Asked about the market's BASE asset, not the collateral: the
    // collateral is DRAWN, never borrowed, so `maxSell` on it is
    // meaningless and gating the leg on it told us nothing.
    //
    // Conditional because shorting needs the tier to list the asset AND
    // the pool to actually hold some of it — a line is permission to
    // borrow, not a promise the coins exist. Where the pool lends none,
    // the market is long-only and skipping is the correct outcome, not a
    // failure.
    const markets = await client.getMarkets();
    const market = markets.find((m) => `${m.base.symbol}/${m.quote.symbol}` === MARKET);
    const maxSell = market ? await client.turbo.maxSell(market.base.asset as never) : 0n;
    console.log(`[turbo] max sellable ${market?.base.symbol}: ${maxSell}`);

    // SIZED FROM THE BOOK, not hardcoded. A fixed 0.001 clears `min_order`
    // at one price and falls under it at another, so the test failed on a
    // dip rather than on anything the SDK did. Take the smallest quantity
    // whose notional clears the minimum, with headroom for the price
    // moving between this read and the submission.
    const shortDepth = market ? await client.api.getDepth(market.market_id, 10, 1) : null;
    const shortBid = shortDepth?.bids?.length ? BigInt(shortDepth.bids[0].price) : 0n;
    const minOrder = market ? BigInt((market as unknown as { min_order: bigint }).min_order) : 0n;
    const baseUnit = market ? 10n ** BigInt(market.base.decimals) : 1n;
    const shortQty = shortBid > 0n ? ((minOrder * baseUnit) / shortBid) * 2n : 0n;

    if (maxSell >= shortQty && shortQty > 0n) {
      // The batch submitting at all is the assertion that matters here: it
      // proves the borrow-then-sell composition is accepted on chain.
      //
      // Whether it becomes a POSITION depends on the book — an unfilled
      // sell leaves the borrowed base locked in the resting order, so the
      // account is genuinely flat (holdings and debt cancel) until it
      // fills. On a thin testnet book that is the normal outcome, and
      // failing on it would test liquidity rather than the SDK.
      const short = await client.turbo.short(MARKET, { quantity: shortQty });
      expect(short.txId ?? short.success ?? true).toBeTruthy();
      if (await waitForPosition(client.turbo, "short")) {
        await client.turbo.closePosition(MARKET);
      } else {
        console.warn("[turbo] short did not fill on this book; cancelling instead");
        await client.cancelAllOrders(MARKET).catch(() => null);
      }
    }

    // PROTECTION ON A TURBO POSITION, while the account is still live.
    // A margin account cannot walk an unpriced order for risk, so the pool
    // refuses a bare market trigger — caught client-side so the rejection
    // never arrives after a signature.
    await expect(
      client.turbo.long(MARKET, { notional: "5" }, { takeProfit: { triggerPrice: "2600" } }),
    ).rejects.toThrow(/must be priced/);

    // A clean close needs no in-kind debts and `drawn_quote == 0`.
    // `closeAccount` cancels resting orders, flattens positions and
    // retires in-kind debts before closing, which is enough for an
    // ordinary account.
    //
    // What it cannot do is conjure funds: an account whose draw is tied up
    // in a position it cannot afford to buy back has no self-serve exit,
    // and the remedy is to add margin first. Attempted here in that order,
    // and reported rather than asserted, because whether this account ends
    // up in that state depends on how the book filled.
    try {
      await client.turbo.closeAccount();
    } catch (error) {
      console.warn(`[turbo] close needed margin first: ${String(error).slice(0, 160)}`);
      await client.turbo.addMargin(25_000_000_000n).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await client.turbo
        .closeAccount()
        .catch((e) => console.warn(`[turbo] close still refused: ${String(e).slice(0, 160)}`));
    }
  }, 900_000);

  it("places, lists and cancels spot take-profit / stop-loss orders", async () => {
    const markets = await client.getMarkets();
    const market = markets.find((m) => `${m.base.symbol}/${m.quote.symbol}` === MARKET);
    if (!market) throw new Error(`${MARKET} not listed`);

    const depth = await client.api.getDepth(market.market_id, 10, 5);
    if (!depth.bids?.length || !depth.asks?.length) {
      console.warn("[turbo] empty book; skipping spot TP/SL");
      return;
    }
    const bid = BigInt(depth.bids[0].price);
    const ask = BigInt(depth.asks[0].price);
    // Every price must land on the market's tick or the chain answers
    // `PricePrecision` — the SDK aligns the ones it derives, but a price
    // the caller states is the caller's to align.
    const tick = 10n ** BigInt(market.quote.decimals - market.quote.max_precision);
    const align = (price: bigint) => (price / tick) * tick;

    // PostOnly so the parent rests rather than filling: the point is the
    // trigger encoding, not a fill.
    const attached = await client.createOrderWithTriggers(
      MARKET,
      "buy",
      align((bid * 90n) / 100n),
      5_000_000n,
      {
        orderType: "PostOnly",
        takeProfit: {
          triggerPrice: align((ask * 110n) / 100n),
          limitPrice: align((ask * 109n) / 100n),
        },
        stopLoss: {
          triggerPrice: align((bid * 80n) / 100n),
          limitPrice: align((bid * 79n) / 100n),
        },
      },
    );
    expect(attached.errorCode ?? null).toBeNull();

    // A slippage-bounded leg exercises the bound derivation and its
    // inward tick rounding.
    const bounded = await client.createOrderWithTriggers(
      MARKET,
      "buy",
      align((bid * 89n) / 100n),
      5_000_000n,
      {
        orderType: "PostOnly",
        takeProfit: { triggerPrice: align((ask * 112n) / 100n), slippageBps: 100 },
      },
    );
    expect(bounded.errorCode ?? null).toBeNull();

    // Standalone, sized explicitly rather than inherited.
    const standalone = await client.createTriggerOrder(
      MARKET,
      triggerLeg({
        side: "sell",
        triggerPrice: align((bid * 85n) / 100n),
        kind: stopLimit(align((bid * 84n) / 100n)),
        quantity: triggerQuantity(3_000_000n),
      }),
    );
    expect(standalone.errorCode ?? null).toBeNull();

    // The triggers must be discoverable — this is the only route to
    // standalone ones, since the socket carries them on change only.
    const account = await client.api.getAccount({ owner: wallet.b256Address });
    const active = await client.api.getActiveOrders(
      market.market_id,
      account.trade_account_id as never,
    );
    expect(active.entries.length).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await client.cancelAllTriggerOrders(MARKET).catch(() => null);
    await client.cancelAllOrders(MARKET).catch(() => null);
  }, 300_000);

  it("reads referral status without a referral", async () => {
    const status = await client.turbo.referral.status();
    expect(typeof status.referred).toBe("boolean");
  });
});
