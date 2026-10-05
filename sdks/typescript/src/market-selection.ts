import { O2Error } from "./errors.js";
import type { MarketSelection } from "./models.js";

/** Preserve historical requests by omitting the public selector. */
export function selectionParams(selection: MarketSelection): { turbo?: true } {
  return selection.turbo ? { turbo: true } : {};
}

/** Refuse a server that silently serves another venue. */
export function assertMarketSelection(raw: unknown, selection: MarketSelection): void {
  if (Array.isArray(raw)) {
    for (const row of raw) assertMarketSelection(row, selection);
    return;
  }
  const turbo =
    raw !== null && typeof raw === "object" && (raw as { turbo?: boolean }).turbo === true;
  if (turbo !== !!selection.turbo) {
    throw new O2Error("The API did not return the requested trading market");
  }
}
