/**
 * Integration tests for the O2 TypeScript SDK.
 *
 * These tests hit the live testnet API and require network access.
 * Run with: O2_INTEGRATION=1 npx vitest run tests/integration.test.ts
 *
 * # Order Book Pollution & Pricing Strategy
 *
 * Integration tests persist maker/taker wallets in a local gitignored file to
 * speed up repeated runs and reduce faucet dependence. Because accounts are
 * reused, cleanup at startup is important to remove stale open orders.
 *
 * ## Non-fill tests: PostOnly Buy at minimum price step
 *
 * The minimum price step (10^{-max_precision}) is the absolute floor — no sell
 * can exist below it, so a PostOnly Buy there always rests. The locked quote
 * value is trivially small regardless of quantity.
 *
 * ## Fill tests: Maker PostOnly Buy + Taker FillOrKill Sell
 *
 * Maker PostOnly price is selected conservatively from live depth (best_ask -
 * one tick) to avoid accidental taker matches in a shared live order book. The
 * taker uses FillOrKill sell, which avoids leaving a resting order.
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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Network, type Numeric, O2Client } from "../src/index.js";
import type { Market, SessionActionsResponse, TradeAccountId, WalletState } from "../src/models.js";

const INTEGRATION = process.env.O2_INTEGRATION === "1";
const INTEGRATION_WALLETS_FILE = fileURLToPath(
  new URL("../.integration-wallets.json", import.meta.url),
);

interface PersistedIntegrationWallets {
  makerPrivateKey: string;
  takerPrivateKey: string;
}

function isPrivateKeyHex(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function privateKeyToHex(privateKey: Uint8Array): string {
  return `0x${Array.from(privateKey)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function loadOrCreateIntegrationWallets(): { makerWallet: WalletState; takerWallet: WalletState } {
  if (existsSync(INTEGRATION_WALLETS_FILE)) {
    try {
      const raw = JSON.parse(
        readFileSync(INTEGRATION_WALLETS_FILE, "utf8"),
      ) as Partial<PersistedIntegrationWallets>;
      if (isPrivateKeyHex(raw.makerPrivateKey) && isPrivateKeyHex(raw.takerPrivateKey)) {
        return {
          makerWallet: O2Client.loadWallet(raw.makerPrivateKey),
          takerWallet: O2Client.loadWallet(raw.takerPrivateKey),
        };
      }
      console.error(
        `[integration] wallet cache at ${INTEGRATION_WALLETS_FILE} is invalid, regenerating`,
      );
    } catch (error) {
      console.error(
        `[integration] failed to read wallet cache at ${INTEGRATION_WALLETS_FILE}, regenerating: ${String(error)}`,
      );
    }
  }

  const makerWallet = O2Client.generateWallet();
  const takerWallet = O2Client.generateWallet();
  const persisted: PersistedIntegrationWallets = {
    makerPrivateKey: privateKeyToHex(makerWallet.privateKey),
    takerPrivateKey: privateKeyToHex(takerWallet.privateKey),
  };
  writeFileSync(INTEGRATION_WALLETS_FILE, `${JSON.stringify(persisted, null, 2)}\n`);
  console.error(`[integration] wrote wallet cache to ${INTEGRATION_WALLETS_FILE}`);
  return { makerWallet, takerWallet };
}

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

function minPriceStep(market: Market): number {
  return 10 ** -market.quote.max_precision;
}

function quantityStep(market: Market): number {
  return 10 ** -market.base.max_precision;
}

function floorToStep(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function ceilToStep(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function minQuantityForMinOrder(market: Market, price: number): number {
  const minOrder = Number(market.min_order);
  const quoteFactor = 10 ** market.quote.decimals;
  const minQty = minOrder / (price * quoteFactor);
  return ceilToStep(minQty, quantityStep(market));
}

async function conservativePostOnlyBuyPriceStr(client: O2Client, market: Market): Promise<string> {
  const step = minPriceStep(market);
  let chosen = step;

  try {
    const depth = await client.getDepth(market, 10);
    if (depth.sells.length > 0) {
      const bestAsk = Number(depth.sells[0].price) / 10 ** market.quote.decimals;
      chosen = Math.max(step, floorToStep(bestAsk - step, step));
    } else if (depth.buys.length > 0) {
      const bestBid = Number(depth.buys[0].price) / 10 ** market.quote.decimals;
      chosen = Math.max(step, floorToStep(bestBid, step));
    }
  } catch (error) {
    console.error(
      `Warning: failed to fetch depth for ${market.base.symbol}/${market.quote.symbol}: ${String(error)}`,
    );
  }

  return chosen.toFixed(market.quote.max_precision);
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
      if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
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
      await new Promise((r) => setTimeout(r, 5_000));
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

async function ensureAccount(
  client: O2Client,
  wallet: WalletState,
): Promise<{ tradeAccountId: TradeAccountId; nonce: bigint }> {
  const existing = await client.api.getAccount({ owner: wallet.b256Address });

  let tradeAccountId = existing.trade_account_id;
  if (!tradeAccountId) {
    const created = await client.api.createAccount({ Address: wallet.b256Address });
    tradeAccountId = created.trade_account_id;
  }

  await whitelistWithRetry(client.api, tradeAccountId, 2);

  const info = await client.api.getAccount({ tradeAccountId });
  return {
    tradeAccountId,
    nonce: info.trade_account?.nonce ?? 0n,
  };
}

async function ensureAccountWithRetry(
  client: O2Client,
  wallet: WalletState,
  maxRetries = 4,
): Promise<{ tradeAccountId: TradeAccountId; nonce: bigint }> {
  let lastError: unknown = null;

  const formatError = (error: unknown): string => {
    if (error instanceof Error) {
      const apiCode = "code" in error ? (error as { code?: unknown }).code : undefined;
      const reason = "reason" in error ? (error as { reason?: unknown }).reason : undefined;
      const parts = [error.name, error.message];
      if (apiCode !== undefined) parts.push(`code=${String(apiCode)}`);
      if (reason !== undefined) parts.push(`reason=${String(reason)}`);
      return parts.join(" | ");
    }
    return String(error);
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await ensureAccount(client, wallet);
    } catch (error: unknown) {
      lastError = error;
      console.error(
        `[integration] ensureAccount attempt ${attempt + 1}/${maxRetries} failed for ${wallet.b256Address.slice(0, 12)}...: ${formatError(error)}`,
      );
      if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  throw new Error(
    `ensureAccount failed after retries. Last error: ${lastError ? formatError(lastError) : "unknown"}`,
  );
}

async function crossFillQuantityStr(
  client: O2Client,
  market: Market,
  priceStr: string,
  makerTradeAccountId: TradeAccountId,
  takerTradeAccountId: TradeAccountId,
): Promise<string> {
  const price = Number.parseFloat(priceStr);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`invalid price for cross-fill quantity: ${priceStr}`);
  }

  const step = quantityStep(market);
  const minQty = minQuantityForMinOrder(market, price);
  const targetQty = minQty * 1.05;
  let lastDetails = "";

  for (let attempt = 0; attempt < 4; attempt++) {
    const [makerBalances, takerBalances] = await Promise.all([
      client.getBalances(makerTradeAccountId),
      client.getBalances(takerTradeAccountId),
    ]);

    const makerQuoteBal =
      Number(makerBalances[market.quote.symbol]?.trading_account_balance ?? 0n) /
      10 ** market.quote.decimals;
    const takerBaseBal =
      Number(takerBalances[market.base.symbol]?.trading_account_balance ?? 0n) /
      10 ** market.base.decimals;

    const makerCap = makerQuoteBal / price;
    const cap = Math.min(takerBaseBal, makerCap);
    const qty = floorToStep(Math.min(targetQty, cap), step);

    lastDetails =
      `minQty=${minQty}, qty=${qty}, cap=${cap}, makerQuote=${makerQuoteBal}, ` +
      `takerBase=${takerBaseBal}, price=${priceStr}`;
    if (qty >= minQty) {
      return qty.toFixed(market.base.max_precision);
    }

    if (attempt < 3) {
      const makerQuoteRequired = BigInt(
        Math.ceil(minQty * price * 1.2 * 10 ** market.quote.decimals),
      );
      const takerBaseRequired = BigInt(Math.ceil(minQty * 1.2 * 10 ** market.base.decimals));
      await Promise.all([
        ensureFunded(client, makerTradeAccountId, market.quote.symbol, makerQuoteRequired, 2),
        ensureFunded(client, takerTradeAccountId, market.base.symbol, takerBaseRequired, 2),
      ]);
    }
  }

  throw new Error(`Unable to compute valid cross-fill quantity: ${lastDetails}`);
}

function firstStreamMessage<T>(stream: AsyncIterable<T>): Promise<T | null> {
  return new Promise((resolve) => {
    (async () => {
      try {
        for await (const update of stream) {
          resolve(update);
          return;
        }
      } catch {}
      resolve(null);
    })();
  });
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
    // Load persistent maker/taker wallets (or create on first run)
    ({ makerWallet, takerWallet } = loadOrCreateIntegrationWallets());

    // Ensure both accounts exist/are whitelisted, without unconditional faucet mints
    const [maker, taker] = await Promise.all([
      ensureAccountWithRetry(makerClient, makerWallet),
      ensureAccountWithRetry(takerClient, takerWallet),
    ]);
    makerTradeAccountId = maker.tradeAccountId;
    takerTradeAccountId = taker.tradeAccountId;

    // Verify both accounts have sufficient balances (runs ensureFunded in parallel per account)
    const markets = await makerClient.getMarkets();
    const market = markets[0];
    await cleanupOpenOrders(makerClient, makerWallet, market);
    await cleanupOpenOrders(takerClient, takerWallet, market);
    const baseSymbol = market.base.symbol;
    const quoteSymbol = market.quote.symbol;
    await Promise.all([
      Promise.all([
        ensureFunded(makerClient, makerTradeAccountId, baseSymbol, 50_000_000n),
        ensureFunded(makerClient, makerTradeAccountId, quoteSymbol, 50_000_000n),
      ]),
      Promise.all([
        ensureFunded(takerClient, takerTradeAccountId, baseSymbol, 50_000_000n),
        ensureFunded(takerClient, takerTradeAccountId, quoteSymbol, 50_000_000n),
      ]),
    ]);
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

    // Place maker buy one tick below best ask to stay post-only in live books.
    const priceStr = await conservativePostOnlyBuyPriceStr(client, market);
    const quantityStr = await crossFillQuantityStr(
      makerClient,
      market,
      priceStr,
      makerTradeAccountId,
      takerTradeAccountId,
    );

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
      const firstMessage = firstStreamMessage(stream);

      await new Promise((r) => setTimeout(r, 2000));

      const priceStr = await conservativePostOnlyBuyPriceStr(wsClient, market);
      const quantityStr = await crossFillQuantityStr(
        makerClient,
        market,
        priceStr,
        makerTradeAccountId,
        takerTradeAccountId,
      );

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

      const tradesFirst = firstStreamMessage(tradesStream);
      const ordersFirst = firstStreamMessage(ordersStream);
      const balancesFirst = firstStreamMessage(balancesStream);

      await new Promise((r) => setTimeout(r, 2000));

      const priceStr = await conservativePostOnlyBuyPriceStr(wsClient, market);
      const quantityStr = await crossFillQuantityStr(
        makerClient,
        market,
        priceStr,
        makerTradeAccountId,
        takerTradeAccountId,
      );

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
