/**
 * Golden-fixture tests for margin call derivation.
 *
 * The expected `callData` strings below are NOT hand-computed. They were
 * produced by encoding the same arguments with `fuels`' own `Interface`
 * against the deployed margin ABIs (margin-pool, prop-account,
 * trade-account-registry), which is the encoder the backend's derivation
 * ultimately agrees with. Treat a failure here as "the contract ABI moved",
 * not "the test is wrong" — regenerate rather than adjust.
 */

import { describe, expect, it } from "vitest";
import { bytesToHex } from "../../src/encoding.js";
import {
  addCollateralAction,
  addMarginCollateralAction,
  borrowAction,
  closeMarginSessionAction,
  drawAction,
  prolongSessionAction,
  registerMarginAccountAction,
  repayAction,
  repayBaseFromCollateralAction,
  repayFromCollateralAction,
  returnQuoteAction,
  revokeMarginAccountSessionAction,
  setAutoProlongAction,
  setMarginAccountSessionAction,
  startMarginSessionAction,
  withdrawFromMarginAccountAction,
  withdrawFromMarginAction,
} from "../../src/turbo/actions.js";
import type { MarginWiring } from "../../src/turbo/encoding.js";
import { marginActionToCall, u256BE } from "../../src/turbo/encoding.js";
import type { Hex } from "../../src/turbo/wire.js";

const ASSET = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const CHILD = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const SESSION = "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex;
const ORDER = "0x4444444444444444444444444444444444444444444444444444444444444444" as Hex;
const POOL = "0xaaaa111111111111111111111111111111111111111111111111111111111111" as Hex;
const REGISTRY = "0xbbbb222222222222222222222222222222222222222222222222222222222222" as Hex;
const COLLATERAL = "0xcccc333333333333333333333333333333333333333333333333333333333333" as Hex;
const PARENT = "0xdddd444444444444444444444444444444444444444444444444444444444444" as Hex;

const wiring: MarginWiring = {
  poolId: POOL,
  registryId: REGISTRY,
  collateralAssetId: COLLATERAL,
  parentAccountId: PARENT,
  marginAccountId: CHILD,
};

/** `u64::MAX` — `GAS_FORWARDED_FOR_ACTIONS` on the backend. */
const GAS = 18446744073709551615n;
const ZERO = `0x${"00".repeat(32)}`;

const selectorOf = (name: string): string =>
  bytesToHex(
    new Uint8Array([
      ...new Uint8Array(new BigUint64Array([BigInt(name.length)]).buffer).reverse(),
      ...new TextEncoder().encode(name),
    ]),
  );

describe("margin call derivation — call data (golden, from fuels)", () => {
  const cases: [string, ReturnType<typeof drawAction> | object, string][] = [
    ["Draw", drawAction(1234567n), "0x000000000012d687"],
    ["ReturnQuote", returnQuoteAction(500n), "0x"],
    [
      "Borrow",
      borrowAction(ASSET, 99n),
      "0x11111111111111111111111111111111111111111111111111111111111111110000000000000063",
    ],
    ["Repay", repayAction(ASSET, 12n), "0x"],
    ["RepayFromCollateral", repayFromCollateralAction(555n), "0x000000000000022b"],
    [
      "RepayBaseFromCollateral",
      repayBaseFromCollateralAction(ASSET, 77n),
      "0x1111111111111111111111111111111111111111111111111111111111111111000000000000004d",
    ],
    [
      "ProlongSession(Week, 2)",
      prolongSessionAction("Week", 2),
      "0x00000000000000020000000000000002",
    ],
    ["SetAutoProlong(Month)", setAutoProlongAction("Month"), "0x00000000000000010000000000000003"],
    ["SetAutoProlong(null)", setAutoProlongAction(null), "0x0000000000000000"],
    ["AddCollateral", addCollateralAction(1000n), CHILD],
    [
      "WithdrawFromMargin",
      withdrawFromMarginAction(ASSET, 42n),
      "0x1111111111111111111111111111111111111111111111111111111111111111000000000000002a",
    ],
    [
      "StartMarginSession",
      startMarginSessionAction(CHILD, 3, 500000n, "Day"),
      "0x0000000000000003000000000007a1200000000000000001",
    ],
    ["AddMarginCollateral", addMarginCollateralAction(CHILD, 250n), CHILD],
    ["CloseMarginSession(empty)", closeMarginSessionAction(CHILD, []), "0x0000000000000000"],
    [
      "CloseMarginSession(one book, one order)",
      closeMarginSessionAction(CHILD, [{ order_book_id: ASSET, order_ids: [SESSION] }]),
      "0x0000000000000001111111111111111111111111111111111111111111111111111111111111111100000000000000013333333333333333333333333333333333333333333333333333333333333333",
    ],
    [
      "CloseMarginSession(two books)",
      closeMarginSessionAction(CHILD, [
        { order_book_id: ASSET, order_ids: [SESSION, ORDER] },
        { order_book_id: ORDER, order_ids: [] },
      ]),
      "0x0000000000000002111111111111111111111111111111111111111111111111111111111111111100000000000000023333333333333333333333333333333333333333333333333333333333333333444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444440000000000000000",
    ],
    [
      "WithdrawFromMarginAccount",
      withdrawFromMarginAccountAction(CHILD, ASSET, 42n),
      "0x1111111111111111111111111111111111111111111111111111111111111111000000000000002a",
    ],
    [
      "SetMarginAccountSession",
      setMarginAccountSessionAction({
        marginAccountId: CHILD,
        marginNonce: "12345",
        sessionId: { Address: SESSION },
        expiry: 4102444800,
      }),
      "0x00000000000000000000000000000000000000000000000000000000000030390000000000000000333333333333333333333333333333333333333333333333333333333333333300000000f48657000000000000000000",
    ],
    [
      "RevokeMarginAccountSession",
      revokeMarginAccountSessionAction(CHILD, "12345"),
      "0x0000000000000000000000000000000000000000000000000000000000003039",
    ],
    [
      "RegisterMarginAccount",
      registerMarginAccountAction(CHILD, 1),
      `0x22222222222222222222222222222222222222222222222222222222222222220000000000000001${PARENT.slice(2)}0000000000000001`,
    ],
  ];

  for (const [label, action, expected] of cases) {
    it(`${label} encodes byte-for-byte`, () => {
      const call = marginActionToCall(action as any, wiring);
      expect(bytesToHex(call.callData ?? new Uint8Array(0))).toBe(expected.toLowerCase());
    });
  }
});

describe("margin call derivation — targets", () => {
  it("routes pool actions to the pool", () => {
    for (const action of [
      drawAction(1n),
      returnQuoteAction(1n),
      borrowAction(ASSET, 1n),
      repayAction(ASSET, 1n),
      repayFromCollateralAction(1n),
      repayBaseFromCollateralAction(ASSET, 1n),
      prolongSessionAction("Day", 1),
      setAutoProlongAction(null),
      addCollateralAction(1n),
      withdrawFromMarginAction(ASSET, 1n),
    ]) {
      expect(bytesToHex(marginActionToCall(action, wiring).contractId)).toBe(POOL);
    }
  });

  it("routes StartMarginSession, Close, Withdraw and SetSession to the CHILD", () => {
    for (const action of [
      startMarginSessionAction(CHILD, 1, 1n, "Day"),
      closeMarginSessionAction(CHILD),
      withdrawFromMarginAccountAction(CHILD, ASSET, 1n),
      revokeMarginAccountSessionAction(CHILD, "1"),
    ]) {
      expect(bytesToHex(marginActionToCall(action, wiring).contractId)).toBe(CHILD);
    }
  });

  it("routes AddMarginCollateral to the POOL, never the child", () => {
    const call = marginActionToCall(addMarginCollateralAction(CHILD, 5n), wiring);
    expect(bytesToHex(call.contractId)).toBe(POOL);
  });

  it("routes RegisterMarginAccount to the REGISTRY", () => {
    const call = marginActionToCall(registerMarginAccountAction(CHILD, 0), wiring);
    expect(bytesToHex(call.contractId)).toBe(REGISTRY);
  });
});

describe("margin call derivation — forwarded coins", () => {
  it("forwards collateral on ReturnQuote, and nothing on the netting repays", () => {
    const ret = marginActionToCall(returnQuoteAction(700n), wiring);
    expect(ret.amount).toBe(700n);
    expect(bytesToHex(ret.assetId)).toBe(COLLATERAL);

    // Two pool-side ledgers falling together is not a transfer.
    for (const action of [
      repayFromCollateralAction(700n),
      repayBaseFromCollateralAction(ASSET, 700n),
      borrowAction(ASSET, 700n),
      drawAction(700n),
    ]) {
      const call = marginActionToCall(action, wiring);
      expect(call.amount).toBe(0n);
      expect(bytesToHex(call.assetId)).toBe(ZERO);
    }
  });

  it("forwards the DEBT asset on Repay, not the collateral", () => {
    const call = marginActionToCall(repayAction(ASSET, 33n), wiring);
    expect(call.amount).toBe(33n);
    expect(bytesToHex(call.assetId)).toBe(ASSET);
  });

  it("forwards the collateral on StartMarginSession and both AddCollateral forms", () => {
    for (const [action, amount] of [
      [startMarginSessionAction(CHILD, 1, 900n, "Week"), 900n],
      [addCollateralAction(400n), 400n],
      [addMarginCollateralAction(CHILD, 250n), 250n],
    ] as const) {
      const call = marginActionToCall(action, wiring);
      expect(call.amount).toBe(amount);
      expect(bytesToHex(call.assetId)).toBe(COLLATERAL);
    }
  });
});

describe("margin call derivation — selectors and gas", () => {
  it("uses the Sway method names the pool and child expose", () => {
    const expectations: [object, string][] = [
      [drawAction(1n), "draw"],
      [returnQuoteAction(1n), "return_quote"],
      [borrowAction(ASSET, 1n), "borrow"],
      [repayAction(ASSET, 1n), "repay"],
      [repayFromCollateralAction(1n), "repay_from_collateral"],
      [repayBaseFromCollateralAction(ASSET, 1n), "repay_base_from_collateral"],
      [prolongSessionAction("Day", 1), "prolong_session"],
      [setAutoProlongAction(null), "set_auto_prolong"],
      [addCollateralAction(1n), "add_collateral"],
      [withdrawFromMarginAction(ASSET, 1n), "withdraw"],
      [startMarginSessionAction(CHILD, 1, 1n, "Day"), "start_session"],
      [addMarginCollateralAction(CHILD, 1n), "add_collateral"],
      [closeMarginSessionAction(CHILD), "close_session"],
      [withdrawFromMarginAccountAction(CHILD, ASSET, 1n), "withdraw"],
      [revokeMarginAccountSessionAction(CHILD, "1"), "revoke_session"],
      [registerMarginAccountAction(CHILD, 0), "prop_register_contract"],
    ];
    for (const [action, name] of expectations) {
      const call = marginActionToCall(action as any, wiring);
      expect(bytesToHex(call.functionSelector)).toBe(selectorOf(name));
      expect(call.gas).toBe(GAS);
    }
  });
});

describe("u256BE", () => {
  it("encodes 32 big-endian bytes", () => {
    expect(bytesToHex(u256BE(0n))).toBe(`0x${"00".repeat(32)}`);
    expect(bytesToHex(u256BE("12345"))).toBe(`0x${"00".repeat(30)}3039`);
  });

  it("refuses negatives and overflow", () => {
    expect(() => u256BE(-1n)).toThrow(/negative/);
    expect(() => u256BE(2n ** 256n)).toThrow(/does not fit/);
  });
});

describe("wiring preconditions", () => {
  it("refuses AddCollateral without the child's own id", () => {
    const { marginAccountId: _omitted, ...rest } = wiring;
    expect(() => marginActionToCall(addCollateralAction(1n), rest)).toThrow(/marginAccountId/);
  });
});
