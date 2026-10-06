import { O2Error } from "../errors.js";

/**
 * Normalize the account and session ID used for Turbo volume requests.
 */
export function canonicalTurboAccountId(id: string): string {
  const match = /^(?:0x)?([0-9a-f]{64}):([0-9]+)$/i.exec(id);
  if (!match) throw new O2Error("Invalid Turbo account ID: expected contract:session");
  return `0x${match[1].toLowerCase()}:${BigInt(match[2])}`;
}
