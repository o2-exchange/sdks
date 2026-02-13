import { describe, expect, it, vi } from "vitest";
import { O2Api } from "../src/api.js";
import { TESTNET } from "../src/config.js";
import { InternalError, RateLimitExceeded } from "../src/errors.js";
import { type SessionActionsRequest, tradeAccountId } from "../src/models.js";

const OWNER = `0x${"11".repeat(32)}`;

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
