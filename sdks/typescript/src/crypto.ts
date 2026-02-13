/**
 * Cryptographic operations for O2 Exchange.
 *
 * Provides key generation, wallet creation, and signing operations for
 * both Fuel-native and EVM-compatible wallets. Implements three signing
 * modes used by the O2 Exchange:
 *
 * - **personalSign** — Fuel prefix + SHA-256 (for session creation)
 * - **rawSign** — Plain SHA-256 (for session actions)
 * - **evmPersonalSign** — Ethereum prefix + keccak-256 (for EVM owner sessions)
 *
 * @remarks
 * Uses `@noble/secp256k1` v3 with `prehash:false` since we pre-hash
 * all messages ourselves. The `hmacSha256` configuration is required
 * for synchronous signing.
 *
 * @module
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

/**
 * Interface for objects that can sign messages for the O2 Exchange.
 *
 * Both built-in wallets ({@link Wallet}, {@link EvmWallet}) and external
 * signers ({@link ExternalSigner}, {@link ExternalEvmSigner}) satisfy this
 * interface. For custom signing backends (hardware wallets, AWS KMS, HSMs,
 * etc.), implement this interface directly or use the provided external
 * signer classes.
 *
 * @example
 * ```ts
 * // Using the built-in wallet (implements Signer)
 * const wallet = client.generateWallet();
 * const session = await client.createSession(wallet, tradeAccountId, ["fFUEL/fUSDC"]);
 *
 * // Using an external signer
 * const signer = new ExternalSigner("0x1234...abcd", myKmsSignDigest);
 * const session = await client.createSession(signer, tradeAccountId, ["fFUEL/fUSDC"]);
 * ```
 */
export interface Signer {
  /** The Fuel B256 address (0x-prefixed, 64-char hex string). */
  readonly b256Address: string;

  /**
   * Sign a message using the appropriate personal_sign format.
   *
   * For Fuel-native accounts: Fuel personalSign
   * (`\x19Fuel Signed Message:\n` prefix + SHA-256).
   *
   * For EVM accounts: Ethereum personalSign
   * (`\x19Ethereum Signed Message:\n` prefix + keccak256).
   *
   * @param message - The raw message bytes to sign.
   * @returns A 64-byte Fuel compact signature.
   */
  personalSign(message: Uint8Array): Uint8Array;
}

/**
 * Callback type for external signing functions.
 *
 * Receives a 32-byte digest and must return a 64-byte Fuel compact
 * signature (r[32] + s[32] with recovery ID embedded in the MSB of s[0]).
 *
 * Use {@link toFuelCompactSignature} to convert standard `(r, s, recoveryId)`
 * components to the expected format.
 */
export type SignDigestFn = (digest: Uint8Array) => Uint8Array;

/**
 * A Fuel-native secp256k1 wallet.
 *
 * The address is derived as `SHA-256(publicKey[1:65])`, skipping the
 * `0x04` uncompressed prefix byte.
 */
export interface Wallet {
  /** The 32-byte private key. */
  privateKey: Uint8Array;
  /** The 65-byte uncompressed public key (with `0x04` prefix). */
  publicKey: Uint8Array;
  /** The 0x-prefixed, 64-character hex Fuel address. */
  b256Address: string;
}

/**
 * An EVM-compatible secp256k1 wallet.
 *
 * Extends {@link Wallet} with an Ethereum-style address derived as the
 * last 20 bytes of `keccak256(publicKey[1:65])`. The `b256Address` is the
 * EVM address zero-padded to 32 bytes.
 */
export interface EvmWallet extends Wallet {
  /** The 0x-prefixed, 40-character hex Ethereum address. */
  evmAddress: string;
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

// ── Digest helpers ──────────────────────────────────────────────────

/**
 * Compute the Fuel personalSign digest.
 *
 * Constructs `SHA-256("\x19Fuel Signed Message:\n" + str(len(message)) + message)`
 * and returns the 32-byte digest.
 *
 * Use this when implementing a custom {@link Signer} for Fuel-native accounts.
 */
export function fuelPersonalSignDigest(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode("\x19Fuel Signed Message:\n");
  const lengthStr = new TextEncoder().encode(String(message.length));
  return sha256(concat([prefix, lengthStr, message]));
}

/**
 * Compute the Ethereum personal_sign digest.
 *
 * Constructs `keccak256("\x19Ethereum Signed Message:\n" + str(len(message)) + message)`
 * and returns the 32-byte digest.
 *
 * Use this when implementing a custom {@link Signer} for EVM accounts.
 */
export function evmPersonalSignDigest(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  return keccak_256(concat([prefix, message]));
}

/**
 * Convert standard `(r, s, recoveryId)` components to a 64-byte Fuel compact signature.
 *
 * The Fuel compact format stores the recovery ID in the MSB of byte 32
 * (first byte of `s`): `s[0] = (recoveryId << 7) | (s[0] & 0x7F)`.
 *
 * @param r - The 32-byte `r` component of the ECDSA signature.
 * @param s - The 32-byte `s` component (must be low-s normalized).
 * @param recoveryId - The recovery ID (0 or 1).
 * @returns A 64-byte Fuel compact signature.
 *
 * @remarks
 * The `s` component **must be low-s normalized** before calling this function.
 * If `s > secp256k1_order / 2`, negate it (`s = order - s`) and flip the
 * recovery ID (`recoveryId ^= 1`). Most modern signing libraries do this
 * automatically, but check your KMS documentation.
 */
export function toFuelCompactSignature(
  r: Uint8Array,
  s: Uint8Array,
  recoveryId: number,
): Uint8Array {
  const sig = new Uint8Array(64);
  sig.set(r, 0);
  sig.set(s, 32);
  // Embed recovery ID in MSB of s[0]
  sig[32] = (recoveryId << 7) | (sig[32] & 0x7f);
  return sig;
}

// ── External Signers ────────────────────────────────────────────────

/**
 * A Fuel-native signer backed by an external signing function.
 *
 * Use this for hardware wallets, AWS KMS, or other secure enclaves
 * that manage private keys externally. The SDK handles Fuel-specific
 * message framing (prefix + SHA-256 hashing); your callback only needs
 * to sign a raw 32-byte digest.
 *
 * @example
 * ```ts
 * import { ExternalSigner, toFuelCompactSignature } from "@o2exchange/sdk";
 *
 * const signer = new ExternalSigner("0x1234...abcd", (digest) => {
 *   const { r, s, recoveryId } = myKms.sign(digest);
 *   return toFuelCompactSignature(r, s, recoveryId);
 * });
 *
 * const session = await client.createSession(signer, tradeAccountId, ["fFUEL/fUSDC"]);
 * ```
 */
export class ExternalSigner implements Signer {
  /** The Fuel B256 address (0x-prefixed hex string). */
  readonly b256Address: string;
  private readonly signDigest: SignDigestFn;

  /**
   * @param b256Address - The Fuel B256 address (0x-prefixed, 64-char hex).
   * @param signDigest - Callback that signs a 32-byte digest and returns
   *   a 64-byte Fuel compact signature.
   */
  constructor(b256Address: string, signDigest: SignDigestFn) {
    this.b256Address = b256Address;
    this.signDigest = signDigest;
  }

  /**
   * Sign using Fuel's personalSign format, delegating to the external signer.
   *
   * Computes `SHA-256("\x19Fuel Signed Message:\n" + len + message)` and
   * passes the 32-byte digest to the `signDigest` callback.
   */
  personalSign(message: Uint8Array): Uint8Array {
    const digest = fuelPersonalSignDigest(message);
    return this.signDigest(digest);
  }
}

/**
 * An EVM signer backed by an external signing function.
 *
 * Same as {@link ExternalSigner} but uses Ethereum personal_sign message
 * framing (`\x19Ethereum Signed Message:\n` prefix + keccak256 hashing).
 *
 * @example
 * ```ts
 * import { ExternalEvmSigner, toFuelCompactSignature } from "@o2exchange/sdk";
 *
 * const signer = new ExternalEvmSigner(
 *   "0x000000000000000000000000abcd...1234", // b256 (zero-padded)
 *   "0xabcd...1234",                          // EVM address
 *   (digest) => {
 *     const { r, s, recoveryId } = myKms.sign(digest);
 *     return toFuelCompactSignature(r, s, recoveryId);
 *   },
 * );
 * ```
 */
export class ExternalEvmSigner implements Signer {
  /** The Fuel B256 address (zero-padded EVM address). */
  readonly b256Address: string;
  /** The EVM address (0x-prefixed, 40-char hex). */
  readonly evmAddress: string;
  private readonly signDigest: SignDigestFn;

  /**
   * @param b256Address - The B256 address (EVM address zero-padded to 32 bytes).
   * @param evmAddress - The EVM address (0x-prefixed, 40-char hex).
   * @param signDigest - Callback that signs a 32-byte digest and returns
   *   a 64-byte Fuel compact signature.
   */
  constructor(b256Address: string, evmAddress: string, signDigest: SignDigestFn) {
    this.b256Address = b256Address;
    this.evmAddress = evmAddress;
    this.signDigest = signDigest;
  }

  /**
   * Sign using Ethereum's personal_sign format, delegating to the external signer.
   *
   * Computes `keccak256("\x19Ethereum Signed Message:\n" + len + message)` and
   * passes the 32-byte digest to the `signDigest` callback.
   */
  personalSign(message: Uint8Array): Uint8Array {
    const digest = evmPersonalSignDigest(message);
    return this.signDigest(digest);
  }
}

export { hexToBytes, bytesToHex };
