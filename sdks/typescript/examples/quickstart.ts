/**
 * O2 Exchange SDK - Quickstart Example
 *
 * Minimal end-to-end flow:
 * 1. Generate wallet
 * 2. Create account & fund via faucet
 * 3. Create trading session
 * 4. Place a spot buy order
 * 5. Check order status
 * 6. Cancel order
 *
 * Run: npx tsx examples/quickstart.ts
 */

import { formatPrice, formatQuantity, Network, O2Client } from "@o2exchange/sdk";

async function main() {
  // Initialize client (default: testnet)
  const client = new O2Client({ network: Network.TESTNET });

  // 1. Generate a new Fuel wallet (static method — no client instance needed)
  const wallet = O2Client.generateWallet();
  console.log(`Wallet address: ${wallet.b256Address}`);

  // 2. Setup account (create, fund, whitelist — idempotent)
  console.log("Setting up account...");
  const { tradeAccountId, nonce } = await client.setupAccount(wallet);
  console.log(`Trade account: ${tradeAccountId}`);
  console.log(`Current nonce: ${nonce}`);

  // Wait for faucet to process
  await sleep(3000);

  // 3. Fetch available markets
  const markets = await client.getMarkets();
  console.log(
    `Available markets: ${markets.map((m) => `${m.base.symbol}/${m.quote.symbol}`).join(", ")}`,
  );

  const market = markets[0];
  const pair = `${market.base.symbol}/${market.quote.symbol}`;
  console.log(`Trading on: ${pair}`);

  // 4. Create a trading session (stored on client, tradeAccountId resolved from wallet)
  console.log("Creating session...");
  await client.createSession(
    wallet,
    [pair],
    30, // 30-day expiry
  );
  console.log(`Session address: ${client.session!.sessionAddress}`);

  // 5. Check depth to find a reasonable price
  const depth = await client.getDepth(pair, 10);
  console.log(`Order book: ${depth.buys.length} bids, ${depth.sells.length} asks`);

  // 6. Place a spot buy order at a low price (string = human-readable, auto-scaled)
  const buyPrice = "0.001"; // Very low to avoid immediate fill
  const buyQuantity = "10.0";

  console.log(
    `Placing buy order: ${buyQuantity} ${market.base.symbol} @ ${buyPrice} ${market.quote.symbol}`,
  );

  try {
    const response = await client.createOrder(pair, "buy", buyPrice, buyQuantity);

    console.log(`Transaction: ${response.txId}`);
    if (response.success && response.orders && response.orders.length > 0) {
      const order = response.orders[0];
      console.log(`Order ID: ${order.order_id}`);
      console.log(
        `Side: ${order.side}, Price: ${formatPrice(market, order.price)}, Qty: ${formatQuantity(market, order.quantity)}`,
      );

      // 7. Check order status
      await sleep(2000);
      const orderStatus = await client.getOrder(pair, order.order_id);
      console.log(`Order status: close=${orderStatus.close}, cancel=${orderStatus.cancel}`);

      // 8. Cancel the order (session nonce is updated in-place)
      console.log("Cancelling order...");
      const cancelResult = await client.cancelOrder(order.order_id, pair);
      console.log(`Cancel tx: ${cancelResult.txId}`);
    }
  } catch (error) {
    console.error("Order failed:", error);
  }

  // Cleanup
  client.close();
  console.log("Done!");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
