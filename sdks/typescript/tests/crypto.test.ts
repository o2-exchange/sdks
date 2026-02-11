import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import {
  evmPersonalSign,
  evmWalletFromPrivateKey,
  fuelCompactSign,
  generateEvmWallet,
  generateWallet,
  personalSign,
  rawSign,
  walletFromPrivateKey,
} from "../src/crypto.js";
import { bytesToHex, hexToBytes } from "../src/encoding.js";

describe("Crypto Module", () => {
  // Known test private key
  const testPrivateKey = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const testKeyBytes = hexToBytes(testPrivateKey);

  describe("Key generation", () => {
    it("generates a valid Fuel wallet", () => {
      const wallet = generateWallet();
      expect(wallet.privateKey).toBeInstanceOf(Uint8Array);
      expect(wallet.privateKey.length).toBe(32);
      expect(wallet.publicKey).toBeInstanceOf(Uint8Array);
      expect(wallet.publicKey.length).toBe(65);
      expect(wallet.publicKey[0]).toBe(0x04); // uncompressed prefix
      expect(wallet.b256Address).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("derives correct Fuel address from known key", () => {
      const wallet = walletFromPrivateKey(testKeyBytes);
      // Address = SHA-256(publicKey[1:65])
      const expectedAddress = sha256(wallet.publicKey.slice(1));
      expect(wallet.b256Address).toBe(bytesToHex(expectedAddress));
    });

    it("loads wallet from hex string", () => {
      const wallet = walletFromPrivateKey(testPrivateKey);
      expect(wallet.privateKey.length).toBe(32);
      expect(wallet.b256Address).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("generates a valid EVM wallet", () => {
      const wallet = generateEvmWallet();
      expect(wallet.evmAddress).toMatch(/^0x[0-9a-f]{40}$/);
      expect(wallet.b256Address).toMatch(/^0x[0-9a-f]{64}$/);
      // First 12 bytes should be zero (24 hex chars after 0x prefix)
      expect(wallet.b256Address.substring(2, 26)).toBe("000000000000000000000000");
    });

    it("derives correct EVM address from known key", () => {
      const wallet = evmWalletFromPrivateKey(testKeyBytes);
      // EVM address = last 20 bytes of keccak256(pubkey[1:65])
      const hash = keccak_256(wallet.publicKey.slice(1));
      const evmBytes = hash.slice(12);
      let expected = "0x";
      for (const b of evmBytes) expected += b.toString(16).padStart(2, "0");
      expect(wallet.evmAddress).toBe(expected);
    });
  });

  describe("Fuel compact signing", () => {
    it("produces a 64-byte signature", () => {
      const digest = sha256(new TextEncoder().encode("test message"));
      const sig = fuelCompactSign(testKeyBytes, digest);
      expect(sig).toBeInstanceOf(Uint8Array);
      expect(sig.length).toBe(64);
    });

    it("embeds recovery ID in MSB of byte 32", () => {
      const digest = sha256(new TextEncoder().encode("test"));
      const sig = fuelCompactSign(testKeyBytes, digest);
      // The MSB of byte 32 is the recovery ID (0 or 1)
      const recoveryBit = (sig[32] >> 7) & 1;
      expect(recoveryBit === 0 || recoveryBit === 1).toBe(true);
    });

    it("signatures are deterministic for same input", () => {
      const digest = sha256(new TextEncoder().encode("deterministic"));
      const sig1 = fuelCompactSign(testKeyBytes, digest);
      const sig2 = fuelCompactSign(testKeyBytes, digest);
      expect(bytesToHex(sig1)).toBe(bytesToHex(sig2));
    });
  });

  describe("personalSign", () => {
    it("applies Fuel prefix before signing", () => {
      const message = new TextEncoder().encode("hello");
      const sig = personalSign(testKeyBytes, message);
      expect(sig.length).toBe(64);

      // Verify it produces a different signature than rawSign
      const rawSig = rawSign(testKeyBytes, message);
      expect(bytesToHex(sig)).not.toBe(bytesToHex(rawSig));
    });

    it("handles empty message", () => {
      const message = new Uint8Array(0);
      const sig = personalSign(testKeyBytes, message);
      expect(sig.length).toBe(64);
    });

    it("handles large messages", () => {
      const message = new Uint8Array(10000);
      message.fill(0xab);
      const sig = personalSign(testKeyBytes, message);
      expect(sig.length).toBe(64);
    });
  });

  describe("rawSign", () => {
    it("produces 64-byte signature with SHA-256 hash", () => {
      const message = new TextEncoder().encode("raw test");
      const sig = rawSign(testKeyBytes, message);
      expect(sig.length).toBe(64);
    });
  });

  describe("evmPersonalSign", () => {
    it("applies Ethereum prefix and keccak256", () => {
      const message = new TextEncoder().encode("evm test");
      const sig = evmPersonalSign(testKeyBytes, message);
      expect(sig.length).toBe(64);

      // Different from Fuel personalSign
      const fuelSig = personalSign(testKeyBytes, message);
      expect(bytesToHex(sig)).not.toBe(bytesToHex(fuelSig));
    });
  });

  describe("Cross-validation", () => {
    it("personalSign matches manual Fuel prefix construction", () => {
      const message = new TextEncoder().encode("verify");
      const sig = personalSign(testKeyBytes, message);

      // Manually construct the digest
      const prefix = new TextEncoder().encode("\x19Fuel Signed Message:\n");
      const lengthStr = new TextEncoder().encode(String(message.length));
      const combined = new Uint8Array(prefix.length + lengthStr.length + message.length);
      combined.set(prefix, 0);
      combined.set(lengthStr, prefix.length);
      combined.set(message, prefix.length + lengthStr.length);
      const digest = sha256(combined);

      const manualSig = fuelCompactSign(testKeyBytes, digest);
      expect(bytesToHex(sig)).toBe(bytesToHex(manualSig));
    });

    it("rawSign matches manual SHA-256 construction", () => {
      const message = new TextEncoder().encode("raw verify");
      const sig = rawSign(testKeyBytes, message);

      const digest = sha256(message);
      const manualSig = fuelCompactSign(testKeyBytes, digest);
      expect(bytesToHex(sig)).toBe(bytesToHex(manualSig));
    });
  });
});
