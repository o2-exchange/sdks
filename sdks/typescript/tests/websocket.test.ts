import { describe, expect, it } from "vitest";
import { TESTNET } from "../src/config.js";
import type { OrderUpdate } from "../src/models.js";
import { O2WebSocket } from "../src/websocket.js";

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
