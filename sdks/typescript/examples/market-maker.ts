/**
 * O2 Exchange SDK - Market Maker Bot Example
 *
 * Implements the market maker pattern from Section 9 of the guide:
 * - Places symmetric buy/sell orders around a reference price
 * - Cancels stale orders and replaces atomically
 * - Uses WebSocket for real-time order fill tracking
 * - Handles filled-order detection (skip cancel for closed orders)
 * - Atomic cancel+settle+replace pattern (5 actions per batch)
 *
 * Run: npx tsx examples/market-maker.ts
 */

import {
  cancelOrderAction,
  createOrderAction,
  type MarketActionGroup,
  Network,
  O2Client,
  O2Error,
  type OrderId,
  settleBalanceAction,
} from "@o2exchange/sdk";

// ── Configuration ─────────────────────────────────────────────────

const CONFIG = {
  network: Network.TESTNET,
  marketPair: "fFUEL/fUSDC", // Adjust to match your testnet market
  spreadPercent: 0.02, // 2% spread
  orderQuantity: "100.0", // Base quantity per side (human-readable)
  cycleIntervalMs: 10000, // 10 seconds between cycles
  referencePrice: 0.025, // Fallback reference price
};

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const client = new O2Client({ network: CONFIG.network });

  // Setup wallet and account
  const wallet = O2Client.generateWallet();
  console.log(`Wallet: ${wallet.b256Address}`);

  const { tradeAccountId } = await client.setupAccount(wallet);
  console.log(`Trade account: ${tradeAccountId}`);

  // Wait for faucet
  await sleep(3000);

  // Create session (stored on client, tradeAccountId resolved from wallet)
  await client.createSession(wallet, [CONFIG.marketPair], 30);
  console.log(`Session: ${client.session!.sessionAddress}`);

  // Subscribe to order updates for fill detection
  let activeBuyId: OrderId | null = null;
  let activeSellId: OrderId | null = null;

  const orderStream = await client.streamOrders(tradeAccountId);

  // Start fill detection in background
  (async () => {
    for await (const update of orderStream) {
      for (const order of update.orders) {
        if (order.close) {
          if (order.order_id === activeBuyId) {
            console.log(`Buy order filled: ${order.order_id}`);
            activeBuyId = null;
          } else if (order.order_id === activeSellId) {
            console.log(`Sell order filled: ${order.order_id}`);
            activeSellId = null;
          }
        }
      }
    }
  })();

  // Market maker loop
  console.log("Starting market maker loop...");

  for (let cycle = 0; ; cycle++) {
    try {
      console.log(`\n--- Cycle ${cycle + 1} ---`);

      // Get reference price (in production, fetch from external source)
      const refPrice = CONFIG.referencePrice;

      // Calculate spread prices (human-readable strings — auto-scaled by SDK)
      const buyPrice = (refPrice * (1 - CONFIG.spreadPercent)).toFixed(6);
      const sellPrice = (refPrice * (1 + CONFIG.spreadPercent)).toFixed(6);

      console.log(`Ref: ${refPrice}, Buy: ${buyPrice}, Sell: ${sellPrice}`);

      // Build type-safe actions using factory functions
      const actions = [];

      // Cancel stale orders (if they haven't been filled)
      if (activeBuyId) {
        actions.push(cancelOrderAction(activeBuyId));
      }
      if (activeSellId) {
        actions.push(cancelOrderAction(activeSellId));
      }

      // Settle balance
      actions.push(settleBalanceAction());

      // Place new orders (string prices are auto-scaled by the SDK)
      actions.push(createOrderAction("buy", buyPrice, CONFIG.orderQuantity, "Spot"));
      actions.push(createOrderAction("sell", sellPrice, CONFIG.orderQuantity, "Spot"));

      // Submit batch — market resolution and accounts registry handled internally
      const marketActionGroups: MarketActionGroup[] = [{ market: CONFIG.marketPair, actions }];

      const result = await client.batchActions(marketActionGroups, true);

      console.log(`TX: ${result.txId}`);

      // Track new order IDs
      activeBuyId = null;
      activeSellId = null;

      if (result.orders) {
        for (const order of result.orders) {
          if (order.side === "buy") {
            activeBuyId = order.order_id;
            console.log(`New buy order: ${order.order_id}`);
          } else {
            activeSellId = order.order_id;
            console.log(`New sell order: ${order.order_id}`);
          }
        }
      }
    } catch (error) {
      if (error instanceof O2Error) {
        console.error(`O2 Error: ${error.message} (code: ${error.code})`);

        // If a cancel failed (order already filled), remove stale IDs and retry
        if (error.reason?.includes("OrderNotActive")) {
          activeBuyId = null;
          activeSellId = null;
          console.log("Cleared stale order IDs, retrying next cycle...");
        }

        // Refresh nonce on any error
        await client.refreshNonce();
      } else {
        console.error("Unexpected error:", error);
      }
    }

    await sleep(CONFIG.cycleIntervalMs);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
