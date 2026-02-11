/**
 * O2 Exchange SDK - Portfolio Monitoring Example
 *
 * Balance and order monitoring:
 * - Streams balances and orders via WebSocket
 * - Displays formatted portfolio state
 * - Shows trade history
 *
 * Run: npx tsx examples/portfolio.ts
 */

import { type BalanceResponse, type Market, Network, O2Client } from "../src/index.js";

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const client = new O2Client({ network: Network.TESTNET });

  // Setup
  const wallet = client.generateWallet();
  console.log(`Wallet: ${wallet.b256Address}`);

  const { tradeAccountId } = await client.setupAccount(wallet);
  console.log(`Trade account: ${tradeAccountId}`);

  await sleep(3000);

  // Fetch markets for symbol mapping
  const markets = await client.getMarkets();
  console.log(`Markets: ${markets.map((m) => `${m.base.symbol}/${m.quote.symbol}`).join(", ")}`);

  // Display initial balances
  console.log("\n=== Portfolio Balances ===");
  const balances = await client.getBalances(tradeAccountId);
  for (const [symbol, balance] of Object.entries(balances)) {
    displayBalance(symbol, balance, markets);
  }

  // Display open orders
  console.log("\n=== Open Orders ===");
  for (const market of markets) {
    try {
      const orders = await client.getOrders(tradeAccountId, market, true, 50);
      if (orders.length > 0) {
        console.log(`\n${market.base.symbol}/${market.quote.symbol}:`);
        for (const order of orders) {
          const price = Number(order.price) / 10 ** market.quote.decimals;
          const qty = Number(order.quantity) / 10 ** market.base.decimals;
          const filled = order.quantity_fill
            ? Number(order.quantity_fill) / 10 ** market.base.decimals
            : 0;
          console.log(
            `  ${order.side} ${qty.toFixed(3)} @ ${price.toFixed(6)} ` +
              `(filled: ${filled.toFixed(3)}) [${order.order_id.slice(0, 10)}...]`,
          );
        }
      }
    } catch {
      // Skip markets with no orders
    }
  }

  // Stream balance updates
  console.log("\n=== Streaming Balance Updates ===");
  const balanceStream = await client.streamBalances(tradeAccountId);

  for await (const update of balanceStream) {
    console.log(`\n--- Balance Update (${new Date().toISOString()}) ---`);
    for (const entry of update.balance) {
      const symbol = findSymbol(entry.asset_id, markets) ?? entry.asset_id.slice(0, 10);
      const tradingBalance = Number(entry.trading_account_balance) / 10 ** 9;
      const locked = Number(entry.total_locked) / 10 ** 9;
      const unlocked = Number(entry.total_unlocked) / 10 ** 9;

      console.log(
        `  ${symbol}: available=${tradingBalance.toFixed(3)}, ` +
          `locked=${locked.toFixed(3)}, unlocked=${unlocked.toFixed(3)}`,
      );
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function displayBalance(symbol: string, balance: BalanceResponse, markets: Market[]) {
  const decimals = findDecimals(symbol, markets) ?? 9;
  const trading = Number(balance.trading_account_balance) / 10 ** decimals;
  const locked = Number(balance.total_locked) / 10 ** decimals;
  const unlocked = Number(balance.total_unlocked) / 10 ** decimals;
  const total = trading + locked + unlocked;

  if (total > 0) {
    console.log(
      `  ${symbol.padEnd(8)} | ` +
        `Available: ${trading.toFixed(3).padStart(12)} | ` +
        `Locked: ${locked.toFixed(3).padStart(12)} | ` +
        `Unlocked: ${unlocked.toFixed(3).padStart(12)} | ` +
        `Total: ${total.toFixed(3).padStart(12)}`,
    );
  }
}

function findDecimals(symbol: string, markets: Market[]): number | undefined {
  for (const m of markets) {
    if (m.base.symbol === symbol) return m.base.decimals;
    if (m.quote.symbol === symbol) return m.quote.decimals;
  }
  return undefined;
}

function findSymbol(assetId: string, markets: Market[]): string | undefined {
  for (const m of markets) {
    if (m.base.asset === assetId) return m.base.symbol;
    if (m.quote.asset === assetId) return m.quote.symbol;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
