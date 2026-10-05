import { describe, expect, it, vi } from "vitest";
import { O2Api } from "../../src/api.js";
import { O2Client } from "../../src/client.js";
import { TESTNET } from "../../src/config.js";
import { bytesToHex } from "../../src/encoding.js";
import { StreamResyncRequired, TurboDiscoveryUnavailable } from "../../src/errors.js";
import {
  assetId,
  contractId,
  depthPrecision,
  type Market,
  type MarketsResponse,
  marketId,
  tradeAccountId,
} from "../../src/models.js";
import { isPerpetualTerm } from "../../src/turbo/terms.js";
import { O2WebSocket } from "../../src/websocket.js";

const id = (byte: string) => `0x${byte.repeat(32)}`;
const market: Market = {
  market_id: marketId(id("11")),
  contract_id: contractId(id("22")),
  pair: "ETH/USDC",
  maker_fee: 0n,
  taker_fee: 0n,
  min_order: 1n,
  dust: 0n,
  price_window: 0,
  base: { symbol: "ETH", asset: assetId(id("33")), decimals: 6, max_precision: 6 },
  quote: { symbol: "USDC", asset: assetId(id("44")), decimals: 6, max_precision: 6 },
};
const turbo: Market = {
  ...market,
  turbo: true,
  canonical_contract_id: market.contract_id,
  contract_id: contractId(id("55")),
};
const catalog: MarketsResponse = {
  markets: [market],
  accounts_registry_id: contractId(id("66")),
  books_registry_id: contractId(id("77")),
  trade_account_oracle_id: contractId(id("88")),
  base_asset_id: market.base.asset,
  chain_id: "0",
};

describe("Turbo 3.0 venue routing", () => {
  it("keeps public and Turbo catalogs separate and signs mixed batches against actual books", async () => {
    const client = new O2Client({ config: TESTNET });
    const getMarkets = vi.spyOn(client.api, "getMarkets").mockImplementation(async (selection) => ({
      ...catalog,
      markets: selection?.turbo ? [turbo] : [market],
    }));
    client.setSession({
      ownerAddress: id("99"),
      tradeAccountId: tradeAccountId(id("aa")),
      sessionPrivateKey: new Uint8Array(32).fill(1),
      sessionAddress: id("bb"),
      contractIds: [market.contract_id, turbo.contract_id],
      expiry: 4_102_444_800,
      nonce: 0n,
    });
    const submit = vi.spyOn(client as any, "submitPrepared").mockResolvedValue({ txId: "tx" });
    const selected = await client.getMarket("ETH/USDC", { turbo: true });
    expect(selected.contract_id).toBe(turbo.contract_id);
    expect((await client.getMarket("ETH/USDC")).contract_id).toBe(market.contract_id);
    await client.batchActions([
      { market, actions: [{ type: "settleBalance" }] },
      { market: selected, actions: [{ type: "settleBalance" }] },
    ]);
    const batch = submit.mock.calls[0][0];
    expect(batch.marketActions.map((group: { turbo?: boolean }) => group.turbo)).toEqual([
      undefined,
      true,
    ]);
    expect(
      batch.calls.map((call: { contractId: Uint8Array }) => bytesToHex(call.contractId)),
    ).toEqual([market.contract_id, turbo.contract_id]);
    expect(getMarkets).toHaveBeenCalledTimes(2);
    await expect(
      client.cancelOrder(id("cc") as never, { ...selected, contract_id: contractId(id("dd")) }),
    ).rejects.toThrow(/refresh/);
  });

  it("propagates selected Market objects through high-level data reads", async () => {
    const client = new O2Client({ config: TESTNET });
    const depth = vi.spyOn(client.api, "getDepth").mockResolvedValue({ bids: [], asks: [] });
    const bars = vi.spyOn(client.api, "getBars").mockResolvedValue([]);
    await client.getDepth(turbo, 1, 2);
    await client.getBars(turbo, "1m", 0, 60_000);
    expect(depth).toHaveBeenCalledWith(market.market_id, 10, 2, turbo);
    expect(bars).toHaveBeenCalledWith(market.market_id, 0, 60_000, "1m", turbo);
  });

  it("omits public flags, requests Turbo by market ID and rejects ignored selectors", async () => {
    const api = new O2Api({ config: TESTNET });
    const get = vi.spyOn(api as any, "get").mockResolvedValue({ orders: { buys: [], sells: [] } });
    await api.getDepth(market.market_id);
    expect(get.mock.calls[0][1]).not.toHaveProperty("turbo");
    await expect(api.getDepth(market.market_id, 10, 1, { turbo: true })).rejects.toThrow(
      /requested trading market/,
    );
    get.mockResolvedValue({
      turbo: true,

      orders: { buys: [], sells: [] },
    });
    expect(await api.getDepth(market.market_id, 10, 1, turbo)).toMatchObject({
      turbo: true,
    });
    expect(get.mock.calls[2][1]).toMatchObject({ market_id: market.market_id, turbo: true });
  });

  it("separates streams for the same market across venues and retains selection for reconnect", async () => {
    const ws = new O2WebSocket({ config: TESTNET, reconnect: false });
    const publicStream = ws.streamDepth(market.market_id, depthPrecision(1));
    const turboStream = ws.streamDepth(market.market_id, depthPrecision(1), turbo);
    const nextPublic = publicStream.next();
    const nextTurbo = turboStream.next();
    await Promise.resolve();
    const state = ws as any;
    expect(state.pendingSubscriptions).toHaveLength(2);
    for (const handler of state.handlers.get("subscribe_depth")) {
      handler({ market_id: id("ee"), turbo: true, orders: { buys: [], sells: [] } });
      handler({
        market_id: market.market_id,
        turbo: true,
        orders: { buys: [], sells: [] },
      });
      handler({ market_id: market.market_id, orders: { buys: [], sells: [] } });
    }
    expect((await nextTurbo).value).toMatchObject({ turbo: true });
    expect((await nextPublic).value?.turbo).toBeUndefined();
    ws.unsubscribeDepth(market.market_id, turbo);
    expect(state.pendingSubscriptions).toHaveLength(1);
    expect(state.pendingSubscriptions[0].turbo).toBeUndefined();
    await publicStream.return(undefined as never);
    await turboStream.return(undefined as never);
  });

  it("interrupts only the matching Turbo trades subscription", async () => {
    const ws = new O2WebSocket({ config: TESTNET, reconnect: false });
    const streams = [
      ws.streamTrades(market.market_id),
      ws.streamTrades(market.market_id, turbo),
      ws.streamDepth(market.market_id, depthPrecision(1), turbo),
      ws.streamOrders([], turbo),
      ws.streamTrades(id("dd"), turbo),
    ];
    const next = streams.map((stream) => stream.next());
    const rejected = expect(next[1]).rejects.toBeInstanceOf(StreamResyncRequired);
    await Promise.resolve();
    const state = ws as any;
    const error = { action: "error", turbo: true, resync_required: true };
    for (const handler of state.handlers.get("error")) {
      handler(error); // Without a market there is no matching trades subscription.
      handler({ ...error, market_id: id("ee") });
      handler({ ...error, turbo: false, market_id: market.market_id });
    }
    expect(state.pendingSubscriptions).toHaveLength(5);
    for (const handler of state.handlers.get("error")) {
      handler({ ...error, market_id: market.market_id.toUpperCase() });
    }
    await rejected;
    expect(state.pendingSubscriptions).toHaveLength(4);
    expect(state.pendingSubscriptions).not.toContainEqual({
      action: "subscribe_trades",
      market_id: market.market_id,
      turbo: true,
    });
    for (const handler of state.handlers.get("subscribe_trades")) {
      handler({ market_id: market.market_id.toUpperCase(), trades: [] });
      handler({ market_id: id("dd"), turbo: true, trades: [] });
    }
    for (const handler of state.handlers.get("subscribe_depth")) {
      handler({ market_id: market.market_id, turbo: true, orders: { buys: [], sells: [] } });
    }
    for (const handler of state.handlers.get("subscribe_orders")) {
      handler({ turbo: true, orders: [] });
    }
    for (const i of [0, 2, 3, 4]) {
      expect((await next[i]).done).toBe(false);
      await streams[i].return(undefined as never);
    }
    expect(state.handlers.size).toBe(0);
  });

  it("types unsupported discovery without swallowing transport failures", async () => {
    const api = new O2Api({ config: TESTNET });
    const get = vi.spyOn(api as any, "get").mockResolvedValue({ markets: [{}] });
    await expect(api.getMarkets({ turbo: true })).rejects.toBeInstanceOf(TurboDiscoveryUnavailable);
    get.mockResolvedValue({ turbo: true, markets: [{}] });
    await expect(api.getMarkets({ turbo: true })).rejects.toBeInstanceOf(TurboDiscoveryUnavailable);
    const transient = new Error("catalog request failed");
    get.mockRejectedValue(transient);
    await expect(api.getMarkets({ turbo: true })).rejects.toBe(transient);
  });

  it("does not sign a session when Turbo catalog discovery fails transiently", async () => {
    const client = new O2Client({ config: TESTNET });
    const error = new Error("temporary catalog failure");
    vi.spyOn(client.api, "getAccount").mockResolvedValue({
      trade_account_id: tradeAccountId(id("aa")),
    } as never);
    vi.spyOn(client.api, "getMarkets").mockImplementation(async (selection) => {
      if (selection?.turbo) throw error;
      return catalog;
    });
    const personalSign = vi.fn();
    const create = vi.spyOn(client.api, "createSession");
    await expect(
      client.createSession({ b256Address: id("99"), personalSign }, [market], { turbo: true }),
    ).rejects.toBe(error);
    expect(personalSign).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("treats omitted and empty order selections as public", async () => {
    const ws = new O2WebSocket({ config: TESTNET, reconnect: false });
    const first = ws.streamOrders([]);
    const second = ws.streamOrders([], {});
    const firstNext = first.next();
    const secondNext = second.next();
    await Promise.resolve();
    const state = ws as any;
    expect(state.pendingSubscriptions).toEqual([{ action: "subscribe_orders", identities: [] }]);
    for (const handler of state.handlers.get("subscribe_orders")) {
      handler({ turbo: true, orders: [] });
      handler({ orders: [] });
    }
    expect((await firstNext).value?.turbo).toBeUndefined();
    expect((await secondNext).value?.turbo).toBeUndefined();
    await first.return(undefined as never);
    await second.return(undefined as never);
  });

  it("signs against the captured market when a catalog refresh replaces its contract", async () => {
    const client = new O2Client({ config: TESTNET });
    vi.spyOn(client.api, "getMarkets").mockImplementation(async (selection) => ({
      ...catalog,
      markets: selection?.turbo ? [turbo] : [market],
    }));
    client.setSession({
      ownerAddress: id("99"),
      tradeAccountId: tradeAccountId(id("aa")),
      sessionPrivateKey: new Uint8Array(32).fill(1),
      sessionAddress: id("bb"),
      contractIds: [turbo.contract_id],
      expiry: 4_102_444_800,
      nonce: 0n,
    });
    const submit = vi.spyOn(client as any, "submitPrepared").mockResolvedValue({ txId: "tx" });
    const state = client as any;
    const original = state.submitBatch.bind(client);
    vi.spyOn(state, "submitBatch").mockImplementation(async (...args: any[]) => {
      state.marketCatalogs.set(true, {
        data: { ...catalog, markets: [{ ...turbo, contract_id: contractId(id("dd")) }] },
        updatedAt: Date.now(),
      });
      return original(...args);
    });
    await client.settleBalance(await client.getMarket("ETH/USDC", { turbo: true }));
    expect(bytesToHex(submit.mock.calls[0][0].calls[0].contractId)).toBe(turbo.contract_id);
    expect(submit.mock.calls[0][0].marketActions[0]).not.toHaveProperty("book_id");
  });

  it("normalizes session-qualified analytics IDs without losing precision", async () => {
    const api = new O2Api({ config: TESTNET });
    const account = `${id("aa")}:9007199254740993`;
    const get = vi.spyOn(api as any, "getAnalytics").mockResolvedValue({
      turbo_account_id: account,
      volume: "0",
      collateral_decimals: 9,
      window_days: 60,
      window_start: 1,
      window_end: 2,
      as_of: 2,
      indexed_at: 2,
      indexed_block: "1",
    });
    await api.getTurboVolume(`${id("aa").slice(2).toUpperCase()}:09007199254740993`);
    expect(get).toHaveBeenCalledWith(
      `/analytics/v1/turbo/volume?turbo_account_id=${encodeURIComponent(account)}`,
    );
    await expect(api.getTurboVolume(id("aa"))).rejects.toThrow(/contract:session/);
  });

  it("reads and validates informational rolling volume", async () => {
    const api = new O2Api({ config: TESTNET });
    const account = `${id("aa")}:1`;
    const get = vi.spyOn(api as any, "getAnalytics").mockResolvedValue({
      turbo_account_id: account,
      volume: "123",
      collateral_decimals: 6,
      window_days: 60,
      window_start: 1,
      window_end: 2,
      as_of: 2,
      indexed_at: 2,
      indexed_block: "10",
    });
    expect((await api.getTurboVolume(account)).volume).toBe("123");
    expect(get).toHaveBeenCalledWith(
      `/analytics/v1/turbo/volume?turbo_account_id=${encodeURIComponent(account)}`,
    );
    get.mockResolvedValue({ turbo_account_id: id("bb"), volume: "123" });
    await expect(api.getTurboVolume(account)).rejects.toThrow(/Invalid Turbo volume/);
  });
});

it("recognizes perpetual sentinels without mistaking ordinary expiry for no expiry", () => {
  for (const value of [
    "18446744073709551615",
    18446744073709551615n,
    Number("18446744073709551615"),
    { unix: "18446744073709551615" },
  ])
    expect(isPerpetualTerm(value)).toBe(true);
  for (const value of [undefined, null, "garbage", Infinity, 1_700_000_000, "604800"])
    expect(isPerpetualTerm(value)).toBe(false);
});
