import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  BadSymbol,
  ExchangeError,
  InsufficientFunds,
  InvalidOrder,
  O2CCXT,
  OrderNotFound,
} from "../../src/ccxt/index.js";
import { Network, O2Client, settleBalanceAction } from "../../src/index.js";
import type { Market, Order, TradeAccountId } from "../../src/models.js";

const INTEGRATION = process.env.O2_INTEGRATION === "1";
const WALLETS_FILE = fileURLToPath(new URL("../../.integration-wallets.json", import.meta.url));

interface IntegrationWallets {
  makerPrivateKey: string;
  takerPrivateKey: string;
}

function minimumOrderAtPrice(
  client: O2Client,
  market: Market,
  requestedPrice: number,
): { price: number; amount: number } {
  const amountStep = 10 ** -market.base.max_precision;
  const price = Number(requestedPrice.toFixed(market.quote.max_precision));
  const minimumCost = Number(market.min_order) / 10 ** market.quote.decimals;
  const minimumAmount = minimumCost / price;
  const priceString = price.toFixed(market.quote.max_precision);
  let amountSteps = Math.ceil((minimumAmount * 2) / amountStep);

  for (let attempt = 0; attempt < 8; attempt++) {
    const amountString = (amountSteps * amountStep).toFixed(market.base.max_precision);
    try {
      client.normalizeCreateOrderValues(market, priceString, amountString, "price", "quantity");
      return { price: Number(priceString), amount: Number(amountString) };
    } catch {
      amountSteps *= 2;
    }
  }

  throw new Error(`Unable to construct a valid minimum resting order for ${market.pair}`);
}

async function postOnlyPrice(client: O2Client, market: Market, side: "buy" | "sell") {
  const depth = await client.getDepth(market, 1);
  const priceStep = 10 ** -market.quote.max_precision;
  const bestBid = depth.bids[0]
    ? Number(depth.bids[0].price) / 10 ** market.quote.decimals
    : undefined;
  const bestAsk = depth.asks[0]
    ? Number(depth.asks[0].price) / 10 ** market.quote.decimals
    : undefined;

  if (side === "buy") {
    // Nothing can rest below the absolute price step, so this remains
    // post-only even while a shared testnet book moves.
    return priceStep;
  }
  const reference = Math.max(bestAsk ?? 0, bestBid ?? 0, priceStep * 1_000);
  return Number((reference * 2 + priceStep).toFixed(market.quote.max_precision));
}

async function controlledMakerPrice(
  client: O2Client,
  market: Market,
  side: "buy" | "sell",
): Promise<number> {
  return waitFor(async () => {
    const depth = await client.getDepth(market, 1);
    const step = 10 ** -market.quote.max_precision;
    const bestBid = depth.bids[0]
      ? Number(depth.bids[0].price) / 10 ** market.quote.decimals
      : undefined;
    const bestAsk = depth.asks[0]
      ? Number(depth.asks[0].price) / 10 ** market.quote.decimals
      : undefined;

    if (side === "buy") {
      if (bestBid !== undefined) {
        const inside = Number((bestBid + step).toFixed(market.quote.max_precision));
        return bestAsk === undefined || inside < bestAsk ? inside : bestBid;
      }
      if (bestAsk !== undefined) {
        return Math.max(step, Math.floor((bestAsk * 0.8) / step) * step);
      }
      return 1;
    }

    if (bestAsk !== undefined) {
      const inside = Number((bestAsk - step).toFixed(market.quote.max_precision));
      return bestBid === undefined || inside > bestBid ? inside : bestAsk;
    }
    if (bestBid !== undefined) {
      return Number((bestBid * 1.2 + step).toFixed(market.quote.max_precision));
    }
    return 1;
  }, `a testnet price for controlled ${side} liquidity`);
}

async function waitFor<T>(
  operation: () => Promise<T | undefined>,
  description: string,
  attempts = 30,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await operation();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

async function ensureTestnetBalance(
  client: O2Client,
  accountId: TradeAccountId,
  symbol: string,
  minimumRaw: bigint,
): Promise<void> {
  for (let mintAttempt = 0; mintAttempt < 3; mintAttempt++) {
    const balances = await client.getBalances(accountId);
    if ((balances[symbol]?.trading_account_balance ?? 0n) >= minimumRaw) return;

    await client.api.mintToContract(accountId);
    await waitFor(
      async () => {
        const refreshed = await client.getBalances(accountId);
        return (refreshed[symbol]?.trading_account_balance ?? 0n) >= minimumRaw ? true : undefined;
      },
      `${symbol} testnet faucet balance`,
      10,
    ).catch(() => undefined);
  }

  const balances = await client.getBalances(accountId);
  const available = balances[symbol]?.trading_account_balance ?? 0n;
  if (available < minimumRaw) {
    throw new Error(
      `Testnet faucet did not fund ${symbol}: ${available} available, ${minimumRaw} required`,
    );
  }
}

async function attemptTestnetWhitelist(client: O2Client, accountId: TradeAccountId): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await client.api.whitelistAccount(accountId);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  console.error(`Testnet whitelist unavailable for ${accountId}: ${String(lastError)}`);
}

describe.skipIf(!INTEGRATION)("O2CCXT testnet lifecycle", () => {
  it("exercises every supported public read method across testnet markets", async () => {
    const persisted = JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as IntegrationWallets;
    const signer = O2Client.loadWallet(persisted.makerPrivateKey);
    const client = new O2Client({
      network: Network.TESTNET,
      apiOptions: { maxRetries: 0 },
    });
    let exchange: O2CCXT | undefined;

    try {
      const account = await client.api.getAccount({ owner: signer.b256Address });
      const accountId = account.trade_account_id as TradeAccountId | null;
      if (!accountId) throw new Error("The maker integration wallet has no O2 testnet account");

      const nativeMarkets = await client.getMarkets();
      const publicNativeMarkets = nativeMarkets.filter(
        (market) => market.base.symbol.trim() !== "" && market.quote.symbol.trim() !== "",
      );
      if (publicNativeMarkets.length === 0)
        throw new Error("O2 testnet returned no public markets");
      await client.createSession(signer, publicNativeMarkets, 1);
      exchange = new O2CCXT({ client, signer, tradeAccountId: accountId });

      const fetchedMarkets = await exchange.fetchMarkets();
      const loadedMarkets = await exchange.loadMarkets(true);
      expect(fetchedMarkets).toHaveLength(publicNativeMarkets.length);
      expect(Object.keys(loadedMarkets)).toHaveLength(publicNativeMarkets.length);

      for (const market of fetchedMarkets) {
        const symbol = market.symbol;
        expect(market).toMatchObject({ symbol, spot: true, active: true });

        const ticker = await exchange.fetchTicker(symbol);
        expect(ticker.symbol).toBe(symbol);
        expect(ticker.timestamp === null || Number.isFinite(ticker.timestamp)).toBe(true);

        const book = await exchange.fetchOrderBook(symbol, 20, { precision: 1 });
        const l2Book = await exchange.fetchL2OrderBook(symbol, 20, { precision: 1 });
        expect(book.symbol).toBe(symbol);
        expect(book.bids).toEqual([...book.bids].sort((a, b) => b[0] - a[0]));
        expect(book.asks).toEqual([...book.asks].sort((a, b) => a[0] - b[0]));
        expect(l2Book.symbol).toBe(symbol);
        expect(l2Book.bids).toEqual([...l2Book.bids].sort((a, b) => b[0] - a[0]));
        expect(l2Book.asks).toEqual([...l2Book.asks].sort((a, b) => a[0] - b[0]));

        const trades = await exchange.fetchTrades(symbol, undefined, 10);
        expect(trades.length).toBeLessThanOrEqual(10);
        expect(trades.every((trade) => trade.symbol === symbol)).toBe(true);
        expect(trades.map((trade) => trade.timestamp)).toEqual(
          [...trades].map((trade) => trade.timestamp).sort((a, b) => a - b),
        );

        for (const timeframe of Object.keys(exchange.timeframes)) {
          const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, 2);
          expect(candles.length).toBeLessThanOrEqual(2);
          expect(candles.every((candle) => candle.length === 6)).toBe(true);
          expect(candles.map((candle) => candle[0])).toEqual(
            [...candles].map((candle) => candle[0]).sort((a, b) => a - b),
          );
        }
      }

      const balance = await exchange.fetchBalance();
      expect(balance.info).toBeDefined();
      for (const code of Object.keys(balance.total ?? {})) {
        expect(balance.total?.[code]).toBeCloseTo(
          (balance.free?.[code] ?? 0) + (balance.used?.[code] ?? 0),
        );
      }

      const [orders, openOrders, closedOrders, accountTrades] = await Promise.all([
        exchange.fetchOrders(undefined, undefined, 20),
        exchange.fetchOpenOrders(undefined, undefined, 20),
        exchange.fetchClosedOrders(undefined, undefined, 20),
        exchange.fetchMyTrades(undefined, undefined, 20),
      ]);
      expect(orders.length).toBeLessThanOrEqual(20);
      expect(openOrders.every((order) => order.status === "open")).toBe(true);
      expect(closedOrders.every((order) => order.status !== "open")).toBe(true);
      expect(accountTrades.length).toBeLessThanOrEqual(20);
      expect(accountTrades.map((trade) => trade.timestamp)).toEqual(
        [...accountTrades].map((trade) => trade.timestamp).sort((a, b) => a - b),
      );

      await expect(exchange.fetchTicker("NOT/A-MARKET")).rejects.toBeInstanceOf(BadSymbol);
    } finally {
      await exchange?.close();
      if (!exchange) client.close();
    }
  }, 240_000);

  it("creates, fetches, and cancels spot and post-only limits on both sides", async () => {
    const persisted = JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as IntegrationWallets;
    const signer = O2Client.loadWallet(persisted.makerPrivateKey);
    const client = new O2Client({
      network: Network.TESTNET,
      apiOptions: { maxRetries: 0 },
    });
    let exchange: O2CCXT | undefined;
    let rawMarket: Market | undefined;
    const createdOrderIds = new Set<string>();

    try {
      const account = await client.api.getAccount({ owner: signer.b256Address });
      const accountId = account.trade_account_id as TradeAccountId | null;
      if (!accountId) throw new Error("The maker integration wallet has no O2 testnet account");

      const markets = await client.getMarkets();
      rawMarket = markets[0];
      if (!rawMarket) throw new Error("O2 testnet returned no markets");

      await attemptTestnetWhitelist(client, accountId);
      await client.createSession(signer, [rawMarket], 1);
      exchange = new O2CCXT({ client, signer, tradeAccountId: accountId });

      const loaded = await exchange.loadMarkets();
      const symbol = rawMarket.pair || `${rawMarket.base.symbol}/${rawMarket.quote.symbol}`;
      const loadedMarket = loaded[symbol];
      expect(loadedMarket).toMatchObject({ symbol, spot: true });
      const orderMarket = loadedMarket?.info as Market | undefined;
      if (!orderMarket) throw new Error(`CCXT market ${symbol} has no O2 market metadata`);

      for (const orderType of ["PostOnly", "Spot"] as const) {
        for (const side of ["buy", "sell"] as const) {
          const { price, amount } = minimumOrderAtPrice(
            client,
            orderMarket,
            await postOnlyPrice(client, orderMarket, side),
          );
          const requiredRaw =
            side === "buy"
              ? BigInt(Math.ceil(price * amount * 10 ** orderMarket.quote.decimals))
              : BigInt(Math.ceil(amount * 10 ** orderMarket.base.decimals));
          await ensureTestnetBalance(
            client,
            accountId,
            side === "buy" ? orderMarket.quote.symbol : orderMarket.base.symbol,
            requiredRaw,
          );

          const created = await exchange.createOrder(symbol, "limit", side, amount, price, {
            orderType,
          });
          createdOrderIds.add(created.id);
          expect(created).toMatchObject({ symbol, side, type: "limit", status: "open" });

          const fetched = await waitFor(
            () => exchange?.fetchOrder(created.id, symbol),
            `the ${orderType} ${side} order to reach the testnet indexer`,
          );
          expect(fetched.id).toBe(created.id);

          const open = await waitFor(async () => {
            const orders = await exchange?.fetchOpenOrders(symbol, undefined, 100);
            return orders?.find((order) => order.id === created.id);
          }, `the ${orderType} ${side} order to appear in fetchOpenOrders`);
          expect(open.status).toBe("open");

          const canceled = await exchange.cancelOrder(created.id, symbol);
          expect(canceled.status).toBe("canceled");

          const closed = await waitFor(async () => {
            const orders = await exchange?.fetchClosedOrders(symbol, undefined, 100);
            return orders?.find((order) => order.id === created.id);
          }, `the canceled ${orderType} ${side} order to appear in fetchClosedOrders`);
          expect(closed.status).toBe("canceled");
          createdOrderIds.delete(created.id);
        }
      }
    } finally {
      if (rawMarket) {
        for (const createdOrderId of createdOrderIds) {
          try {
            await client.cancelOrder(createdOrderId as Order["order_id"], rawMarket);
          } catch {
            // The order may already be canceled or filled.
          }
        }
      }
      await exchange?.close();
      if (!exchange) client.close();
    }
  }, 180_000);

  it("executes bounded market and explicit FOK limits on both sides", async () => {
    const persisted = JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as IntegrationWallets;
    const makerSigner = O2Client.loadWallet(persisted.makerPrivateKey);
    const takerSigner = O2Client.loadWallet(persisted.takerPrivateKey);
    const makerClient = new O2Client({ network: Network.TESTNET, apiOptions: { maxRetries: 0 } });
    const takerClient = new O2Client({ network: Network.TESTNET, apiOptions: { maxRetries: 0 } });
    let takerExchange: O2CCXT | undefined;
    let market: Market | undefined;

    try {
      const [makerAccount, takerAccount, markets] = await Promise.all([
        makerClient.api.getAccount({ owner: makerSigner.b256Address }),
        takerClient.api.getAccount({ owner: takerSigner.b256Address }),
        makerClient.getMarkets(),
      ]);
      const makerAccountId = makerAccount.trade_account_id as TradeAccountId | null;
      const takerAccountId = takerAccount.trade_account_id as TradeAccountId | null;
      if (!makerAccountId || !takerAccountId) {
        throw new Error("Both integration wallets must have O2 testnet accounts");
      }
      market = markets[0];
      if (!market) throw new Error("O2 testnet returned no markets");

      await Promise.all([
        attemptTestnetWhitelist(makerClient, makerAccountId),
        attemptTestnetWhitelist(takerClient, takerAccountId),
      ]);
      await makerClient.createSession(makerSigner, [market], 1);
      await takerClient.createSession(takerSigner, [market], 1);
      takerExchange = new O2CCXT({
        client: takerClient,
        signer: takerSigner,
        tradeAccountId: takerAccountId,
      });
      await Promise.allSettled([
        makerClient.cancelAllOrders(market),
        takerClient.cancelAllOrders(market),
      ]);
      await Promise.allSettled([
        makerClient.settleBalance(market),
        takerClient.settleBalance(market),
      ]);

      const symbol = market.pair || `${market.base.symbol}/${market.quote.symbol}`;
      const priceStep = 10 ** -market.quote.max_precision;
      const amountStep = 10 ** -market.base.max_precision;

      for (const executionType of ["market", "limit"] as const) {
        for (const takerSide of ["buy", "sell"] as const) {
          const makerSide = takerSide === "buy" ? "sell" : "buy";
          const { price, amount } = minimumOrderAtPrice(
            makerClient,
            market,
            await controlledMakerPrice(makerClient, market, makerSide),
          );
          const quoteRaw = BigInt(Math.ceil(price * amount * 1.1 * 10 ** market.quote.decimals));
          const baseRaw = BigInt(Math.ceil(amount * 1.1 * 10 ** market.base.decimals));
          await Promise.all([
            ensureTestnetBalance(
              makerClient,
              makerAccountId,
              makerSide === "buy" ? market.quote.symbol : market.base.symbol,
              makerSide === "buy" ? quoteRaw : baseRaw,
            ),
            ensureTestnetBalance(
              takerClient,
              takerAccountId,
              takerSide === "buy" ? market.quote.symbol : market.base.symbol,
              takerSide === "buy" ? quoteRaw : baseRaw,
            ),
          ]);

          const maker = await makerClient.createOrder(
            market,
            makerSide,
            price.toFixed(market.quote.max_precision),
            amount.toFixed(market.base.max_precision),
            { orderType: "PostOnly" },
          );
          const makerOrder = maker.orders?.[maker.orders.length - 1];
          expect(makerOrder?.order_id).toBeTruthy();
          await waitFor(async () => {
            const liveDepth = await makerClient.getDepth(market!, 1);
            const levels = makerSide === "buy" ? liveDepth.bids : liveDepth.asks;
            const resting = levels.find((level) => {
              const levelPrice = Number(level.price) / 10 ** market!.quote.decimals;
              const levelAmount = Number(level.quantity) / 10 ** market!.base.decimals;
              return Math.abs(levelPrice - price) < priceStep / 2 && levelAmount >= amount;
            });
            return resting ? true : undefined;
          }, `the controlled ${makerSide} maker order to become active in testnet depth`);

          const protectivePrice =
            takerSide === "buy" ? price + priceStep : Math.max(priceStep, price - priceStep);
          const taker = await takerExchange.createOrder(
            symbol,
            executionType,
            takerSide,
            amount,
            executionType === "limit" ? protectivePrice : undefined,
            executionType === "market"
              ? {
                  maxPrice: (price + priceStep).toFixed(market.quote.max_precision),
                  minPrice: Math.max(priceStep, price - priceStep).toFixed(
                    market.quote.max_precision,
                  ),
                }
              : { orderType: "FillOrKill" },
          );
          expect(taker).toMatchObject({ symbol, type: executionType, side: takerSide, amount });

          const indexedTaker = await waitFor(async () => {
            const indexed = await takerExchange?.fetchOrder(taker.id, symbol);
            return indexed?.status === "closed" && indexed.filled >= amount - amountStep / 2
              ? indexed
              : undefined;
          }, `the ${executionType} FOK ${takerSide} to close in the testnet indexer`);
          expect(indexedTaker.filled).toBeGreaterThanOrEqual(amount - amountStep / 2);

          await Promise.allSettled([
            makerClient.settleBalance(market),
            takerClient.settleBalance(market),
          ]);
        }
      }
    } finally {
      if (market) {
        await Promise.allSettled([
          makerClient.cancelAllOrders(market),
          takerClient.cancelAllOrders(market),
        ]);
        await Promise.allSettled([
          makerClient.settleBalance(market),
          takerClient.settleBalance(market),
        ]);
      }
      makerClient.close();
      if (takerExchange) await takerExchange.close();
      else takerClient.close();
    }
  }, 180_000);

  it("maps definitive testnet order rejections without retrying", async () => {
    const persisted = JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as IntegrationWallets;
    const makerSigner = O2Client.loadWallet(persisted.makerPrivateKey);
    const takerSigner = O2Client.loadWallet(persisted.takerPrivateKey);
    const makerClient = new O2Client({ network: Network.TESTNET, apiOptions: { maxRetries: 0 } });
    const client = new O2Client({ network: Network.TESTNET, apiOptions: { maxRetries: 0 } });
    let exchange: O2CCXT | undefined;
    let makerOrderId: Order["order_id"] | undefined;
    let selectedMarket: Market | undefined;

    try {
      const [makerAccount, account] = await Promise.all([
        makerClient.api.getAccount({ owner: makerSigner.b256Address }),
        client.api.getAccount({ owner: takerSigner.b256Address }),
      ]);
      const makerAccountId = makerAccount.trade_account_id as TradeAccountId | null;
      const accountId = account.trade_account_id as TradeAccountId | null;
      if (!makerAccountId || !accountId) {
        throw new Error("Both integration wallets must have O2 testnet accounts");
      }
      const market = (await client.getMarkets()).find(
        (candidate) => candidate.base.symbol.trim() !== "" && candidate.quote.symbol.trim() !== "",
      );
      if (!market) throw new Error("O2 testnet returned no public markets");
      selectedMarket = market;

      await Promise.all([
        attemptTestnetWhitelist(makerClient, makerAccountId),
        attemptTestnetWhitelist(client, accountId),
      ]);
      await Promise.all([
        makerClient.createSession(makerSigner, [market], 1),
        client.createSession(takerSigner, [market], 1),
      ]);
      exchange = new O2CCXT({ client, signer: takerSigner, tradeAccountId: accountId });
      await exchange.loadMarkets();

      const symbol = market.pair || `${market.base.symbol}/${market.quote.symbol}`;
      const crossing = minimumOrderAtPrice(
        makerClient,
        market,
        await controlledMakerPrice(makerClient, market, "buy"),
      );
      await Promise.all([
        ensureTestnetBalance(
          makerClient,
          makerAccountId,
          market.quote.symbol,
          BigInt(Math.ceil(crossing.price * crossing.amount * 1.1 * 10 ** market.quote.decimals)),
        ),
        ensureTestnetBalance(
          client,
          accountId,
          market.base.symbol,
          BigInt(Math.ceil(crossing.amount * 1.1 * 10 ** market.base.decimals)),
        ),
      ]);
      const maker = await makerClient.createOrder(
        market,
        "buy",
        crossing.price.toFixed(market.quote.max_precision),
        crossing.amount.toFixed(market.base.max_precision),
        { orderType: "PostOnly" },
      );
      makerOrderId = maker.orders?.[maker.orders.length - 1]?.order_id;
      expect(makerOrderId).toBeTruthy();
      await waitFor(async () => {
        const liveDepth = await makerClient.getDepth(market, 1);
        return liveDepth.bids.some(
          (level) =>
            Number(level.price) / 10 ** market.quote.decimals === crossing.price &&
            Number(level.quantity) / 10 ** market.base.decimals >= crossing.amount,
        )
          ? true
          : undefined;
      }, "the controlled maker order for a crossing post-only rejection");
      await expect(
        exchange.createOrder(symbol, "limit", "sell", crossing.amount, crossing.price, {
          orderType: "PostOnly",
          settleFirst: false,
        }),
      ).rejects.toBeInstanceOf(InvalidOrder);
      await makerClient.cancelOrder(makerOrderId!, market);
      makerOrderId = undefined;

      const depth = await client.getDepth(market, 1);
      const priceStep = 10 ** -market.quote.max_precision;
      const bestBid = depth.bids[0] ? Number(depth.bids[0].price) / 10 ** market.quote.decimals : 0;
      const noLiquidityPrice = Number(
        (bestBid + Math.max(priceStep, bestBid || priceStep)).toFixed(market.quote.max_precision),
      );
      const { amount } = minimumOrderAtPrice(client, market, noLiquidityPrice);
      await ensureTestnetBalance(
        client,
        accountId,
        market.base.symbol,
        BigInt(Math.ceil(amount * 1.1 * 10 ** market.base.decimals)),
      );

      await expect(
        exchange.createOrder(symbol, "market", "sell", amount, undefined, {
          maxPrice: noLiquidityPrice + priceStep,
          minPrice: noLiquidityPrice,
          settleFirst: false,
        }),
      ).rejects.toBeInstanceOf(InvalidOrder);

      const balances = await client.getBalances(accountId);
      const availableBase = balances[market.base.symbol]?.trading_account_balance ?? 0n;
      const amountStep = 10 ** -market.base.max_precision;
      const unavailableAmount =
        Math.ceil(
          (Number(availableBase) / 10 ** market.base.decimals + amountStep * 10) / amountStep,
        ) * amountStep;
      await expect(
        exchange.createOrder(symbol, "limit", "sell", unavailableAmount, noLiquidityPrice, {
          orderType: "PostOnly",
          settleFirst: false,
        }),
      ).rejects.toBeInstanceOf(InsufficientFunds);

      await expect(exchange.fetchOrder(`0x${"ff".repeat(32)}`, symbol)).rejects.toBeInstanceOf(
        OrderNotFound,
      );
    } finally {
      if (makerOrderId && selectedMarket) {
        await makerClient.cancelOrder(makerOrderId, selectedMarket).catch(() => undefined);
      }
      await exchange?.close();
      if (!exchange) client.close();
      makerClient.close();
    }
  }, 180_000);

  it("owns account setup, session creation, restoration, settlement, and batching", async () => {
    const persisted = JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as IntegrationWallets;
    const signer = O2Client.loadWallet(persisted.makerPrivateKey);
    const client = new O2Client({ network: Network.TESTNET, apiOptions: { maxRetries: 0 } });
    let exchange: O2CCXT | undefined = new O2CCXT({ client, signer });
    let restoredExchange: O2CCXT | undefined;

    try {
      const setup = await exchange.setupAccount();
      expect(setup.tradeAccountId).toMatch(/^0x[0-9a-f]{64}$/);

      const markets = await exchange.fetchMarkets();
      const market = markets[0];
      if (!market) throw new Error("O2 testnet returned no public CCXT markets");

      await attemptTestnetWhitelist(client, setup.tradeAccountId);
      const session = await exchange.createSession([market.symbol], 1);
      expect(session.tradeAccountId).toBe(setup.tradeAccountId);
      expect(client.session).toBe(session);
      expect((await exchange.fetchBalance()).total).toBeDefined();

      const settled = await exchange.settleBalance(market.symbol);
      expect(settled.success).toBe(true);
      const batch = await exchange.batchActions([
        { market: market.symbol, actions: [settleBalanceAction()] },
      ]);
      expect(batch.success).toBe(true);

      await exchange.close();
      exchange = undefined;

      const restoredClient = new O2Client({
        network: Network.TESTNET,
        apiOptions: { maxRetries: 0 },
      });
      restoredExchange = new O2CCXT({ client: restoredClient, signer });
      restoredExchange.restoreSession(session);
      expect(restoredClient.session).toBe(session);
      expect((await restoredExchange.fetchBalance()).total).toBeDefined();
      expect((await restoredExchange.settleBalance(market.symbol)).success).toBe(true);

      const unauthorizedMarket = markets[1];
      if (unauthorizedMarket) {
        await expect(
          restoredExchange.settleBalance(unauthorizedMarket.symbol),
        ).rejects.toBeInstanceOf(ExchangeError);
      }

      restoredExchange.restoreSession({
        ...session,
        expiry: Math.floor(Date.now() / 1000) - 1,
      });
      await expect(restoredExchange.settleBalance(market.symbol)).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    } finally {
      await exchange?.close();
      await restoredExchange?.close();
    }
  }, 180_000);
});
