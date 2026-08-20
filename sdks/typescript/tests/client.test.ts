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
  orderId,
  tradeAccountId,
  triggerOrderId,
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
  pair: "",
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

const FRACTIONAL_PRICE_MARKET: Market = {
  ...MARKET,
  market_id: marketId(`0x${"cd".repeat(32)}`),
  min_order: 1n,
  base: {
    ...MARKET.base,
    decimals: 1,
    max_precision: 1,
  },
  quote: {
    ...MARKET.quote,
    decimals: 1,
    max_precision: 1,
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

const FRACTIONAL_PRICE_MARKETS_RESPONSE: MarketsResponse = {
  ...MARKETS_RESPONSE,
  markets: [FRACTIONAL_PRICE_MARKET],
};

function decodeNonceFromSigningBytes(bytes: Uint8Array): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(0, false);
}

function withSyncSigner() {
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

function withAsyncSigner() {
  const personalSign = vi.fn(async (message: Uint8Array) => {
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

describe("O2Client sign paths", () => {
  for (const makeSigner of [withSyncSigner, withAsyncSigner]) {
    describe(makeSigner.name, () => {
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

        it("withdraw signs and sends a ContractId destination", async () => {
          const client = new O2Client({ network: Network.TESTNET });
          const { signer, personalSign } = makeSigner();

          vi.spyOn(client.api, "getAccount")
            .mockResolvedValueOnce({
              trade_account_id: TRADE_ACCOUNT_ID,
              trade_account: null,
              session: null,
            })
            .mockResolvedValueOnce({
              trade_account_id: TRADE_ACCOUNT_ID,
              trade_account: {
                last_modification: 0,
                nonce: 3n,
                owner: { Address: OWNER },
              },
              session: null,
            });
          vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
          const withdrawSpy = vi
            .spyOn(client.api, "withdraw")
            .mockResolvedValue({} as Awaited<ReturnType<typeof client.api.withdraw>>);

          await client.withdraw(signer, BASE_ASSET_ID, 123n, { ContractId: DESTINATION });

          expect(withdrawSpy).toHaveBeenCalledWith(
            OWNER,
            expect.objectContaining({ to: { ContractId: DESTINATION } }),
          );
          const signingBytes = personalSign.mock.calls[0][0];
          expect(signingBytes.slice(32, 40)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]));
          expect(signingBytes.slice(72, 80)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 123]));
          expect(signingBytes.slice(80, 112)).toEqual(new Uint8Array(32).fill(0x55));
        });
      });

      describe("O2Client faucet top-up", () => {
        it("topUpFromFaucet resolves trade account by owner and mints to contract", async () => {
          const client = new O2Client({ network: Network.TESTNET });
          const { signer } = makeSigner();

          vi.spyOn(client.api, "getAccount").mockResolvedValue({
            trade_account_id: TRADE_ACCOUNT_ID,
            trade_account: null,
            session: null,
          });
          const mintSpy = vi.spyOn(client.api, "mintToContract").mockResolvedValue({
            message: "Minted test assets to contract",
          });

          const res = await client.topUpFromFaucet(signer);

          expect(res.error).toBeUndefined();
          expect(res.message).toBeTruthy();
          expect(mintSpy).toHaveBeenCalledWith(TRADE_ACCOUNT_ID);
        });

        it("topUpFromFaucet throws when no trade account exists for owner", async () => {
          const client = new O2Client({ network: Network.TESTNET });
          const { signer } = makeSigner();

          vi.spyOn(client.api, "getAccount").mockResolvedValue({
            trade_account_id: undefined,
            trade_account: null,
            session: null,
          } as unknown as AccountInfo);
          const mintSpy = vi.spyOn(client.api, "mintToContract");

          await expect(client.topUpFromFaucet(signer)).rejects.toThrow("Call setupAccount() first");
          expect(mintSpy).not.toHaveBeenCalled();
        });
      });

      describe("O2Client runtime numeric guards", () => {
        it("createOrder rejects JS number price with a controlled O2Error", async () => {
          const client = new O2Client({ network: Network.TESTNET });
          client.setSession(makeSession());

          vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
          const submitActionsSpy = vi.spyOn(client.api, "submitActions");

          await expect(client.createOrder("fFUEL/fUSDC", "buy", 1 as any, "1")).rejects.toThrow(
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
                market: "fFUEL/fUSDC",
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
            client.createOrder("fFUEL/fUSDC", "buy", "1", "1", {
              orderType: {
                BoundedMarket: { max_price: 1 as any, min_price: "0" },
              },
            }),
          ).rejects.toThrow(
            "Invalid orderType.BoundedMarket.max_price type: expected string or bigint",
          );
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

          await expect(client.withdraw(signer, "fFUEL", 1 as any)).rejects.toThrow(
            "Invalid amount type: expected string or bigint, got number",
          );
          expect(withdrawSpy).not.toHaveBeenCalled();
          expect(personalSign).not.toHaveBeenCalled();
        });
      });
    });
  }
});

describe("O2Client management", () => {
  it("clearSession removes the active session", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    const session = makeSession();

    client.setSession(session);
    expect(client.session).toBe(session);

    client.clearSession();
    expect(client.session).toBeNull();
    await expect(client.refreshNonce()).rejects.toThrow("No active session");
  });

  it("createOrder can use an explicit session without setting an active session", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    const session = {
      ...makeSession(),
      ownerAddress: `0x${"ab".repeat(32)}`,
      tradeAccountId: tradeAccountId(`0x${"bc".repeat(32)}`),
      sessionAddress: `0x${"cd".repeat(32)}`,
      sessionPrivateKey: new Uint8Array(32).fill(2),
      nonce: 11n,
    };

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"dd".repeat(32)}`,
    } as never);

    await expect(client.createOrder(MARKET, "buy", "1", "1", { session })).resolves.toBeTruthy();

    expect(client.session).toBeNull();
    expect(session.nonce).toBe(12n);
    expect(submitActionsSpy).toHaveBeenCalledWith(
      session.ownerAddress,
      expect.objectContaining({
        nonce: "11",
        trade_account_id: session.tradeAccountId,
        session_id: { Address: session.sessionAddress },
      }),
    );
  });

  it("batchActions accepts a Market object and explicit session", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    const session = {
      ...makeSession(),
      tradeAccountId: tradeAccountId(`0x${"de".repeat(32)}`),
      nonce: 21n,
    };

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"ef".repeat(32)}`,
    } as never);

    await expect(
      client.batchActions(
        [
          {
            market: MARKET,
            actions: [{ type: "cancelOrder", orderId: orderId(`0x${"fa".repeat(32)}`) }],
          },
        ],
        false,
        session,
      ),
    ).resolves.toBeTruthy();

    expect(session.nonce).toBe(22n);
    expect(submitActionsSpy).toHaveBeenCalledWith(
      session.ownerAddress,
      expect.objectContaining({
        actions: [
          {
            market_id: MARKET.market_id,
            actions: [{ CancelOrder: { order_id: `0x${"fa".repeat(32)}` } }],
          },
        ],
        nonce: "21",
        trade_account_id: session.tradeAccountId,
      }),
    );
  });

  it("cancelAllOrders paginates and cancels spot and standalone trigger entries", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);

    const spotIds = ["01", "02", "03", "04"].map((byte) => orderId(`0x${byte.repeat(32)}`));
    const triggerIds = ["05", "06"].map((byte) => triggerOrderId(`0x${byte.repeat(32)}`));
    const cursorId = triggerOrderId(`0x${"07".repeat(32)}`);
    const orderEntry = (id: (typeof spotIds)[number]) => ({
      kind: "order" as const,
      order_id: id,
    });
    const triggerEntry = (id: (typeof triggerIds)[number]) => ({
      kind: "trigger" as const,
      order_id: id,
    });

    const getActiveOrdersSpy = vi
      .spyOn(client.api, "getActiveOrders")
      .mockResolvedValueOnce({
        entries: [
          orderEntry(spotIds[0]!),
          triggerEntry(triggerIds[0]!),
          orderEntry(spotIds[1]!),
          orderEntry(spotIds[2]!),
          orderEntry(spotIds[3]!),
        ],
        next_timestamp: "123",
        next_id: cursorId,
        next_kind: "trigger",
      } as never)
      .mockResolvedValueOnce({
        entries: [triggerEntry(triggerIds[1]!)],
        next_timestamp: null,
        next_id: null,
        next_kind: null,
      } as never);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"bb".repeat(32)}`,
    } as never);

    const results = await client.cancelAllOrders(MARKET);

    expect(results).toHaveLength(2);
    expect(getActiveOrdersSpy).toHaveBeenNthCalledWith(
      2,
      MARKET_ID,
      expect.objectContaining({
        cursor: {
          startTimestamp: "123",
          startId: cursorId,
          startKind: "trigger",
        },
      }),
    );
    const submittedActions = submitActionsSpy.mock.calls.flatMap(
      ([, request]) => request.actions[0]!.actions,
    );
    expect(submittedActions).toEqual([
      { CancelOrder: { order_id: spotIds[0] } },
      { CancelTriggerOrder: { order_id: triggerIds[0] } },
      { CancelOrder: { order_id: spotIds[1] } },
      { CancelOrder: { order_id: spotIds[2] } },
      { CancelOrder: { order_id: spotIds[3] } },
      { CancelTriggerOrder: { order_id: triggerIds[1] } },
    ]);
  });

  it("cancelAllOrders returns null when there are no active entries", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    vi.spyOn(client.api, "getActiveOrders").mockResolvedValue({
      entries: [],
      next_timestamp: null,
      next_id: null,
      next_kind: null,
    } as never);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions");

    await expect(client.cancelAllOrders(MARKET)).resolves.toBeNull();
    expect(submitActionsSpy).not.toHaveBeenCalled();
  });
});

describe("O2Client trigger orders", () => {
  it("scales and submits a standalone trigger order", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"bb".repeat(32)}`,
    } as never);

    await client.createTriggerOrder("fFUEL/fUSDC", {
      order_type: { Spot: { price: "0.9" } },
      quantity: { Quantity: { quantity: "1.5" } },
      trigger_price: "1",
      side: "sell",
    });

    expect(submitActionsSpy).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        actions: [
          {
            market_id: MARKET.market_id,
            actions: [
              { SettleBalance: { to: { ContractId: TRADE_ACCOUNT_ID } } },
              {
                CreateTriggerOrder: {
                  args: {
                    order_type: { Spot: { price: "900000000" } },
                    quantity: { Quantity: { quantity: "1500000000" } },
                    trigger_price: "1000000000",
                    side: "Sell",
                  },
                  parent: null,
                },
              },
            ],
          },
        ],
      }),
    );
  });

  it("submits a parent-linked OCO pair with a scaled quantity snapshot", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"bb".repeat(32)}`,
    } as never);
    const parentId = orderId(`0x${"ca".repeat(32)}`);
    const quantity = { ParentOrder: { parent_order_id: parentId } };

    await client.createTriggerOrders(
      MARKET,
      { order_type: "Market", quantity, trigger_price: "0.8", side: "sell" },
      { order_type: "Market", quantity, trigger_price: "1.2", side: "sell" },
      { order_id: parentId, expected_quantity: "2" },
    );

    expect(submitActionsSpy).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            actions: expect.arrayContaining([
              {
                CreateTriggerOrders: expect.objectContaining({
                  parent: { order_id: parentId, expected_quantity: "2000000000" },
                }),
              },
            ]),
          }),
        ],
      }),
    );
  });

  it("makes the higher-priced buy leg canonical for the shared OCO lock", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"bb".repeat(32)}`,
    } as never);

    await client.createTriggerOrders(
      MARKET,
      {
        order_type: { Spot: { price: "0.9" } },
        quantity: { Quantity: { quantity: "2" } },
        trigger_price: "0.8",
        side: "buy",
      },
      {
        order_type: { MarketBounded: { max_price: "1.2", min_price: "1" } },
        quantity: { Quantity: { quantity: "2" } },
        trigger_price: "1.1",
        side: "buy",
      },
    );

    const request = submitActionsSpy.mock.calls[0]![1];
    const action = request.actions[0]!.actions[1]!;
    expect(action).toEqual({
      CreateTriggerOrders: expect.objectContaining({
        first: expect.objectContaining({
          order_type: { MarketBounded: { max_price: "1200000000", min_price: "1000000000" } },
          trigger_price: "1100000000",
        }),
        second: expect.objectContaining({
          order_type: { Spot: { price: "900000000" } },
          trigger_price: "800000000",
        }),
      }),
    });
  });

  it("makes the larger sell leg canonical for the shared OCO lock", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"bb".repeat(32)}`,
    } as never);

    await client.createTriggerOrders(
      MARKET,
      {
        order_type: "Market",
        quantity: { Quantity: { quantity: "1" } },
        trigger_price: "0.8",
        side: "sell",
      },
      {
        order_type: "Market",
        quantity: { Quantity: { quantity: "2" } },
        trigger_price: "1.2",
        side: "sell",
      },
    );

    const request = submitActionsSpy.mock.calls[0]![1];
    const action = request.actions[0]!.actions[1]!;
    expect(action).toEqual({
      CreateTriggerOrders: expect.objectContaining({
        first: expect.objectContaining({
          quantity: { Quantity: { quantity: "2000000000" } },
          trigger_price: "1200000000",
        }),
        second: expect.objectContaining({
          quantity: { Quantity: { quantity: "1000000000" } },
          trigger_price: "800000000",
        }),
      }),
    });
  });

  it("submits a spot order with attached triggers and cancels a trigger", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"bb".repeat(32)}`,
    } as never);
    const trigger = {
      order_type: { MarketBounded: { max_price: "1.1", min_price: "0.9" } },
      trigger_price: "1",
      side: "sell" as const,
    };

    await client.createOrderWithTriggers(MARKET, "buy", "1", "2", "Spot", trigger);

    expect(submitActionsSpy).toHaveBeenLastCalledWith(
      OWNER,
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            actions: expect.arrayContaining([
              {
                CreateOrderWithTriggers: expect.objectContaining({
                  price: "1000000000",
                  quantity: "2000000000",
                  trigger_1: expect.objectContaining({
                    quantity: {
                      ParentOrder: { parent_order_id: `0x${"00".repeat(32)}` },
                    },
                    side: "Sell",
                  }),
                  trigger_2: null,
                }),
              },
            ]),
          }),
        ],
      }),
    );

    const id = triggerOrderId(`0x${"de".repeat(32)}`);
    await client.cancelTriggerOrder(id, MARKET);
    expect(submitActionsSpy).toHaveBeenLastCalledWith(
      OWNER,
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            market_id: MARKET.market_id,
            actions: expect.arrayContaining([{ CancelTriggerOrder: { order_id: id } }]),
          }),
        ],
      }),
    );
  });

  it.each([
    {
      field: "trigger_price",
      args: {
        order_type: "Market" as const,
        quantity: { Quantity: { quantity: 123000000n } },
        trigger_price: 123456789n,
        side: "buy" as const,
      },
    },
    {
      field: "MarketBounded.max_price",
      args: {
        order_type: { MarketBounded: { max_price: 123456789n, min_price: 123000000n } },
        quantity: { Quantity: { quantity: 123000000n } },
        trigger_price: 123000000n,
        side: "buy" as const,
      },
    },
    {
      field: "MarketBounded.min_price",
      args: {
        order_type: { MarketBounded: { max_price: 123000000n, min_price: 123456789n } },
        quantity: { Quantity: { quantity: 123000000n } },
        trigger_price: 123000000n,
        side: "buy" as const,
      },
    },
    {
      field: "Spot.price",
      args: {
        order_type: { Spot: { price: 123456789n } },
        quantity: { Quantity: { quantity: 123000000n } },
        trigger_price: 123000000n,
        side: "buy" as const,
      },
    },
  ])("rejects imprecise bigint $field values", async ({ args }) => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(LOW_PRECISION_MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions");

    await expect(client.createTriggerOrder(LOW_PRECISION_MARKET, args)).rejects.toThrow(
      "Price must be a multiple of 1000000",
    );
    expect(submitActionsSpy).not.toHaveBeenCalled();
  });

  it.each([
    { order_type: "Market" as const, trigger_price: 6n },
    { order_type: { MarketBounded: { max_price: 6n, min_price: 4n } }, trigger_price: 8n },
    { order_type: { Spot: { price: 6n } }, trigger_price: 8n },
  ])("adjusts standalone quantity using the trigger type's effective price", async (prices) => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(FRACTIONAL_PRICE_MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"bb".repeat(32)}`,
    } as never);

    await client.createTriggerOrder(FRACTIONAL_PRICE_MARKET, {
      ...prices,
      quantity: { Quantity: { quantity: 7n } },
      side: "buy",
    });

    expect(submitActionsSpy).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        actions: [
          expect.objectContaining({
            actions: expect.arrayContaining([
              expect.objectContaining({
                CreateTriggerOrder: expect.objectContaining({
                  args: expect.objectContaining({
                    quantity: { Quantity: { quantity: "5" } },
                  }),
                }),
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it("rejects a standalone trigger below min_order and identifies the leg price field", async () => {
    const market = { ...FRACTIONAL_PRICE_MARKET, min_order: 4n };
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());
    vi.spyOn(client.api, "getMarkets").mockResolvedValue({
      ...FRACTIONAL_PRICE_MARKETS_RESPONSE,
      markets: [market],
    });
    const submitActionsSpy = vi.spyOn(client.api, "submitActions");

    await expect(
      client.createTriggerOrders(
        market,
        {
          order_type: "Market",
          quantity: { ParentOrder: { parent_order_id: orderId(`0x${"ca".repeat(32)}`) } },
          trigger_price: 8n,
          side: "buy",
        },
        {
          order_type: { Spot: { price: 6n } },
          quantity: { Quantity: { quantity: 7n } },
          trigger_price: 8n,
          side: "buy",
        },
      ),
    ).rejects.toThrow("second.order_type.Spot.price");
    expect(submitActionsSpy).not.toHaveBeenCalled();
  });
});

describe("O2Client bigint precision", () => {
  it("createOrder accepts bigint quantity at atomic-unit precision", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(LOW_PRECISION_MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"bb".repeat(32)}`,
    } as never);

    await expect(
      client.createOrder("fFUEL/fUSDC", "buy", 1000000000n, 123456789n),
    ).resolves.toBeTruthy();
    expect(submitActionsSpy).toHaveBeenCalledOnce();
  });

  it("batchActions accepts bigint quantity at atomic-unit precision", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(LOW_PRECISION_MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"bb".repeat(32)}`,
    } as never);

    await expect(
      client.batchActions([
        {
          market: "fFUEL/fUSDC",
          actions: [{ type: "createOrder", side: "buy", price: 1000000000n, quantity: 123456789n }],
        },
      ]),
    ).resolves.toBeTruthy();
    expect(submitActionsSpy).toHaveBeenCalledOnce();
  });

  it("createOrder rejects bigint price that exceeds market max_precision", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(LOW_PRECISION_MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions");

    await expect(client.createOrder("fFUEL/fUSDC", "buy", 123456789n, 123000000n)).rejects.toThrow(
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
          market: "fFUEL/fUSDC",
          actions: [{ type: "createOrder", side: "buy", price: 123456789n, quantity: 123000000n }],
        },
      ]),
    ).rejects.toThrow("Price must be a multiple of 1000000");
    expect(submitActionsSpy).not.toHaveBeenCalled();
  });
});

describe("O2Client fractional price adjustment", () => {
  it("createOrder rounds quantity down to the valid fractional-price quantum", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(FRACTIONAL_PRICE_MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"bb".repeat(32)}`,
    } as never);

    await expect(client.createOrder("fFUEL/fUSDC", "buy", 6n, 7n)).resolves.toBeTruthy();

    expect(submitActionsSpy).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        actions: [
          {
            market_id: FRACTIONAL_PRICE_MARKET.market_id,
            actions: expect.arrayContaining([
              expect.objectContaining({
                CreateOrder: expect.objectContaining({
                  price: "6",
                  quantity: "5",
                }),
              }),
            ]),
          },
        ],
      }),
    );
  });

  it("batchActions applies the same fractional-price rounding as createOrder", async () => {
    const client = new O2Client({ network: Network.TESTNET });
    client.setSession(makeSession());

    vi.spyOn(client.api, "getMarkets").mockResolvedValue(FRACTIONAL_PRICE_MARKETS_RESPONSE);
    const submitActionsSpy = vi.spyOn(client.api, "submitActions").mockResolvedValue({
      tx_id: `0x${"bb".repeat(32)}`,
    } as never);

    await expect(
      client.batchActions([
        {
          market: "fFUEL/fUSDC",
          actions: [{ type: "createOrder", side: "buy", price: 6n, quantity: 7n }],
        },
      ]),
    ).resolves.toBeTruthy();

    expect(submitActionsSpy).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        actions: [
          {
            market_id: FRACTIONAL_PRICE_MARKET.market_id,
            actions: [
              expect.objectContaining({
                CreateOrder: expect.objectContaining({
                  price: "6",
                  quantity: "5",
                }),
              }),
            ],
          },
        ],
      }),
    );
  });
});

describe("O2Client depth precision validation", () => {
  it("getDepth rejects precision 0", async () => {
    const client = new O2Client();
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    await expect(client.getDepth("fFUEL/fUSDC", 0)).rejects.toThrow("Invalid depth precision 0");
  });

  it("getDepth rejects precision 19", async () => {
    const client = new O2Client();
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    await expect(client.getDepth("fFUEL/fUSDC", 19)).rejects.toThrow("Invalid depth precision 19");
  });

  it("getDepth rejects negative precision", async () => {
    const client = new O2Client();
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    await expect(client.getDepth("fFUEL/fUSDC", -1)).rejects.toThrow("Invalid depth precision -1");
  });

  it("streamDepth rejects precision 0", async () => {
    const client = new O2Client();
    vi.spyOn(client.api, "getMarkets").mockResolvedValue(MARKETS_RESPONSE);
    await expect(client.streamDepth("fFUEL/fUSDC", 0)).rejects.toThrow("Invalid depth precision 0");
  });
});
