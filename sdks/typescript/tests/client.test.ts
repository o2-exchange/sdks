import { describe, expect, it, vi } from "vitest";
import type { Signer } from "../src/crypto.js";
import { Network, O2Client } from "../src/index.js";
import {
  type AccountInfo,
  assetId,
  contractId,
  type Market,
  type MarketsResponse,
  marketId,
  tradeAccountId,
} from "../src/models.js";

const OWNER = `0x${"11".repeat(32)}`;
const TRADE_ACCOUNT_ID = tradeAccountId(`0x${"22".repeat(32)}`);
const MARKET_ID = marketId(`0x${"33".repeat(32)}`);
const MARKET_CONTRACT_ID = contractId(`0x${"44".repeat(32)}`);
const BASE_ASSET_ID = assetId(`0x${"55".repeat(32)}`);
const QUOTE_ASSET_ID = assetId(`0x${"66".repeat(32)}`);
const DESTINATION = `0x${"77".repeat(32)}`;

const MARKET: Market = {
  contract_id: MARKET_CONTRACT_ID,
  market_id: MARKET_ID,
  maker_fee: 0n,
  taker_fee: 0n,
  min_order: 1n,
  dust: 0n,
  price_window: 0,
  base: {
    symbol: "FUEL",
    asset: BASE_ASSET_ID,
    decimals: 9,
    max_precision: 9,
  },
  quote: {
    symbol: "USDC",
    asset: QUOTE_ASSET_ID,
    decimals: 9,
    max_precision: 9,
  },
};

const LOW_PRECISION_MARKET: Market = {
  ...MARKET,
  market_id: marketId(`0x${"ab".repeat(32)}`),
  base: {
    ...MARKET.base,
    max_precision: 3,
  },
  quote: {
    ...MARKET.quote,
    max_precision: 3,
  },
};

const MARKETS_RESPONSE: MarketsResponse = {
  books_registry_id: contractId(`0x${"88".repeat(32)}`),
  accounts_registry_id: contractId(`0x${"99".repeat(32)}`),
  trade_account_oracle_id: contractId(`0x${"aa".repeat(32)}`),
  chain_id: "0x0",
  base_asset_id: BASE_ASSET_ID,
  markets: [MARKET],
};

const LOW_PRECISION_MARKETS_RESPONSE: MarketsResponse = {
  ...MARKETS_RESPONSE,
  markets: [LOW_PRECISION_MARKET],
};

function decodeNonceFromSigningBytes(bytes: Uint8Array): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(0, false);
}

function makeSigner() {
  const personalSign = vi.fn((message: Uint8Array) => {
    void message;
    return new Uint8Array(64);
  });
  const signer: Signer = {
    b256Address: OWNER,
    personalSign,
  };
  return { signer, personalSign };
}

function makeSession() {
  return {
    ownerAddress: OWNER,
    tradeAccountId: TRADE_ACCOUNT_ID,
    sessionPrivateKey: new Uint8Array(32).fill(1),
    sessionAddress: `0x${"12".repeat(32)}`,
    contractIds: [MARKET_CONTRACT_ID],
    expiry: Math.floor(Date.now() / 1000) + 3600,
    nonce: 1n,
  };
}

describe("O2Client nonce sourcing", () => {
  it("createSession fetches nonce by tradeAccountId when owner lookup omits trade_account", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    const { signer, personalSign } = makeSigner();

    const ownerLookup: AccountInfo = {
      trade_account_id: TRADE_ACCOUNT_ID,
      trade_account: null,
      session: null,
    };
    const nonceLookup: AccountInfo = {
      trade_account_id: TRADE_ACCOUNT_ID,
      trade_account: {
        last_modification: 0,
        nonce: 42n,
        owner: { Address: OWNER },
      },
      session: null,
    };

    const getAccountSpy = vi
      .spyOn(client.api, "getAccount")
      .mockResolvedValueOnce(ownerLookup)
      .mockResolvedValueOnce(nonceLookup);
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const createSessionSpy = vi
      .spyOn(client.api, "createSession")
      .mockResolvedValue({} as Awaited<ReturnType<typeof client.api.createSession>>);

    const session = await client.createSession(signer, [MARKET], 1);

    expect(getAccountSpy).toHaveBeenNthCalledWith(1, { owner: OWNER });
    expect(getAccountSpy).toHaveBeenNthCalledWith(2, { tradeAccountId: TRADE_ACCOUNT_ID });
    expect(createSessionSpy).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        contract_id: TRADE_ACCOUNT_ID,
        contract_ids: [MARKET_CONTRACT_ID],
        nonce: "42",
      }),
    );
    expect(personalSign).toHaveBeenCalledTimes(1);
    expect(decodeNonceFromSigningBytes(personalSign.mock.calls[0][0])).toBe(42n);
    expect(session.nonce).toBe(43n);
  });

  it("withdraw fetches nonce by tradeAccountId when owner lookup omits trade_account", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    const { signer, personalSign } = makeSigner();

    const ownerLookup: AccountInfo = {
      trade_account_id: TRADE_ACCOUNT_ID,
      trade_account: null,
      session: null,
    };
    const nonceLookup: AccountInfo = {
      trade_account_id: TRADE_ACCOUNT_ID,
      trade_account: {
        last_modification: 0,
        nonce: 99n,
        owner: { Address: OWNER },
      },
      session: null,
    };

    const getAccountSpy = vi
      .spyOn(client.api, "getAccount")
      .mockResolvedValueOnce(ownerLookup)
      .mockResolvedValueOnce(nonceLookup);
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const withdrawSpy = vi
      .spyOn(client.api, "withdraw")
      .mockResolvedValue({} as Awaited<ReturnType<typeof client.api.withdraw>>);

    await client.withdraw(signer, BASE_ASSET_ID, 123n, DESTINATION);

    expect(getAccountSpy).toHaveBeenNthCalledWith(1, { owner: OWNER });
    expect(getAccountSpy).toHaveBeenNthCalledWith(2, { tradeAccountId: TRADE_ACCOUNT_ID });
    expect(withdrawSpy).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        trade_account_id: TRADE_ACCOUNT_ID,
        nonce: "99",
        to: { Address: DESTINATION },
        asset_id: BASE_ASSET_ID,
        amount: "123",
      }),
    );
    expect(personalSign).toHaveBeenCalledTimes(1);
    expect(decodeNonceFromSigningBytes(personalSign.mock.calls[0][0])).toBe(99n);
  });

  it("withdraw resolves mixed-case asset IDs and scales string amounts", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    const { signer, personalSign } = makeSigner();

    const ownerLookup: AccountInfo = {
      trade_account_id: TRADE_ACCOUNT_ID,
      trade_account: null,
      session: null,
    };
    const nonceLookup: AccountInfo = {
      trade_account_id: TRADE_ACCOUNT_ID,
      trade_account: {
        last_modification: 0,
        nonce: 7n,
        owner: { Address: OWNER },
      },
      session: null,
    };

    vi.spyOn(client.api, "getAccount")
      .mockResolvedValueOnce(ownerLookup)
      .mockResolvedValueOnce(nonceLookup);
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const withdrawSpy = vi
      .spyOn(client.api, "withdraw")
      .mockResolvedValue({} as Awaited<ReturnType<typeof client.api.withdraw>>);

    const uppercaseAssetId = `0x${BASE_ASSET_ID.slice(2).toUpperCase()}`;
    await client.withdraw(signer, uppercaseAssetId, "1.25", DESTINATION);

    expect(withdrawSpy).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        trade_account_id: TRADE_ACCOUNT_ID,
        nonce: "7",
        to: { Address: DESTINATION },
        asset_id: BASE_ASSET_ID,
        amount: "1250000000",
      }),
    );
    expect(personalSign).toHaveBeenCalledTimes(1);
    expect(decodeNonceFromSigningBytes(personalSign.mock.calls[0][0])).toBe(7n);
  });
});

describe("O2Client bigint precision", () => {
  it("createOrder rejects bigint quantity that exceeds market max_precision", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(LOW_PRECISION_MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions");

    await expect(client.createOrder("FUEL/USDC", "buy", 100000000n, 123456789n)).rejects.toThrow(
      "Quantity must be a multiple of 1000000",
    );
    expect(submitActionsSpy).not.toHaveBeenCalled();
  });

  it("batchActions rejects bigint quantity that exceeds market max_precision", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(LOW_PRECISION_MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions");

    await expect(
      client.batchActions([
        {
          market: "FUEL/USDC",
          actions: [{ type: "createOrder", side: "buy", price: 100000000n, quantity: 123456789n }],
        },
      ]),
    ).rejects.toThrow("Quantity must be a multiple of 1000000");
    expect(submitActionsSpy).not.toHaveBeenCalled();
  });

  it("createOrder rejects bigint price that exceeds market max_precision", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(LOW_PRECISION_MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions");

    await expect(client.createOrder("FUEL/USDC", "buy", 123456789n, 123000000n)).rejects.toThrow(
      "Price must be a multiple of 1000000",
    );
    expect(submitActionsSpy).not.toHaveBeenCalled();
  });

  it("batchActions rejects bigint price that exceeds market max_precision", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(LOW_PRECISION_MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions");

    await expect(
      client.batchActions([
        {
          market: "FUEL/USDC",
          actions: [{ type: "createOrder", side: "buy", price: 123456789n, quantity: 123000000n }],
        },
      ]),
    ).rejects.toThrow("Price must be a multiple of 1000000");
    expect(submitActionsSpy).not.toHaveBeenCalled();
  });
});

describe("O2Client runtime numeric guards", () => {
  it("createOrder rejects JS number price with a controlled O2Error", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions");

    await expect(client.createOrder("FUEL/USDC", "buy", 1 as any, "1")).rejects.toThrow(
      "Invalid price type: expected string or bigint, got number",
    );
    expect(submitActionsSpy).not.toHaveBeenCalled();
  });

  it("batchActions rejects JS number action quantity with a controlled O2Error", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions");

    await expect(
      client.batchActions([
        {
          market: "FUEL/USDC",
          actions: [{ type: "createOrder", side: "buy", price: "1", quantity: 1 as any }],
        },
      ]),
    ).rejects.toThrow("Invalid action.quantity type: expected string or bigint, got number");
    expect(submitActionsSpy).not.toHaveBeenCalled();
  });

  it("createOrder rejects JS number orderType price with a controlled O2Error", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions");

    await expect(
      client.createOrder("FUEL/USDC", "buy", "1", "1", {
        orderType: {
          BoundedMarket: { max_price: 1 as any, min_price: "0" },
        },
      }),
    ).rejects.toThrow("Invalid orderType.BoundedMarket.max_price type: expected string or bigint");
    expect(submitActionsSpy).not.toHaveBeenCalled();
  });

  it("withdraw rejects JS number amount with a controlled O2Error", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    const { signer, personalSign } = makeSigner();

    const ownerLookup: AccountInfo = {
      trade_account_id: TRADE_ACCOUNT_ID,
      trade_account: null,
      session: null,
    };
    const nonceLookup: AccountInfo = {
      trade_account_id: TRADE_ACCOUNT_ID,
      trade_account: {
        last_modification: 0,
        nonce: 5n,
        owner: { Address: OWNER },
      },
      session: null,
    };

    vi.spyOn(client.api, "getAccount")
      .mockResolvedValueOnce(ownerLookup)
      .mockResolvedValueOnce(nonceLookup);
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const withdrawSpy = vi.spyOn(client.api, "withdraw");

    await expect(client.withdraw(signer, "FUEL", 1 as any)).rejects.toThrow(
      "Invalid amount type: expected string or bigint, got number",
    );
    expect(withdrawSpy).not.toHaveBeenCalled();
    expect(personalSign).not.toHaveBeenCalled();
  });
});
