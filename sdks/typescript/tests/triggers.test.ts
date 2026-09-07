/**
 * Golden-fixture tests for trigger (TP/SL) call encoding.
 *
 * The expected strings are NOT hand-computed: they came from encoding the
 * same arguments with `fuels`' own `Interface` against the DEPLOYED
 * order-book ABI. Two details they pin down that a reading of the wire
 * types would get wrong:
 *
 *  - the contract orders `TriggerOrderArgs` as `quantity, order_type,
 *    trigger_price` — the reverse of the JSON shape;
 *  - `side` is absent from the call data entirely, because the contract
 *    reads it off the forwarded asset.
 */

import { describe, expect, it } from "vitest";
import type { ActionJSON, MarketInfo } from "../src/encoding.js";
import {
  actionToCall,
  adjustQuantityForPrices,
  bytesToHex,
  encodeTriggerArgs,
} from "../src/encoding.js";
import {
  orderPairByLock,
  PARENT_ORDER_PLACEHOLDER,
  stopLimit,
  stopMarket,
  stopMarketBounded,
  triggerFromParent,
  triggerJudgedPrices,
  triggerLeg,
  triggerLockAmount,
  triggerLockPrice,
  triggerQuantity,
  withTriggerQuantity,
} from "../src/triggers.js";

const PARENT = `0x${"aa".repeat(32)}`;
const market: MarketInfo = {
  contractId: `0x${"11".repeat(32)}`,
  marketId: `0x${"22".repeat(32)}`,
  base: { asset: `0x${"bb".repeat(32)}`, decimals: 9, maxPrecision: 4, symbol: "fETH" },
  quote: { asset: `0x${"cc".repeat(32)}`, decimals: 9, maxPrecision: 2, symbol: "fUSDC" },
};

const legQtyMarket = triggerLeg({
  side: "sell",
  triggerPrice: 2500n,
  kind: stopMarket,
  quantity: triggerQuantity(5000n),
});
const legQtySpot = triggerLeg({
  side: "sell",
  triggerPrice: 2500n,
  kind: stopLimit(2400n),
  quantity: triggerQuantity(5000n),
});
const legQtyBounded = triggerLeg({
  side: "sell",
  triggerPrice: 2500n,
  kind: stopMarketBounded(2600n, 2400n),
  quantity: triggerQuantity(5000n),
});
const legParent = triggerLeg({
  side: "sell",
  triggerPrice: 2500n,
  kind: stopMarket,
  quantity: triggerFromParent(PARENT),
});

describe("TriggerOrderArgs encoding (golden, from the deployed ABI)", () => {
  it("Quantity + Market", () => {
    expect(bytesToHex(encodeTriggerArgs(legQtyMarket))).toBe(
      "0x00000000000000000000000000001388000000000000000000000000000009c4",
    );
  });

  it("Quantity + Spot(limit)", () => {
    expect(bytesToHex(encodeTriggerArgs(legQtySpot))).toBe(
      "0x000000000000000000000000000013880000000000000002000000000000096000000000000009c4",
    );
  });

  it("Quantity + MarketBounded encodes max BEFORE min", () => {
    expect(bytesToHex(encodeTriggerArgs(legQtyBounded))).toBe(
      "0x0000000000000000000000000000138800000000000000010000000000000a28000000000000096000000000000009c4",
    );
  });

  it("ParentOrder carries the 32-byte parent id", () => {
    expect(bytesToHex(encodeTriggerArgs(legParent))).toBe(
      `0x0000000000000001${"aa".repeat(32)}000000000000000000000000000009c4`,
    );
  });

  it("omits `side` — the contract reads it off the forwarded asset", () => {
    const buySide = { ...legQtyMarket, side: "buy" as const };
    expect(bytesToHex(encodeTriggerArgs(buySide))).toBe(
      bytesToHex(encodeTriggerArgs(legQtyMarket)),
    );
  });
});

describe("create_trigger_order", () => {
  it("encodes args + Option::None for a standalone leg", () => {
    const call = actionToCall({ CreateTriggerOrder: { args: legQtyMarket } } as ActionJSON, market);
    expect(bytesToHex(call.callData ?? new Uint8Array())).toBe(
      "0x00000000000000000000000000001388000000000000000000000000000009c40000000000000000",
    );
  });

  it("encodes Option::Some(expected_quantity) when bound to a parent", () => {
    const call = actionToCall(
      {
        CreateTriggerOrder: {
          args: legParent,
          parent: { order_id: PARENT, expected_quantity: "777" },
        },
      } as ActionJSON,
      market,
    );
    expect(bytesToHex(call.callData ?? new Uint8Array())).toBe(
      `0x0000000000000001${"aa".repeat(32)}000000000000000000000000000009c400000000000000010000000000000309`,
    );
  });
});

describe("create_trigger_orders (OCO pair)", () => {
  it("encodes both legs then the optional expected quantity", () => {
    const first = triggerLeg({
      side: "sell",
      triggerPrice: 2600n,
      kind: stopLimit(2600n),
      quantity: triggerFromParent(PARENT),
    });
    const second = triggerLeg({
      side: "sell",
      triggerPrice: 2400n,
      kind: stopMarket,
      quantity: triggerFromParent(PARENT),
    });
    const call = actionToCall({ CreateTriggerOrders: { first, second } } as ActionJSON, market);
    expect(bytesToHex(call.callData ?? new Uint8Array())).toBe(
      `0x0000000000000001${"aa".repeat(32)}00000000000000020000000000000a280000000000000a280000000000000001${"aa".repeat(32)}000000000000000000000000000009600000000000000000`,
    );
  });
});

describe("create_order_with_triggers", () => {
  const attached = (kind: ReturnType<typeof stopLimit>) =>
    triggerLeg({
      side: "sell",
      triggerPrice: 2600n,
      kind,
      quantity: triggerFromParent(PARENT_ORDER_PLACEHOLDER),
    });

  it("encodes OrderArgs + one trigger + Option::None", () => {
    const call = actionToCall(
      {
        CreateOrderWithTriggers: {
          side: "buy",
          price: "2500",
          quantity: "4000",
          order_type: "Spot",
          trigger_1: attached(stopLimit(2600n)),
        },
      } as ActionJSON,
      market,
    );
    expect(bytesToHex(call.callData ?? new Uint8Array())).toBe(
      `0x00000000000009c40000000000000fa000000000000000010000000000000001${"00".repeat(32)}00000000000000020000000000000a280000000000000a280000000000000000`,
    );
  });

  it("encodes a second trigger as Option::Some", () => {
    const tp = attached(stopLimit(2600n));
    const sl = triggerLeg({
      side: "sell",
      triggerPrice: 2400n,
      kind: stopMarket,
      quantity: triggerFromParent(PARENT_ORDER_PLACEHOLDER),
    });
    const call = actionToCall(
      {
        CreateOrderWithTriggers: {
          side: "buy",
          price: "2500",
          quantity: "4000",
          order_type: "Market",
          trigger_1: tp,
          trigger_2: sl,
        },
      } as ActionJSON,
      market,
    );
    expect(bytesToHex(call.callData ?? new Uint8Array())).toBe(
      `0x00000000000009c40000000000000fa000000000000000040000000000000001${"00".repeat(32)}00000000000000020000000000000a280000000000000a2800000000000000010000000000000001${"00".repeat(32)}00000000000000000000000000000960`,
    );
  });

  it("escrows exactly what a plain CreateOrder would", () => {
    const withTriggers = actionToCall(
      {
        CreateOrderWithTriggers: {
          side: "buy",
          price: "2500",
          quantity: "4000",
          order_type: "Spot",
          trigger_1: attached(stopLimit(2600n)),
        },
      } as ActionJSON,
      market,
    );
    const plain = actionToCall(
      {
        CreateOrder: { side: "buy", price: "2500", quantity: "4000", order_type: "Spot" },
      } as ActionJSON,
      market,
    );
    expect(withTriggers.amount).toBe(plain.amount);
    expect(bytesToHex(withTriggers.assetId)).toBe(bytesToHex(plain.assetId));
  });
});

describe("cancel_trigger_order", () => {
  it("shares the spot cancel selector and sends the bare id", () => {
    const trigger = actionToCall(
      { CancelTriggerOrder: { order_id: PARENT } } as ActionJSON,
      market,
    );
    const spot = actionToCall({ CancelOrder: { order_id: PARENT } } as ActionJSON, market);
    // One `cancel_order` entry point; the contract dispatches on the id's
    // own `is_trigger` flag.
    expect(bytesToHex(trigger.functionSelector)).toBe(bytesToHex(spot.functionSelector));
    expect(bytesToHex(trigger.callData ?? new Uint8Array())).toBe(PARENT);
    expect(trigger.amount).toBe(0n);
  });
});

describe("escrow", () => {
  it("locks at the limit price, the worst bound, or the trigger price", () => {
    expect(triggerLockPrice(legQtySpot)).toBe(2400n);
    expect(triggerLockPrice(legQtyBounded)).toBe(2600n);
    expect(triggerLockPrice(legQtyMarket)).toBe(2500n);
  });

  it("a SELL escrows the base, a BUY escrows quote", () => {
    const sell = actionToCall({ CreateTriggerOrder: { args: legQtyMarket } } as ActionJSON, market);
    expect(sell.amount).toBe(5000n);
    expect(bytesToHex(sell.assetId)).toBe(market.base.asset);

    const buyLeg = { ...legQtySpot, side: "buy" as const };
    const buy = actionToCall({ CreateTriggerOrder: { args: buyLeg } } as ActionJSON, market);
    // 5000 * 2400 / 1e9 rounds to zero at this scale — the point is the
    // formula and the asset, both of which the backend re-derives.
    expect(buy.amount).toBe((5000n * 2400n) / 10n ** 9n);
    expect(bytesToHex(buy.assetId)).toBe(market.quote.asset);
  });

  it("an inherited leg escrows NOTHING — the parent's funds cover it", () => {
    expect(triggerLockAmount(legParent, 9).amount).toBe(0n);
    const call = actionToCall({ CreateTriggerOrder: { args: legParent } } as ActionJSON, market);
    expect(call.amount).toBe(0n);
  });

  it("orders a pair so the bigger lock leads — the chain funds both from it", () => {
    const small = triggerLeg({
      side: "sell",
      triggerPrice: 100n,
      kind: stopLimit(100n),
      quantity: triggerQuantity(10n),
    });
    const large = triggerLeg({
      side: "sell",
      triggerPrice: 100n,
      kind: stopLimit(100n),
      quantity: triggerQuantity(99n),
    });
    expect(orderPairByLock(small, large, 9)[0]).toBe(large);
    expect(orderPairByLock(large, small, 9)[0]).toBe(large);
  });
});

describe("regression: OCO pair is ordered AFTER fitting", () => {
  /**
   * The chain escrows only `first`'s lock to cover both legs. Fitting
   * rounds each leg down against its OWN prices, so ordering before the
   * fit can leave the lead cheaper than its sibling and under-fund the
   * pair — a rejection after signing.
   */
  it("leads with the leg that locks more once both are fitted", () => {
    // Both sells, equal raw quantity. `a` prices at 1e9 (quantum 1, so it
    // survives the fit); `b` prices at 999_999_999 — coprime with 10^9,
    // so its quantum is 10^9 and the fit rounds it down hard.
    const a = triggerLeg({
      side: "sell",
      triggerPrice: 1_000_000_000n,
      kind: stopLimit(1_000_000_000n),
      quantity: triggerQuantity(1_500_000_000n),
    });
    const b = triggerLeg({
      side: "sell",
      triggerPrice: 999_999_999n,
      kind: stopLimit(999_999_999n),
      quantity: triggerQuantity(1_500_000_000n),
    });
    const fitLeg = (leg: typeof a) => {
      const q = BigInt((leg.quantity as { Quantity: { quantity: string } }).Quantity.quantity);
      return withTriggerQuantity(leg, adjustQuantityForPrices(triggerJudgedPrices(leg), q, 9));
    };

    // Ordering the RAW pair puts them either way round; ordering the
    // FITTED pair must put the larger surviving lock first.
    const [lead] = orderPairByLock(fitLeg(a), fitLeg(b), 9);
    const leadQty = BigInt((lead.quantity as { Quantity: { quantity: string } }).Quantity.quantity);
    const aQty = BigInt(
      (fitLeg(a).quantity as { Quantity: { quantity: string } }).Quantity.quantity,
    );
    const bQty = BigInt(
      (fitLeg(b).quantity as { Quantity: { quantity: string } }).Quantity.quantity,
    );
    expect(bQty).toBeLessThan(aQty); // the fit really did diverge them
    expect(leadQty).toBe(aQty); // and the bigger one leads
  });
});
