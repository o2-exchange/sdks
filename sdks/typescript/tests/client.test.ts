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
    symbol: "fFUEL",
    asset: BASE_ASSET_ID,
    decimals: 9,
    max_precision: 9,
  },
  quote: {
    symbol: "fUSDC",
    asset: QUOTE_ASSET_ID,
    decimals: 9,
    max_precision: 9,
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
});
