/** Lowercase a hex id for comparison. */
export function normaliseHex(id: string): `0x${string}` {
  const lower = id.toLowerCase();
  return (lower.startsWith("0x") ? lower : `0x${lower}`) as `0x${string}`;
}

/**
 * Compare two hex ids.
 *
 * Not decorative: tier asset lists come back as BARE hex while market ids
 * carry `0x`, so a plain `===` matches nothing and every market reads as
 * allowed.
 */
export function sameHex(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normaliseHex(a) === normaliseHex(b);
}
