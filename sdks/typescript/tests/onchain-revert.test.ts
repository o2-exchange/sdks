/**
 * Tests for on-chain revert code decoding.
 *
 * Ported from the Python/Rust SDK tests.
 */
import { describe, expect, it } from "vitest";
import { OnChainRevertError, parseApiError } from "../src/errors.js";
import { augmentRevertReason } from "../src/onchain-revert.js";

// ---------------------------------------------------------------------------
// augmentRevertReason — direct unit tests
// ---------------------------------------------------------------------------

describe("augmentRevertReason", () => {
  it("decodes OrderCreationError from CreateOrder context", () => {
    const message =
      "Failed payload ... CreateOrder { side: Buy } ... " + "Revert(18446744073709486086)";
    const decoded = augmentRevertReason(message, undefined, undefined);
    expect(decoded).toContain("OrderCreationError::FractionalPrice");
    expect(decoded).toContain("ordinal=6");
  });

  it("decodes even when reason is empty", () => {
    const message = "CreateOrder Revert(18446744073709486080)";
    const decoded = augmentRevertReason(message, "", undefined);
    expect(decoded).toContain("OrderCreationError::InvalidOrderArgs");
    expect(decoded).toContain("ordinal=0");
  });

  it("decodes NotEnoughBalance", () => {
    const message = "Withdraw Revert(18446744073709486081)";
    const decoded = augmentRevertReason(message, undefined, undefined);
    expect(decoded).toContain("WithdrawError::NotEnoughBalance");
    expect(decoded).toContain("ordinal=1");
  });

  it("leaves reason unchanged when no revert code", () => {
    const decoded = augmentRevertReason("some error", "reason", undefined);
    expect(decoded).toBe("reason");
  });

  it("decodes CancelOrder context", () => {
    const message = "CancelOrder Revert(18446744073709486080)";
    const decoded = augmentRevertReason(message, undefined, undefined);
    expect(decoded).toContain("OrderCancelError::NotOrderOwner");
  });

  it("decodes session context", () => {
    const message = "Session Revert(18446744073709486080)";
    const decoded = augmentRevertReason(message, undefined, undefined);
    expect(decoded).toContain("SessionError::SessionInThePast");
  });

  it("decodes nonce context", () => {
    const message = "Nonce Revert(18446744073709486080)";
    const decoded = augmentRevertReason(message, undefined, undefined);
    expect(decoded).toContain("NonceError::InvalidNonce");
  });

  it("maps SettleBalance to OrderCreationError", () => {
    const message = "SettleBalance Revert(18446744073709486080)";
    const decoded = augmentRevertReason(message, undefined, undefined);
    expect(decoded).toContain("OrderCreationError::InvalidOrderArgs");
  });

  it("falls back to ambiguous when no context", () => {
    // ordinal=1 matches many enums
    const message = "Revert(18446744073709486081)";
    const decoded = augmentRevertReason(message, undefined, undefined);
    expect(decoded).toContain("ambiguous ABI error ordinal=1");
    expect(decoded).toContain("candidates=");
  });

  it("reports unknown for high ordinal", () => {
    // ordinal=100 exceeds all enum sizes
    const message = "Revert(18446744073709486180)";
    const decoded = augmentRevertReason(message, undefined, undefined);
    expect(decoded).toContain("unknown ABI error ordinal=100");
  });

  it("ignores non-Fuel revert codes", () => {
    const message = "Revert(42)";
    const decoded = augmentRevertReason(message, "original", undefined);
    expect(decoded).toBe("original");
  });

  it("searches receipts for revert codes", () => {
    const receipts = [{ type: "Revert", val: "Revert(18446744073709486081)" }];
    const decoded = augmentRevertReason("CreateOrder", undefined, receipts);
    expect(decoded).toContain("OrderCreationError::InvalidInputAmount");
  });

  it("treats undefined reason as empty string", () => {
    const decoded = augmentRevertReason("no revert here", undefined, undefined);
    expect(decoded).toBe("");
  });

  it("decodes ordinal zero with context", () => {
    // 0xffffffffffff0000 | 0 = 0xffffffffffff0000
    const message = "CreateOrder ... Revert(18446744073709486080)";
    const decoded = augmentRevertReason(message, "reason", undefined);
    expect(decoded).toContain("OrderCreationError::InvalidOrderArgs");
  });

  it("truncates long reason without revert code", () => {
    const reason = "x".repeat(500);
    const decoded = augmentRevertReason("error", reason, undefined);
    expect(decoded.length).toBeLessThan(300);
    expect(decoded).toContain("truncated");
  });

  it("returns clean decoded when reason already contains tag", () => {
    const tag =
      "contract_schema::order_book::OrderCreationError::FractionalPrice (ordinal=6, raw=0xffffffffffff0006)";
    const reason = `tx reverted [${tag}]`;
    const decoded = augmentRevertReason(
      "CreateOrder ... Revert(18446744073709486086)",
      reason,
      undefined,
    );
    expect(decoded).toBe(tag);
  });
});

// ---------------------------------------------------------------------------
// Integration: parseApiError produces OnChainRevertError with decoded reason
// ---------------------------------------------------------------------------

describe("parseApiError on-chain revert integration", () => {
  it("decodes revert code in API error response", () => {
    const body = {
      message: "CreateOrder failed: Revert(18446744073709486086)",
      reason: null,
      receipts: [],
    };
    const err = parseApiError(body);
    expect(err).toBeInstanceOf(OnChainRevertError);
    expect(err.reason).toContain("OrderCreationError::FractionalPrice");
  });

  it("preserves original reason when no revert code", () => {
    const body = {
      message: "transaction failed",
      reason: "out of gas",
      receipts: [],
    };
    const err = parseApiError(body);
    expect(err).toBeInstanceOf(OnChainRevertError);
    expect(err.reason).toBe("out of gas");
  });

  it("toString uses decoded reason", () => {
    const body = {
      message: "CreateOrder failed: Revert(18446744073709486086)",
      reason: null,
      receipts: [],
    };
    const err = parseApiError(body) as OnChainRevertError;
    expect(err.toString()).toContain("On-chain revert:");
    expect(err.toString()).toContain("FractionalPrice");
  });

  it("toString falls back to message when no reason", () => {
    const err = new OnChainRevertError("raw error message");
    expect(err.toString()).toBe("On-chain revert: raw error message");
  });
});
