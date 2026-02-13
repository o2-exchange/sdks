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

import { Network, O2Client, O2Error } from "../src/index.js";

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
  const wallet = client.generateWallet();
  console.log(`Wallet: ${wallet.b256Address}`);

  const { tradeAccountId } = await client.setupAccount(wallet);
  console.log(`Trade account: ${tradeAccountId}`);

  await sleep(3000);

  // Get market
  const markets = await client.getMarkets();
  const market = markets[0];
  console.log(`Monitoring: ${market.base.symbol}/${market.quote.symbol}`);

  // Create session
  const session = await client.createSession(wallet, tradeAccountId, [market], 30);

  // Stream depth
  console.log(`Watching for asks below ${CONFIG.buyBelowPrice} ${market.quote.symbol}...`);
  const depthStream = await client.streamDepth(market, 1);

  for await (const update of depthStream) {
    const sells = update.view?.sells ?? update.changes?.sells;
    if (!sells || sells.length === 0) continue;

    const bestAsk = Number(sells[0].price) / 10 ** market.quote.decimals;
    const bestAskQty = Number(sells[0].quantity) / 10 ** market.base.decimals;

    console.log(
      `Best ask: ${bestAsk.toFixed(6)} ${market.quote.symbol} (qty: ${bestAskQty.toFixed(3)})`,
    );

    // Check if price meets our target
    if (bestAsk <= CONFIG.buyBelowPrice && bestAsk > 0) {
      console.log(`Target price reached! Executing buy...`);

      const maxPrice = bestAsk * (1 + CONFIG.slippagePercent);

      try {
        const response = await client.createOrder(
          session,
          market,
          "Buy",
          bestAsk,
          Math.min(CONFIG.maxQuantity, bestAskQty),
          {
            BoundedMarket: {
              max_price: scalePriceStr(maxPrice, market.quote.decimals, market.quote.max_precision),
              min_price: "0",
            },
          },
          true,
          true,
        );

        console.log(`Buy executed! TX: ${response.tx_id}`);

        if (response.orders) {
          for (const order of response.orders) {
            console.log(
              `  Order ${order.order_id}: ${order.side} ${order.quantity} @ ${order.price}`,
            );
          }
        }
      } catch (error) {
        if (error instanceof O2Error) {
          console.error(`Trade failed: ${error.message}`);
          await client.refreshNonce(session);
        } else {
          console.error("Unexpected error:", error);
        }
      }
    }
  }
}

function scalePriceStr(price: number, decimals: number, maxPrecision: number): string {
  const scaled = BigInt(Math.floor(price * 10 ** decimals));
  const factor = BigInt(10 ** (decimals - maxPrecision));
  return ((scaled / factor) * factor).toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
