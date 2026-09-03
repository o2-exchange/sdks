/**
 * Turbo (margin) trading.
 *
 * A Turbo account trades on a credit line rather than its own cash. Its
 * collateral sits with the POOL, not on the account, so every trade needs a
 * funding leg — the SDK composes that for you: `long` draws quote, `short`
 * borrows the asset in kind, and both ride the same signed batch as the
 * order.
 *
 * Run: npx tsx examples/turbo.ts
 */

import { Network, O2Client } from "../src/index.js";

const MARKET = "fETH/fUSDC";

async function main() {
  const client = new O2Client({ network: Network.TESTNET });
  const wallet = process.env.O2_PRIVATE_KEY
    ? O2Client.loadWallet(process.env.O2_PRIVATE_KEY)
    : O2Client.generateWallet();

  await client.setupAccount(wallet);

  // `turbo: true` adds the margin pool, every margin account this owner
  // already has, and the next few they could open, to the session's signed
  // contract scope.
  //
  // This is not an optimisation. The trade account checks every call's
  // target against that scope, and it CANNOT be widened afterwards —
  // it is part of what the wallet signed. A session created without it can
  // do nothing with a Turbo account and the only repair is a new session.
  await client.createSession(wallet, [MARKET], { turbo: true });

  const turbo = client.turbo;

  // ── Open an account ────────────────────────────────────────────
  const tiers = await turbo.tiers();
  const tier = tiers[0];
  if (!tier) throw new Error("No Turbo tiers published on this deployment");

  // The entry buys its first term, so it costs the tier's collateral plus
  // `open_fee + prolong_fee[period]`.
  const collateral =
    BigInt(tier.required_collateral) + BigInt(tier.open_fee) + BigInt(tier.prolong_fee[3]);

  const account = await turbo.open({
    tierId: tier.tier_id,
    collateral,
    period: "Month",
    // Opening is two submissions with an indexing wait between them —
    // without this it reads as a hung call.
    onProgress: (stage) => console.log(`  ${stage}…`),
  });
  console.log("Turbo account:", account.marginAccountId);

  // ── Look at it ─────────────────────────────────────────────────
  const snapshot = await turbo.snapshot();
  console.log("credit line      :", snapshot.creditLine);
  console.log("equity           :", snapshot.equity);
  console.log("available to trade:", snapshot.availableToTrade);
  console.log("time remaining   :", snapshot.secondsRemaining, "s");

  // ── Trade ──────────────────────────────────────────────────────
  // Size by base quantity, or by collateral notional.
  await turbo.long(MARKET, { notional: "500" });
  console.log("positions:", await turbo.positions());

  await turbo.closePosition(MARKET);
  // The fill is not known at signing time, so retiring the draw the
  // position left behind is a separate step.
  await turbo.repayDrawn();

  // Shorting borrows the asset from the pool. Only assets the tier lists
  // AND the pool actually holds are shortable — everything else is
  // long-only, which `maxSell` will tell you before you try.
  const wiring = await turbo.wiring();
  console.log("max sellable:", await turbo.maxSell(wiring.collateralAssetId));
  await turbo.short(MARKET, { quantity: "0.05" });
  await turbo.closePosition(MARKET);

  // ── Manage ─────────────────────────────────────────────────────
  await turbo.addMargin(100_000000n); // top up, straight to the pool
  await turbo.extend("Week"); // buy more session life
  await turbo.setAutoExtend("Week"); // or let it renew itself

  // ── Referral ───────────────────────────────────────────────────
  const code = await turbo.referral.mintCode();
  console.log("referral code:", code.code);
  // A referee binds themselves to it. Permanent, first code wins — and
  // gate any discounted purchase on `discount_active`, not on the call
  // merely succeeding.
  // await turbo.referral.activate("SOMECODE");

  // ── Close out ──────────────────────────────────────────────────
  // A clean close needs no in-kind debts and no drawn quote. Positions are
  // swept in kind rather than sold, so leaving never forces a market exit.
  await turbo.repayDrawn(undefined, { fromCollateral: true });
  await turbo.closeAccount();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
