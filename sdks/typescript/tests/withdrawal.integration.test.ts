import { describe, expect, it } from "vitest";
import { Network, O2Client } from "../src/index.js";
import type { AssetId, TradeAccountId } from "../src/models.js";

const INTEGRATION = process.env.O2_INTEGRATION === "1";

async function waitForBalance(
  client: O2Client,
  tradeAccountId: TradeAccountId,
  assetId: AssetId,
): Promise<bigint> {
  for (let attempt = 0; attempt < 24; attempt++) {
    const balance = await client.api.getBalance(assetId, { contract: tradeAccountId });
    if (balance.trading_account_balance >= 2n) return balance.trading_account_balance;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Testnet faucet balance did not arrive within 120 seconds");
}

async function waitForNonce(
  client: O2Client,
  tradeAccountId: TradeAccountId,
  previous: bigint,
): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt++) {
    if ((await client.getNonce(tradeAccountId)) > previous) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Testnet account nonce did not advance within 120 seconds");
}

describe.skipIf(!INTEGRATION)("live testnet withdrawals", () => {
  it("withdraws to an address and ContractId", async () => {
    const sourceClient = new O2Client({ network: Network.TESTNET });
    const recipientClient = new O2Client({ network: Network.TESTNET });
    try {
      const sourceWallet = O2Client.generateWallet();
      const source = await sourceClient.setupAccount(sourceWallet);

      const recipientWallet = O2Client.generateWallet();
      const recipient = await recipientClient.api.createAccount({
        Address: recipientWallet.b256Address,
      });

      const markets = await sourceClient.getMarkets();
      const asset = markets
        .flatMap((market) => [market.base, market.quote])
        .find((candidate) => candidate.symbol === "fUSDC");
      if (!asset) throw new Error("fUSDC is not configured on testnet");

      const before = await waitForBalance(sourceClient, source.tradeAccountId, asset.asset);
      const nonceBefore = await sourceClient.getNonce(source.tradeAccountId);

      const addressResult = await sourceClient.withdraw(
        sourceWallet,
        asset.asset,
        1n,
        sourceWallet.b256Address,
      );
      expect(addressResult.tx_id).toBeTruthy();
      await waitForNonce(sourceClient, source.tradeAccountId, nonceBefore);

      const contractResult = await sourceClient.withdraw(sourceWallet, asset.asset, 1n, {
        ContractId: recipient.trade_account_id,
      });
      expect(contractResult.tx_id).toBeTruthy();

      const after = await sourceClient.api.getBalance(asset.asset, {
        contract: source.tradeAccountId,
      });
      expect(after.trading_account_balance).toBe(before - 2n);
    } finally {
      sourceClient.close();
      recipientClient.close();
    }
  }, 180_000);
});
