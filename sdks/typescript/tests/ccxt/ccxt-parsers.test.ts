import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseBalance,
  parseMarket,
  parseOHLCV,
  parseOrder,
  parseOrderBook,
  parseTicker,
  parseTrade,
} from "../../src/ccxt/index.js";
import type {
  BalanceResponse,
  Bar,
  DepthSnapshot,
  Market,
  MarketTicker,
  Order,
  Trade,
} from "../../src/models.js";
import { assetId, contractId, marketId, orderId } from "../../src/models.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/ccxt/", import.meta.url));

function fixture<T>(path: string): T {
  return JSON.parse(readFileSync(`${FIXTURES}${path}`, "utf8")) as T;
}

function rawMarket(): Market {
  const raw = fixture<Record<string, any>[]>("raw/markets.json")[0];
  return {
    ...raw,
    contract_id: contractId(raw.contract_id),
    market_id: marketId(raw.market_id),
    maker_fee: BigInt(raw.maker_fee),
    taker_fee: BigInt(raw.taker_fee),
    min_order: BigInt(raw.min_order),
    dust: BigInt(raw.dust),
    base: { ...raw.base, asset: assetId(raw.base.asset) },
    quote: { ...raw.quote, asset: assetId(raw.quote.asset) },
  };
}

function projection(value: Record<string, unknown>, expected: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(expected).map((key) => [key, value[key]]));
}

describe("shared CCXT fixture parsers", () => {
  it("normalizes market metadata", () => {
    const actual = parseMarket(rawMarket());
    const expected = fixture<Record<string, unknown>[]>("expected/markets.json")[0];
    expect({
      ...projection(actual as unknown as Record<string, unknown>, expected),
      minimumCost: actual.limits.cost.min,
    }).toEqual(expected);
  });

  it("normalizes public, maker, taker, and self trades", () => {
    const market = parseMarket(rawMarket());
    const raw = fixture<Record<string, any>[]>("raw/trades.json").map(
      (trade): Trade => ({
        ...trade,
        total: BigInt(trade.total),
        quantity: BigInt(trade.quantity),
        price: BigInt(trade.price),
      }),
    );
    const expected = fixture<Record<string, unknown>[]>("expected/trades.json");
    const actual = [
      parseTrade(raw[0], market),
      parseTrade(raw[1], market, true),
      parseTrade(raw[2], market, true),
      parseTrade(raw[3], market, true),
    ].map((trade, index) =>
      projection(trade as unknown as Record<string, unknown>, expected[index]),
    );

    expect(actual).toEqual(expected);
    expect(actual[3].side).toBeNull();
  });

  it("normalizes order book, ticker, candles, balances, and orders", () => {
    const market = parseMarket(rawMarket());
    const rawBook = fixture<Record<string, any>>("raw/orderbook.json");
    const book: DepthSnapshot = {
      bids: rawBook.bids.map((level: any) => ({
        price: BigInt(level.price),
        quantity: BigInt(level.quantity),
      })),
      asks: rawBook.asks.map((level: any) => ({
        price: BigInt(level.price),
        quantity: BigInt(level.quantity),
      })),
    };
    expect(parseOrderBook(book, market)).toEqual(fixture("expected/orderbook.json"));

    const ticker = fixture<MarketTicker>("raw/ticker.json");
    const expectedTicker = fixture<Record<string, unknown>>("expected/ticker.json");
    expect(
      projection(
        parseTicker(ticker, market, 1_700_000_000_000) as unknown as Record<string, unknown>,
        expectedTicker,
      ),
    ).toEqual(expectedTicker);

    const bars = fixture<Bar[]>("raw/ohlcv.json").map(parseOHLCV);
    expect(bars).toEqual(fixture("expected/ohlcv.json"));

    const rawBalances = fixture<Record<string, any>>("raw/balances.json");
    const balances = Object.fromEntries(
      Object.entries(rawBalances).map(([symbol, balance]): [string, BalanceResponse] => [
        symbol,
        {
          ...balance,
          total_locked: BigInt(balance.total_locked),
          total_unlocked: BigInt(balance.total_unlocked),
          trading_account_balance: BigInt(balance.trading_account_balance),
        },
      ]),
    );
    const parsedBalance = parseBalance(balances, new Map([["USDC", 6]]));
    expect(parsedBalance.USDC).toEqual(fixture("expected/balances.json").USDC);

    const expectedOrders = fixture<Record<string, unknown>[]>("expected/orders.json");
    const orders = fixture<Record<string, any>[]>("raw/orders.json").map(
      (raw): Order => ({
        ...raw,
        order_id: orderId(raw.order_id),
        market_id: marketId(raw.market_id),
        quantity: BigInt(raw.quantity),
        quantity_fill: BigInt(raw.quantity_fill),
        price: BigInt(raw.price),
        price_fill: BigInt(raw.price_fill),
      }),
    );
    expect(
      orders.map((order, index) =>
        projection(
          parseOrder(order, market) as unknown as Record<string, unknown>,
          expectedOrders[index],
        ),
      ),
    ).toEqual(expectedOrders);
  });
});
