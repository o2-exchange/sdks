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
  formatPrice,
  formatQuantity,
  Network,
  O2Client,
  O2Error,
} from "../src/index.js";

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

  for await (const update of depthStream) {
    const sells = update.view?.sells ?? update.changes?.sells;
    if (!sells || sells.length === 0) continue;

    // depth levels now have bigint price/quantity
    const bestAsk = formatPrice(market, sells[0].price);
    const bestAskQty = formatQuantity(market, sells[0].quantity);

    console.log(
      `Best ask: ${bestAsk.toFixed(6)} ${market.quote.symbol} (qty: ${bestAskQty.toFixed(3)})`,
    );

    // Check if price meets our target
    if (bestAsk <= CONFIG.buyBelowPrice && bestAsk > 0) {
      console.log(`Target price reached! Executing buy...`);

      // Use bigint prices directly from depth (pass-through path)
      const bestAskBigint = sells[0].price;
      const bestAskQtyBigint = sells[0].quantity;

      // Calculate max price with slippage as a string for BoundedMarket
      const maxPrice = (bestAsk * (1 + CONFIG.slippagePercent)).toFixed(6);

      try {
        const response = await client.createOrder(
          pair,
          "Buy",
          bestAskBigint, // bigint pass-through — already scaled
          bestAskQtyBigint > scaleQuantity(CONFIG.maxQuantity, market.base.decimals)
            ? scaleQuantity(CONFIG.maxQuantity, market.base.decimals)
            : bestAskQtyBigint,
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

function scaleQuantity(humanQty: number, decimals: number): bigint {
  return BigInt(Math.ceil(humanQty * 10 ** decimals));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
