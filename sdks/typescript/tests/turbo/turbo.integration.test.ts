/**
 * End-to-end Turbo round trip against a live network.
 *
 * ⚠️  THIS SUITE HAS NEVER BEEN EXECUTED. It was written from the wire
 * contracts and the backend's own call derivation, but running it needs a
 * funded account on a deployment with margin wired AND a purchasable tier,
 * neither of which was available when it was authored. Treat a first run as
 * exploratory: expect to adjust tier selection and sizing for whatever the
 * target network actually publishes.
 *
 * Run with:
 *   O2_INTEGRATION=1 O2_PRIVATE_KEY=0x… npx vitest run tests/turbo/turbo.integration.test.ts
 */

import { beforeAll, describe, expect, it } from "vitest";
import { Network, O2Client } from "../../src/index.js";
import type { WalletState } from "../../src/models.js";
import type { MarginTierWire } from "../../src/turbo/wire.js";

const RUN = process.env.O2_INTEGRATION === "1";
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

    const tiers = await client.turbo.tiers();
    expect(tiers.length).toBeGreaterThan(0);
    tier = tiers[0];
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
    // Margin PLUS premium. `required_collateral` is the floor; the open
    // also costs `open_fee + prolong_fee[period]` out of the same forward.
    const collateral =
      BigInt(tier.required_collateral) + BigInt(tier.open_fee) + BigInt(tier.prolong_fee[3]);

    const opened = await client.turbo.open({
      tierId: tier.tier_id,
      collateral,
      period: "Month",
      onProgress: (stage) => console.log(`[turbo] ${stage}`),
    });
    expect(opened.marginAccountId).toMatch(/^0x[0-9a-f]{64}$/);

    const snapshot = await client.turbo.snapshot();
    expect(snapshot.creditLine).toBeGreaterThan(0n);
    expect(snapshot.frozen).toBe(false);

    // LONG — one batch: sweep, draw, buy.
    const long = await client.turbo.long(MARKET, { notional: "10" });
    expect(long.success ?? true).toBeTruthy();

    let positions = await client.turbo.positions();
    expect(positions.some((p) => p.side === "long")).toBe(true);

    await client.turbo.closePosition(MARKET);
    await client.turbo.repayDrawn();

    // SHORT — one batch: sweep, borrow, sell. Only assets the tier lists
    // AND the pool holds can be shorted.
    const maxSell = await client.turbo.maxSell((await client.turbo.wiring()).collateralAssetId);
    if (maxSell > 0n) {
      await client.turbo.short(MARKET, { quantity: "0.001" });
      positions = await client.turbo.positions();
      expect(positions.some((p) => p.side === "short")).toBe(true);
      await client.turbo.closePosition(MARKET);
    }

    // A clean close needs `drawn_quote == 0` and no in-kind debts.
    await client.turbo.repayDrawn(undefined, { fromCollateral: true });
    await client.turbo.closeAccount();
  }, 600_000);

  it("reads referral status without a referral", async () => {
    const status = await client.turbo.referral.status();
    expect(typeof status.referred).toBe("boolean");
  });
});
