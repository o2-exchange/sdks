import { afterEach, describe, expect, it, vi } from "vitest";
import { O2Client } from "../src/client.js";
import { TESTNET } from "../src/config.js";
import { StreamResyncRequired } from "../src/errors.js";
import { depthPrecision } from "../src/models.js";
import {
  O2WebSocket,
  type O2WebSocketOptions,
  WebSocketBufferOverflowError,
} from "../src/websocket.js";

const identities = [{ ContractId: `0x${"11".repeat(32)}` }];
const orderMessage = { action: "subscribe_orders", orders: [] };

class FakeWebSocket extends EventTarget {
  readyState = WebSocket.CONNECTING as number;
  sent: Array<Record<string, unknown>> = [];

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  send(message: string): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error("Socket is not open");
    if (message !== "PING") this.sent.push(JSON.parse(message));
  }

  async message(data: unknown): Promise<void> {
    this.dispatchEvent(new MessageEvent("message", { data }));
    await Promise.resolve();
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

class InspectedWebSocket extends O2WebSocket {
  get subscriptions(): number {
    return this.pendingSubscriptions.size;
  }

  get listeners(): number {
    return [...this.handlers.values()].reduce((total, set) => total + set.size, 0);
  }

  lifecycle(): void {
    this.emitLifecycle("reconnecting", 1, "test transition");
  }
}

const clients: O2WebSocket[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.useRealTimers();
});

function fixture(options: Partial<O2WebSocketOptions> = {}) {
  const sockets: FakeWebSocket[] = [];
  const client = new InspectedWebSocket({
    config: TESTNET,
    reconnect: false,
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket.asWebSocket();
    },
    ...options,
  });
  clients.push(client);
  return { client, sockets };
}

async function connected(options: Partial<O2WebSocketOptions> = {}) {
  const result = fixture(options);
  const opening = result.client.connect();
  result.sockets[0].open();
  await opening;
  return { ...result, socket: result.sockets[0] };
}

describe("WebSocket subscription ownership", () => {
  it.each([
    "orders",
    "trades",
    "depth",
  ])("cancelling %s in Turbo preserves the spot stream", async (kind) => {
    const { client, socket } = await connected();
    const stream = (turbo: boolean) =>
      kind === "orders"
        ? client.streamOrders(identities, { turbo })
        : kind === "trades"
          ? client.streamTrades("0xaaaa", { turbo })
          : client.streamDepth("0xaaaa", depthPrecision(1), { turbo });
    const spot = stream(false);
    const turbo = stream(true);
    const spotNext = spot.next();
    const turboNext = turbo.next();
    await turbo.return(undefined);
    await expect(turboNext).resolves.toMatchObject({ done: true });
    expect(client.subscriptions).toBe(1);
    expect(socket.sent.at(-1)).toMatchObject({ action: `unsubscribe_${kind}`, turbo: true });
    const message =
      kind === "orders"
        ? orderMessage
        : kind === "trades"
          ? { action: "subscribe_trades", market_id: "0xaaaa", trades: [] }
          : { action: "subscribe_depth", market_id: "0xaaaa", orders: { buys: [], sells: [] } };
    await socket.message(JSON.stringify(message));
    await expect(spotNext).resolves.toMatchObject({ done: false });
    await spot.return(undefined);
    expect(socket.sent.at(-1)).not.toHaveProperty("turbo");
    expect(client.subscriptions).toBe(0);
    expect(client.listeners).toBe(0);
  });

  it("Turbo resync releases all shared consumers and error handlers while preserving spot", async () => {
    const { client, socket } = await connected();
    const spot = client.streamTrades("0xaaaa");
    const first = client.streamTrades("0xaaaa", { turbo: true });
    const second = client.streamTrades("0xaaaa", { turbo: true });
    const spotNext = spot.next();
    const failures = [
      expect(first.next()).rejects.toBeInstanceOf(StreamResyncRequired),
      expect(second.next()).rejects.toBeInstanceOf(StreamResyncRequired),
    ];
    await socket.message(
      JSON.stringify({ action: "error", market_id: "0XAAAA", turbo: true, resync_required: true }),
    );
    await Promise.all(failures);
    expect(client.subscriptions).toBe(1);
    expect(client.listeners).toBe(3);
    expect(socket.sent.filter((message) => message.action === "unsubscribe_trades")).toEqual([
      { action: "unsubscribe_trades", market_id: "0xaaaa", turbo: true },
    ]);
    await socket.message(
      JSON.stringify({ action: "subscribe_trades", market_id: "0xaaaa", trades: [] }),
    );
    await expect(spotNext).resolves.toMatchObject({ done: false });
    await spot.return(undefined);
    expect(client.listeners).toBe(0);
  });

  it.each([
    ["orders", { action: "unsubscribe_orders" }],
    ["balances", { action: "unsubscribe_balances", identities }],
    ["nonce", { action: "unsubscribe_nonce", identities }],
    ["trades", { action: "unsubscribe_trades", market_id: "0xaaaa" }],
    ["depth", { action: "unsubscribe_depth", market_id: "0xaaaa" }],
  ])(
    "return cancels a pending %s next and unsubscribes",
    async (kind, unsubscribe) => {
      const { client, socket } = await connected();
      const stream =
        kind === "orders"
          ? client.streamOrders(identities)
          : kind === "balances"
            ? client.streamBalances(identities)
            : kind === "nonce"
              ? client.streamNonce(identities)
              : kind === "trades"
                ? client.streamTrades("0xaaaa")
                : client.streamDepth("0xaaaa", depthPrecision(1));
      const pending = stream.next();
      const returning = stream.return(undefined);
      expect(client.subscriptions).toBe(0);
      expect(client.listeners).toBe(0);
      expect(socket.sent.at(-1)).toEqual(unsubscribe);
      await expect(pending).resolves.toMatchObject({ done: true });
      await expect(returning).resolves.toMatchObject({ done: true });
    },
    2000,
  );

  it("breaking a stream releases its server subscription", async () => {
    const { client, socket } = await connected();
    const stream = client.streamOrders(identities);
    const consuming = (async () => {
      for await (const _message of stream) break;
    })();
    await socket.message(JSON.stringify(orderMessage));
    await consuming;
    expect(client.subscriptions).toBe(0);
    expect(client.listeners).toBe(0);
    expect(socket.sent.at(-1)?.action).toBe("unsubscribe_orders");
  });

  it("does not subscribe a generator that is never started", async () => {
    const { client, socket } = await connected();
    const stream = client.streamOrders(identities);
    await stream.return(undefined);
    expect(socket.sent).toEqual([]);
    expect(client.listeners).toBe(0);
  });

  it("shares identical subscriptions until the last consumer returns", async () => {
    const { client, socket } = await connected();
    const first = client.streamOrders(identities);
    const second = client.streamOrders(identities);
    const firstNext = first.next();
    const secondNext = second.next();
    expect(socket.sent).toHaveLength(1);
    await first.return(undefined);
    await expect(firstNext).resolves.toMatchObject({ done: true });
    expect(client.subscriptions).toBe(1);
    expect(socket.sent).toHaveLength(1);
    await socket.message(JSON.stringify(orderMessage));
    await expect(secondNext).resolves.toMatchObject({ done: false });
    await second.return(undefined);
    expect(socket.sent.map((message) => message.action)).toEqual([
      "subscribe_orders",
      "unsubscribe_orders",
    ]);
  });

  it("rejects conflicting parameters without releasing the active topic", async () => {
    const { client, socket } = await connected();
    const active = client.streamDepth("0xaaaa", depthPrecision(1));
    const pending = active.next();
    const conflicting = client.streamDepth("0xaaaa", depthPrecision(2));
    await expect(conflicting.next()).rejects.toThrow("different parameters");
    expect(client.subscriptions).toBe(1);
    expect(socket.sent).toHaveLength(1);
    await active.return(undefined);
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it.each([
    "orders",
    "balances",
    "nonce",
    "trades",
    "depth",
  ])("explicit %s unsubscribe unblocks the generator and removes reconnect state", async (kind) => {
    const { client, socket } = await connected();
    let stream: AsyncGenerator<unknown>;
    let unsubscribe: () => void;
    switch (kind) {
      case "balances":
        stream = client.streamBalances(identities);
        unsubscribe = () => client.unsubscribeBalances(identities);
        break;
      case "nonce":
        stream = client.streamNonce(identities);
        unsubscribe = () => client.unsubscribeNonce(identities);
        break;
      case "trades":
        stream = client.streamTrades("0xaaaa");
        unsubscribe = () => client.unsubscribeTrades("0xaaaa");
        break;
      case "depth":
        stream = client.streamDepth("0xaaaa", depthPrecision(1));
        unsubscribe = () => client.unsubscribeDepth("0xaaaa");
        break;
      default:
        stream = client.streamOrders(identities);
        unsubscribe = () => client.unsubscribeOrders();
    }
    const pending = stream.next();
    unsubscribe();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(client.listeners).toBe(0);
    expect(client.subscriptions).toBe(0);
    expect(socket.sent).toHaveLength(2);
  }, 2000);

  it("throw cancels a waiting generator", async () => {
    const { client } = await connected();
    const stream = client.streamOrders(identities);
    const pending = stream.next();
    const throwing = stream.throw(new Error("consumer failed"));
    await expect(pending).resolves.toMatchObject({ done: true });
    await expect(throwing).rejects.toThrow("consumer failed");
    expect(client.listeners).toBe(0);
    expect(client.subscriptions).toBe(0);
  });

  it("return cancels a waiting lifecycle generator", async () => {
    const { client } = await connected();
    const stream = client.streamLifecycle();
    const pending = stream.next();
    await stream.return(undefined);
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(client.listeners).toBe(0);
  });

  it("filters market updates before queueing them", async () => {
    const { client, socket } = await connected({ maxBufferedMessages: 1 });
    const first = client.streamTrades("0xaaaa");
    const second = client.streamTrades("0xbbbb");
    const firstNext = first.next();
    const secondNext = second.next();
    await socket.message(
      JSON.stringify({ action: "subscribe_trades", market_id: "0xaaaa", trades: [] }),
    );
    await expect(firstNext).resolves.toMatchObject({ done: false });
    for (let i = 0; i < 10; i++) {
      await socket.message(
        JSON.stringify({ action: "subscribe_trades", market_id: "0xbbbb", trades: [] }),
      );
      if (i === 0) await secondNext;
      else await second.next();
    }
    await socket.message(
      JSON.stringify({ action: "subscribe_trades", market_id: "0xaaaa", trades: [] }),
    );
    await expect(first.next()).resolves.toMatchObject({ done: false });
    await first.return(undefined);
    await second.return(undefined);
  });

  it("keeps subscription inputs stable across caller mutation", async () => {
    const { client, socket } = await connected();
    const input = [{ ContractId: "0xabcd" }];
    const stream = client.streamBalances(input);
    input[0].ContractId = "0xeeee";
    const pending = stream.next();
    expect(socket.sent[0].identities).toEqual([{ ContractId: "0xabcd" }]);
    await stream.return(undefined);
    await pending;
    expect(socket.sent[1].identities).toEqual([{ ContractId: "0xabcd" }]);
  });

  it.each(["0XABCD", "abcd", "0xabcd"])("normalizes %s for routing and unsubscribe", async (id) => {
    const { client, socket } = await connected();
    const trades = client.streamTrades(id);
    const depth = client.streamDepth(id, depthPrecision(1));
    const tradesNext = trades.next();
    const depthNext = depth.next();
    expect(socket.sent.map((request) => request.market_id)).toEqual(["0xabcd", "0xabcd"]);
    await socket.message(
      JSON.stringify({ action: "subscribe_trades", market_id: "0xABCD", trades: [] }),
    );
    await socket.message(
      JSON.stringify({
        action: "subscribe_depth",
        market_id: "abcd",
        view: { asks: [], bids: [] },
      }),
    );
    await expect(tradesNext).resolves.toMatchObject({
      done: false,
      value: { market_id: "0xabcd" },
    });
    await expect(depthNext).resolves.toMatchObject({ done: false, value: { market_id: "0xabcd" } });
    const tradesWaiting = trades.next();
    const depthWaiting = depth.next();
    client.unsubscribeTrades("ABCD");
    client.unsubscribeDepth("0XABCD");
    await expect(tradesWaiting).resolves.toMatchObject({ done: true });
    await expect(depthWaiting).resolves.toMatchObject({ done: true });
    expect(client.listeners).toBe(0);
    expect(client.subscriptions).toBe(0);
    expect(socket.sent.slice(2)).toEqual([
      { action: "unsubscribe_trades", market_id: "0xabcd" },
      { action: "unsubscribe_depth", market_id: "0xabcd" },
    ]);
  });

  it("depth restart ignores queued stale deltas and malformed snapshots before the new snapshot", async () => {
    const { client, socket } = await connected({ maxBufferedMessages: 1 });
    const first = client.streamDepth("0xabcd", depthPrecision(1));
    const firstNext = first.next();
    await socket.message(
      JSON.stringify({
        action: "subscribe_depth",
        market_id: "0xabcd",
        orders: { sells: [], buys: [] },
      }),
    );
    await firstNext;
    await first.return(undefined);
    const restarted = client.streamDepth("0xabcd", depthPrecision(2));
    const snapshot = restarted.next();
    for (let i = 0; i < 5; i++) {
      await socket.message(
        JSON.stringify({
          action: "subscribe_depth_update",
          market_id: "0xabcd",
          changes: { asks: [], bids: [] },
        }),
      );
    }
    await socket.message(JSON.stringify({ action: "subscribe_depth", market_id: "0xabcd" }));
    await socket.message(
      JSON.stringify({
        action: "subscribe_depth",
        market_id: "0xabcd",
        orders: { sells: [{ price: "invalid" }], buys: [] },
      }),
    );
    await socket.message(
      JSON.stringify({
        action: "subscribe_depth",
        market_id: "0xabcd",
        orders: { sells: [{ price: "10", quantity: "2" }], buys: [] },
      }),
    );
    await expect(snapshot).resolves.toMatchObject({
      done: false,
      value: { action: "subscribe_depth", view: { asks: [{ price: 10n, quantity: 2n }] } },
    });
    const update = restarted.next();
    await socket.message(
      JSON.stringify({
        action: "subscribe_depth_update",
        market_id: "0xabcd",
        changes: { asks: [], bids: [] },
      }),
    );
    await expect(update).resolves.toMatchObject({
      done: false,
      value: { action: "subscribe_depth_update" },
    });
    await restarted.return(undefined);
    expect(client.listeners).toBe(0);
    expect(client.subscriptions).toBe(0);
  });

  it("rejects a late depth consumer instead of yielding deltas without a snapshot", async () => {
    const { client, socket } = await connected();
    const active = client.streamDepth("0xabcd", depthPrecision(1));
    const initial = active.next();
    await socket.message(
      JSON.stringify({
        action: "subscribe_depth",
        market_id: "0xabcd",
        view: { asks: [], bids: [] },
      }),
    );
    await expect(initial).resolves.toMatchObject({ value: { view: { asks: [], bids: [] } } });
    const late = client.streamDepth("0xabcd", depthPrecision(1));
    await expect(late.next()).rejects.toThrow("independent snapshot");
    expect(socket.sent).toHaveLength(1);
    const update = active.next();
    await socket.message(
      JSON.stringify({
        action: "subscribe_depth_update",
        market_id: "0xabcd",
        changes: { asks: [], bids: [] },
      }),
    );
    await expect(update).resolves.toMatchObject({
      done: false,
      value: { action: "subscribe_depth_update" },
    });
    await active.return(undefined);
    expect(client.subscriptions).toBe(0);
  });
});

describe("WebSocket bounded stream buffering", () => {
  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid maxBufferedMessages %s", (limit) => {
    expect(() => fixture({ maxBufferedMessages: limit })).toThrow(RangeError);
  });

  it("overflows at the limit, releases handlers immediately and reports data loss", async () => {
    const { client, socket } = await connected({ maxBufferedMessages: 2 });
    const stream = client.streamOrders(identities);
    const pending = stream.next();
    await socket.message(JSON.stringify(orderMessage));
    await pending;
    await socket.message(JSON.stringify(orderMessage));
    await socket.message(JSON.stringify(orderMessage));
    expect(client.subscriptions).toBe(1);
    await socket.message(JSON.stringify(orderMessage));
    expect(client.subscriptions).toBe(0);
    expect(client.listeners).toBe(0);
    expect(socket.sent.at(-1)?.action).toBe("unsubscribe_orders");
    await expect(stream.next()).rejects.toBeInstanceOf(WebSocketBufferOverflowError);
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    expect(client.isConnected()).toBe(true);
  });

  it("keeps a fast consumer alive when a shared slow consumer overflows", async () => {
    const { client, socket } = await connected({ maxBufferedMessages: 1 });
    const slow = client.streamOrders(identities);
    const fast = client.streamOrders(identities);
    const slowNext = slow.next();
    const fastNext = fast.next();
    await socket.message(JSON.stringify(orderMessage));
    await Promise.all([slowNext, fastNext]);
    for (let i = 0; i < 10; i++) {
      const next = fast.next();
      await socket.message(JSON.stringify(orderMessage));
      await expect(next).resolves.toMatchObject({ done: false });
    }
    await expect(slow.next()).rejects.toBeInstanceOf(WebSocketBufferOverflowError);
    expect(client.subscriptions).toBe(1);
    expect(socket.sent).toHaveLength(1);
    await fast.return(undefined);
    expect(client.subscriptions).toBe(0);
  });

  it("bounds lifecycle buffering without closing data streams", async () => {
    const { client } = await connected({ maxBufferedMessages: 1 });
    const stream = client.streamLifecycle();
    const pending = stream.next();
    client.lifecycle();
    await pending;
    client.lifecycle();
    client.lifecycle();
    expect(client.listeners).toBe(0);
    await expect(stream.next()).rejects.toBeInstanceOf(WebSocketBufferOverflowError);
    expect(client.isConnected()).toBe(true);
  });

  it("preserves queued data on disconnect and prevents old cleanup releasing a new stream", async () => {
    const { client, socket, sockets } = await connected();
    const old = client.streamOrders(identities);
    const pending = old.next();
    await socket.message(JSON.stringify(orderMessage));
    await pending;
    await socket.message(JSON.stringify(orderMessage));
    client.disconnect();
    const reconnecting = client.connect();
    sockets[1].open();
    await reconnecting;
    const fresh = client.streamOrders(identities);
    const freshNext = fresh.next();
    await expect(old.next()).resolves.toMatchObject({ done: false });
    await expect(old.next()).resolves.toMatchObject({ done: true });
    expect(client.subscriptions).toBe(1);
    expect(sockets[1].sent.map((message) => message.action)).toEqual(["subscribe_orders"]);
    await fresh.return(undefined);
    await freshNext;
  });
});

describe("WebSocket connection ownership", () => {
  it("manual recovery emits reconnected exactly once", async () => {
    vi.useFakeTimers();
    const { client, socket, sockets } = await connected({ reconnect: true });
    const states: string[] = [];
    const reading = (async () => {
      for await (const event of client.streamLifecycle()) states.push(event.state);
    })();
    socket.close();
    expect(client.isReconnecting()).toBe(true);
    const opening = client.connect();
    sockets[1].open();
    await opening;
    expect(client.isReconnecting()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    client.disconnect();
    await reading;
    expect(sockets).toHaveLength(2);
    expect(states).toEqual(["disconnected", "reconnecting", "reconnected", "closed"]);
  });

  it("a failed manual open during backoff resumes retries and eventually closes consumers", async () => {
    vi.useFakeTimers();
    const { client, socket, sockets } = await connected({
      reconnect: true,
      maxReconnectAttempts: 2,
    });
    const stream = client.streamOrders(identities);
    const pending = stream.next();
    socket.close();
    const opening = client.connect();
    const failure = expect(opening).rejects.toThrow("closed before open");
    sockets[1].close();
    await failure;
    expect(client.isReconnecting()).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sockets).toHaveLength(3);
    sockets[2].dispatchEvent(new Event("error"));
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(client.isTerminated()).toBe(true);
    expect(client.isReconnecting()).toBe(false);
    expect(client.listeners).toBe(0);
    expect(client.subscriptions).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(3);
  });

  it("a factory exception during recovery resumes retries", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    let attempts = 0;
    const client = new InspectedWebSocket({
      config: TESTNET,
      reconnect: true,
      webSocketFactory: () => {
        if (++attempts === 2) throw new Error("factory failed");
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket.asWebSocket();
      },
    });
    clients.push(client);
    const initial = client.connect();
    sockets[0].open();
    await initial;
    sockets[0].close();
    await expect(client.connect()).rejects.toThrow("factory failed");
    await vi.advanceTimersByTimeAsync(3000);
    expect(attempts).toBe(3);
    sockets[1].open();
    expect(client.isConnected()).toBe(true);
    expect(client.isReconnecting()).toBe(false);
  });
  it("shares concurrent connect attempts and leaves an open socket intact", async () => {
    const { client, sockets } = fixture();
    const first = client.connect();
    const second = client.connect();
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    await Promise.all([first, second]);
    await client.connect();
    expect(sockets).toHaveLength(1);
  });

  it("cancels a queued reconnect before manually connecting", async () => {
    vi.useFakeTimers();
    const { client, socket, sockets } = await connected({ reconnect: true });
    socket.close();
    client.disconnect();
    const opening = client.connect();
    sockets[1].open();
    await opening;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(2);
    expect(client.isConnected()).toBe(true);
  });

  it("only resubscribes active topics after reconnect", async () => {
    vi.useFakeTimers();
    const { client, socket, sockets } = await connected({ reconnect: true });
    const states: string[] = [];
    const reading = (async () => {
      for await (const event of client.streamLifecycle()) states.push(event.state);
    })();
    const stopped = client.streamOrders(identities);
    const active = client.streamTrades("0xaaaa");
    const stoppedNext = stopped.next();
    const activeNext = active.next();
    await stopped.return(undefined);
    await stoppedNext;
    socket.close();
    await vi.advanceTimersByTimeAsync(1500);
    sockets[1].open();
    await Promise.resolve();
    expect(sockets[1].sent).toEqual([{ action: "subscribe_trades", market_id: "0xaaaa" }]);
    await active.return(undefined);
    await activeNext;
    client.disconnect();
    await reading;
    expect(states).toEqual(["disconnected", "reconnecting", "reconnected", "closed"]);
  });

  it("retries failed opens and releases all streams when attempts are exhausted", async () => {
    vi.useFakeTimers();
    const { client, socket, sockets } = await connected({
      reconnect: true,
      maxReconnectAttempts: 2,
    });
    const stream = client.streamOrders(identities);
    const pending = stream.next();
    socket.close();
    await vi.advanceTimersByTimeAsync(1500);
    sockets[1].close();
    await vi.advanceTimersByTimeAsync(3000);
    sockets[2].dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(client.isTerminated()).toBe(true);
    expect(client.subscriptions).toBe(0);
    expect(client.listeners).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(3);
  });

  it("disconnect cancels an in-flight reconnect and ignores its late events", async () => {
    vi.useFakeTimers();
    const { client, socket, sockets } = await connected({ reconnect: true });
    socket.close();
    await vi.advanceTimersByTimeAsync(1500);
    client.disconnect();
    sockets[1].open();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.isConnected()).toBe(false);
    expect(sockets).toHaveLength(2);
  });

  it("disconnect rejects an initial connection still awaiting open", async () => {
    const { client, sockets } = fixture();
    const opening = client.connect();
    const rejected = expect(opening).rejects.toThrow("cancelled");
    client.disconnect();
    await rejected;
    sockets[0].open();
    expect(client.isConnected()).toBe(false);
  });

  it("a non-reconnecting peer close terminates waiting consumers", async () => {
    const { client, socket } = await connected();
    const stream = client.streamOrders(identities);
    const pending = stream.next();
    socket.close();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(client.isTerminated()).toBe(true);
    expect(client.listeners).toBe(0);
  });

  it("ignores asynchronous messages from a replaced socket", async () => {
    const { client, socket, sockets } = await connected();
    let resolveText!: (value: string) => void;
    class DelayedBlob extends Blob {
      override text(): Promise<string> {
        return new Promise((resolve) => {
          resolveText = resolve;
        });
      }
    }
    await socket.message(new DelayedBlob());
    client.disconnect();
    const opening = client.connect();
    sockets[1].open();
    await opening;
    const stream = client.streamOrders(identities);
    const pending = stream.next();
    resolveText(
      JSON.stringify({ action: "subscribe_orders", orders: [{ side: "buy", price: "1" }] }),
    );
    await Promise.resolve();
    await Promise.resolve();
    socket.close();
    expect(client.isConnected()).toBe(true);
    await sockets[1].message(JSON.stringify(orderMessage));
    await expect(pending).resolves.toMatchObject({ value: { orders: [] } });
    await stream.return(undefined);
  });
});

describe("O2Client WebSocket policy", () => {
  it.each([
    false,
    true,
  ])("stream calls preserve backoff when the next open fails: %s", async (fail) => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const client = new O2Client({
      config: TESTNET,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket.asWebSocket();
      },
    });
    const states: string[] = [];
    let reading: Promise<void> | undefined;
    try {
      const opening = client.streamOrders(
        identities[0].ContractId as Parameters<O2Client["streamOrders"]>[0],
      );
      sockets[0].open();
      const orders = await opening;
      const ordersNext = orders.next();
      const lifecycle = await client.streamLifecycle();
      reading = (async () => {
        for await (const event of lifecycle) states.push(event.state);
      })();
      sockets[0].close();
      const balances = await client.streamBalances(
        identities[0].ContractId as Parameters<O2Client["streamBalances"]>[0],
      );
      const balancesNext = balances.next();
      const extraLifecycle = await client.streamLifecycle();
      await extraLifecycle.return(undefined);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1500);
      let recovered = sockets[1];
      if (fail) {
        recovered.close();
        await vi.advanceTimersByTimeAsync(3000);
        recovered = sockets[2];
      }
      recovered.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(recovered.sent.map((message) => message.action)).toEqual([
        "subscribe_orders",
        "subscribe_balances",
      ]);
      expect(states.filter((state) => state === "reconnected")).toHaveLength(1);
      client.close();
      await expect(ordersNext).resolves.toMatchObject({ done: true });
      await expect(balancesNext).resolves.toMatchObject({ done: true });
      await reading;
    } finally {
      client.close();
      await reading;
    }
  });
  it("awaits the shared connection and forwards the buffer policy", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new O2Client({
      config: TESTNET,
      webSocketOptions: { maxBufferedMessages: 1, reconnect: false },
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket.asWebSocket();
      },
    });
    try {
      const firstOpening = client.streamOrders(
        identities[0].ContractId as Parameters<O2Client["streamOrders"]>[0],
      );
      const secondOpening = client.streamBalances(
        identities[0].ContractId as Parameters<O2Client["streamBalances"]>[0],
      );
      expect(sockets).toHaveLength(1);
      expect(sockets[0].sent).toEqual([]);
      sockets[0].open();
      const [stream, balances] = await Promise.all([firstOpening, secondOpening]);
      const pending = stream.next();
      await sockets[0].message(JSON.stringify(orderMessage));
      await pending;
      await sockets[0].message(JSON.stringify(orderMessage));
      await sockets[0].message(JSON.stringify(orderMessage));
      await expect(stream.next()).rejects.toBeInstanceOf(WebSocketBufferOverflowError);
      await balances.return(undefined);
    } finally {
      client.close();
    }
  });
});
