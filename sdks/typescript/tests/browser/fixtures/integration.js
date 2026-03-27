const status = document.getElementById("status");

function setStatus(state, text) {
  status.dataset.status = state;
  status.textContent = text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minQuantityStr(market, priceStr) {
  const minOrder = Number(market.min_order);
  const quoteFactor = 10 ** market.quote.decimals;
  const baseFactor = 10 ** market.base.decimals;
  const price = Number.parseFloat(priceStr);
  const minQty = minOrder / (price * quoteFactor);
  const truncateFactor = 10 ** (market.base.decimals - market.base.max_precision);
  const step = truncateFactor / baseFactor;
  const rounded = Math.ceil(minQty / step) * step;
  const withMargin = rounded * 1.1;
  return withMargin.toFixed(market.base.max_precision);
}

async function ensureFunded(client, wallet, tradeAccountId, symbol, minBalance) {
  let attempts = 0;
  while (attempts < 5) {
    const balances = await client.getBalances(tradeAccountId);
    const balance = balances[symbol]?.trading_account_balance ?? 0n;
    if (balance >= minBalance) return balance;

    try {
      await client.topUpFromFaucet(wallet);
    } catch {
      // Faucet cooldown or temporary error; retry after delay.
    }
    attempts++;
    await sleep(8_000);
  }
  const balances = await client.getBalances(tradeAccountId);
  return balances[symbol]?.trading_account_balance ?? 0n;
}

async function firstStreamMessage(stream, timeoutMs) {
  return Promise.race([
    (async () => {
      for await (const update of stream) {
        return update;
      }
      throw new Error("stream ended without messages");
    })(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("stream timeout")), timeoutMs);
    }),
  ]);
}

try {
  const sdk = await import("/dist/index.js");
  const client = new sdk.O2Client({ network: sdk.Network.TESTNET });
  const wallet = sdk.O2Client.generateWallet();

  const { tradeAccountId } = await client.setupAccount(wallet);
  const markets = await client.getMarkets();
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error("no markets available");
  }
  const market = markets[0];
  const pair = `${market.base.symbol}/${market.quote.symbol}`;

  await ensureFunded(client, wallet, tradeAccountId, market.quote.symbol, 50_000_000n);
  await client.createSession(wallet, [market], 30);

  const depth = await client.getDepth(market, 10);
  if (!depth || !Array.isArray(depth.buys) || !Array.isArray(depth.sells)) {
    throw new Error("depth fetch failed");
  }

  const depthStream = await client.streamDepth(market, 10);
  await firstStreamMessage(depthStream, 30_000);

  const priceStr = `0.${"0".repeat(market.quote.max_precision - 1)}1`;
  const quantityStr = minQuantityStr(market, priceStr);

  const orderResult = await client.createOrder(market, "buy", priceStr, quantityStr, {
    orderType: "PostOnly",
    settleFirst: false,
    collectOrders: true,
  });
  if (!orderResult.txId) {
    throw new Error("createOrder did not return txId");
  }

  const order = orderResult.orders?.[0];
  if (order?.order_id) {
    try {
      await client.cancelOrder(order.order_id, market);
    } catch {
      // It may already be closed/filled.
    }
  }

  client.close();
  setStatus("ok", `ok: pair=${pair} tx=${orderResult.txId}`);
} catch (error) {
  setStatus("error", String(error));
}
