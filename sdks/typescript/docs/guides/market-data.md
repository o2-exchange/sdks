# Market Data Guide

This guide covers how to fetch market data using the O2 TypeScript SDK.

## Listing Markets

```ts
const markets = await client.getMarkets();
for (const market of markets) {
  console.log(`${market.base.symbol}/${market.quote.symbol} — ${market.market_id}`);
}
```

To get a specific market by its symbol pair:

```ts
const market = await client.getMarket("FUEL/USDC");
console.log(market.contract_id);
console.log(market.base.decimals);  // e.g., 9
console.log(market.quote.decimals); // e.g., 9
```

The market pair lookup is case-insensitive and supports the `f`-prefix
convention used on testnet (e.g., `"FUEL/USDC"` matches `"FUEL/USDC"`).
You can also pass a hex `market_id` directly.

## Order Book Depth

Fetch a snapshot of the current order book:

```ts
const depth = await client.getDepth("FUEL/USDC", 10);

console.log("Top 3 bids:");
for (const level of depth.buys.slice(0, 3)) {
  console.log(`  ${level.price} — ${level.quantity}`);  // bigint values
}

console.log("Top 3 asks:");
for (const level of depth.sells.slice(0, 3)) {
  console.log(`  ${level.price} — ${level.quantity}`);
}
```

Depth level `price` and `quantity` are `bigint` chain integers. Use
`formatPrice()` and `formatQuantity()` to convert to human-readable:

```ts
import { formatPrice, formatQuantity } from "@o2exchange/sdk";

const market = await client.getMarket("FUEL/USDC");
const depth = await client.getDepth(market, 10);

for (const level of depth.buys) {
  console.log(`${formatPrice(market, level.price)} — ${formatQuantity(market, level.quantity)}`);
}
```

## Recent Trades

```ts
const trades = await client.getTrades("FUEL/USDC", 20);
for (const trade of trades) {
  console.log(`${trade.side} ${trade.quantity} @ ${trade.price} — ${trade.timestamp}`);
  // trade.price, trade.quantity, trade.total are bigint
}
```

## OHLCV Candles (Bars)

Fetch candlestick data for charting:

```ts
const now = Math.floor(Date.now() / 1000);
const oneDayAgo = now - 86400;

const bars = await client.getBars("FUEL/USDC", "1h", oneDayAgo, now);
for (const bar of bars) {
  console.log(
    `${new Date(bar.time * 1000).toISOString()}: ` +
    `O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} V=${bar.volume}`
  );
}
```

Supported resolutions: `"1m"`, `"5m"`, `"15m"`, `"30m"`, `"1h"`, `"4h"`, `"1d"`, `"1w"`.

## Ticker Data

Get the current ticker for a market:

```ts
const ticker = await client.getTicker("FUEL/USDC");
console.log(`Last: ${ticker.last_price}`);
console.log(`Bid: ${ticker.best_bid} / Ask: ${ticker.best_ask}`);
console.log(`Volume: ${ticker.base_volume} base, ${ticker.quote_volume} quote`);
```

## Account Balances

Fetch balances for a trading account, keyed by asset symbol:

```ts
const balances = await client.getBalances(tradeAccountId);
for (const [symbol, bal] of Object.entries(balances)) {
  console.log(`${symbol}:`);
  console.log(`  Total: ${bal.trading_account_balance}`);   // bigint
  console.log(`  Locked: ${bal.total_locked}`);              // bigint
  console.log(`  Unlocked: ${bal.total_unlocked}`);          // bigint
}
```

## Price and Quantity Formatting

The API returns prices and quantities as `bigint` chain integers. Use the
helper functions to convert between human-readable and chain formats:

```ts
import { formatPrice, formatQuantity, scalePriceForMarket, scaleQuantityForMarket } from "@o2exchange/sdk";

const market = await client.getMarket("FUEL/USDC");

// Chain integer (bigint) → human-readable
const humanPrice = formatPrice(market, 20000000n);      // e.g., 0.02
const humanQty = formatQuantity(market, 100000000000n);  // e.g., 100.0

// Human-readable → chain integer (bigint)
const chainPrice = scalePriceForMarket(market, 0.02);
const chainQty = scaleQuantityForMarket(market, 100.0);
```

## Low-Level API Access

For advanced use cases, you can access the underlying `O2Api` directly
through the `api` property:

```ts
// Market summary (24h stats)
const summary = await client.api.getMarketSummary(market.market_id);

// Trades by specific account
const accountTrades = await client.api.getTradesByAccount(
  market.market_id,
  tradeAccountId,
);

// Aggregated data (CoinGecko format)
const assets = await client.api.getAggregatedAssets();
const orderbook = await client.api.getAggregatedOrderbook("FUEL_USDC");
```
