import type {
  BalanceResponse,
  Bar,
  DepthSnapshot,
  Market,
  MarketTicker,
  Order,
  Trade,
} from "../models.js";
import { formatPrice, formatQuantity } from "../models.js";
import type {
  CCXTBalance,
  CCXTMarket,
  CCXTOHLCV,
  CCXTOrder,
  CCXTOrderBook,
  CCXTTicker,
  CCXTTrade,
} from "./types.js";

export const CCXT_TIMEFRAMES: Readonly<Record<string, number>> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function timestampMs(value: string | number | undefined): number | null {
  if (value === undefined || value === "") return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

export function parseMarket(market: Market): CCXTMarket {
  return {
    id: market.market_id,
    symbol: market.pair || `${market.base.symbol}/${market.quote.symbol}`,
    base: market.base.symbol,
    quote: market.quote.symbol,
    baseId: market.base.asset,
    quoteId: market.quote.asset,
    type: "spot",
    spot: true,
    margin: false,
    swap: false,
    future: false,
    option: false,
    active: true,
    contract: false,
    maker: null,
    taker: null,
    percentage: true,
    precision: { amount: market.base.max_precision, price: market.quote.max_precision },
    limits: {
      amount: { min: null, max: null },
      price: { min: null, max: null },
      cost: { min: Number(market.min_order) / 10 ** market.quote.decimals, max: null },
    },
    info: market,
  };
}

export function parseOrderBook(
  depth: DepthSnapshot,
  market: CCXTMarket,
  timestamp: number | null = null,
): CCXTOrderBook {
  return {
    symbol: market.symbol,
    bids: depth.bids.map((level) => [
      formatPrice(market.info, level.price),
      formatQuantity(market.info, level.quantity),
    ]),
    asks: depth.asks.map((level) => [
      formatPrice(market.info, level.price),
      formatQuantity(market.info, level.quantity),
    ]),
    timestamp,
    datetime: timestamp === null ? null : new Date(timestamp).toISOString(),
    nonce: null,
  };
}

function oppositeSide(side: Trade["side"]): "buy" | "sell" {
  return side === "buy" ? "sell" : "buy";
}

export function parseTrade(trade: Trade, market: CCXTMarket, accountRelative = false): CCXTTrade {
  const timestamp = timestampMs(trade.timestamp) ?? 0;
  const price = formatPrice(market.info, trade.price);
  const amount = formatQuantity(market.info, trade.quantity);
  let side: "buy" | "sell" | null;
  let takerOrMaker: "taker" | "maker" | null = null;
  if (!accountRelative) {
    side = oppositeSide(trade.side);
  } else if (trade.trader_side === "both") {
    side = null;
  } else if (trade.trader_side === "maker") {
    side = trade.side;
    takerOrMaker = "maker";
  } else {
    side = oppositeSide(trade.side);
    takerOrMaker = trade.trader_side === "taker" ? "taker" : null;
  }
  return {
    id: trade.trade_id,
    timestamp,
    datetime: new Date(timestamp).toISOString(),
    symbol: market.symbol,
    order: null,
    type: null,
    side,
    takerOrMaker,
    price,
    amount,
    cost: price * amount,
    fee: null,
    info: trade,
  };
}

export function parseTicker(
  ticker: MarketTicker,
  market: CCXTMarket,
  timestamp = Date.now(),
): CCXTTicker {
  const last = numberOrNull(ticker.last_price);
  return {
    symbol: market.symbol,
    timestamp,
    datetime: new Date(timestamp).toISOString(),
    high: null,
    low: null,
    bid: numberOrNull(ticker.best_bid),
    bidVolume: null,
    ask: numberOrNull(ticker.best_ask),
    askVolume: null,
    vwap: null,
    open: null,
    close: last,
    last,
    previousClose: null,
    change: null,
    percentage: null,
    average: null,
    baseVolume: numberOrNull(ticker.base_volume),
    quoteVolume: numberOrNull(ticker.quote_volume),
    info: ticker,
  };
}

export function parseOHLCV(bar: Bar): CCXTOHLCV {
  return [
    timestampMs(bar.time) ?? 0,
    Number(bar.open),
    Number(bar.high),
    Number(bar.low),
    Number(bar.close),
    Number(bar.volume),
  ];
}

export function parseBalance(
  balances: Record<string, BalanceResponse>,
  decimals: ReadonlyMap<string, number>,
): CCXTBalance {
  const result: CCXTBalance = { free: {}, used: {}, total: {}, info: balances };
  for (const [currency, balance] of Object.entries(balances)) {
    const scale = 10 ** (decimals.get(currency) ?? 0);
    const free = Number(balance.total_unlocked) / scale;
    const used = Number(balance.total_locked) / scale;
    const total = free + used;
    result.free[currency] = free;
    result.used[currency] = used;
    result.total[currency] = total;
    result[currency] = { free, used, total };
  }
  return result;
}

function orderTypeInfo(value: Order["order_type"]): {
  type: "limit" | "market";
  timeInForce: "GTC" | "FOK" | "PO" | null;
  postOnly: boolean;
} {
  const label = typeof value === "string" ? value : (Object.keys(value)[0] ?? "Spot");
  if (label === "Market" || label === "BoundedMarket") {
    return { type: "market", timeInForce: null, postOnly: false };
  }
  if (label === "FillOrKill") {
    return { type: "limit", timeInForce: "FOK", postOnly: false };
  }
  if (label === "PostOnly") {
    return { type: "limit", timeInForce: "PO", postOnly: true };
  }
  return { type: "limit", timeInForce: "GTC", postOnly: false };
}

export function parseOrder(order: Order, market: CCXTMarket): CCXTOrder {
  const timestamp = timestampMs(order.timestamp);
  const amount = formatQuantity(market.info, order.quantity);
  const filled = formatQuantity(market.info, order.quantity_fill ?? 0n);
  const price = formatPrice(market.info, order.price);
  const average = order.price_fill ? formatPrice(market.info, order.price_fill) : null;
  const kind = orderTypeInfo(order.order_type);
  const status = order.cancel ? "canceled" : order.close ? "closed" : "open";
  return {
    id: order.order_id,
    clientOrderId: null,
    timestamp,
    datetime: timestamp === null ? null : new Date(timestamp).toISOString(),
    lastTradeTimestamp: null,
    lastUpdateTimestamp: null,
    symbol: market.symbol,
    type: kind.type,
    timeInForce: kind.timeInForce,
    postOnly: kind.postOnly,
    reduceOnly: false,
    side: order.side,
    price,
    triggerPrice: null,
    amount,
    cost: (average ?? price) * filled,
    average,
    filled,
    remaining: Math.max(0, amount - filled),
    status,
    fee: null,
    trades: null,
    info: order,
  };
}
