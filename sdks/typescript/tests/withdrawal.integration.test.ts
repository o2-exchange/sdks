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
  throw new Error("Devnet faucet balance did not arrive within 120 seconds");
}

describe.skipIf(!INTEGRATION)("live devnet withdrawals", () => {
  it("withdraws to an address and ContractId", async () => {
    const sourceClient = new O2Client({ network: Network.DEVNET });
    const recipientClient = new O2Client({ network: Network.DEVNET });
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
        .find((candidate) => candidate.symbol === "USDC");
      if (!asset) throw new Error("USDC is not configured on devnet");

      const before = await waitForBalance(sourceClient, source.tradeAccountId, asset.asset);

      const addressResult = await sourceClient.withdraw(
        sourceWallet,
        asset.asset,
        1n,
        sourceWallet.b256Address,
      );
      expect(addressResult.tx_id).toBeTruthy();

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
