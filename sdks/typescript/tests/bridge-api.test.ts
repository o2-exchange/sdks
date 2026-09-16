import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type * as T from "../src/bridge/types.js";
import { FastBridgeClient } from "../src/index.js";

const fixtures = JSON.parse(
  readFileSync(new URL("../../../fixtures/bridge/http.json", import.meta.url), "utf8"),
);
it("maps every v1 endpoint, preserves payloads, and omits absent queries", async () => {
  let index = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const fixture = fixtures[index++];
    const url = new URL(String(input));
    expect(url.pathname).toBe(`/proxy${fixture.path}`);
    expect(init?.method).toBe(fixture.method);
    expect(Object.fromEntries(url.searchParams)).toEqual(
      Object.fromEntries(Object.entries(fixture.query ?? {}).map(([k, v]) => [k, String(v)])),
    );
    expect(init?.body ? JSON.parse(String(init.body)) : undefined).toEqual(fixture.body);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("error");
    return new Response(JSON.stringify(fixture.response), {
      status: fixture.path.endsWith("/submit") ? 202 : 200,
    });
  });
  const client = new FastBridgeClient({ baseUrl: "https://bridge.example/proxy/", fetch });
  expect(await client.getInfo()).toEqual(fixtures[0].response);
  expect(await client.getAssets(fixtures[1].query.chainId)).toEqual(fixtures[1].response);
  expect(
    await client.getDepositInfo(
      fixtures[2].query.sourceChainId,
      fixtures[2].query.assetId,
      fixtures[2].query.amount,
    ),
  ).toEqual(fixtures[2].response);
  expect(await client.prepareDeposit(fixtures[3].body as T.DepositPrepareRequest)).toEqual(
    fixtures[3].response,
  );
  expect(await client.submitDeposit(fixtures[4].body as T.SubmitRequest)).toEqual(
    fixtures[4].response,
  );
  expect(
    await client.getDepositStatus(fixtures[5].query.sourceChainId, fixtures[5].query.evmTxHash),
  ).toEqual(fixtures[5].response);
  expect(
    await client.getWithdrawInfo(
      fixtures[6].query.destinationChainId,
      fixtures[6].query.assetId,
      fixtures[6].query.amount,
    ),
  ).toEqual(fixtures[6].response);
  expect(
    await client.getWithdrawFee(fixtures[7].query.destinationChainId, fixtures[7].query.assetId),
  ).toEqual(fixtures[7].response);
  expect(await client.prepareWithdraw(fixtures[8].body as T.WithdrawPrepareRequest)).toEqual(
    fixtures[8].response,
  );
  expect(await client.submitWithdraw(fixtures[9].body as T.SubmitRequest)).toEqual(
    fixtures[9].response,
  );
  expect(await client.getWithdrawStatus(fixtures[10].query.fuelTxId)).toEqual(
    fixtures[10].response,
  );
  expect(fetch).toHaveBeenCalledTimes(11);
  const omitted = vi.fn(async (input: RequestInfo | URL) => {
    expect(new URL(String(input)).search).toBe("");
    return new Response("{}");
  });
  await new FastBridgeClient({ baseUrl: "https://bridge.example", fetch: omitted }).getAssets();
});
