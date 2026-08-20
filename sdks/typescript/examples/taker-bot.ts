/**
 * O2 Exchange SDK - Taker Bot Example
 *
 * WebSocket-driven taker bot that:
 * - Monitors order book depth in real-time
 * - Executes BoundedMarket orders when price crosses threshold
 * - Configurable target price and slippage tolerance
 *
 * Run: npx tsx examples/taker-bot.ts
 */

import {
  boundedMarketOrder,
  DepthBook,
  formatPrice,
  formatQuantity,
  Network,
  O2Client,
  O2Error,
  scaleQuantityForMarket,
} from "@o2exchange/sdk";

// ── Configuration ─────────────────────────────────────────────────

const CONFIG = {
  network: Network.TESTNET,
  buyBelowPrice: 0.02, // Buy when best ask drops below this
  maxQuantity: 50.0, // Max quantity per trade
  slippagePercent: 0.005, // 0.5% slippage tolerance
};

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const client = new O2Client({ network: CONFIG.network });

  // Setup
  const wallet = O2Client.generateWallet();
  console.log(`Wallet: ${wallet.b256Address}`);

  const { tradeAccountId } = await client.setupAccount(wallet);
  console.log(`Trade account: ${tradeAccountId}`);

  await sleep(3000);

  // Get market
  const markets = await client.getMarkets();
  const market = markets[0];
  const pair = `${market.base.symbol}/${market.quote.symbol}`;
  console.log(`Monitoring: ${pair}`);

  // Create session (stored on client, tradeAccountId resolved from wallet)
  await client.createSession(wallet, [pair], 30);

  // Stream depth
  console.log(`Watching for asks below ${CONFIG.buyBelowPrice} ${market.quote.symbol}...`);
  const depthStream = await client.streamDepth(pair, 1);

  // Depth messages after the snapshot carry signed relative changes;
  // DepthBook applies them and keeps a correct local book.
  const book = new DepthBook();
  for await (const update of depthStream) {
    book.apply(update);
    const bestAskPrice = book.bestAsk;
    if (bestAskPrice === undefined) continue;

    const bestAsk = formatPrice(market, bestAskPrice);
    const bestAskQty = formatQuantity(market, book.asks.get(bestAskPrice) ?? 0n);

    console.log(
      `Best ask: ${bestAsk.toFixed(6)} ${market.quote.symbol} (qty: ${bestAskQty.toFixed(3)})`,
    );

    // Check if price meets our target
    if (bestAsk <= CONFIG.buyBelowPrice && bestAsk > 0) {
      console.log(`Target price reached! Executing buy...`);

      // Use bigint prices directly from the book (pass-through path)
      const bestAskBigint = bestAskPrice;
      const bestAskQtyBigint = book.asks.get(bestAskPrice) ?? 0n;
      const maxOrderQuantity = scaleQuantityForMarket(market, CONFIG.maxQuantity);

      // Calculate max price with slippage as a string for BoundedMarket
      const maxPrice = (bestAsk * (1 + CONFIG.slippagePercent)).toFixed(6);

      try {
        const response = await client.createOrder(
          pair,
          "buy",
          bestAskBigint, // bigint pass-through — already scaled
          bestAskQtyBigint > maxOrderQuantity ? maxOrderQuantity : bestAskQtyBigint,
          { orderType: boundedMarketOrder(maxPrice, "0") },
        );

        console.log(`Buy executed! TX: ${response.txId}`);

        if (response.orders) {
          for (const order of response.orders) {
            console.log(
              `  Order ${order.order_id}: ${order.side} ${formatQuantity(market, order.quantity)} @ ${formatPrice(market, order.price)}`,
            );
          }
        }
      } catch (error) {
        if (error instanceof O2Error) {
          console.error(`Trade failed: ${error.message}`);
          await client.refreshNonce();
        } else {
          console.error("Unexpected error:", error);
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
