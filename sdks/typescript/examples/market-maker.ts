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
  type ActionPayload,
  type Market,
  type MarketActions,
  Network,
  O2Client,
  O2Error,
} from "../src/index.js";

// ── Configuration ─────────────────────────────────────────────────

const CONFIG = {
  network: Network.TESTNET,
  marketPair: "fFUEL/fUSDC", // Adjust to match your testnet market
  spreadPercent: 0.02, // 2% spread
  orderQuantity: 100.0, // Base quantity per side
  cycleIntervalMs: 10000, // 10 seconds between cycles
  referencePrice: 0.025, // Fallback reference price
};

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const client = new O2Client({ network: CONFIG.network });

  // Setup wallet and account
  const wallet = client.generateWallet();
  console.log(`Wallet: ${wallet.b256Address}`);

  const { tradeAccountId } = await client.setupAccount(wallet);
  console.log(`Trade account: ${tradeAccountId}`);

  // Wait for faucet
  await sleep(3000);

  // Fetch markets
  const markets = await client.getMarkets();
  const market = findMarket(markets, CONFIG.marketPair);
  console.log(`Trading: ${market.base.symbol}/${market.quote.symbol}`);

  // Create session
  const session = await client.createSession(wallet, tradeAccountId, [market], 30);
  console.log(`Session: ${session.sessionAddress}`);

  // Subscribe to order updates for fill detection
  let activeBuyId: string | null = null;
  let activeSellId: string | null = null;

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

      // Calculate spread prices
      const buyPrice = refPrice * (1 - CONFIG.spreadPercent);
      const sellPrice = refPrice * (1 + CONFIG.spreadPercent);

      console.log(`Ref: ${refPrice}, Buy: ${buyPrice.toFixed(6)}, Sell: ${sellPrice.toFixed(6)}`);

      // Build actions (max 5 per batch)
      const actions: ActionPayload[] = [];

      // Cancel stale orders (if they haven't been filled)
      if (activeBuyId) {
        actions.push({ CancelOrder: { order_id: activeBuyId } });
      }
      if (activeSellId) {
        actions.push({ CancelOrder: { order_id: activeSellId } });
      }

      // Settle balance
      actions.push({
        SettleBalance: { to: { ContractId: tradeAccountId } },
      });

      // Place new orders
      const buyPriceScaled = scalePriceStr(
        buyPrice,
        market.quote.decimals,
        market.quote.max_precision,
      );
      const sellPriceScaled = scalePriceStr(
        sellPrice,
        market.quote.decimals,
        market.quote.max_precision,
      );
      const quantityScaled = scaleQuantityStr(
        CONFIG.orderQuantity,
        market.base.decimals,
        market.base.max_precision,
      );

      actions.push({
        CreateOrder: {
          side: "Buy",
          price: buyPriceScaled,
          quantity: quantityScaled,
          order_type: "Spot",
        },
      });

      actions.push({
        CreateOrder: {
          side: "Sell",
          price: sellPriceScaled,
          quantity: quantityScaled,
          order_type: "Spot",
        },
      });

      // Submit batch
      const marketActions: MarketActions[] = [{ market_id: market.market_id, actions }];

      const result = await client.batchActions(
        session,
        marketActions,
        market,
        (await client.api.getMarkets()).accounts_registry_id,
        true, // collect_orders
      );

      console.log(`TX: ${result.tx_id}`);

      // Track new order IDs
      activeBuyId = null;
      activeSellId = null;

      if (result.orders) {
        for (const order of result.orders) {
          if (order.side === "Buy") {
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
        await client.refreshNonce(session);
      } else {
        console.error("Unexpected error:", error);
      }
    }

    await sleep(CONFIG.cycleIntervalMs);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function findMarket(markets: Market[], pair: string): Market {
  const [base, quote] = pair.split("/");
  const found = markets.find(
    (m) =>
      m.base.symbol.toLowerCase() === base.toLowerCase() &&
      m.quote.symbol.toLowerCase() === quote.toLowerCase(),
  );
  if (!found) {
    console.log(
      `Available: ${markets.map((m) => `${m.base.symbol}/${m.quote.symbol}`).join(", ")}`,
    );
    // Fallback to first market
    return markets[0];
  }
  return found;
}

function scalePriceStr(price: number, decimals: number, maxPrecision: number): string {
  const scaled = BigInt(Math.floor(price * 10 ** decimals));
  const factor = BigInt(10 ** (decimals - maxPrecision));
  return ((scaled / factor) * factor).toString();
}

function scaleQuantityStr(qty: number, decimals: number, maxPrecision: number): string {
  const scaled = BigInt(Math.ceil(qty * 10 ** decimals));
  const factor = BigInt(10 ** (decimals - maxPrecision));
  const remainder = scaled % factor;
  if (remainder === 0n) return scaled.toString();
  return (scaled + (factor - remainder)).toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
