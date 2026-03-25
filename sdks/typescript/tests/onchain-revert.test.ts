/**
 * Tests for on-chain revert code decoding.
 *
 * Tests the new decoding strategy:
 * 1. LogResult extraction (backend-decoded names)
 * 2. LogData receipt parsing (logId + discriminant)
 * 3. Signal constant recognition
 * 4. PanicInstruction extraction
 * 5. "and error:" fallback
 *
 * Ported from the Python SDK tests.
 */
import { describe, expect, it } from "vitest";
import { OnChainRevertError, parseApiError } from "../src/errors.js";
import { augmentRevertReason } from "../src/onchain-revert.js";

// ---------------------------------------------------------------------------
// Realistic reason string from a real backend error response.
// The backend wraps the fuels-rs error chain in the reason field.
// ---------------------------------------------------------------------------

const REALISTIC_REASON =
  "Failed to process SessionCallPayload { actions: [MarketActions { actions: " +
  "[SettleBalance, CreateOrder { side: Buy }] }] } with error: " +
  "Transaction abc123 failed with logs: LogResult { results: " +
  '[Ok("IncrementNonceEvent { nonce: 2752 }"), ' +
  'Ok("SessionContractCallEvent { nonce: 2751 }"), ' +
  'Ok("SessionContractCallEvent { nonce: 2751 }"), ' +
  'Ok("OrderCreatedEvent { quantity: 1000000, price: 2129980000000 }"), ' +
  'Ok("OrderMatchedEvent { quantity: 1000000, price: 2129320000000 }"), ' +
  'Ok("FeesCollectedEvent { base_fees: 100, quote_fees: 0 }"), ' +
  'Ok("OrderPartiallyFilled")] } ' +
  "and error: transaction reverted: Revert(18446744073709486086), " +
  "receipts: [Call { id: 0000, to: f155, amount: 0 }, " +
  "LogData { id: f155, ra: 0, rb: 2261086600904378517, ptr: 67108286, len: 8, " +
  "digest: abc, data: Some(Bytes(0000000000000000)) }, " +
  "LogData { id: 2a78, ra: 0, rb: 12033795032676640771, ptr: 67100980, len: 8, " +
  "digest: 4c0e, data: Some(Bytes(0000000000000008)) }, " +
  "Revert { id: 2a78, ra: 18446744073709486086 }, " +
  "ScriptResult { result: Revert }]";

// ---------------------------------------------------------------------------
// Strategy 1: LogResult extraction
// ---------------------------------------------------------------------------

describe("Strategy 1: LogResult extraction", () => {
  it("extracts error from log result", () => {
    const decoded = augmentRevertReason(
      "Failed to process transaction",
      REALISTIC_REASON,
      undefined,
    );
    expect(decoded).toBe("contract_schema::order_book::OrderCreationError::OrderPartiallyFilled");
  });

  it("log result with escaped quotes", () => {
    const reason =
      'LogResult { results: [Ok(\\"IncrementNonceEvent\\"), ' + 'Ok(\\"TraderNotWhiteListed\\")] }';
    const decoded = augmentRevertReason("msg", reason, undefined);
    expect(decoded).toBe("contract_schema::order_book::OrderCreationError::TraderNotWhiteListed");
  });

  it("log result ignores non-error entries", () => {
    const reason =
      'LogResult { results: [Ok("IncrementNonceEvent"), ' +
      'Ok("OrderCreatedEvent"), Ok("NotEnoughBalance")] }';
    const decoded = augmentRevertReason("msg", reason, undefined);
    expect(decoded).toBe("contract_schema::trade_account::WithdrawError::NotEnoughBalance");
  });
});

// ---------------------------------------------------------------------------
// Strategy 2: LogData receipt parsing
// ---------------------------------------------------------------------------

describe("Strategy 2: LogData receipt parsing", () => {
  it("extracts error from logdata receipt", () => {
    // LogData with rb=12033795032676640771 (OrderCreationError) and data=0x08 (OrderPartiallyFilled)
    const reason =
      "receipts: [LogData { id: abc, ra: 0, rb: 12033795032676640771, " +
      "ptr: 100, len: 8, digest: def, data: Some(Bytes(0000000000000008)) }, " +
      "Revert { id: abc, ra: 18446744073709486086 }]";
    const decoded = augmentRevertReason("msg", reason, undefined);
    expect(decoded).toBe("contract_schema::order_book::OrderCreationError::OrderPartiallyFilled");
  });

  it("logdata discriminant zero", () => {
    const reason =
      "LogData { id: x, ra: 0, rb: 12033795032676640771, " +
      "ptr: 0, len: 8, digest: y, data: Some(Bytes(0000000000000000)) }, " +
      "Revert { id: x, ra: 18446744073709486086 }";
    const decoded = augmentRevertReason("msg", reason, undefined);
    expect(decoded).toBe("contract_schema::order_book::OrderCreationError::InvalidOrderArgs");
  });

  it("logdata withdraw error", () => {
    const reason =
      "LogData { id: x, ra: 0, rb: 14888260448086063780, " +
      "ptr: 0, len: 8, digest: y, data: Some(Bytes(0000000000000001)) }, " +
      "Revert { id: x, ra: 18446744073709486000 }";
    const decoded = augmentRevertReason("msg", reason, undefined);
    expect(decoded).toBe("contract_schema::trade_account::WithdrawError::NotEnoughBalance");
  });

  it("logdata unknown log id falls through", () => {
    const reason =
      "LogData { id: x, ra: 0, rb: 9999999999999999999, " +
      "ptr: 0, len: 8, digest: y, data: Some(Bytes(0000000000000000)) }, " +
      "Revert { id: x, ra: 18446744073709486086 }";
    const decoded = augmentRevertReason("msg", reason, undefined);
    // Falls through to signal recognition
    expect(decoded).toContain("REVERT_WITH_LOG");
  });
});

// ---------------------------------------------------------------------------
// Strategy 3: Signal constant recognition
// ---------------------------------------------------------------------------

describe("Strategy 3: Signal constant recognition", () => {
  it("recognizes failed require signal", () => {
    const reason = "Revert(18446744073709486080)"; // 0xffffffffffff0000
    const decoded = augmentRevertReason("msg", reason, undefined);
    expect(decoded).toContain("FAILED_REQUIRE");
  });

  it("recognizes revert with log signal", () => {
    const reason = "Revert(18446744073709486086)"; // 0xffffffffffff0006
    const decoded = augmentRevertReason("msg", reason, undefined);
    expect(decoded).toContain("REVERT_WITH_LOG");
  });

  it("non-signal revert code falls through", () => {
    const decoded = augmentRevertReason("msg", "Revert(42)", undefined);
    // Falls through to truncation — reason is the raw "Revert(42)"
    expect(decoded).toBe("Revert(42)");
  });
});

// ---------------------------------------------------------------------------
// Strategy 4: PanicInstruction
// ---------------------------------------------------------------------------

describe("Strategy 4: PanicInstruction", () => {
  it("extracts panic reason", () => {
    const reason =
      "receipts: [Panic { id: abc, reason: PanicInstruction " +
      "{ reason: NotEnoughBalance, instruction: CALL {} }, pc: 123 }]";
    const decoded = augmentRevertReason("msg", reason, undefined);
    expect(decoded).toBe("NotEnoughBalance");
  });
});

// ---------------------------------------------------------------------------
// Strategy 5: "and error:" fallback
// ---------------------------------------------------------------------------

describe('Strategy 5: "and error:" fallback', () => {
  it("extracts and error summary", () => {
    const reason = "lots of noise and error: transaction reverted: SomeError, receipts: [...]";
    const decoded = augmentRevertReason("msg", reason, undefined);
    expect(decoded).toBe("transaction reverted: SomeError");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("leaves reason unchanged when no patterns", () => {
    const decoded = augmentRevertReason("plain error", "some reason", undefined);
    expect(decoded).toBe("some reason");
  });

  it("reason undefined treated as empty", () => {
    const decoded = augmentRevertReason("plain error", undefined, undefined);
    expect(decoded).toBe("");
  });

  it("truncates long reason", () => {
    const reason = "x".repeat(500);
    const decoded = augmentRevertReason("error", reason, undefined);
    expect(decoded.length).toBeLessThan(300);
    expect(decoded).toContain("truncated");
  });

  it("receipts json searched", () => {
    const receipts = [{ note: 'Ok("InvalidNonce")' }];
    const decoded = augmentRevertReason("msg", "", receipts);
    expect(decoded).toBe("contract_schema::trade_account::NonceError::InvalidNonce");
  });

  it("priority log result over logdata", () => {
    const decoded = augmentRevertReason(
      "Failed to process transaction",
      REALISTIC_REASON,
      undefined,
    );
    // Should get OrderPartiallyFilled from LogResult, not from LogData
    expect(decoded).toContain("OrderPartiallyFilled");
  });
});

// ---------------------------------------------------------------------------
// Integration: parseApiError produces OnChainRevertError with decoded reason
// ---------------------------------------------------------------------------

describe("parseApiError on-chain revert integration", () => {
  it("decodes revert code in API error response", () => {
    const body = {
      message: "Failed to process transaction",
      reason: REALISTIC_REASON,
      receipts: [],
    };
    const err = parseApiError(body);
    expect(err).toBeInstanceOf(OnChainRevertError);
    expect(err.reason).toContain("OrderPartiallyFilled");
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
      message: "Failed to process transaction",
      reason: REALISTIC_REASON,
      receipts: [],
    };
    const err = parseApiError(body) as OnChainRevertError;
    expect(err.toString()).toContain("On-chain revert:");
    expect(err.toString()).toContain("OrderPartiallyFilled");
  });

  it("toString falls back to message when no reason", () => {
    const err = new OnChainRevertError("raw error message");
    expect(err.toString()).toBe("On-chain revert: raw error message");
  });
});
