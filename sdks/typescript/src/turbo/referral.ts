/**
 * The Turbo referral surface.
 *
 * Off-chain and signature-authenticated: minting a code and activating one
 * both carry a payload signed by the caller's SESSION key, and the server
 * recovers the signer from `sha256(payload-bytes)` — which is exactly what
 * the SDK's `rawSign` produces.
 *
 * The signature is not ceremony. Activation is PERMANENT: `referee_address`
 * is unique and first code wins, so an unauthenticated endpoint would let
 * anyone bind any wallet to their own code, forever, with no way back. The
 * CODE therefore rides INSIDE the signed payload rather than beside it —
 * anything between client and server could otherwise swap it and bind the
 * referee to a different referrer while the signature still verified.
 *
 * @module
 */

import { rawSign } from "../crypto.js";
import { bytesToHex } from "../encoding.js";

/** A signed request envelope: the literal payload string, and its signature. */
export interface SignedEnvelope {
  /**
   * The exact JSON string that was signed.
   *
   * Sent literally, never re-serialised — the server uses these bytes as
   * the message, so a round trip through `JSON.parse`/`stringify` can
   * invalidate a perfectly good signature.
   */
  payload: string;
  /** Hex-encoded 64-byte Fuel compact signature. */
  signature: string;
}

/** Whether a referral grant has landed on chain. */
export type TurboReferralState = "pending" | "active" | "cleared" | string;

/** What the referral discount applies to. */
export type TurboReferralScope = string;

/** The referee half: has this wallet been referred, and is the discount live? */
export interface TurboReferralStatus {
  referee: string;
  /** Never-referred is a fact, not an error. */
  referred: boolean;
  referrer_address?: string;
  code?: string;
  state?: TurboReferralState;
  discount_bps?: number;
  scope?: TurboReferralScope;
  granted_at?: string | null;
  expires_at?: string | null;
  grant_tx?: string | null;
  cleared_at?: string | null;
  /**
   * THE ONLY FIELD A PURCHASE FLOW MAY GATE ON.
   *
   * True exactly when the grant has landed on chain. Until then the
   * discount does not exist, and quoting a discounted price against a
   * pending grant is the worst version of this feature.
   */
  discount_active?: boolean;
}

/** A minted referral code. */
export interface TurboReferralCode {
  owner_address: string;
  /** `^[A-Z0-9]{3,20}$`. */
  code: string;
  /** Nullable by design: a referrer may hand out a link before trading. */
  owner_identity: string | null;
  created_at: string;
  is_active: boolean;
  /** False on every call after the first — minting is idempotent. */
  created: boolean;
}

/** The outcome of binding a wallet to a code. */
export interface TurboReferralActivation {
  referee_address: string;
  referrer_address: string;
  code: string;
  /**
   * The real outcome. Usually already `"active"` — the endpoint attempts
   * the on-chain grant in-request. Gate on `discount_active`, never on the
   * mere fact that the call succeeded.
   */
  state: TurboReferralState;
  discount_bps: number;
  scope: TurboReferralScope;
  granted_at: string | null;
  expires_at: string | null;
  grant_tx: string | null;
  discount_active: boolean;
  note?: string;
}

/** A random v4 UUID, for the payload's single-use nonce. */
function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Node 22 always has webcrypto; this is for exotic embedders only.
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Build the canonical payload string for a signed referral request.
 *
 * The server bounds `issuedAt` to a five-minute window and rejects a
 * repeated `nonce`, so neither is decorative.
 */
export function buildReferralPayload(params: {
  action: "turbo_referral_code" | "turbo_referral_activate";
  traderId: string;
  code?: string;
  nonce?: string;
  issuedAt?: string;
}): string {
  return JSON.stringify({
    action: params.action,
    traderId: params.traderId,
    ...(params.code ? { code: params.code } : {}),
    nonce: params.nonce ?? uuid(),
    issuedAt: params.issuedAt ?? new Date().toISOString(),
  });
}

/**
 * Sign a referral payload with a session private key.
 *
 * `rawSign` is the right primitive here and not by coincidence: the server
 * recovers from `sha256(payload-bytes)` with no Fuel message prefix, which
 * is precisely what `rawSign` signs.
 */
export function signReferralPayload(
  sessionPrivateKey: Uint8Array,
  payload: string,
): SignedEnvelope {
  const message = new TextEncoder().encode(payload);
  return { payload, signature: bytesToHex(rawSign(sessionPrivateKey, message)) };
}

/** Build and sign a payload in one step. */
export function buildSignedReferralEnvelope(
  sessionPrivateKey: Uint8Array,
  params: Parameters<typeof buildReferralPayload>[0],
): SignedEnvelope {
  return signReferralPayload(sessionPrivateKey, buildReferralPayload(params));
}
