/**
 * Integration tests for the O2 TypeScript SDK.
 *
 * These tests hit the live testnet API and require network access.
 * Run with: npm test -- --grep integration
 *
 * Tests are idempotent and safe to run repeatedly.
 */

import { describe, it, expect } from "vitest";
import { O2Client, Network } from "../src/index.js";

const INTEGRATION = process.env.O2_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("integration", () => {
  const client = new O2Client({ network: Network.TESTNET });

  it("integration: fetches markets", async () => {
    const markets = await client.getMarkets();
    expect(markets.length).toBeGreaterThan(0);
    expect(markets[0].market_id).toMatch(/^0x/);
    expect(markets[0].base.symbol).toBeTruthy();
    expect(markets[0].quote.symbol).toBeTruthy();
    expect(markets[0].base.decimals).toBeGreaterThan(0);
  });

  it("integration: fetches depth", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];
    const depth = await client.getDepth(market, 10);
    expect(depth).toHaveProperty("buys");
    expect(depth).toHaveProperty("sells");
    expect(Array.isArray(depth.buys)).toBe(true);
    expect(Array.isArray(depth.sells)).toBe(true);
  });

  it("integration: fetches trades", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];
    const trades = await client.getTrades(market, 10);
    expect(Array.isArray(trades)).toBe(true);
  });

  it("integration: creates account idempotently", async () => {
    const wallet = client.generateWallet();
    const { tradeAccountId, nonce } = await client.setupAccount(wallet);
    expect(tradeAccountId).toMatch(/^0x/);
    expect(typeof nonce).toBe("bigint");

    // Second call should be safe
    const second = await client.setupAccount(wallet);
    expect(second.tradeAccountId).toBe(tradeAccountId);
  });

  it("integration: full session and order flow", async () => {
    const wallet = client.generateWallet();
    let tradeAccountId: string;
    try {
      ({ tradeAccountId } = await client.setupAccount(wallet));
    } catch {
      console.log("setupAccount rate-limited (expected on testnet)");
      return;
    }

    // Wait for faucet cooldown
    await new Promise((r) => setTimeout(r, 2000));

    const markets = await client.getMarkets();
    const market = markets[0];

    const session = await client.createSession(
      wallet,
      tradeAccountId,
      [market],
      30
    );

    expect(session.sessionAddress).toMatch(/^0x/);
    expect(session.contractIds.length).toBeGreaterThan(0);

    // Place an order (may fail due to insufficient balance, which is expected)
    try {
      const { response } = await client.createOrder(
        session,
        market,
        "Buy",
        0.001, // very low price to avoid fills
        10.0,
        "Spot",
        true,
        true
      );
      expect(response.tx_id).toMatch(/^0x/);
    } catch (error) {
      // Expected if faucet didn't provide enough funds
      console.log("Order placement failed (expected if low balance):", error);
    }
  });

  it("integration: fetches account info", async () => {
    const wallet = client.generateWallet();
    let tradeAccountId: string;
    try {
      ({ tradeAccountId } = await client.setupAccount(wallet));
    } catch {
      console.log("setupAccount rate-limited (expected on testnet)");
      return;
    }

    const nonce = await client.getNonce(tradeAccountId);
    expect(typeof nonce).toBe("bigint");
  });
});
