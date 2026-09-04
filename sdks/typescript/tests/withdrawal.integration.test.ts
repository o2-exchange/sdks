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

/**
 * Poll until the balance settles on `expected`.
 *
 * A withdrawal is accepted well before the balance indexer reflects it, so
 * reading once after submitting races the indexer — and the race is
 * asymmetric: the read almost always wins, which is why this only ever
 * failed as "one withdrawal short" rather than flapping both ways.
 *
 * The account is freshly generated and nothing else spends from it, so
 * equality is the right assertion once it converges.
 */
async function waitForBalanceToSettle(
  client: O2Client,
  tradeAccountId: TradeAccountId,
  assetId: AssetId,
  expected: bigint,
): Promise<bigint> {
  // Polled faster and for less long than the other waits: the nonce has
  // already advanced by the time this runs, so only the balance indexer is
  // still catching up and it is normally a second or two behind.
  let latest = -1n;
  for (let attempt = 0; attempt < 30; attempt++) {
    latest = (await client.api.getBalance(assetId, { contract: tradeAccountId }))
      .trading_account_balance;
    if (latest === expected) return latest;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Balance did not settle on ${expected} within 60 seconds (last read ${latest})`);
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

      // BOTH withdrawals have to be reflected before the balance means
      // anything. The first one is sequenced by `waitForNonce` above; the
      // second was asserted immediately, so the read landed between the two
      // and reported `before - 1`.
      const after = await waitForBalanceToSettle(
        sourceClient,
        source.tradeAccountId,
        asset.asset,
        before - 2n,
      );
      expect(after).toBe(before - 2n);
    } finally {
      sourceClient.close();
      recipientClient.close();
    }
  }, 320_000);
});
