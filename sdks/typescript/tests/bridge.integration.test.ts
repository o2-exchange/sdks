/**
 * Read-only integration test for the deployed Fast Bridge testnet proxy.
 *
 * Run with: O2_INTEGRATION=1 npx vitest run tests/bridge.integration.test.ts
 */

import { describe, expect, it } from "vitest";
import { FAST_BRIDGE_TESTNET_URL, FastBridgeClient } from "../src/index.js";

const INTEGRATION = process.env.O2_INTEGRATION === "1";
const UNKNOWN_TRANSACTION_ID = `0x${"00".repeat(32)}`;

describe.skipIf(!INTEGRATION)("live Fast Bridge testnet proxy", () => {
  it("reads every GET endpoint through the SDK", async () => {
    const client = new FastBridgeClient({ baseUrl: FAST_BRIDGE_TESTNET_URL });

    const info = await client.getInfo();
    expect(info.environment).toBe("testnet");
    expect(info.apiVersion).toMatch(/^1\./);
    expect(info.chains.length).toBeGreaterThan(0);

    const assets = await client.getAssets();
    expect(assets.assets.length).toBeGreaterThan(0);

    const selected = assets.assets
      .flatMap((asset) => asset.routes.map((route) => ({ asset, route })))
      .find(({ route }) => info.chains.some((chain) => chain.chainId === route.chainId));
    if (!selected) throw new Error("Testnet proxy returned no asset on a configured chain");

    const { asset, route } = selected;
    const chain = info.chains.find(({ chainId }) => chainId === route.chainId);
    if (!chain) throw new Error("Selected asset route is missing from /v1/info");

    const filteredAssets = await client.getAssets(route.chainId);
    expect(
      filteredAssets.assets.some(
        (candidate) =>
          candidate.assetId === asset.assetId &&
          candidate.routes.some(({ chainId }) => chainId === route.chainId),
      ),
    ).toBe(true);

    const deposit = await client.getDepositInfo(route.chainId, asset.assetId);
    expect(deposit.sourceChainId).toBe(route.chainId);
    expect(deposit.messengerAddress).toBe(chain.messengerAddress);
    expect(deposit.assets.map(({ assetId }) => assetId)).toContain(asset.assetId);

    const withdraw = await client.getWithdrawInfo(route.chainId, asset.assetId);
    expect(withdraw.destinationChainId).toBe(route.chainId);
    expect(withdraw.messengerAddress).toBe(chain.messengerAddress);
    expect(withdraw.outpostAddress).toBe(chain.outpostAddress);
    expect(withdraw.assets.map(({ assetId }) => assetId)).toContain(asset.assetId);

    const fee = await client.getWithdrawFee(route.chainId, asset.assetId);
    expect(fee.destinationChainId).toBe(route.chainId);
    expect(fee.assetId).toBe(asset.assetId);
    expect(BigInt(fee.fee)).toBeGreaterThanOrEqual(0n);

    await expect(
      client.getDepositStatus(route.chainId, UNKNOWN_TRANSACTION_ID),
    ).rejects.toMatchObject({ status: 404, bridgeCode: "TRANSACTION_NOT_FOUND" });
    await expect(client.getWithdrawStatus(UNKNOWN_TRANSACTION_ID)).rejects.toMatchObject({
      status: 404,
      bridgeCode: "TRANSACTION_NOT_FOUND",
    });
  });
});
