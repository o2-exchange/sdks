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

/** Words the on-chain sliding window covers. */
export const NONCE_SESSION_SLIDING_WINDOW_SIZE = 8n;

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

// ── The indexed window (GET /v1/accounts/window) ─────────────────────

/** One word of the on-chain bitmap, as the indexer reports it. */
export interface NonceWindowSlot {
  word_position: string | number;
  bitmap: string | number;
}

/** The indexed view of the contract's sliding window for one lane. */
export interface NonceWindow {
  nonce_session_id: string | number;
  base: string | number;
  slots: NonceWindowSlot[];
}

/** Raised when the top window word is full and the chain must slide first. */
export class ParallelNonceWindowFull extends Error {
  constructor(message = "Top window word fully consumed; wait for the on-chain window to slide.") {
    super(message);
    this.name = "ParallelNonceWindowFull";
  }
}

/**
 * The consumed-bit bitmap for one word.
 *
 * A slot recycled by a window slide still holds a DIFFERENT word's bitmap,
 * which counts as empty — the slot's own `word_position` is the source of
 * truth. A fresh account may also report fewer slots than the window holds.
 */
export function effectiveBitmap(window: NonceWindow, word: bigint): bigint {
  const slots = window.slots ?? [];
  if (slots.length === 0) return 0n;
  const index = Number(word % NONCE_SESSION_SLIDING_WINDOW_SIZE);
  if (index >= slots.length) return 0n;
  const slot = slots[index];
  return BigInt(slot.word_position) === word ? BigInt(slot.bitmap) : 0n;
}

/** Index of the highest set bit, or -1 for zero. */
function highestSetBit(value: bigint): number {
  return value === 0n ? -1 : value.toString(2).length - 1;
}

/**
 * The `(word, bit)` strictly after the highest consumed position.
 *
 * Deliberately NOT the first free hole. A hole can belong to an earlier run
 * of this lane whose later positions already landed on chain, so a cursor
 * started inside it would mint nonces the chain has already seen. Starting
 * past the highest used bit wastes holes but can never collide.
 */
export function firstFreePosition(window: NonceWindow): { word: bigint; bit: number } {
  const base = BigInt(window.base);
  const top = base + NONCE_SESSION_SLIDING_WINDOW_SIZE - 1n;
  for (let word = top; ; word--) {
    const bitmap = effectiveBitmap(window, word);
    if (bitmap !== 0n) {
      const highest = highestSetBit(bitmap);
      if (highest + 1 < NONCE_BITMAP_SIZE) return { word, bit: highest + 1 };
      if (word < top) return { word: word + 1n, bit: 0 };
      throw new ParallelNonceWindowFull();
    }
    if (word === base) return { word: base, bit: 0 };
  }
}
