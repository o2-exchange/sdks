import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { O2CCXT } from "../../src/ccxt/index.js";
import { Network, O2Client } from "../../src/index.js";
import type { Market, Order, TradeAccountId } from "../../src/models.js";

const INTEGRATION = process.env.O2_INTEGRATION === "1";
const WALLETS_FILE = fileURLToPath(new URL("../../.integration-wallets.json", import.meta.url));

interface IntegrationWallets {
  makerPrivateKey: string;
  takerPrivateKey: string;
}

function minimumRestingOrder(client: O2Client, market: Market): { price: number; amount: number } {
  const priceStep = 10 ** -market.quote.max_precision;
  const amountStep = 10 ** -market.base.max_precision;
  const minimumCost = Number(market.min_order) / 10 ** market.quote.decimals;
  const minimumAmount = minimumCost / priceStep;
  const priceString = priceStep.toFixed(market.quote.max_precision);
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
  it("loads, creates, fetches, cancels, and observes a closed order", async () => {
    const persisted = JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as IntegrationWallets;
    const signer = O2Client.loadWallet(persisted.makerPrivateKey);
    const client = new O2Client({
      network: Network.TESTNET,
      apiOptions: { maxRetries: 0 },
    });
    let exchange: O2CCXT | undefined;
    let rawMarket: Market | undefined;
    let createdOrderId: string | undefined;

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

      const balance = await exchange.fetchBalance();
      const quoteFree = balance.free?.[orderMarket.quote.symbol] ?? 0;
      const { price, amount } = minimumRestingOrder(client, orderMarket);
      const requiredQuote = price * amount;
      if (quoteFree < requiredQuote) {
        throw new Error(
          `Integration wallet has insufficient ${orderMarket.quote.symbol}: ` +
            `${quoteFree} available, ${requiredQuote} required`,
        );
      }

      const created = await exchange.createOrder(symbol, "limit", "buy", amount, price, {
        orderType: "PostOnly",
      });
      createdOrderId = created.id;
      expect(created).toMatchObject({ symbol, side: "buy", type: "limit", status: "open" });

      const fetched = await waitFor(
        () => exchange?.fetchOrder(createdOrderId!, symbol),
        "the created order to reach the testnet indexer",
      );
      expect(fetched.id).toBe(createdOrderId);

      const open = await waitFor(async () => {
        const orders = await exchange?.fetchOpenOrders(symbol, undefined, 100);
        return orders?.find((order) => order.id === createdOrderId);
      }, "the order to appear in fetchOpenOrders");
      expect(open.status).toBe("open");

      const canceled = await exchange.cancelOrder(createdOrderId, symbol);
      expect(canceled.status).toBe("canceled");

      const closed = await waitFor(async () => {
        const orders = await exchange?.fetchClosedOrders(symbol, undefined, 100);
        return orders?.find((order) => order.id === createdOrderId);
      }, "the canceled order to appear in fetchClosedOrders");
      expect(closed.status).toBe("canceled");
      createdOrderId = undefined;
    } finally {
      if (createdOrderId && rawMarket) {
        try {
          await client.cancelOrder(createdOrderId as Order["order_id"], rawMarket);
        } catch {
          // The order may already be canceled or filled.
        }
      }
      await exchange?.close();
      if (!exchange) client.close();
    }
  }, 180_000);

  it("executes a CCXT bounded-market order against controlled liquidity", async () => {
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

      const priceStep = 10 ** -market.quote.max_precision;
      const amountStep = 10 ** -market.base.max_precision;
      const depth = await makerClient.getDepth(market, 1);
      const bestAsk = depth.asks[0]
        ? Number(depth.asks[0].price) / 10 ** market.quote.decimals
        : undefined;
      const bestBid = depth.bids[0]
        ? Number(depth.bids[0].price) / 10 ** market.quote.decimals
        : undefined;
      const candidatePrice = bestAsk
        ? Math.max(priceStep, bestAsk - priceStep)
        : Math.max(priceStep, bestBid ?? 1);
      const price = Math.floor(candidatePrice / priceStep) * priceStep;
      const minimumCost = Number(market.min_order) / 10 ** market.quote.decimals;
      const amount = Math.ceil(((minimumCost / price) * 1.1) / amountStep) * amountStep;
      const priceString = price.toFixed(market.quote.max_precision);
      const amountString = amount.toFixed(market.base.max_precision);

      await Promise.all([
        ensureTestnetBalance(
          makerClient,
          makerAccountId,
          market.quote.symbol,
          BigInt(Math.ceil(price * amount * 1.1 * 10 ** market.quote.decimals)),
        ),
        ensureTestnetBalance(
          takerClient,
          takerAccountId,
          market.base.symbol,
          BigInt(Math.ceil(amount * 1.1 * 10 ** market.base.decimals)),
        ),
      ]);

      const [makerBalances, takerBalances] = await Promise.all([
        makerClient.getBalances(makerAccountId),
        takerClient.getBalances(takerAccountId),
      ]);
      const makerQuote =
        Number(makerBalances[market.quote.symbol]?.trading_account_balance ?? 0n) /
        10 ** market.quote.decimals;
      const takerBase =
        Number(takerBalances[market.base.symbol]?.trading_account_balance ?? 0n) /
        10 ** market.base.decimals;
      if (makerQuote < price * amount || takerBase < amount) {
        throw new Error(
          `Bounded-market wallets need funding: makerQuote=${makerQuote}, ` +
            `takerBase=${takerBase}, price=${priceString}, amount=${amountString}`,
        );
      }

      const maker = await makerClient.createOrder(market, "buy", priceString, amountString, {
        orderType: "PostOnly",
      });
      const makerOrder = maker.orders?.[0];
      expect(makerOrder?.order_id).toBeTruthy();

      const maxPrice = (price + priceStep).toFixed(market.quote.max_precision);
      const symbol = market.pair || `${market.base.symbol}/${market.quote.symbol}`;
      const taker = await takerExchange.createOrder(symbol, "market", "sell", amount, undefined, {
        maxPrice,
        minPrice: priceString,
      });
      expect(taker).toMatchObject({
        symbol,
        type: "market",
        side: "sell",
      });

      if (makerOrder) {
        await waitFor(async () => {
          const indexed = await makerClient.getOrder(market!, makerOrder.order_id);
          return indexed.close ? indexed : undefined;
        }, "the maker order to close after the bounded-market fill");
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
});
