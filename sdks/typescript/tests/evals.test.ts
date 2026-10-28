import { afterEach, describe, expect, it, vi } from "vitest";
import { rawSign } from "../src/crypto.js";
import {
  buildActionsSigningBytes,
  buildEvalPurchaseCall,
  bytesToHex,
  GAS_MAX,
  hexToBytes,
} from "../src/encoding.js";
import { EVAL, getNetworkConfig, Network, O2Api, O2Client } from "../src/index.js";
import {
  assetId,
  contractId,
  type MarketsResponse,
  SessionActionsResponse,
  type SessionState,
  tradeAccountId,
  txId,
} from "../src/models.js";

const SHOP = contractId(`0x${"ab".repeat(32)}`);
const PAYMENT_ASSET = assetId(`0x${"22".repeat(32)}`);
const ACCOUNT = tradeAccountId(`0x${"33".repeat(32)}`);
const OWNER = `0x${"44".repeat(32)}`;
const CATALOG: MarketsResponse = {
  books_registry_id: contractId(`0x${"55".repeat(32)}`),
  accounts_registry_id: contractId(`0x${"66".repeat(32)}`),
  trade_account_oracle_id: contractId(`0x${"77".repeat(32)}`),
  chain_id: "0x0",
  base_asset_id: PAYMENT_ASSET,
  markets: [],
  eval_shop_id: SHOP,
};

function session(): SessionState {
  return {
    ownerAddress: OWNER,
    tradeAccountId: ACCOUNT,
    sessionPrivateKey: new Uint8Array(32).fill(1),
    sessionAddress: `0x${"88".repeat(32)}`,
    contractIds: [SHOP],
    expiry: Math.floor(Date.now() / 1000) + 3600,
    nonce: 7n,
  };
}

function makeClient(catalog: Partial<MarketsResponse> = {}, activeSession = session()) {
  const client = new O2Client({ network: Network.MAINNET });
  client.setSession(activeSession);
  vi.spyOn(client.api, "getMarkets").mockResolvedValue({ ...CATALOG, ...catalog });
  const response = new SessionActionsResponse(
    txId(`0x${"99".repeat(32)}`),
    null,
    null,
    null,
    null,
    null,
  );
  const submit = vi.spyOn(client.api, "submitActions").mockResolvedValue(response);
  return { client, submit, response, activeSession };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("evaluation purchases", () => {
  it("encodes the shop's buy_account(u64) call and forwards the exact payment", () => {
    const call = buildEvalPurchaseCall(SHOP, 20n, PAYMENT_ASSET, 9_007_199_254_740_993n);
    expect(bytesToHex(call.functionSelector)).toBe("0x000000000000000b6275795f6163636f756e74");
    expect(bytesToHex(call.callData!)).toBe("0x0000000000000014");
    expect(call.contractId).toEqual(hexToBytes(SHOP));
    expect(call.assetId).toEqual(hexToBytes(PAYMENT_ASSET));
    expect(call.amount).toBe(9_007_199_254_740_993n);
    expect(call.gas).toBe(GAS_MAX);
  });

  it.each([
    [-1n, 1n],
    [1n << 64n, 1n],
    [1n, -1n],
    [1n, 1n << 64n],
  ])("rejects amounts or tier IDs outside u64", (tier, amount) => {
    expect(() => buildEvalPurchaseCall(SHOP, tier, PAYMENT_ASSET, amount)).toThrow("64-bit");
  });

  it("rejects malformed contract and asset IDs before signing", () => {
    expect(() => buildEvalPurchaseCall("0x123", 1n, PAYMENT_ASSET, 1n)).toThrow("shopId");
    expect(() => buildEvalPurchaseCall(SHOP, 1n, "0xgg", 1n)).toThrow("assetId");
  });

  it("signs a purchase without a market ID, matching the API", async () => {
    const { client, submit, response, activeSession } = makeClient();
    const amount = 9_007_199_254_740_993n;
    await expect(client.buyEvalAccount(20n, PAYMENT_ASSET, amount)).resolves.toBe(response);
    expect(submit).toHaveBeenCalledOnce();
    const [owner, request] = submit.mock.calls[0];
    expect(owner).toBe(OWNER);
    expect(request.actions).toEqual([
      {
        actions: [
          {
            BuyEvalAccount: {
              tier_id: "20",
              asset_id: PAYMENT_ASSET,
              amount: amount.toString(),
            },
          },
        ],
      },
    ]);
    expect(request.trade_account_id).toBe(ACCOUNT);
    expect(request.nonce).toBe("7");
    expect(request.collect_orders).toBe(false);
    const expectedBytes = buildActionsSigningBytes(7n, [
      {
        contractId: hexToBytes(SHOP),
        functionSelector: hexToBytes("0x000000000000000b6275795f6163636f756e74"),
        callData: hexToBytes("0x0000000000000014"),
        amount,
        assetId: hexToBytes(PAYMENT_ASSET),
        gas: GAS_MAX,
      },
    ]);
    expect(request.signature).toEqual({
      Secp256k1: bytesToHex(rawSign(activeSession.sessionPrivateKey, expectedBytes)),
    });
    expect(activeSession.nonce).toBe(8n);
    client.close();
  });

  it.each([
    null,
    undefined,
    contractId(`0x${"00".repeat(32)}`),
  ])("rejects unavailable shops", async (shop) => {
    const { client, submit } = makeClient({ eval_shop_id: shop });
    await expect(client.buyEvalAccount(1n, PAYMENT_ASSET, 1n)).rejects.toThrow("unavailable");
    expect(submit).not.toHaveBeenCalled();
    client.close();
  });

  it("requires the session to include the shop", async () => {
    const { client, submit } = makeClient({}, { ...session(), contractIds: [] });
    await expect(client.buyEvalAccount(1n, PAYMENT_ASSET, 1n)).rejects.toThrow("extraContractIds");
    expect(submit).not.toHaveBeenCalled();
    client.close();
  });

  it("accepts explicit sessions and shop IDs with mixed casing", async () => {
    const { client, submit } = makeClient();
    const explicit = {
      ...session(),
      contractIds: [contractId(`0x${"AB".repeat(32)}`)],
      nonce: 19n,
    };
    await client.buyEvalAccount(1n, PAYMENT_ASSET, 1n, explicit);
    expect(submit.mock.calls[0][1].nonce).toBe("19");
    expect(explicit.nonce).toBe(20n);
    client.close();
  });

  it("does not submit an expired session", async () => {
    const { client, submit } = makeClient({}, { ...session(), expiry: 1 });
    await expect(client.buyEvalAccount(1n, PAYMENT_ASSET, 1n)).rejects.toThrow("expired");
    expect(submit).not.toHaveBeenCalled();
    client.close();
  });

  it("does not retry a purchase when the connection fails", async () => {
    const { client, submit } = makeClient();
    submit.mockRestore();
    const fetch = vi.fn().mockRejectedValue(new TypeError("connection reset after submit"));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(client.api, "getAccount").mockRejectedValue(new Error("unavailable"));
    await expect(client.buyEvalAccount(1n, PAYMENT_ASSET, 1n)).rejects.toThrow("connection reset");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("https://api.o2.app/v1/session/actions");
    client.close();
  });

  it("uses extraContractIds to create a purchase-only session", async () => {
    const client = new O2Client({ network: Network.MAINNET });
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(CATALOG);
    vi.spyOn(client.api, "getAccount").mockResolvedValue({
      trade_account_id: ACCOUNT,
      trade_account: { last_modification: 0, nonce: 3n, owner: { Address: OWNER } },
      session: null,
    });
    const create = vi.spyOn(client.api, "createSession").mockResolvedValue({} as never);
    const activeSession = await client.createSession(
      {
        b256Address: OWNER,
        personalSign: () => new Uint8Array(64),
      },
      [],
      { extraContractIds: [SHOP] },
    );
    expect(activeSession.contractIds).toEqual([SHOP]);
    expect(create.mock.calls[0][1].contract_ids).toEqual([SHOP]);
    client.close();
  });
});

describe("evaluation discovery", () => {
  it.each([SHOP, null, undefined])("preserves the shop ID, null or missing value", async (shop) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...CATALOG, eval_shop_id: shop }))),
    );
    const api = new O2Api({ config: EVAL });
    expect((await api.getMarkets()).eval_shop_id).toBe(shop);
  });

  it.each([
    { eval_profit_target_bps: "900", daily_loss_limit_bps: "300" },
    { eval_profit_target_bps: "0", daily_loss_limit_bps: "0" },
    { eval_profit_target_bps: null, daily_loss_limit_bps: null },
    {},
  ])("preserves tier policies, including null, zero and missing values", async (policy) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ tiers: [{ tier_id: 1, version: 1, ...policy }] })),
        ),
    );
    const api = new O2Api({ config: EVAL });
    const [tier] = await api.getMarginTiers();
    expect(tier.eval_profit_target_bps).toBe(policy.eval_profit_target_bps);
    expect(tier.daily_loss_limit_bps).toBe(policy.daily_loss_limit_bps);
  });

  it("connects to the eval API on Fuel testnet without a faucet", () => {
    expect(getNetworkConfig(Network.EVAL)).toBe(EVAL);
    expect(EVAL.apiBase).toBe("https://api.eval.o2.app");
    expect(EVAL.wsUrl).toBe("wss://api.eval.o2.app/v1/ws");
    expect(EVAL.fuelRpc).toBe("https://testnet.fuel.network/v1/graphql");
    expect(EVAL.faucetUrl).toBeNull();
  });
});
