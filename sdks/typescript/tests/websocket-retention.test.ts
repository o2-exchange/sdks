import { afterEach, describe, expect, it, vi } from "vitest";
import { O2Client } from "../src/client.js";
import { TESTNET } from "../src/config.js";
import { StreamResyncRequired } from "../src/errors.js";
import { depthPrecision } from "../src/models.js";
import { O2WebSocket, type O2WebSocketOptions } from "../src/websocket.js";

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
    return this.pendingSubscriptions.length;
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

describe("WebSocket stream cleanup", () => {
  it.each(["orders", "trades", "depth"])("cancelling %s in Turbo preserves spot", async (kind) => {
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

  it("breaking a stream releases its server subscription", async () => {
    const { client, socket } = await connected();
    const consuming = (async () => {
      for await (const _message of client.streamOrders(identities)) break;
    })();
    await socket.message(JSON.stringify(orderMessage));
    await consuming;
    expect(client.subscriptions).toBe(0);
    expect(client.listeners).toBe(0);
    expect(socket.sent.at(-1)?.action).toBe("unsubscribe_orders");
  });

  it("does not register a generator that is never started", async () => {
    const { client, socket } = await connected();
    await client.streamOrders(identities).return(undefined);
    await client.streamLifecycle().return(undefined);
    expect(socket.sent).toEqual([]);
    expect(client.listeners).toBe(0);
  });

  it("only unsubscribes identical requests when the final consumer stops", async () => {
    const { client, socket } = await connected();
    const first = client.streamOrders(identities);
    const second = client.streamOrders(identities);
    const firstNext = first.next();
    const secondNext = second.next();
    // Preserve main's per-consumer subscribe send and deduplicated reconnect array.
    expect(socket.sent).toHaveLength(2);
    expect(client.subscriptions).toBe(1);
    await first.return(undefined);
    await expect(firstNext).resolves.toMatchObject({ done: true });
    expect(socket.sent).toHaveLength(2);
    expect(client.subscriptions).toBe(1);
    await socket.message(JSON.stringify(orderMessage));
    await expect(secondNext).resolves.toMatchObject({ done: false });
    await second.return(undefined);
    expect(socket.sent.map((message) => message.action)).toEqual([
      "subscribe_orders",
      "subscribe_orders",
      "unsubscribe_orders",
    ]);
    expect(client.listeners).toBe(0);
    expect(client.subscriptions).toBe(0);
  });

  it("throw cancels a pending read and releases its handlers", async () => {
    const { client } = await connected();
    const stream = client.streamOrders(identities);
    const pending = stream.next();
    const throwing = stream.throw(new Error("consumer failed"));
    await expect(pending).resolves.toMatchObject({ done: true });
    await expect(throwing).rejects.toThrow("consumer failed");
    expect(client.listeners).toBe(0);
    expect(client.subscriptions).toBe(0);
  });

  it("return cancels a pending lifecycle read", async () => {
    const { client } = await connected();
    const stream = client.streamLifecycle();
    const pending = stream.next();
    await stream.return(undefined);
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(client.listeners).toBe(0);
  });

  it("Turbo resync releases all matching consumers while preserving spot", async () => {
    const { client, socket } = await connected();
    const spot = client.streamTrades("0xaaaa");
    const turbo = [
      client.streamTrades("0xaaaa", { turbo: true }),
      client.streamTrades("0xaaaa", { turbo: true }),
    ];
    const spotNext = spot.next();
    const turboReads = turbo.map((stream) =>
      expect(stream.next()).rejects.toBeInstanceOf(StreamResyncRequired),
    );
    await socket.message(
      JSON.stringify({ action: "error", market_id: "0xAAAA", turbo: true, resync_required: true }),
    );
    await Promise.all(turboReads);
    expect(client.subscriptions).toBe(1);
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

  it("drains disconnect data without releasing a replacement stream", async () => {
    const { client, socket, sockets } = await connected();
    const old = client.streamOrders(identities);
    const pending = old.next();
    await socket.message(JSON.stringify(orderMessage));
    await pending;
    await socket.message(JSON.stringify(orderMessage));
    client.disconnect();
    const opening = client.connect();
    sockets[1].open();
    await opening;
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

describe("WebSocket existing stream behavior", () => {
  it.each([1, 2])("accepts a second depth consumer at precision %s", async (precision) => {
    const { client, socket } = await connected();
    const first = client.streamDepth("0xaaaa", depthPrecision(1));
    const second = client.streamDepth("0xaaaa", depthPrecision(precision));
    const reads = [first.next(), second.next()];
    await socket.message(
      JSON.stringify({
        action: "subscribe_depth",
        market_id: "0xaaaa",
        orders: { buys: [], sells: [] },
      }),
    );
    for (const read of reads) await expect(read).resolves.toMatchObject({ done: false });
    await first.return(undefined);
    expect(socket.sent.filter((message) => message.action === "unsubscribe_depth")).toHaveLength(0);
    const next = second.next();
    await socket.message(
      JSON.stringify({
        action: "subscribe_depth_update",
        market_id: "0xaaaa",
        changes: { asks: [], bids: [] },
      }),
    );
    await expect(next).resolves.toMatchObject({ done: false });
    await second.return(undefined);
    expect(socket.sent.filter((message) => message.action === "unsubscribe_depth")).toHaveLength(1);
    expect(client.subscriptions).toBe(0);
  });

  it.each([
    "orders",
    "balances",
    "nonce",
  ])("accepts different identities for %s without client-side rejection", async (kind) => {
    const { client, socket } = await connected();
    const subscribe = (ids: typeof identities) =>
      kind === "orders"
        ? client.streamOrders(ids)
        : kind === "balances"
          ? client.streamBalances(ids)
          : client.streamNonce(ids);
    const first = subscribe(identities);
    const second = subscribe([{ ContractId: `0x${"22".repeat(32)}` }]);
    const reads = [first.next(), second.next()];
    // Server-side topic limits remain unchanged; this probes SDK admission only.
    const message =
      kind === "orders"
        ? orderMessage
        : kind === "balances"
          ? { action: "subscribe_balances", balance: [] }
          : { action: "subscribe_nonce", contract_id: identities[0].ContractId, nonce: "1" };
    await socket.message(JSON.stringify(message));
    for (const read of reads) await expect(read).resolves.toMatchObject({ done: false });
    expect(client.subscriptions).toBe(2);
    await first.return(undefined);
    expect(client.subscriptions).toBe(1);
    expect(socket.sent).toHaveLength(2);
    await second.return(undefined);
    expect(socket.sent.at(-1)?.action).toBe(`unsubscribe_${kind}`);
    expect(client.subscriptions).toBe(0);
  });

  it("keeps a late depth consumer's existing delta delivery behavior", async () => {
    const { client, socket } = await connected();
    const first = client.streamDepth("0xaaaa", depthPrecision(1));
    const initial = first.next();
    await socket.message(
      JSON.stringify({
        action: "subscribe_depth",
        market_id: "0xaaaa",
        orders: { buys: [], sells: [] },
      }),
    );
    await initial;
    const second = client.streamDepth("0xaaaa", depthPrecision(1));
    const next = second.next();
    await socket.message(
      JSON.stringify({
        action: "subscribe_depth_update",
        market_id: "0xaaaa",
        changes: { asks: [], bids: [] },
      }),
    );
    await expect(next).resolves.toMatchObject({ value: { action: "subscribe_depth_update" } });
    await first.return(undefined);
    await second.return(undefined);
  });

  it.each([
    "orders",
    "balances",
    "nonce",
    "trades",
    "depth",
  ])("explicit %s unsubscribe preserves queued data and the local iterator", async (kind) => {
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
    const message =
      kind === "orders"
        ? orderMessage
        : kind === "balances"
          ? { action: "subscribe_balances", balance: [] }
          : kind === "nonce"
            ? { action: "subscribe_nonce", contract_id: identities[0].ContractId, nonce: "1" }
            : kind === "trades"
              ? { action: "subscribe_trades", market_id: "0xaaaa", trades: [] }
              : { action: "subscribe_depth", market_id: "0xaaaa", orders: { buys: [], sells: [] } };
    const first = stream.next();
    await socket.message(JSON.stringify(message));
    await first;
    await socket.message(JSON.stringify(message));
    if (kind === "orders") client.unsubscribeOrders();
    else if (kind === "balances") client.unsubscribeBalances(identities);
    else if (kind === "nonce") client.unsubscribeNonce(identities);
    else if (kind === "trades") client.unsubscribeTrades("0xaaaa");
    else client.unsubscribeDepth("0xaaaa");
    expect(client.subscriptions).toBe(0);
    await expect(stream.next()).resolves.toMatchObject({ done: false });
    const waiting = stream.next();
    await socket.message(JSON.stringify(message));
    await expect(waiting).resolves.toMatchObject({ done: false });
    await stream.return(undefined);
    expect(socket.sent).toHaveLength(2);
    expect(client.listeners).toBe(0);
  });

  it("old cleanup after unsubscribe cannot unsubscribe a replacement topic", async () => {
    const { client, socket } = await connected();
    const old = client.streamOrders(identities);
    const oldNext = old.next();
    client.unsubscribeOrders();
    const fresh = client.streamOrders(identities);
    const freshNext = fresh.next();
    await old.return(undefined);
    await expect(oldNext).resolves.toMatchObject({ done: true });
    expect(client.subscriptions).toBe(1);
    expect(socket.sent.map((message) => message.action)).toEqual([
      "subscribe_orders",
      "unsubscribe_orders",
      "subscribe_orders",
    ]);
    await fresh.return(undefined);
    await freshNext;
    expect(socket.sent.at(-1)?.action).toBe("unsubscribe_orders");
  });

  it("continues buffering and delivering more than 1024 unread messages", async () => {
    const { client, socket } = await connected();
    const stream = client.streamOrders(identities);
    const pending = stream.next();
    await socket.message(JSON.stringify(orderMessage));
    await pending;
    for (let i = 0; i < 2048; i++) await socket.message(JSON.stringify(orderMessage));
    expect(client.subscriptions).toBe(1);
    for (let i = 0; i < 2048; i++)
      await expect(stream.next()).resolves.toMatchObject({ done: false });
    await stream.return(undefined);
    expect(client.listeners).toBe(0);
  });

  it("preserves lifecycle event backlogs beyond 1024 messages", async () => {
    const { client } = await connected();
    const stream = client.streamLifecycle();
    const pending = stream.next();
    client.lifecycle();
    await pending;
    for (let i = 0; i < 2048; i++) client.lifecycle();
    for (let i = 0; i < 2048; i++)
      await expect(stream.next()).resolves.toMatchObject({ done: false });
    await stream.return(undefined);
    expect(client.listeners).toBe(0);
  });

  it("preserves the protected pendingSubscriptions array for subclasses", async () => {
    class ExistingSubclass extends O2WebSocket {
      requests(): Record<string, unknown>[] {
        return this.pendingSubscriptions.filter((request) => request.action === "subscribe_orders");
      }
    }
    const ws = new ExistingSubclass({ config: TESTNET, reconnect: false });
    clients.push(ws);
    const stream = ws.streamOrders(identities);
    const next = stream.next();
    expect(ws.requests()).toEqual([{ action: "subscribe_orders", identities }]);
    await stream.return(undefined);
    await next;
    expect(ws.requests()).toEqual([]);
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

describe("O2Client connection cleanup", () => {
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
  it("awaits the shared initial connection for concurrent streams", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new O2Client({
      config: TESTNET,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket.asWebSocket();
      },
    });
    try {
      const account = identities[0].ContractId as Parameters<O2Client["streamOrders"]>[0];
      const first = client.streamOrders(account);
      const second = client.streamBalances(account);
      expect(sockets).toHaveLength(1);
      expect(sockets[0].sent).toEqual([]);
      sockets[0].open();
      const streams = await Promise.all([first, second]);
      const reads = streams.map((stream) => stream.next());
      expect(sockets[0].sent.map((message) => message.action)).toEqual([
        "subscribe_orders",
        "subscribe_balances",
      ]);
      client.close();
      for (const read of reads) await expect(read).resolves.toMatchObject({ done: true });
    } finally {
      client.close();
    }
  });
});
