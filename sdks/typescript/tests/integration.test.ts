/**
 * Integration tests for the O2 TypeScript SDK.
 *
 * These tests hit the live testnet API and require network access.
 * Run with: O2_INTEGRATION=1 npx vitest run tests/integration.test.ts
 *
 * Tests are idempotent and safe to run repeatedly.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { Network, O2Client } from "../src/index.js";
import type { Market, WalletState } from "../src/models.js";

const INTEGRATION = process.env.O2_INTEGRATION === "1";

function minQuantityForMinOrder(market: Market, price: number): number {
  const minOrder = Number(market.min_order) || 1_000_000;
  const quoteFactor = 10 ** market.quote.decimals;
  const baseFactor = 10 ** market.base.decimals;
  const minQty = minOrder / (price * quoteFactor);
  const truncateFactor = 10 ** (market.base.decimals - market.base.max_precision);
  const step = truncateFactor / baseFactor;
  const rounded = Math.ceil(minQty / step) * step;
  return rounded * 1.1;
}

/**
 * Calculate a safe sell price from balance constraints alone (no book dependency).
 * Uses a tiny fraction of base balance so the price is very high — well above
 * any testnet bid — and the required quantity is trivially small.
 */
function safeSellPrice(market: Market, baseBalance: bigint): number {
  const minOrder = Number(market.min_order) || 1_000_000;
  const baseFactor = 10 ** market.base.decimals;
  const quoteFactor = 10 ** market.quote.decimals;
  // Budget: 0.1% of balance or 100k chain units, whichever is smaller
  const budgetChain = Math.min(Number(baseBalance) * 0.001, 100_000);
  const budget = Math.max(budgetChain, 1) / baseFactor;
  // Price where selling 'budget' meets min_order, with 2x margin
  return (minOrder / (budget * quoteFactor)) * 2.0;
}

async function mintWithRetry(
  api: InstanceType<typeof O2Client>["api"],
  tradeAccountId: string,
  maxRetries = 4,
) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await api.mintToContract(tradeAccountId);
      return;
    } catch {
      if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 65_000));
    }
  }
}

async function whitelistWithRetry(
  api: InstanceType<typeof O2Client>["api"],
  tradeAccountId: string,
  maxRetries = 4,
) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await api.whitelistAccount(tradeAccountId);
      // Allow time for on-chain whitelist propagation
      await new Promise((r) => setTimeout(r, 10_000));
      return;
    } catch {
      if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 65_000));
    }
  }
}

async function createOrderWithWhitelistRetry(
  client: O2Client,
  session: ReturnType<typeof client.createSession> extends Promise<infer T> ? T : never,
  market: Market,
  side: "Buy" | "Sell",
  price: number,
  quantity: number,
  orderType: string,
  settleFirst: boolean,
  collectOrders: boolean,
  tradeAccountId: string,
  maxRetries = 5,
): Promise<{ response: any; session: any }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await client.createOrder(
        session,
        market,
        side,
        price,
        quantity,
        orderType,
        settleFirst,
        collectOrders,
      );
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("TraderNotWhiteListed") && attempt < maxRetries - 1) {
        await whitelistWithRetry(client.api, tradeAccountId, 2);
        // Additional backoff on top of whitelist propagation delay
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
): Promise<{ tradeAccountId: string; nonce: bigint }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await client.setupAccount(wallet);
    } catch {
      if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 65_000));
    }
  }
  throw new Error("setupAccount failed after retries");
}

function moderateFillPrice(market: Market): number {
  const minOrder = Number(market.min_order) || 1_000_000;
  const basePrecisionFactor = 10 ** market.base.max_precision;
  const quoteFactor = 10 ** market.quote.decimals;
  return (minOrder * basePrecisionFactor) / quoteFactor;
}

function fillQuantity(market: Market, price: number): number {
  const minOrder = Number(market.min_order) || 1_000_000;
  const quoteFactor = 10 ** market.quote.decimals;
  const baseFactor = 10 ** market.base.decimals;
  const qty = (10 * minOrder) / (price * quoteFactor);
  const truncateFactor = 10 ** (market.base.decimals - market.base.max_precision);
  const step = truncateFactor / baseFactor;
  return Math.ceil(qty / step) * step;
}

async function cleanupOpenOrders(
  cl: O2Client,
  wallet: WalletState,
  tradeAccountId: string,
  market: Market,
): Promise<void> {
  try {
    const session = await cl.createSession(wallet, tradeAccountId, [market], 1);
    try {
      await cl.cancelAllOrders(session, market);
    } catch {}
    try {
      await cl.settleBalance(session, market);
    } catch {}
  } catch {}
}

describe.skipIf(!INTEGRATION)("integration", () => {
  const client = new O2Client({ network: Network.TESTNET });

  let makerWallet: WalletState;
  let makerTradeAccountId: string;
  let takerWallet: WalletState;
  let takerTradeAccountId: string;

  beforeAll(async () => {
    // Set up maker account (with rate-limit retries)
    makerWallet = client.generateWallet();
    const maker = await setupWithRetry(client, makerWallet);
    makerTradeAccountId = maker.tradeAccountId;
    await whitelistWithRetry(client.api, makerTradeAccountId);
    await mintWithRetry(client.api, makerTradeAccountId);

    // Set up taker account (with rate-limit retries)
    takerWallet = client.generateWallet();
    const taker = await setupWithRetry(client, takerWallet);
    takerTradeAccountId = taker.tradeAccountId;
    await whitelistWithRetry(client.api, takerTradeAccountId);
    await mintWithRetry(client.api, takerTradeAccountId);
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
    const wallet = client.generateWallet();
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

    // Re-whitelist before trading (handles propagation delays)
    await whitelistWithRetry(client.api, makerTradeAccountId, 2);

    // Use minimum price step — guaranteed below any ask on the book.
    // Buy cost is always ≈ min_order regardless of price, so this is affordable.
    const priceStep = 10 ** -market.quote.max_precision;
    const buyPrice = priceStep;
    const quantity = minQuantityForMinOrder(market, buyPrice);

    // Verify quote balance
    const balances = await client.getBalances(makerTradeAccountId);
    const quoteSymbol = market.quote.symbol;
    expect(balances[quoteSymbol]).toBeDefined();
    expect(BigInt(balances[quoteSymbol].trading_account_balance)).toBeGreaterThan(0n);

    const session = await client.createSession(makerWallet, makerTradeAccountId, [market], 30);

    // Place PostOnly Buy at minimum price — guaranteed to rest on the book
    const { response, session: updatedSession } = await createOrderWithWhitelistRetry(
      client,
      session,
      market,
      "Buy",
      buyPrice,
      quantity,
      "PostOnly",
      true,
      true,
      makerTradeAccountId,
    );

    expect(response.tx_id).toBeTruthy();
    expect(response.orders).toBeDefined();
    expect(response.orders?.length).toBeGreaterThan(0);
    const order = response.orders?.[0];
    expect(order.order_id).toBeTruthy();
    expect(order.cancel).not.toBe(true);

    // Cancel the order
    const { response: cancelResponse } = await client.cancelOrder(
      updatedSession,
      order.order_id,
      market,
    );
    expect(cancelResponse.tx_id).toBeTruthy();
  });

  it("integration: cross-account fill", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    // Re-whitelist both accounts before trading
    await whitelistWithRetry(client.api, makerTradeAccountId, 2);
    await whitelistWithRetry(client.api, takerTradeAccountId, 2);

    // Check maker base balance
    const balances = await client.getBalances(makerTradeAccountId);
    const baseSymbol = market.base.symbol;
    expect(balances[baseSymbol]).toBeDefined();
    const baseBalance = BigInt(balances[baseSymbol].trading_account_balance);
    expect(baseBalance).toBeGreaterThan(0n);

    // Calculate sell price from balance alone (no book dependency).
    // This produces a high price well above any testnet bid, needing
    // only a tiny amount of base tokens.
    const sellPrice = safeSellPrice(market, baseBalance);
    const quantity = minQuantityForMinOrder(market, sellPrice);

    // Maker: PostOnly Sell at high price → guaranteed to rest on the book
    const makerSession = await client.createSession(makerWallet, makerTradeAccountId, [market], 30);
    const { response: makerResponse } = await createOrderWithWhitelistRetry(
      client,
      makerSession,
      market,
      "Sell",
      sellPrice,
      quantity,
      "PostOnly",
      true,
      true,
      makerTradeAccountId,
    );

    expect(makerResponse.tx_id).toBeTruthy();
    expect(makerResponse.orders).toBeDefined();
    expect(makerResponse.orders?.length).toBeGreaterThan(0);
    const makerOrder = makerResponse.orders?.[0];
    expect(makerOrder.order_id).toBeTruthy();
    expect(makerOrder.cancel).not.toBe(true);

    // Taker: buy a small multiple of the maker quantity to limit gas usage.
    // Using too much quote balance causes OutOfGas when the taker walks
    // through many intermediate orders on a busy book.
    const takerQuantity = quantity * 3.0;

    const takerSession = await client.createSession(takerWallet, takerTradeAccountId, [market], 30);
    const { response: takerResponse } = await createOrderWithWhitelistRetry(
      client,
      takerSession,
      market,
      "Buy",
      sellPrice,
      takerQuantity,
      "Spot",
      true,
      true,
      takerTradeAccountId,
    );

    expect(takerResponse.tx_id).toBeTruthy();

    // Cleanup: cancel maker order if still open
    try {
      await client.cancelOrder(makerSession, makerOrder.order_id, market);
    } catch {
      // Already filled/closed
    }
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
      break; // Just need one message
    }

    expect(received).toBe(true);
    client.disconnectWs();
  }, 30_000);

  it("integration: streams trades via WebSocket", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(client.api, makerTradeAccountId, 2);
    await whitelistWithRetry(client.api, takerTradeAccountId, 2);

    await cleanupOpenOrders(client, makerWallet, makerTradeAccountId, market);
    await cleanupOpenOrders(client, takerWallet, takerTradeAccountId, market);

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

      const price = moderateFillPrice(market);
      const quantity = fillQuantity(market, price);

      const makerSession = await client.createSession(
        makerWallet,
        makerTradeAccountId,
        [market],
        30,
      );
      const { response: makerResponse } = await createOrderWithWhitelistRetry(
        client,
        makerSession,
        market,
        "Buy",
        price,
        quantity,
        "PostOnly",
        true,
        true,
        makerTradeAccountId,
      );
      expect(makerResponse.orders?.length).toBeGreaterThan(0);
      const makerOrder = makerResponse.orders?.[0];
      expect(makerOrder.cancel).not.toBe(true);

      const takerSession = await client.createSession(
        takerWallet,
        takerTradeAccountId,
        [market],
        30,
      );
      await createOrderWithWhitelistRetry(
        client,
        takerSession,
        market,
        "Sell",
        price,
        quantity,
        "FillOrKill",
        true,
        true,
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
      await cleanupOpenOrders(client, makerWallet, makerTradeAccountId, market);
      await cleanupOpenOrders(client, takerWallet, takerTradeAccountId, market);
    }
  }, 120_000);

  it("integration: streams orders via WebSocket", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(client.api, makerTradeAccountId, 2);
    await cleanupOpenOrders(client, makerWallet, makerTradeAccountId, market);

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

      const priceStep = 10 ** -market.quote.max_precision;
      const quantity = minQuantityForMinOrder(market, priceStep);

      const session = await client.createSession(makerWallet, makerTradeAccountId, [market], 30);
      const { response, session: updatedSession } = await createOrderWithWhitelistRetry(
        client,
        session,
        market,
        "Buy",
        priceStep,
        quantity,
        "PostOnly",
        true,
        true,
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
        await client.cancelOrder(updatedSession, order.order_id, market);
      } catch {}
    } finally {
      wsClient.disconnectWs();
      await cleanupOpenOrders(client, makerWallet, makerTradeAccountId, market);
    }
  }, 60_000);

  it("integration: streams balances via WebSocket", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(client.api, makerTradeAccountId, 2);
    await cleanupOpenOrders(client, makerWallet, makerTradeAccountId, market);

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

      const priceStep = 10 ** -market.quote.max_precision;
      const quantity = minQuantityForMinOrder(market, priceStep);

      const session = await client.createSession(makerWallet, makerTradeAccountId, [market], 30);
      const { response, session: updatedSession } = await createOrderWithWhitelistRetry(
        client,
        session,
        market,
        "Buy",
        priceStep,
        quantity,
        "PostOnly",
        true,
        true,
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
        await client.cancelOrder(updatedSession, order.order_id, market);
      } catch {}
    } finally {
      wsClient.disconnectWs();
      await cleanupOpenOrders(client, makerWallet, makerTradeAccountId, market);
    }
  }, 60_000);

  it("integration: streams nonce via WebSocket", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(client.api, makerTradeAccountId, 2);
    await cleanupOpenOrders(client, makerWallet, makerTradeAccountId, market);

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

      const priceStep = 10 ** -market.quote.max_precision;
      const quantity = minQuantityForMinOrder(market, priceStep);

      const session = await client.createSession(makerWallet, makerTradeAccountId, [market], 30);
      const { response, session: updatedSession } = await createOrderWithWhitelistRetry(
        client,
        session,
        market,
        "Buy",
        priceStep,
        quantity,
        "PostOnly",
        true,
        true,
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
        await client.cancelOrder(updatedSession, order.order_id, market);
      } catch {}
    } finally {
      wsClient.disconnectWs();
      await cleanupOpenOrders(client, makerWallet, makerTradeAccountId, market);
    }
  }, 60_000);

  it("integration: concurrent different-type subscriptions (orders + balances + nonce)", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(client.api, makerTradeAccountId, 2);
    await cleanupOpenOrders(client, makerWallet, makerTradeAccountId, market);

    const wsClient = new O2Client({ network: Network.TESTNET });
    try {
      // Subscribe to all three streams concurrently on one WS connection
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

      // Place one order — triggers orders, balances, and nonce updates
      const priceStep = 10 ** -market.quote.max_precision;
      const quantity = minQuantityForMinOrder(market, priceStep);

      const session = await client.createSession(makerWallet, makerTradeAccountId, [market], 30);
      const { response, session: updatedSession } = await createOrderWithWhitelistRetry(
        client,
        session,
        market,
        "Buy",
        priceStep,
        quantity,
        "PostOnly",
        true,
        true,
        makerTradeAccountId,
      );
      expect(response.orders?.length).toBeGreaterThan(0);
      const order = response.orders?.[0];

      const timeout = (ms: number) =>
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));

      // Wait for all three with timeout
      const [ordersUpdate, balancesUpdate, nonceUpdate] = await Promise.all([
        Promise.race([ordersFirst, timeout(30_000)]),
        Promise.race([balancesFirst, timeout(30_000)]),
        Promise.race([nonceFirst, timeout(30_000)]),
      ]);

      // Verify each stream received only its correct type
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
        await client.cancelOrder(updatedSession, order.order_id, market);
      } catch {}
    } finally {
      wsClient.disconnectWs();
      await cleanupOpenOrders(client, makerWallet, makerTradeAccountId, market);
    }
  }, 120_000);

  it("integration: mixed subscriptions with cross-account fill", async () => {
    const markets = await client.getMarkets();
    const market = markets[0];

    await whitelistWithRetry(client.api, makerTradeAccountId, 2);
    await whitelistWithRetry(client.api, takerTradeAccountId, 2);

    await cleanupOpenOrders(client, makerWallet, makerTradeAccountId, market);
    await cleanupOpenOrders(client, takerWallet, takerTradeAccountId, market);

    const wsClient = new O2Client({ network: Network.TESTNET });
    try {
      // Subscribe to trades, orders, and balances concurrently
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

      // Cross-account fill
      const price = moderateFillPrice(market);
      const quantity = fillQuantity(market, price);

      const makerSession = await client.createSession(
        makerWallet,
        makerTradeAccountId,
        [market],
        30,
      );
      const { response: makerResponse } = await createOrderWithWhitelistRetry(
        client,
        makerSession,
        market,
        "Buy",
        price,
        quantity,
        "PostOnly",
        true,
        true,
        makerTradeAccountId,
      );
      expect(makerResponse.orders?.length).toBeGreaterThan(0);
      const makerOrder = makerResponse.orders?.[0];
      expect(makerOrder.cancel).not.toBe(true);

      const takerSession = await client.createSession(
        takerWallet,
        takerTradeAccountId,
        [market],
        30,
      );
      await createOrderWithWhitelistRetry(
        client,
        takerSession,
        market,
        "Sell",
        price,
        quantity,
        "FillOrKill",
        true,
        true,
        takerTradeAccountId,
      );

      const timeout = (ms: number) =>
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));

      const [tradesUpdate, ordersUpdate, balancesUpdate] = await Promise.all([
        Promise.race([tradesFirst, timeout(30_000)]),
        Promise.race([ordersFirst, timeout(30_000)]),
        Promise.race([balancesFirst, timeout(30_000)]),
      ]);

      // Verify each stream received only its correct type
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
      await cleanupOpenOrders(client, makerWallet, makerTradeAccountId, market);
      await cleanupOpenOrders(client, takerWallet, takerTradeAccountId, market);
    }
  }, 120_000);
});
