/**
 * Retry behaviour on the HTTP layer.
 *
 * The backoff used to fire only when `parseApiError` produced a
 * `RateLimitExceeded`, which needs the body to carry code 1003. A gateway
 * answering 429 in any other shape got no backoff at all — which is how a
 * read-heavy CI run took the limit and failed four tests outright.
 */

import { describe, expect, it, vi } from "vitest";
import { O2Api } from "../src/api.js";
import { TESTNET } from "../src/config.js";
import { O2Error, RateLimitExceeded } from "../src/errors.js";

class TestApi extends O2Api {
  call(path: string) {
    return this.get<unknown>(path);
  }
}

const api = () => new TestApi({ config: TESTNET, maxRetries: 2, retryDelayMs: 1 });

const reply = (status: number, body: string, ok = status < 400) =>
  ({ ok, status, text: async () => body }) as unknown as Response;

describe("HTTP retry", () => {
  it("retries a 429 whose body does NOT carry code 1003", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(429, JSON.stringify({ message: "rate limit exceeded" })))
      .mockResolvedValueOnce(reply(200, JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api().call("/v1/markets")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("retries a 429 served as PLAIN TEXT", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(429, "Too Many Requests"))
      .mockResolvedValueOnce(reply(200, JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api().call("/v1/markets")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("still retries the typed RateLimitExceeded", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(429, JSON.stringify({ code: 1003, message: "slow down" })))
      .mockResolvedValueOnce(reply(200, JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api().call("/v1/markets")).resolves.toEqual({ ok: true });
    vi.unstubAllGlobals();
  });

  it("does NOT retry 5xx — the request's fate is unknown", async () => {
    // A 502 can arrive after the batch already landed and a 500 can carry
    // an on-chain revert, so resending is how one trade becomes two.
    const fetchMock = vi.fn().mockResolvedValue(reply(502, "<html>bad gateway</html>"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api().call("/v1/markets")).rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("does NOT retry an ordinary client error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(reply(400, JSON.stringify({ code: 1001, message: "bad request" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api().call("/v1/markets")).rejects.toBeInstanceOf(O2Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("gives up after maxRetries and surfaces the rate-limit error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(429, "Too Many Requests"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api().call("/v1/markets")).rejects.toThrow(/429/);
    // initial attempt + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("surfaces a non-JSON body's text instead of a parse error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(422, "Failed to deserialize the JSON body"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api().call("/v1/session/actions")).rejects.toThrow(/Failed to deserialize/);
    vi.unstubAllGlobals();
  });

  it("treats RateLimitExceeded as retryable even on an odd status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(400, JSON.stringify({ code: 1003, message: "slow down" })))
      .mockResolvedValueOnce(reply(200, JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api().call("/v1/markets")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

describe("RateLimitExceeded", () => {
  it("carries code 1003", () => {
    expect(new RateLimitExceeded().code).toBe(1003);
  });
});

describe("signed mutations are never replayed by the transport", () => {
  /**
   * Their payloads carry a nonce and a signature fixed before dispatch,
   * and an accepted-but-lost response looks exactly like a rejected one.
   * A replay can therefore submit the same trade twice — and with the
   * sequential-nonce self-heal it could re-sign under the next nonce and
   * place a genuine duplicate. The Python SDK draws the same line.
   */
  const OWNER = "0xowner";
  const signed: [string, (a: O2Api) => Promise<unknown>][] = [
    ["submitActions", (a) => a.submitActions(OWNER, {} as never)],
    ["submitMarginAccountActions", (a) => a.submitMarginAccountActions(OWNER, {} as never)],
    ["createSession", (a) => a.createSession(OWNER, {} as never)],
    ["withdraw", (a) => a.withdraw(OWNER, {} as never)],
  ];

  for (const [name, call] of signed) {
    it(`${name} is not retried on 429`, async () => {
      const fetchMock = vi.fn().mockResolvedValue(reply(429, "Too Many Requests"));
      vi.stubGlobal("fetch", fetchMock);
      await expect(call(api())).rejects.toBeInstanceOf(O2Error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });

    it(`${name} is not retried on a network error`, async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("socket hang up"));
      vi.stubGlobal("fetch", fetchMock);
      await expect(call(api())).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });
  }

  it("but ordinary reads still back off on a rate limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(429, "Too Many Requests"))
      .mockResolvedValueOnce(reply(200, JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api().call("/v1/markets")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
