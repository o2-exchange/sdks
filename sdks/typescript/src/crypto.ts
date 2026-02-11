/**
 * Cryptographic operations for O2 Exchange.
 *
 * Key generation, signing (personalSign, rawSign, evm_personal_sign),
 * and Fuel compact signature encoding.
 *
 * CRITICAL: @noble/secp256k1 v3 defaults prehash:true.
 * We MUST use prehash:false since we pre-hash ourselves.
 * Must configure etc.hmacSha256Sync for synchronous signing.
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as secp from "@noble/secp256k1";
import { bytesToHex, concat, hexToBytes } from "./encoding.js";

// Configure @noble/secp256k1 v3 for synchronous signing.
// v3 requires manual hash configuration via secp.hashes.
secp.hashes.hmacSha256 = (key: Uint8Array, ...msgs: Uint8Array[]) => {
  const h = hmac.create(sha256, key);
  for (const msg of msgs) h.update(msg);
  return h.digest();
};
secp.hashes.sha256 = (...msgs: Uint8Array[]) => {
  const h = sha256.create();
  for (const msg of msgs) h.update(msg);
  return h.digest();
};

// ── Types ───────────────────────────────────────────────────────────

export interface Wallet {
  privateKey: Uint8Array;
  publicKey: Uint8Array; // 65 bytes uncompressed
  b256Address: string; // 0x-prefixed hex
}

export interface EvmWallet extends Wallet {
  evmAddress: string; // 0x-prefixed 40-char hex
}

// ── Key Generation ──────────────────────────────────────────────────

/**
 * Generate a Fuel-native secp256k1 keypair.
 * Address = SHA-256(publicKey[1:65]) — skip 0x04 prefix.
 */
export function generateWallet(): Wallet {
  const privateKey = secp.utils.randomSecretKey();
  return walletFromPrivateKey(privateKey);
}

/** Load a wallet from a private key (hex string or bytes). */
export function walletFromPrivateKey(privateKeyInput: Uint8Array | string): Wallet {
  const privateKey =
    typeof privateKeyInput === "string" ? hexToBytes(privateKeyInput) : privateKeyInput;
  const publicKey = secp.getPublicKey(privateKey, false); // uncompressed 65 bytes
  const addressBytes = sha256(publicKey.slice(1)); // skip 0x04 prefix
  return {
    privateKey,
    publicKey,
    b256Address: bytesToHex(addressBytes),
  };
}

/**
 * Generate an EVM-compatible secp256k1 keypair.
 * EVM address = last 20 bytes of keccak256(publicKey[1:65]).
 * B256 address = zero-padded EVM address.
 */
export function generateEvmWallet(): EvmWallet {
  const privateKey = secp.utils.randomSecretKey();
  return evmWalletFromPrivateKey(privateKey);
}

/** Load an EVM wallet from a private key. */
export function evmWalletFromPrivateKey(privateKeyInput: Uint8Array | string): EvmWallet {
  const privateKey =
    typeof privateKeyInput === "string" ? hexToBytes(privateKeyInput) : privateKeyInput;
  const publicKey = secp.getPublicKey(privateKey, false);
  const hash = keccak_256(publicKey.slice(1));
  const evmAddressBytes = hash.slice(12); // last 20 bytes

  let evmHex = "0x";
  for (const b of evmAddressBytes) evmHex += b.toString(16).padStart(2, "0");

  // B256: 12 zero bytes + 20 EVM address bytes
  const b256Bytes = new Uint8Array(32);
  b256Bytes.set(evmAddressBytes, 12);

  return {
    privateKey,
    publicKey,
    b256Address: bytesToHex(b256Bytes),
    evmAddress: evmHex,
  };
}

// ── Signing ─────────────────────────────────────────────────────────

/**
 * Sign a 32-byte digest and return a 64-byte Fuel compact signature.
 *
 * Steps:
 * 1. Sign with secp256k1 using prehash:false (digest is already hashed)
 * 2. Low-s normalization is handled by @noble/secp256k1 v3 automatically
 * 3. Embed recovery ID in MSB of byte 32 (first byte of s):
 *    s[0] = (recovery_id << 7) | (s[0] & 0x7F)
 * 4. Return r(32) + s(32) = 64 bytes
 */
export function fuelCompactSign(privateKey: Uint8Array, digest: Uint8Array): Uint8Array {
  // CRITICAL: prehash must be false — the digest is already SHA-256 hashed.
  // Use format: 'recovered' to get 65-byte output: [recovery_id, r(32), s(32)].
  // Low-s normalization is handled automatically by the library.
  const sig65 = secp.sign(digest, privateKey, {
    prehash: false,
    format: "recovered",
  } as Parameters<typeof secp.sign>[2]);
  const recovery = sig65[0]; // recovery ID: 0 or 1
  const r = sig65.slice(1, 33);
  const s = new Uint8Array(sig65.slice(33, 65));

  // Embed recovery ID in MSB of s[0] (first byte of s component)
  s[0] = (recovery << 7) | (s[0] & 0x7f);

  // Return r(32) + s(32) = 64 bytes
  const result = new Uint8Array(64);
  result.set(r, 0);
  result.set(s, 32);
  return result;
}

/**
 * Sign using Fuel's personalSign format (for session creation).
 *
 * prefix = "\x19Fuel Signed Message:\n"
 * digest = sha256(prefix + str(len(message)) + message)
 */
export function personalSign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode("\x19Fuel Signed Message:\n");
  const lengthStr = new TextEncoder().encode(String(message.length));
  const fullMessage = concat([prefix, lengthStr, message]);
  const digest = sha256(fullMessage);
  return fuelCompactSign(privateKey, digest);
}

/**
 * Sign using raw SHA-256 hash, no prefix (for session actions).
 *
 * digest = sha256(message)
 */
export function rawSign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  const digest = sha256(message);
  return fuelCompactSign(privateKey, digest);
}

/**
 * Sign using Ethereum's personal_sign format (for EVM owner sessions).
 *
 * prefix = "\x19Ethereum Signed Message:\n" + str(len(message))
 * digest = keccak256(prefix + message)
 */
export function evmPersonalSign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const fullMessage = concat([prefix, message]);
  const digest = keccak_256(fullMessage);
  return fuelCompactSign(privateKey, digest);
}

export { hexToBytes, bytesToHex };
