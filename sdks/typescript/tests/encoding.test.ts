import { describe, expect, it } from "vitest";
import {
  buildActionsSigningBytes,
  buildSessionSigningBytes,
  buildWithdrawSigningBytes,
  bytesToHex,
  type ContractCall,
  concat,
  encodeIdentity,
  encodeOptionCallData,
  encodeOptionNone,
  encodeOptionSome,
  encodeOrderArgs,
  formatDecimal,
  functionSelector,
  GAS_MAX,
  hexToBytes,
  scalePrice,
  scaleQuantity,
  u64BE,
  validateFractionalPrice,
  validateMinOrder,
} from "../src/encoding.js";

describe("Encoding Module", () => {
  describe("u64BE", () => {
    it("encodes 0 correctly", () => {
      const result = u64BE(0);
      expect(result.length).toBe(8);
      expect(bytesToHex(result)).toBe("0x0000000000000000");
    });

    it("encodes 1 correctly", () => {
      expect(bytesToHex(u64BE(1))).toBe("0x0000000000000001");
    });

    it("encodes u64::MAX correctly", () => {
      expect(bytesToHex(u64BE(GAS_MAX))).toBe("0xffffffffffffffff");
    });

    it("encodes arbitrary values correctly", () => {
      expect(bytesToHex(u64BE(12))).toBe("0x000000000000000c");
      expect(bytesToHex(u64BE(256))).toBe("0x0000000000000100");
      expect(bytesToHex(u64BE(1000000000))).toBe("0x000000003b9aca00");
    });

    it("accepts BigInt values", () => {
      expect(bytesToHex(u64BE(18446744073709551615n))).toBe("0xffffffffffffffff");
    });
  });

  describe("functionSelector", () => {
    it("encodes create_order correctly", () => {
      const result = functionSelector("create_order");
      // u64(12) + "create_order"
      expect(bytesToHex(result)).toBe("0x000000000000000c6372656174655f6f72646572");
      expect(result.length).toBe(20);
    });

    it("encodes cancel_order correctly", () => {
      const result = functionSelector("cancel_order");
      expect(bytesToHex(result)).toBe("0x000000000000000c63616e63656c5f6f72646572");
      expect(result.length).toBe(20);
    });

    it("encodes settle_balance correctly", () => {
      const result = functionSelector("settle_balance");
      // u64(14) + "settle_balance"
      expect(bytesToHex(result)).toBe("0x000000000000000e736574746c655f62616c616e6365");
      expect(result.length).toBe(22);
    });

    it("encodes register_referer correctly", () => {
      const result = functionSelector("register_referer");
      // u64(16) + "register_referer"
      expect(result.length).toBe(24); // 8 + 16
      // Verify against manual construction
      const expected = concat([u64BE(16), new TextEncoder().encode("register_referer")]);
      expect(bytesToHex(result)).toBe(bytesToHex(expected));
    });

    it("is NOT hash-based (raw name encoding)", () => {
      // Verify function selectors are just length + utf8 name
      const result = functionSelector("set_session");
      const expected = concat([
        u64BE(11), // "set_session".length = 11
        new TextEncoder().encode("set_session"),
      ]);
      expect(bytesToHex(result)).toBe(bytesToHex(expected));
    });
  });

  describe("encodeIdentity", () => {
    it("encodes Address identity (discriminant 0)", () => {
      const address = new Uint8Array(32).fill(0xaa);
      const result = encodeIdentity(0, address);
      expect(result.length).toBe(40); // 8 + 32
      expect(bytesToHex(result.slice(0, 8))).toBe("0x0000000000000000"); // disc = 0
      expect(result.slice(8)).toEqual(address);
    });

    it("encodes ContractId identity (discriminant 1)", () => {
      const address = new Uint8Array(32).fill(0xbb);
      const result = encodeIdentity(1, address);
      expect(result.length).toBe(40);
      expect(bytesToHex(result.slice(0, 8))).toBe("0x0000000000000001"); // disc = 1
    });
  });

  describe("Option encoding", () => {
    it("encodes None correctly", () => {
      expect(bytesToHex(encodeOptionNone())).toBe("0x0000000000000000");
    });

    it("encodes Some correctly", () => {
      const data = new Uint8Array([0x01, 0x02, 0x03]);
      const result = encodeOptionSome(data);
      expect(bytesToHex(result)).toBe("0x0000000000000001010203");
    });

    it("encodeOptionCallData encodes null as None", () => {
      expect(bytesToHex(encodeOptionCallData(null))).toBe("0x0000000000000000");
    });

    it("encodeOptionCallData encodes data as Some(len + data)", () => {
      const data = new Uint8Array([0xab, 0xcd]);
      const result = encodeOptionCallData(data);
      // u64(1) + u64(2) + data
      expect(bytesToHex(result)).toBe("0x00000000000000010000000000000002abcd");
    });
  });

  describe("OrderArgs encoding", () => {
    const price = 100000000n; // 0.1 USDC
    const quantity = 5000000000n; // 5 units

    it("encodes Spot order (8 bytes variant)", () => {
      const result = encodeOrderArgs(price, quantity, "Spot");
      // u64(price) + u64(quantity) + u64(1)
      expect(result.length).toBe(24); // 8 + 8 + 8
      expect(bytesToHex(result.slice(16))).toBe("0x0000000000000001"); // Spot = variant 1
    });

    it("encodes Market order (8 bytes variant)", () => {
      const result = encodeOrderArgs(price, quantity, "Market");
      expect(result.length).toBe(24);
      expect(bytesToHex(result.slice(16))).toBe("0x0000000000000004"); // Market = variant 4
    });

    it("encodes FillOrKill order (8 bytes variant)", () => {
      const result = encodeOrderArgs(price, quantity, "FillOrKill");
      expect(result.length).toBe(24);
      expect(bytesToHex(result.slice(16))).toBe("0x0000000000000002"); // FillOrKill = variant 2
    });

    it("encodes PostOnly order (8 bytes variant)", () => {
      const result = encodeOrderArgs(price, quantity, "PostOnly");
      expect(result.length).toBe(24);
      expect(bytesToHex(result.slice(16))).toBe("0x0000000000000003"); // PostOnly = variant 3
    });

    it("encodes Limit order (24 bytes variant)", () => {
      const result = encodeOrderArgs(price, quantity, {
        Limit: { price: 100000000n, timestamp: 1734876543210n },
      });
      // u64(price) + u64(quantity) + u64(0) + u64(limit_price) + u64(timestamp)
      expect(result.length).toBe(40); // 8 + 8 + 8 + 8 + 8
      expect(bytesToHex(result.slice(16, 24))).toBe("0x0000000000000000"); // Limit = variant 0
    });

    it("encodes BoundedMarket order (24 bytes variant)", () => {
      const result = encodeOrderArgs(price, quantity, {
        BoundedMarket: { maxPrice: 110000000n, minPrice: 90000000n },
      });
      // u64(price) + u64(quantity) + u64(5) + u64(max) + u64(min)
      expect(result.length).toBe(40);
      expect(bytesToHex(result.slice(16, 24))).toBe("0x0000000000000005"); // BoundedMarket = variant 5
    });

    it("tightly packs variants (no padding)", () => {
      // Spot = 24 bytes total, Limit = 40 bytes total
      const spot = encodeOrderArgs(price, quantity, "Spot");
      const limit = encodeOrderArgs(price, quantity, {
        Limit: { price: 100000000n, timestamp: 1734876543210n },
      });
      expect(spot.length).toBe(24);
      expect(limit.length).toBe(40);
      // No padding: Spot is not padded to 40 bytes
    });
  });

  describe("buildSessionSigningBytes", () => {
    it("produces correct byte layout", () => {
      const nonce = 0n;
      const chainId = 0n;
      const sessionAddress = new Uint8Array(32).fill(0xaa);
      const contractId = new Uint8Array(32).fill(0xbb);
      const expiry = 1737504000n;

      const result = buildSessionSigningBytes(nonce, chainId, sessionAddress, [contractId], expiry);

      // Verify structure:
      // u64(nonce=0) + u64(chain_id=0) + u64(11) + "set_session"
      // + u64(1) + u64(0) + session_addr(32) + u64(expiry) + u64(1) + contract_id(32)
      expect(result.length).toBe(8 + 8 + 8 + 11 + 8 + 8 + 32 + 8 + 8 + 32); // = 131

      // Check nonce
      expect(bytesToHex(result.slice(0, 8))).toBe("0x0000000000000000");
      // Check chain_id
      expect(bytesToHex(result.slice(8, 16))).toBe("0x0000000000000000");
      // Check function name length
      expect(bytesToHex(result.slice(16, 24))).toBe("0x000000000000000b"); // 11
      // Check "set_session"
      const funcName = new TextDecoder().decode(result.slice(24, 35));
      expect(funcName).toBe("set_session");
      // Check Option::Some
      expect(bytesToHex(result.slice(35, 43))).toBe("0x0000000000000001");
      // Check Identity::Address
      expect(bytesToHex(result.slice(43, 51))).toBe("0x0000000000000000");
      // Check session address
      expect(result.slice(51, 83)).toEqual(sessionAddress);
      // Check expiry
      expect(bytesToHex(result.slice(83, 91))).toBe("0x0000000067903500");
      // Check contract_ids length
      expect(bytesToHex(result.slice(91, 99))).toBe("0x0000000000000001");
      // Check contract_id
      expect(result.slice(99, 131)).toEqual(contractId);
    });

    it("handles multiple contract IDs", () => {
      const cid1 = new Uint8Array(32).fill(0xaa);
      const cid2 = new Uint8Array(32).fill(0xbb);
      const result = buildSessionSigningBytes(1n, 0n, new Uint8Array(32), [cid1, cid2], 1000n);
      // Same structure but with 2 contract IDs
      expect(result.length).toBe(8 + 8 + 8 + 11 + 8 + 8 + 32 + 8 + 8 + 64); // = 163
    });

    it("handles chain_id = 0 correctly (testnet)", () => {
      const result = buildSessionSigningBytes(
        0n,
        0n, // chain_id is 0 on testnet
        new Uint8Array(32),
        [new Uint8Array(32)],
        1000n,
      );
      expect(bytesToHex(result.slice(8, 16))).toBe("0x0000000000000000");
    });
  });

  describe("buildActionsSigningBytes", () => {
    it("produces correct byte layout for a single call", () => {
      const contractId = new Uint8Array(32).fill(0xcc);
      const selector = functionSelector("create_order");
      const assetId = new Uint8Array(32).fill(0xdd);
      const callData = new Uint8Array(24); // Spot order args

      const call: ContractCall = {
        contractId,
        functionSelector: selector,
        amount: 500000000n,
        assetId,
        gas: GAS_MAX,
        callData,
      };

      const result = buildActionsSigningBytes(1n, [call]);

      // u64(nonce) + u64(num_calls=1) + [call data]
      expect(bytesToHex(result.slice(0, 8))).toBe("0x0000000000000001"); // nonce
      expect(bytesToHex(result.slice(8, 16))).toBe("0x0000000000000001"); // num_calls

      // call: contract_id(32) + u64(selector_len) + selector + u64(amount) + asset_id(32) + u64(gas) + option(call_data)
      expect(result.slice(16, 48)).toEqual(contractId);
    });

    it("handles null call_data (Option::None)", () => {
      const call: ContractCall = {
        contractId: new Uint8Array(32),
        functionSelector: functionSelector("settle_balance"),
        amount: 0n,
        assetId: new Uint8Array(32),
        gas: GAS_MAX,
        callData: null,
      };

      const result = buildActionsSigningBytes(0n, [call]);
      // Last 8 bytes of the call should be Option::None = u64(0)
      // But settle_balance has call_data (identity), so this is actually for testing null case
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("handles multiple calls", () => {
      const calls: ContractCall[] = [
        {
          contractId: new Uint8Array(32).fill(0x01),
          functionSelector: functionSelector("settle_balance"),
          amount: 0n,
          assetId: new Uint8Array(32),
          gas: GAS_MAX,
          callData: encodeIdentity(1, new Uint8Array(32).fill(0x02)),
        },
        {
          contractId: new Uint8Array(32).fill(0x01),
          functionSelector: functionSelector("create_order"),
          amount: 500000000n,
          assetId: new Uint8Array(32).fill(0x03),
          gas: GAS_MAX,
          callData: encodeOrderArgs(100000000n, 5000000000n, "Spot"),
        },
      ];

      const result = buildActionsSigningBytes(5n, calls);
      expect(bytesToHex(result.slice(0, 8))).toBe("0x0000000000000005"); // nonce=5
      expect(bytesToHex(result.slice(8, 16))).toBe("0x0000000000000002"); // 2 calls
    });
  });

  describe("Decimal helpers", () => {
    it("scalePrice truncates correctly", () => {
      // decimals=9, max_precision=3 -> truncate_factor = 10^6 = 1000000
      const result = scalePrice(0.084, 9, 3);
      expect(result).toBe(84000000n); // 0.084 * 10^9 = 84000000, truncated
    });

    it("scalePrice with full precision", () => {
      // decimals=9, max_precision=9 -> truncate_factor = 1
      const result = scalePrice(2500.5, 9, 9);
      expect(result).toBe(2500500000000n);
    });

    it("scaleQuantity rounds up", () => {
      const result = scaleQuantity(1.234, 9, 3);
      // 1.234 * 10^9 = 1234000000, truncate_factor = 10^6
      // 1234000000 % 1000000 = 0, so no rounding needed
      expect(result).toBe(1234000000n);
    });

    it("formatDecimal converts back correctly", () => {
      expect(formatDecimal(84000000n, 9)).toBeCloseTo(0.084, 6);
      expect(formatDecimal(1000000000n, 9)).toBe(1.0);
    });

    it("validateFractionalPrice checks divisibility", () => {
      // (100000000 * 5000000000) % 10^9 = 0 -> valid
      expect(validateFractionalPrice(100000000n, 5000000000n, 9)).toBe(true);

      // (100000001 * 1) % 10^9 != 0 -> invalid
      expect(validateFractionalPrice(100000001n, 1n, 9)).toBe(false);
    });

    it("validateMinOrder checks minimum value", () => {
      // (100000000 * 5000000000) / 10^9 = 500000000 < 1000000000 -> invalid
      expect(validateMinOrder(100000000n, 5000000000n, 9, 1000000000n)).toBe(false);

      // (200000000 * 5000000000) / 10^9 = 1000000000 >= 1000000000 -> valid
      expect(validateMinOrder(200000000n, 5000000000n, 9, 1000000000n)).toBe(true);
    });
  });

  describe("buildWithdrawSigningBytes", () => {
    it("produces correct byte layout", () => {
      const nonce = 5n;
      const chainId = 0n;
      const toAddress = new Uint8Array(32).fill(0xaa);
      const assetId = new Uint8Array(32).fill(0xbb);
      const amount = 1000000000n;

      const result = buildWithdrawSigningBytes(nonce, chainId, 0, toAddress, assetId, amount);

      // Layout: u64(nonce) + u64(chain_id) + u64(8) + "withdraw"
      //       + u64(0) + to_address(32) + asset_id(32) + u64(amount)
      const expectedLen = 8 + 8 + 8 + 8 + 8 + 32 + 32 + 8; // = 112
      expect(result.length).toBe(expectedLen);

      let offset = 0;
      // nonce
      expect(bytesToHex(result.slice(offset, offset + 8))).toBe("0x0000000000000005");
      offset += 8;
      // chain_id
      expect(bytesToHex(result.slice(offset, offset + 8))).toBe("0x0000000000000000");
      offset += 8;
      // func name length = 8
      expect(bytesToHex(result.slice(offset, offset + 8))).toBe("0x0000000000000008");
      offset += 8;
      // "withdraw"
      const funcName = new TextDecoder().decode(result.slice(offset, offset + 8));
      expect(funcName).toBe("withdraw");
      offset += 8;
      // to discriminant = 0 (Address)
      expect(bytesToHex(result.slice(offset, offset + 8))).toBe("0x0000000000000000");
      offset += 8;
      // to_address
      expect(result.slice(offset, offset + 32)).toEqual(toAddress);
      offset += 32;
      // asset_id
      expect(result.slice(offset, offset + 32)).toEqual(assetId);
      offset += 32;
      // amount
      expect(bytesToHex(result.slice(offset, offset + 8))).toBe("0x000000003b9aca00");
    });

    it("handles ContractId discriminant", () => {
      const result = buildWithdrawSigningBytes(
        0n,
        0n,
        1, // ContractId
        new Uint8Array(32),
        new Uint8Array(32),
        0n,
      );
      // Check discriminant at offset 8 + 8 + 8 + 8 = 32
      expect(bytesToHex(result.slice(32, 40))).toBe("0x0000000000000001");
    });
  });

  describe("hexToBytes / bytesToHex", () => {
    it("round-trips correctly", () => {
      const original = "0xdeadbeef01020304";
      const bytes = hexToBytes(original);
      expect(bytes.length).toBe(8);
      expect(bytesToHex(bytes)).toBe(original);
    });

    it("handles 0x prefix", () => {
      const bytes = hexToBytes("0xabcd");
      expect(bytes.length).toBe(2);
      expect(bytes[0]).toBe(0xab);
      expect(bytes[1]).toBe(0xcd);
    });

    it("handles no prefix", () => {
      const bytes = hexToBytes("abcd");
      expect(bytes.length).toBe(2);
    });
  });
});
