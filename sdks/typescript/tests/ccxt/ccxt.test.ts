import { Exchange } from "ccxt";
import { describe, expect, it, vi } from "vitest";
import { ArgumentsRequired, BadRequest, NotSupported, O2CCXT } from "../../src/ccxt/index.js";
import type { Signer } from "../../src/crypto.js";
import { Network, O2Client, SessionActionsResponse } from "../../src/index.js";
import {
  assetId,
  contractId,
  type Market,
  marketId,
  type Order,
  orderId,
  tradeAccountId,
  txId,
} from "../../src/models.js";

const ACCOUNT_ID = tradeAccountId(`0x${"11".repeat(32)}`);
const MARKET: Market = {
  contract_id: contractId(`0x${"22".repeat(32)}`),
  market_id: marketId(`0x${"33".repeat(32)}`),
  pair: "FUEL/USDC",
  maker_fee: 0n,
  taker_fee: 10n,
  min_order: 1_000_000n,
  dust: 0n,
  price_window: 0,
  base: {
    symbol: "FUEL",
    asset: assetId(`0x${"44".repeat(32)}`),
    decimals: 9,
    max_precision: 4,
  },
  quote: {
    symbol: "USDC",
    asset: assetId(`0x${"55".repeat(32)}`),
    decimals: 6,
    max_precision: 3,
  },
};

const RAW_ORDER: Order = {
  order_id: orderId(`0x${"66".repeat(32)}`),
  side: "buy",
  order_type: "PostOnly",
  quantity: 2_000_000_000n,
  quantity_fill: 500_000_000n,
  price: 1_500_000n,
  price_fill: 1_400_000n,
  timestamp: 1_700_000_000,
  close: false,
  partially_filled: true,
  cancel: false,
  market_id: MARKET.market_id,
};

function setup() {
  const client = new O2Client({ network: Network.TESTNET });
  vi.spyOn(client, "getMarkets").mockResolvedValue([MARKET]);
  return { client, exchange: new O2CCXT({ client, tradeAccountId: ACCOUNT_ID }) };
}

describe("O2CCXT public alpha", () => {
  it("is an official CCXT Exchange subclass", () => {
    const { client, exchange } = setup();

    expect(exchange).toBeInstanceOf(Exchange);
    expect(exchange.id).toBe("o2");
    expect(exchange.has.fetchTicker).toBe(true);
    expect(exchange.has.createMarketOrder).toBe(true);
    expect(exchange.o2Client).toBe(client);
  });

  it("loads unified spot market metadata and caches it", async () => {
    const { client, exchange } = setup();

    const markets = await exchange.loadMarkets();

    expect(markets["FUEL/USDC"]).toMatchObject({
      id: MARKET.market_id,
      symbol: "FUEL/USDC",
      base: "FUEL",
      quote: "USDC",
      spot: true,
      precision: { amount: 4, price: 3 },
      limits: { cost: { min: 1, max: null } },
    });
    expect(exchange.symbols).toEqual(["FUEL/USDC"]);
    await exchange.loadMarkets();
    expect(client.getMarkets).toHaveBeenCalledTimes(1);
  });

  it("converts depth and public trades from chain units", async () => {
    const { client, exchange } = setup();
    const getDepth = vi.spyOn(client, "getDepth").mockResolvedValue({
      bids: [{ price: 1_500_000n, quantity: 2_000_000_000n }],
      asks: [{ price: 1_600_000n, quantity: 3_000_000_000n }],
    });
    vi.spyOn(client, "getTrades").mockResolvedValue([
      {
        trade_id: "trade-1",
        side: "buy",
        total: 3_000_000n,
        quantity: 2_000_000_000n,
        price: 1_500_000n,
        timestamp: 1_700_000_000_000,
      },
    ]);

    const book = await exchange.fetchOrderBook("FUEL/USDC", 10, { precision: 2 });
    const trades = await exchange.fetchTrades("FUEL/USDC", 1_699_999_999_000, 10);

    expect(getDepth).toHaveBeenCalledWith(MARKET, 2, 10);
    expect(book.bids).toEqual([[1.5, 2]]);
    expect(book.asks).toEqual([[1.6, 3]]);
    expect(trades[0]).toMatchObject({
      id: "trade-1",
      side: "sell",
      price: 1.5,
      amount: 2,
      cost: 3,
    });
    await expect(
      exchange.fetchOrderBook("FUEL/USDC", 10, { precision: 19 }),
    ).rejects.toBeInstanceOf(BadRequest);
  });

  it("normalizes ticker and OHLCV data", async () => {
    const { client, exchange } = setup();
    vi.spyOn(client, "getTicker").mockResolvedValue({
      market_id: MARKET.market_id,
      last_price: "1.5",
      best_bid: "1.4",
      best_ask: "1.6",
      base_volume: "100",
      quote_volume: "150",
    });
    const getBars = vi
      .spyOn(client, "getBars")
      .mockResolvedValue([
        { time: 1_700_000_000, open: "1", high: "2", low: "0.5", close: "1.5", volume: "9" },
      ]);

    const ticker = await exchange.fetchTicker("FUEL/USDC");
    const candles = await exchange.fetchOHLCV("FUEL/USDC", "1m", 1_700_000_000_000, 10, {
      until: 1_700_000_600_000,
    });

    expect(ticker).toMatchObject({ last: 1.5, close: 1.5, bid: 1.4, ask: 1.6 });
    expect(candles).toEqual([[1_700_000_000_000, 1, 2, 0.5, 1.5, 9]]);
    expect(getBars).toHaveBeenCalledWith(MARKET, "1m", 1_700_000_000_000, 1_700_000_600_000);
    await expect(exchange.fetchOHLCV("FUEL/USDC", "2m")).rejects.toBeInstanceOf(NotSupported);
  });

  it("returns CCXT balance dictionaries without double-counting unlocked funds", async () => {
    const { client, exchange } = setup();
    vi.spyOn(client, "getBalances").mockResolvedValue({
      USDC: {
        order_books: {},
        total_locked: 2_000_000n,
        total_unlocked: 8_000_000n,
        trading_account_balance: 5_000_000n,
      },
    });

    const balance = await exchange.fetchBalance();

    expect(client.getBalances).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(balance.USDC).toEqual({ free: 8, used: 2, total: 10 });
    expect(balance.free.USDC).toBe(8);
  });

  it("creates and parses limit orders with CCXT parameters", async () => {
    const { client, exchange } = setup();
    const response = new SessionActionsResponse(
      txId(`0x${"77".repeat(32)}`),
      [RAW_ORDER],
      null,
      null,
      null,
      null,
    );
    const create = vi.spyOn(client, "createOrder").mockResolvedValue(response);

    const order = await exchange.createOrder("FUEL/USDC", "limit", "buy", 2, 1.5, {
      orderType: "PostOnly",
      settleFirst: false,
    });

    expect(create).toHaveBeenCalledWith(MARKET, "buy", "1.5", "2", {
      orderType: "PostOnly",
      settleFirst: false,
      collectOrders: true,
    });
    expect(order).toMatchObject({
      id: RAW_ORDER.order_id,
      type: "limit",
      timeInForce: "PO",
      postOnly: true,
      price: 1.5,
      amount: 2,
      filled: 0.5,
      remaining: 1.5,
      average: 1.4,
      cost: 0.7,
      status: "open",
    });
    await expect(exchange.createOrder("FUEL/USDC", "stop", "buy", 2)).rejects.toBeInstanceOf(
      NotSupported,
    );
  });

  it("maps bounded CCXT market orders to O2 BoundedMarket orders", async () => {
    const { client, exchange } = setup();
    const marketOrder: Order = {
      ...RAW_ORDER,
      side: "sell",
      close: true,
      order_type: { BoundedMarket: { max_price: "1.6", min_price: "1.4" } },
    };
    const create = vi
      .spyOn(client, "createOrder")
      .mockResolvedValue(
        new SessionActionsResponse(
          txId(`0x${"77".repeat(32)}`),
          [marketOrder],
          null,
          null,
          null,
          null,
        ),
      );

    const order = await exchange.createMarketOrder("FUEL/USDC", "sell", 2, undefined, {
      maxPrice: 1.6,
      minPrice: 1.4,
    });

    expect(create).toHaveBeenCalledWith(MARKET, "sell", "1.4", "2", {
      orderType: { BoundedMarket: { max_price: "1.6", min_price: "1.4" } },
      settleFirst: true,
      collectOrders: true,
    });
    expect(order).toMatchObject({ type: "market", side: "sell", status: "closed" });

    await expect(
      exchange.createOrder("FUEL/USDC", "market", "buy", 2, undefined, { maxPrice: 1.6 }),
    ).rejects.toBeInstanceOf(ArgumentsRequired);
  });

  it("requires a symbol for O2 order lookups and maps open orders", async () => {
    const { client, exchange } = setup();
    vi.spyOn(client, "getOrders").mockResolvedValue([RAW_ORDER]);

    await expect(exchange.fetchOrder(RAW_ORDER.order_id)).rejects.toBeInstanceOf(ArgumentsRequired);
    const orders = await exchange.fetchOpenOrders("FUEL/USDC");

    expect(client.getOrders).toHaveBeenCalledWith(MARKET, ACCOUNT_ID, true, 20);
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("open");
  });

  it("returns a canceled order without waiting for indexer catch-up", async () => {
    const { client, exchange } = setup();
    const getOrder = vi.spyOn(client, "getOrder").mockResolvedValue(RAW_ORDER);
    const cancelOrder = vi
      .spyOn(client, "cancelOrder")
      .mockResolvedValue(
        new SessionActionsResponse(txId(`0x${"88".repeat(32)}`), null, null, null, null, null),
      );

    const canceled = await exchange.cancelOrder(RAW_ORDER.order_id, "FUEL/USDC");

    expect(getOrder).toHaveBeenCalledOnce();
    expect(cancelOrder).toHaveBeenCalledWith(RAW_ORDER.order_id, MARKET);
    expect(canceled.status).toBe("canceled");
  });

  it("normalizes account-relative trades and leaves self-trade side null", async () => {
    const { client, exchange } = setup();
    vi.spyOn(client, "getTrades").mockResolvedValue([
      {
        trade_id: "self-trade",
        side: "buy",
        trader_side: "both",
        total: 3_000_000n,
        quantity: 2_000_000_000n,
        price: 1_500_000n,
        timestamp: 1_700_000_000_000,
      },
    ]);

    const trades = await exchange.fetchMyTrades(undefined, undefined, 50);

    expect(client.getTrades).toHaveBeenCalledWith(MARKET, 50, ACCOUNT_ID);
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBeNull();
    expect(trades[0].info.trader_side).toBe("both");
  });

  it("runs account setup only through the explicit extension", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    const signer: Signer = {
      b256Address: `0x${"99".repeat(32)}`,
      personalSign: () => new Uint8Array(64),
    };
    const setupAccount = vi
      .spyOn(client, "setupAccount")
      .mockResolvedValue({ tradeAccountId: ACCOUNT_ID, nonce: 3n });
    const exchange = new O2CCXT({ client, signer });

    expect(setupAccount).not.toHaveBeenCalled();
    await exchange.setupAccount();
    expect(setupAccount).toHaveBeenCalledWith(signer);
  });

  it("normalizes withdrawals through the unified CCXT signature", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    const signer: Signer = {
      b256Address: `0x${"99".repeat(32)}`,
      personalSign: () => new Uint8Array(64),
    };
    const transactionId = txId(`0x${"aa".repeat(32)}`);
    const withdraw = vi.spyOn(client, "withdraw").mockResolvedValue({ tx_id: transactionId });
    const exchange = new O2CCXT({ client, signer });

    const transaction = await exchange.withdraw("USDC", 10, signer.b256Address);

    expect(withdraw).toHaveBeenCalledWith(signer, "USDC", "10", signer.b256Address);
    expect(transaction).toMatchObject({
      id: transactionId,
      txid: transactionId,
      type: "withdrawal",
      currency: "USDC",
      amount: 10,
      address: signer.b256Address,
      status: "pending",
    });
  });
});
