/**
 * Integration tests for the O2 TypeScript SDK.
 *
 * These tests hit the live testnet API and require network access.
 * Run with: O2_INTEGRATION=1 npx vitest run tests/integration.test.ts
 *
 * # Order Book Pollution & Pricing Strategy
 *
 * Integration tests create ephemeral accounts (new wallets each run), so orders
 * from prior runs can never be cancelled. Over time, orphaned orders accumulate
 * at whatever prices tests used. All pricing strategies must tolerate an
 * arbitrary number of stale orders on the book.
 *
 * ## Non-fill tests: PostOnly Buy at minimum price step
 *
 * The minimum price step (10^{-max_precision}) is the absolute floor — no sell
 * can exist below it, so a PostOnly Buy there always rests. The locked quote
 * value is trivially small regardless of quantity.
 *
 * ## Fill tests: Maker PostOnly Buy + Taker FillOrKill Sell
 *
 * A taker *buy* walks the sell side from lowest ask upward, paying for every
 * intermediate order. If stale sells have accumulated at high prices, this
 * becomes prohibitively expensive. A taker *sell* walks the buy side from
 * highest bid downward — each fill *pays the taker* rather than costing them.
 * Stale buys at high prices are harmless (taker gets a better fill), and stale
 * buys at low prices are never reached.
 *
 * FillOrKill for the taker prevents leaving a resting order on the book, which
 * is the primary vector for adding new pollution.
 *
 * ## Cleanup: `cleanupOpenOrders` at test start
 *
 * Cleans up leaked orders from earlier tests within the same suite run. Cannot
 * fix prior runs (different wallets), but prevents intra-run accumulation.
 *
 * ## Sizing: 10x min_order
 *
 * Comfortable margin above the minimum order threshold to absorb fee deductions
 * and rounding without rejection.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { Network, type Numeric, O2Client } from "../src/index.js";
import type { Market, SessionActionsResponse, TradeAccountId, WalletState } from "../src/models.js";

const INTEGRATION = process.env.O2_INTEGRATION === "1";

/**
 * Compute the minimum quantity (as human-readable string) that satisfies
 * min_order for a given price string. Returns a string for the Numeric path.
 */
function minQuantityStr(market: Market, priceStr: string): string {
  const minOrder = Number(market.min_order);
  const quoteFactor = 10 ** market.quote.decimals;
  const baseFactor = 10 ** market.base.decimals;
  const price = Number.parseFloat(priceStr);
  const minQty = minOrder / (price * quoteFactor);
  const truncateFactor = 10 ** (market.base.decimals - market.base.max_precision);
  const step = truncateFactor / baseFactor;
  const rounded = Math.ceil(minQty / step) * step;
  const withMargin = rounded * 1.1;
  return withMargin.toFixed(market.base.max_precision);
}

async function mintWithRetry(
  api: InstanceType<typeof O2Client>["api"],
  tradeAccountId: TradeAccountId,
  maxRetries = 4,
) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await api.mintToContract(tradeAccountId);
      return;
    } catch {
      if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

async function ensureFunded(
  client: O2Client,
  tradeAccountId: TradeAccountId,
  assetSymbol: string,
  minBalance: bigint,
  maxMints = 5,
): Promise<void> {
  let mintCount = 0;
  while (true) {
    const balances = await client.getBalances(tradeAccountId);
    const balance = balances[assetSymbol]?.trading_account_balance ?? 0n;

    if (balance >= minBalance) {
      if (mintCount > 0) {
        console.error(`Balance for ${assetSymbol} is now ${balance} (needed ${minBalance})`);
      }
      break;
    }

    if (mintCount >= maxMints) {
      console.error(
        `Warning: Balance for ${assetSymbol} is ${balance} after ${mintCount} mints (need ${minBalance})`,
      );
      break;
    }

    console.error(
      `Balance for ${assetSymbol} is ${balance} (need ${minBalance}), minting... (attempt ${mintCount + 1}/${maxMints})`,
    );

    await mintWithRetry(client.api, tradeAccountId, 3);
    mintCount++;

    // Allow time for on-chain balance to update after mint
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function whitelistWithRetry(
  api: InstanceType<typeof O2Client>["api"],
  tradeAccountId: TradeAccountId,
  maxRetries = 4,
) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await api.whitelistAccount(tradeAccountId);
      await new Promise((r) => setTimeout(r, 10_000));
      return;
    } catch {
      if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

async function createOrderWithWhitelistRetry(
  client: O2Client,
  market: string | Market,
  side: "buy" | "sell",
  price: Numeric,
  quantity: Numeric,
  orderType: string,
  tradeAccountId: TradeAccountId,
  maxRetries = 5,
): Promise<SessionActionsResponse> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await client.createOrder(market, side, price, quantity, {
        orderType: orderType as any,
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("TraderNotWhiteListed") && attempt < maxRetries - 1) {
        await whitelistWithRetry(client.api, tradeAccountId, 2);
        await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

async function setupWithRetry(
  client: O2Client,
  wallet: WalletState,
  maxRetries = 4,
): Promise<{ tradeAccountId: TradeAccountId; nonce: bigint }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await client.setupAccount(wallet);
    } catch {
      if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  throw new Error("setupAccount failed after retries");
}

function moderateFillPriceStr(market: Market): string {
  const minOrder = Number(market.min_order);
  const basePrecisionFactor = 10 ** market.base.max_precision;
  const quoteFactor = 10 ** market.quote.decimals;
  const price = (minOrder * basePrecisionFactor) / quoteFactor;
  return price.toFixed(market.quote.max_precision);
}

function fillQuantityStr(market: Market, priceStr: string): string {
  const minOrder = Number(market.min_order);
  const quoteFactor = 10 ** market.quote.decimals;
  const baseFactor = 10 ** market.base.decimals;
  const price = Number.parseFloat(priceStr);
  const qty = (10 * minOrder) / (price * quoteFactor);
  const truncateFactor = 10 ** (market.base.decimals - market.base.max_precision);
  const step = truncateFactor / baseFactor;
  const rounded = Math.ceil(qty / step) * step;
  return rounded.toFixed(market.base.max_precision);
}

async function cleanupOpenOrders(cl: O2Client, wallet: WalletState, market: Market): Promise<void> {
  try {
    await cl.createSession(wallet, [market], 1);
    try {
      await cl.cancelAllOrders(market);
    } catch {}
    try {
      await cl.settleBalance(market);
    } catch {}
  } catch {}
}

describe.skipIf(!INTEGRATION)("integration", () => {
  // Separate clients for maker/taker — each stores its own session
  const makerClient = new O2Client({ network: Network.TESTNET });
  const takerClient = new O2Client({ network: Network.TESTNET });
  // Shared read-only client for market data queries (no session needed)
  const client = makerClient;

  let makerWallet: WalletState;
  let makerTradeAccountId: TradeAccountId;
  let takerWallet: WalletState;
  let takerTradeAccountId: TradeAccountId;

  beforeAll(async () => {
    // Set up maker account
    makerWallet = O2Client.generateWallet();
    const maker = await setupWithRetry(makerClient, makerWallet);
    makerTradeAccountId = maker.tradeAccountId;
    await whitelistWithRetry(makerClient.api, makerTradeAccountId);
    await mintWithRetry(makerClient.api, makerTradeAccountId);

    // Set up taker account
    takerWallet = O2Client.generateWallet();
    const taker = await setupWithRetry(takerClient, takerWallet);
    takerTradeAccountId = taker.tradeAccountId;
    await whitelistWithRetry(takerClient.api, takerTradeAccountId);
    await mintWithRetry(takerClient.api, takerTradeAccountId);

    // Verify both accounts have sufficient balances
    const markets = await makerClient.getMarkets();
    const market = markets[0];
    const baseSymbol = market.base.symbol;
    const quoteSymbol = market.quote.symbol;
    await ensureFunded(makerClient, makerTradeAccountId, baseSymbol, 50_000_000n);
    await ensureFunded(makerClient, makerTradeAccountId, quoteSymbol, 50_000_000n);
    await ensureFunded(takerClient, takerTradeAccountId, baseSymbol, 50_000_000n);
    await ensureFunded(takerClient, takerTradeAccountId, quoteSymbol, 50_000_000n);
  }, 600_000);

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
    const wallet = O2Client.generateWallet();
    const { tradeAccountId, nonce } = await client.setupAccount(wallet);
    expect(tradeAccountId).toMatch(/^0x/);
    expect(typeof nonce).toBe("bigint");

    // Second call should be safe
    const second = await client.setupAccount(wallet);
    expect(second.tradeAccountId).toBe(tradeAccountId);
  });

  it("integration: resolves market by pair", async () => {
    const markets = await client.getMarkets();
    expect(markets.length).toBeGreaterThan(0);
    const first = markets[0];
    const pair = `${first.base.symbol}/${first.quote.symbol}`;

    const resolved = await client.getMarket(pair);
    expect(resolved.market_id).toBe(first.market_id);
  });

  it("integration: order placement and cancellation", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    // Re-whitelist before trading
    await whitelistWithRetry(makerClient.api, makerTradeAccountId, 2);

    // Use minimum price step — string decimal
    const priceStr = `0.${"0".repeat(market.quote.max_precision - 1)}1`;
    const quantityStr = minQuantityStr(market, priceStr);

    // Verify quote balance (bigint fields)
    const balances = await makerClient.getBalances(makerTradeAccountId);
    const quoteSymbol = market.quote.symbol;
    expect(balances[quoteSymbol]).toBeDefined();
    expect(balances[quoteSymbol].trading_account_balance).toBeGreaterThan(0n);

    // createSession stores session on makerClient
    await makerClient.createSession(makerWallet, [market], 30);

    // Place PostOnly Buy at minimum price
    const response = await createOrderWithWhitelistRetry(
      makerClient,
      market,
      "buy",
      priceStr,
      quantityStr,
      "PostOnly",
      makerTradeAccountId,
    );

    expect(response.txId).toBeTruthy();
    expect(response.orders).toBeDefined();
    expect(response.orders?.length).toBeGreaterThan(0);
    const order = response.orders?.[0];
    expect(order!.order_id).toBeTruthy();
    expect(order!.cancel).not.toBe(true);

    // Cancel the order
    const cancelResponse = await makerClient.cancelOrder(order!.order_id, market);
    expect(cancelResponse.txId).toBeTruthy();
  });

  it("integration: cross-account fill", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(makerClient.api, makerTradeAccountId, 2);
    await whitelistWithRetry(takerClient.api, takerTradeAccountId, 2);

    // Cancel leaked orders from earlier tests in this run
    await cleanupOpenOrders(makerClient, makerWallet, market);
    await cleanupOpenOrders(takerClient, takerWallet, market);

    // Maker buys (needs quote), taker sells (needs base)
    await ensureFunded(makerClient, makerTradeAccountId, market.quote.symbol, 50_000_000n);
    await ensureFunded(takerClient, takerTradeAccountId, market.base.symbol, 50_000_000n);

    // Moderate price below any stale sells — maker buy rests safely.
    // Taker sell walks buys from highest bid down, which is free (receives funds).
    const priceStr = moderateFillPriceStr(market);
    const quantityStr = fillQuantityStr(market, priceStr);

    // Maker: PostOnly Buy at moderate price — rests below all stale sells
    await makerClient.createSession(makerWallet, [market], 30);
    const makerResponse = await createOrderWithWhitelistRetry(
      makerClient,
      market,
      "buy",
      priceStr,
      quantityStr,
      "PostOnly",
      makerTradeAccountId,
    );

    expect(makerResponse.txId).toBeTruthy();
    expect(makerResponse.orders).toBeDefined();
    expect(makerResponse.orders?.length).toBeGreaterThan(0);
    const makerOrder = makerResponse.orders?.[0];
    expect(makerOrder!.order_id).toBeTruthy();
    expect(makerOrder!.cancel).not.toBe(true);

    // Taker: FillOrKill Sell — fills against maker (or stale buys), never rests
    await takerClient.createSession(takerWallet, [market], 30);
    const takerResponse = await createOrderWithWhitelistRetry(
      takerClient,
      market,
      "sell",
      priceStr,
      quantityStr,
      "FillOrKill",
      takerTradeAccountId,
    );

    expect(takerResponse.txId).toBeTruthy();

    // Cleanup: cancel both orders if still open
    try {
      await makerClient.cancelOrder(makerOrder!.order_id, market);
    } catch {
      // Already filled/closed
    }

    // Settle balances to release locked funds for both accounts
    try {
      await makerClient.settleBalance(market);
    } catch {}
    try {
      await takerClient.settleBalance(market);
    } catch {}
  });

  it("integration: fetches account info", async () => {
    const nonce = await client.getNonce(makerTradeAccountId);
    expect(typeof nonce).toBe("bigint");
  });

  it("integration: checks balances", async () => {
    const balances = await client.getBalances(makerTradeAccountId);
    expect(typeof balances).toBe("object");
    expect(balances).not.toBeNull();
  });

  it("integration: streams depth via WebSocket", async () => {
    const markets = await client.getMarkets();
    expect(markets.length).toBeGreaterThan(0);
    const market = markets[0];

    const stream = await client.streamDepth(market, 10);
    let received = false;
    for await (const update of stream) {
      expect(update).toBeDefined();
      received = true;
      break;
    }

    expect(received).toBe(true);
    client.disconnectWs();
  }, 30_000);

  it("integration: streams trades via WebSocket", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(makerClient.api, makerTradeAccountId, 2);
    await whitelistWithRetry(takerClient.api, takerTradeAccountId, 2);

    await cleanupOpenOrders(makerClient, makerWallet, market);
    await cleanupOpenOrders(takerClient, takerWallet, market);

    const wsClient = new O2Client({ network: Network.TESTNET });
    try {
      const stream = await wsClient.streamTrades(market);
      const firstMessage = new Promise<any>((resolve, reject) => {
        (async () => {
          for await (const update of stream) {
            resolve(update);
            return;
          }
          reject(new Error("stream ended without message"));
        })();
      });

      await new Promise((r) => setTimeout(r, 2000));

      const priceStr = moderateFillPriceStr(market);
      const quantityStr = fillQuantityStr(market, priceStr);

      await makerClient.createSession(makerWallet, [market], 30);
      const makerResponse = await createOrderWithWhitelistRetry(
        makerClient,
        market,
        "buy",
        priceStr,
        quantityStr,
        "PostOnly",
        makerTradeAccountId,
      );
      expect(makerResponse.orders?.length).toBeGreaterThan(0);
      const makerOrder = makerResponse.orders?.[0];
      expect(makerOrder!.cancel).not.toBe(true);

      await takerClient.createSession(takerWallet, [market], 30);
      await createOrderWithWhitelistRetry(
        takerClient,
        market,
        "sell",
        priceStr,
        quantityStr,
        "FillOrKill",
        takerTradeAccountId,
      );

      const update = await Promise.race([
        firstMessage,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("WS trades timeout")), 30_000),
        ),
      ]);

      expect(update).toBeDefined();
      expect(update.trades).toBeDefined();
      expect(Array.isArray(update.trades)).toBe(true);
    } finally {
      wsClient.disconnectWs();
      await cleanupOpenOrders(makerClient, makerWallet, market);
      await cleanupOpenOrders(takerClient, takerWallet, market);
    }
  }, 120_000);

  it("integration: streams orders via WebSocket", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(makerClient.api, makerTradeAccountId, 2);
    await cleanupOpenOrders(makerClient, makerWallet, market);

    const wsClient = new O2Client({ network: Network.TESTNET });
    try {
      const stream = await wsClient.streamOrders(makerTradeAccountId);
      const firstMessage = new Promise<any>((resolve, reject) => {
        (async () => {
          for await (const update of stream) {
            resolve(update);
            return;
          }
          reject(new Error("stream ended without message"));
        })();
      });

      await new Promise((r) => setTimeout(r, 2000));

      const priceStr = `0.${"0".repeat(market.quote.max_precision - 1)}1`;
      const quantityStr = minQuantityStr(market, priceStr);

      await makerClient.createSession(makerWallet, [market], 30);
      const response = await createOrderWithWhitelistRetry(
        makerClient,
        market,
        "buy",
        priceStr,
        quantityStr,
        "PostOnly",
        makerTradeAccountId,
      );
      expect(response.orders?.length).toBeGreaterThan(0);
      const order = response.orders?.[0];

      const update = await Promise.race([
        firstMessage,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("WS orders timeout")), 30_000),
        ),
      ]);

      expect(update).toBeDefined();
      expect(update.orders).toBeDefined();
      expect(Array.isArray(update.orders)).toBe(true);

      try {
        await makerClient.cancelOrder(order!.order_id, market);
      } catch {}
    } finally {
      wsClient.disconnectWs();
      await cleanupOpenOrders(makerClient, makerWallet, market);
    }
  }, 60_000);

  it("integration: streams balances via WebSocket", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(makerClient.api, makerTradeAccountId, 2);
    await cleanupOpenOrders(makerClient, makerWallet, market);

    const wsClient = new O2Client({ network: Network.TESTNET });
    try {
      const stream = await wsClient.streamBalances(makerTradeAccountId);
      const firstMessage = new Promise<any>((resolve, reject) => {
        (async () => {
          for await (const update of stream) {
            resolve(update);
            return;
          }
          reject(new Error("stream ended without message"));
        })();
      });

      await new Promise((r) => setTimeout(r, 2000));

      const priceStr = `0.${"0".repeat(market.quote.max_precision - 1)}1`;
      const quantityStr = minQuantityStr(market, priceStr);

      await makerClient.createSession(makerWallet, [market], 30);
      const response = await createOrderWithWhitelistRetry(
        makerClient,
        market,
        "buy",
        priceStr,
        quantityStr,
        "PostOnly",
        makerTradeAccountId,
      );
      expect(response.orders?.length).toBeGreaterThan(0);
      const order = response.orders?.[0];

      const update = await Promise.race([
        firstMessage,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("WS balances timeout")), 30_000),
        ),
      ]);

      expect(update).toBeDefined();
      expect(update.balance).toBeDefined();
      expect(Array.isArray(update.balance)).toBe(true);

      try {
        await makerClient.cancelOrder(order!.order_id, market);
      } catch {}
    } finally {
      wsClient.disconnectWs();
      await cleanupOpenOrders(makerClient, makerWallet, market);
    }
  }, 60_000);

  it("integration: streams nonce via WebSocket", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(makerClient.api, makerTradeAccountId, 2);
    await cleanupOpenOrders(makerClient, makerWallet, market);

    const wsClient = new O2Client({ network: Network.TESTNET });
    try {
      const stream = await wsClient.streamNonce(makerTradeAccountId);
      const firstMessage = new Promise<any>((resolve, reject) => {
        (async () => {
          for await (const update of stream) {
            resolve(update);
            return;
          }
          reject(new Error("stream ended without message"));
        })();
      });

      await new Promise((r) => setTimeout(r, 2000));

      const priceStr = `0.${"0".repeat(market.quote.max_precision - 1)}1`;
      const quantityStr = minQuantityStr(market, priceStr);

      await makerClient.createSession(makerWallet, [market], 30);
      const response = await createOrderWithWhitelistRetry(
        makerClient,
        market,
        "buy",
        priceStr,
        quantityStr,
        "PostOnly",
        makerTradeAccountId,
      );
      expect(response.orders?.length).toBeGreaterThan(0);
      const order = response.orders?.[0];

      const update = await Promise.race([
        firstMessage,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("WS nonce timeout")), 30_000),
        ),
      ]);

      expect(update).toBeDefined();
      expect(update.nonce).toBeDefined();

      try {
        await makerClient.cancelOrder(order!.order_id, market);
      } catch {}
    } finally {
      wsClient.disconnectWs();
      await cleanupOpenOrders(makerClient, makerWallet, market);
    }
  }, 60_000);

  it("integration: concurrent different-type subscriptions (orders + balances + nonce)", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(makerClient.api, makerTradeAccountId, 2);
    await cleanupOpenOrders(makerClient, makerWallet, market);

    const wsClient = new O2Client({ network: Network.TESTNET });
    try {
      const ordersStream = await wsClient.streamOrders(makerTradeAccountId);
      const balancesStream = await wsClient.streamBalances(makerTradeAccountId);
      const nonceStream = await wsClient.streamNonce(makerTradeAccountId);

      const ordersFirst = new Promise<any>((resolve, reject) => {
        (async () => {
          for await (const update of ordersStream) {
            resolve(update);
            return;
          }
          reject(new Error("orders stream ended"));
        })();
      });
      const balancesFirst = new Promise<any>((resolve, reject) => {
        (async () => {
          for await (const update of balancesStream) {
            resolve(update);
            return;
          }
          reject(new Error("balances stream ended"));
        })();
      });
      const nonceFirst = new Promise<any>((resolve, reject) => {
        (async () => {
          for await (const update of nonceStream) {
            resolve(update);
            return;
          }
          reject(new Error("nonce stream ended"));
        })();
      });

      await new Promise((r) => setTimeout(r, 2000));

      const priceStr = `0.${"0".repeat(market.quote.max_precision - 1)}1`;
      const quantityStr = minQuantityStr(market, priceStr);

      await makerClient.createSession(makerWallet, [market], 30);
      const response = await createOrderWithWhitelistRetry(
        makerClient,
        market,
        "buy",
        priceStr,
        quantityStr,
        "PostOnly",
        makerTradeAccountId,
      );
      expect(response.orders?.length).toBeGreaterThan(0);
      const order = response.orders?.[0];

      const timeout = (ms: number) =>
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));

      const [ordersUpdate, balancesUpdate, nonceUpdate] = await Promise.all([
        Promise.race([ordersFirst, timeout(30_000)]),
        Promise.race([balancesFirst, timeout(30_000)]),
        Promise.race([nonceFirst, timeout(30_000)]),
      ]);

      expect(ordersUpdate.orders).toBeDefined();
      expect(Array.isArray(ordersUpdate.orders)).toBe(true);
      expect(ordersUpdate.balance).toBeUndefined();
      expect(ordersUpdate.nonce).toBeUndefined();

      expect(balancesUpdate.balance).toBeDefined();
      expect(Array.isArray(balancesUpdate.balance)).toBe(true);
      expect(balancesUpdate.orders).toBeUndefined();
      expect(balancesUpdate.nonce).toBeUndefined();

      expect(nonceUpdate.nonce).toBeDefined();
      expect(nonceUpdate.orders).toBeUndefined();
      expect(nonceUpdate.balance).toBeUndefined();

      try {
        await makerClient.cancelOrder(order!.order_id, market);
      } catch {}
    } finally {
      wsClient.disconnectWs();
      await cleanupOpenOrders(makerClient, makerWallet, market);
    }
  }, 120_000);

  it("integration: mixed subscriptions with cross-account fill", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(makerClient.api, makerTradeAccountId, 2);
    await whitelistWithRetry(takerClient.api, takerTradeAccountId, 2);

    await cleanupOpenOrders(makerClient, makerWallet, market);
    await cleanupOpenOrders(takerClient, takerWallet, market);

    const wsClient = new O2Client({ network: Network.TESTNET });
    try {
      const tradesStream = await wsClient.streamTrades(market);
      const ordersStream = await wsClient.streamOrders(makerTradeAccountId);
      const balancesStream = await wsClient.streamBalances(makerTradeAccountId);

      const tradesFirst = new Promise<any>((resolve, reject) => {
        (async () => {
          for await (const update of tradesStream) {
            resolve(update);
            return;
          }
          reject(new Error("trades stream ended"));
        })();
      });
      const ordersFirst = new Promise<any>((resolve, reject) => {
        (async () => {
          for await (const update of ordersStream) {
            resolve(update);
            return;
          }
          reject(new Error("orders stream ended"));
        })();
      });
      const balancesFirst = new Promise<any>((resolve, reject) => {
        (async () => {
          for await (const update of balancesStream) {
            resolve(update);
            return;
          }
          reject(new Error("balances stream ended"));
        })();
      });

      await new Promise((r) => setTimeout(r, 2000));

      const priceStr = moderateFillPriceStr(market);
      const quantityStr = fillQuantityStr(market, priceStr);

      await makerClient.createSession(makerWallet, [market], 30);
      const makerResponse = await createOrderWithWhitelistRetry(
        makerClient,
        market,
        "buy",
        priceStr,
        quantityStr,
        "PostOnly",
        makerTradeAccountId,
      );
      expect(makerResponse.orders?.length).toBeGreaterThan(0);
      const makerOrder = makerResponse.orders?.[0];
      expect(makerOrder!.cancel).not.toBe(true);

      await takerClient.createSession(takerWallet, [market], 30);
      await createOrderWithWhitelistRetry(
        takerClient,
        market,
        "sell",
        priceStr,
        quantityStr,
        "FillOrKill",
        takerTradeAccountId,
      );

      const timeout = (ms: number) =>
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));

      const [tradesUpdate, ordersUpdate, balancesUpdate] = await Promise.all([
        Promise.race([tradesFirst, timeout(30_000)]),
        Promise.race([ordersFirst, timeout(30_000)]),
        Promise.race([balancesFirst, timeout(30_000)]),
      ]);

      expect(tradesUpdate.trades).toBeDefined();
      expect(Array.isArray(tradesUpdate.trades)).toBe(true);
      expect(tradesUpdate.orders).toBeUndefined();
      expect(tradesUpdate.balance).toBeUndefined();

      expect(ordersUpdate.orders).toBeDefined();
      expect(Array.isArray(ordersUpdate.orders)).toBe(true);
      expect(ordersUpdate.trades).toBeUndefined();
      expect(ordersUpdate.balance).toBeUndefined();

      expect(balancesUpdate.balance).toBeDefined();
      expect(Array.isArray(balancesUpdate.balance)).toBe(true);
      expect(balancesUpdate.trades).toBeUndefined();
      expect(balancesUpdate.orders).toBeUndefined();
    } finally {
      wsClient.disconnectWs();
      await cleanupOpenOrders(makerClient, makerWallet, market);
      await cleanupOpenOrders(takerClient, takerWallet, market);
    }
  }, 120_000);
});
