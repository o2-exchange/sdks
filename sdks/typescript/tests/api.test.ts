import { describe, expect, it, vi } from "vitest";
import { O2Api } from "../src/api.js";
import { TESTNET } from "../src/config.js";
import { InternalError, RateLimitExceeded } from "../src/errors.js";
import { marketId, type SessionActionsRequest, tradeAccountId } from "../src/models.js";

const OWNER = `0x${"11".repeat(32)}`;
const MARKET_ID = marketId(`0x${"55".repeat(32)}`);

const BASE_ACTIONS_REQUEST: SessionActionsRequest = {
  actions: [],
  signature: { Secp256k1: `0x${"22".repeat(64)}` },
  nonce: "0",
  trade_account_id: tradeAccountId(`0x${"33".repeat(32)}`),
  session_id: { Address: `0x${"44".repeat(32)}` },
};

describe("O2Api.submitActions", () => {
  it("returns SessionActionsResponse for preflight validation payloads", async () => {
    const api = new O2Api({ config: TESTNET });
    vi.spyOn(api as any, "request").mockResolvedValue({
      code: 7004,
      message: "Too many actions",
    });

    const response = await api.submitActions(OWNER, BASE_ACTIONS_REQUEST);

    expect(response.isPreflightError).toBe(true);
    expect(response.code).toBe(7004);
    expect(response.message).toBe("Too many actions");
  });

  it("throws RateLimitExceeded errors from request path", async () => {
    const api = new O2Api({ config: TESTNET });
    vi.spyOn(api as any, "request").mockRejectedValue(new RateLimitExceeded("Too many requests"));

    await expect(api.submitActions(OWNER, BASE_ACTIONS_REQUEST)).rejects.toBeInstanceOf(
      RateLimitExceeded,
    );
  });

  it("throws InternalError errors from request path", async () => {
    const api = new O2Api({ config: TESTNET });
    vi.spyOn(api as any, "request").mockRejectedValue(new InternalError("Unexpected server error"));

    await expect(api.submitActions(OWNER, BASE_ACTIONS_REQUEST)).rejects.toBeInstanceOf(
      InternalError,
    );
  });
});

describe("O2Api trades parsing", () => {
  it("getTradesByAccount parses wrapped trades payloads", async () => {
    const api = new O2Api({ config: TESTNET });
    vi.spyOn(api as any, "request").mockResolvedValue({
      trades: [
        {
          trade_id: "1",
          side: "Buy",
          price: "100",
          quantity: "2",
          total: "200",
          timestamp: "1700000000",
        },
      ],
    });

    const trades = await api.getTradesByAccount(MARKET_ID, BASE_ACTIONS_REQUEST.trade_account_id);

    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe("buy");
    expect(trades[0].price).toBe(100n);
  });

  it("getAggregatedTrades parses wrapped payloads that provide type instead of side", async () => {
    const api = new O2Api({ config: TESTNET });
    vi.spyOn(api as any, "request").mockResolvedValue({
      trades: [
        {
          trade_id: "2",
          type: "Sell",
          price: "3",
          quantity: "4",
          total: "12",
          timestamp: "1700000001",
        },
      ],
    });

    const trades = await api.getAggregatedTrades("fFUEL_fUSDC");

    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe("sell");
    expect(trades[0].total).toBe(12n);
  });

  it("getAggregatedTrades does not throw when side and type are missing", async () => {
    const api = new O2Api({ config: TESTNET });
    vi.spyOn(api as any, "request").mockResolvedValue([
      {
        trade_id: "3",
        price: "5",
        quantity: "6",
        total: "30",
        timestamp: "1700000002",
      },
    ]);

    const trades = await api.getAggregatedTrades("fFUEL_fUSDC");

    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe("buy");
    expect(trades[0].price).toBe(5n);
  });
});
