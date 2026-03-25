import { describe, expect, it } from "vitest";
import { TESTNET } from "../src/config.js";
import type { OrderUpdate } from "../src/models.js";
import { type ConnectionEvent, O2WebSocket } from "../src/websocket.js";

function timeout<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

describe("O2WebSocket parser error handling", () => {
  it("skips malformed payloads and keeps the stream alive", async () => {
    const ws = new O2WebSocket({ config: TESTNET, reconnect: false });
    const stream = ws.streamOrders([{ ContractId: `0x${"11".repeat(32)}` }]);

    const nextValue = stream.next();

    // The handler is registered after the generator starts.
    await Promise.resolve();

    const handlerSet = (
      ws as unknown as {
        handlers: Map<string, Set<(msg: Record<string, unknown>) => void>>;
      }
    ).handlers.get("subscribe_orders");
    expect(handlerSet).toBeDefined();
    expect(handlerSet?.size).toBe(1);
    const handler = handlerSet!.values().next().value!;

    // side:null triggers parseOrder().toLowerCase() failure in parser.
    expect(() =>
      handler({
        action: "subscribe_orders",
        orders: [{ order_id: "0x1", side: null }],
      }),
    ).not.toThrow();

    handler({
      action: "subscribe_orders",
      orders: [
        {
          order_id: "0x1",
          side: "buy",
          order_type: "Spot",
          price: "100",
          quantity: "50",
          timestamp: "0",
          close: false,
        },
      ],
    });

    const result = (await Promise.race([
      nextValue,
      timeout<IteratorResult<OrderUpdate>>(2_000, "timed out waiting for parsed order update"),
    ])) as IteratorResult<OrderUpdate>;

    expect(result.done).toBe(false);
    expect(result.value.orders.length).toBe(1);
    expect(result.value.orders[0].price).toBe(100n);
    expect(result.value.orders[0].quantity).toBe(50n);

    await stream.return(undefined);
  });
});

describe("O2WebSocket lifecycle event delivery", () => {
  it("streamLifecycle yields 'closed' event on disconnect", async () => {
    const ws = new O2WebSocket({ config: TESTNET, reconnect: false });
    const stream = ws.streamLifecycle();

    // Start the generator — it registers handlers and suspends at await
    const nextPromise = stream.next();
    await Promise.resolve();

    // disconnect() emits "closed" lifecycle event then fires close handlers.
    // Before the fix, close handlers set done=true before the generator
    // could yield the queued "closed" event.
    ws.disconnect();

    const result = (await Promise.race([
      nextPromise,
      timeout<IteratorResult<ConnectionEvent>>(
        2_000,
        "timed out waiting for closed lifecycle event",
      ),
    ])) as IteratorResult<ConnectionEvent>;

    expect(result.done).toBe(false);
    expect(result.value.state).toBe("closed");
    expect(result.value.message).toBe("Disconnected by client");

    // Generator should terminate after the terminal event
    const next = await stream.next();
    expect(next.done).toBe(true);
  });

  it("data stream drains queued items before terminating on disconnect", async () => {
    const ws = new O2WebSocket({ config: TESTNET, reconnect: false });
    const stream = ws.streamOrders([{ ContractId: `0x${"22".repeat(32)}` }]);

    // Start the generator
    const nextPromise = stream.next();
    await Promise.resolve();

    // Inject a valid order update via the handler, then immediately disconnect
    const handlerSet = (
      ws as unknown as {
        handlers: Map<string, Set<(msg: Record<string, unknown>) => void>>;
      }
    ).handlers.get("subscribe_orders");
    const handler = handlerSet!.values().next().value!;

    handler({
      action: "subscribe_orders",
      orders: [
        {
          order_id: "0x1",
          side: "buy",
          order_type: "Spot",
          price: "200",
          quantity: "10",
          timestamp: "0",
          close: false,
        },
      ],
    });

    // disconnect() fires close handlers (sets done=true) synchronously.
    // The queued order update should still be yielded via the drain loop.
    ws.disconnect();

    const result = (await Promise.race([
      nextPromise,
      timeout<IteratorResult<OrderUpdate>>(2_000, "timed out waiting for order update"),
    ])) as IteratorResult<OrderUpdate>;

    expect(result.done).toBe(false);
    expect(result.value.orders[0].price).toBe(200n);
  });
});
