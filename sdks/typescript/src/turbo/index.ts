/**
 * Turbo (margin) trading on O2.
 *
 * A Turbo account is a margin child of an ordinary trade account. Its
 * collateral sits with the POOL rather than on the account, which is why
 * every trade carries a funding leg: a buy draws quote against the credit
 * line, a sell borrows the asset in kind. {@link TurboClient} composes
 * those legs so a caller only says `long` or `short`.
 *
 * Reach it through {@link O2Client.turbo} rather than constructing it.
 *
 * @module
 */

export * from "./actions.js";
export * from "./client.js";
export * from "./encoding.js";
export * from "./formulas.js";
export type { PreparedBatch, PreparedMarketActions, TurboHost } from "./host.js";
export * from "./limits.js";
export * from "./parallelNonce.js";
export * from "./referral.js";
export * from "./terms.js";
export * from "./wire.js";
