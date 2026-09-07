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

  it("retries 5xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(502, "<html>bad gateway</html>"))
      .mockResolvedValueOnce(reply(200, JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api().call("/v1/markets")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
