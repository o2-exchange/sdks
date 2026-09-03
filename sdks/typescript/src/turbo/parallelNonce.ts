/**
 * Packed parallel nonces for a trade account.
 *
 * A parallel nonce is a packed u256:
 *
 * ```text
 *   bits   0..8    bitmap_position (0..127)
 *   bits   8..136  word_position (u128)
 *   bits 136..168  unix expiry timestamp (u32, seconds)
 *   bits 168..176  nonce_session_id (lane, 0..=4)
 *   bits 176..256  reserved, must be zero
 * ```
 *
 * The SDK needs this for exactly one thing: the INNER nonce a margin child
 * carries in its own `set_session` window. That one is never burned on
 * chain — the child authenticates `set_session` by `msg_sender() == parent`
 * and never reaches `commit_parallel_nonce` — but the backend still decodes
 * and expiry-checks it, which is why it cannot simply be zero.
 *
 * @module
 */

const WORD_POSITION_SHIFT = 8n;
const TIMESTAMP_SHIFT = 136n;
const SESSION_ID_SHIFT = 168n;

/** Bits in one bitmap word. */
export const NONCE_BITMAP_SIZE = 128;

/** Must match the deployed trade account's `MAX_NONCE_SESSION_ID`. */
export const MAX_NONCE_SESSION_ID = 4;

/** How long a minted owner-lane nonce stays valid, seconds. */
export const OWNER_NONCE_TTL_SECONDS = 300;

/** The parts of a packed parallel nonce. */
export interface ParallelNonceParts {
  /** The lane, 0..=4. */
  nonceSessionId: number;
  /** Unix expiry in seconds. Truncated to 32 bits on encode. */
  timestamp: number;
  wordPosition: bigint;
  bitmapPosition: number;
}

/** Pack nonce parts into the on-chain u256, as a decimal string. */
export function encodeParallelNonce(parts: ParallelNonceParts): string {
  if (parts.bitmapPosition < 0 || parts.bitmapPosition >= NONCE_BITMAP_SIZE) {
    throw new Error(
      `bitmap position ${parts.bitmapPosition} out of range 0..${NONCE_BITMAP_SIZE - 1}`,
    );
  }
  if (parts.nonceSessionId < 0 || parts.nonceSessionId > MAX_NONCE_SESSION_ID) {
    throw new Error(
      `nonce session id ${parts.nonceSessionId} out of range 0..${MAX_NONCE_SESSION_ID}`,
    );
  }
  if (parts.wordPosition < 0n) {
    throw new Error("word position cannot be negative");
  }

  const packed =
    BigInt(parts.bitmapPosition) |
    (parts.wordPosition << WORD_POSITION_SHIFT) |
    ((BigInt(parts.timestamp) & 0xffff_ffffn) << TIMESTAMP_SHIFT) |
    (BigInt(parts.nonceSessionId) << SESSION_ID_SHIFT);

  return packed.toString(10);
}

/** Unpack a nonce — the inverse of {@link encodeParallelNonce}. */
export function decodeParallelNonce(nonce: string | bigint): ParallelNonceParts {
  const packed = typeof nonce === "bigint" ? nonce : BigInt(nonce);
  return {
    bitmapPosition: Number(packed & 0xffn),
    wordPosition: (packed >> WORD_POSITION_SHIFT) & ((1n << 128n) - 1n),
    timestamp: Number((packed >> TIMESTAMP_SHIFT) & 0xffff_ffffn),
    nonceSessionId: Number((packed >> SESSION_ID_SHIFT) & 0xffn),
  };
}

/**
 * The one nonce a brand-new margin child will admit.
 *
 * Its window base is 0, so `(word 0, bit 0)` is the only coordinate it
 * accepts. Deliberately NOT minted from the parent's cursor: taking a
 * position from there would retire a parent position for nothing, since the
 * child never burns this one.
 */
export function newMarginAccountNonce(nowSeconds = Math.floor(Date.now() / 1000)): string {
  return encodeParallelNonce({
    nonceSessionId: 0,
    timestamp: nowSeconds + OWNER_NONCE_TTL_SECONDS,
    wordPosition: 0n,
    bitmapPosition: 0,
  });
}
