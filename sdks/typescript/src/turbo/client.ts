/**
 * The Turbo (margin) trading surface.
 *
 * This is the abstraction the rest of the module exists to serve: a caller
 * says `long` or `short` and the funding, the sweep and the settle happen
 * behind it, in ONE signed atomic batch, exactly as the O2 front end does
 * it. The trader-facing vocabulary never mentions draw, borrow, pool or
 * debt — those are what the module translates into.
 *
 * Two things make this more than sugar over `createOrder`:
 *
 * 1. **A Turbo account holds no cash.** The collateral went to the POOL at
 *    `start_session`, so a buy must `Draw` and a sell must `Borrow` in the
 *    same batch as the order, or the order forwards coins it does not have
 *    and reverts on custody.
 * 2. **Both halves must be reproduced.** The backend re-derives every call
 *    from the typed action and checks the signature against its own
 *    derivation, so the action and the call are built together and must
 *    stay in step.
 *
 * @module
 */

import type { ContractCall } from "../encoding.js";
import { adjustQuantityForPrices, validateFractionalPrice } from "../encoding.js";
import { O2Error } from "../errors.js";
import type {
  Identity,
  Market,
  MarketId,
  MarketsResponse,
  Numeric,
  OrderType,
  SessionActionsResponse,
  TradeAccountId,
} from "../models.js";
import type { ProtectionSpec } from "../triggers.js";
import {
  PARENT_ORDER_PLACEHOLDER,
  priceTick,
  protectionLeg,
  triggerLockPrice,
} from "../triggers.js";
import { capitalizeSide, scaleOrderType } from "../utils.js";
import type { MarginAction } from "./actions.js";
import {
  addMarginCollateralAction,
  borrowAction,
  closeMarginSessionAction,
  drawAction,
  prolongSessionAction,
  registerMarginAccountAction,
  repayAction,
  repayBaseFromCollateralAction,
  repayFromCollateralAction,
  returnQuoteAction,
  setAutoProlongAction,
  setMarginAccountSessionAction,
  startMarginSessionAction,
  withdrawFromMarginAccountAction,
} from "./actions.js";
import type { MarginWiring } from "./encoding.js";
import { marginActionToCall } from "./encoding.js";
import { big, max, min, scaleDecimalString } from "./formulas.js";
import type { SessionState, TurboHost } from "./host.js";
import type { MarginLimits } from "./limits.js";
import {
  marginBorrowableBase,
  marginDrawAmount,
  marginLimits,
  marginShortableBase,
} from "./limits.js";
import {
  encodeParallelNonce,
  firstFreePosition,
  NONCE_BITMAP_SIZE,
  newMarginAccountNonce,
  OWNER_NONCE_TTL_SECONDS,
} from "./parallelNonce.js";
import type {
  TurboReferralActivation,
  TurboReferralCode,
  TurboReferralStatus,
} from "./referral.js";
import { buildSignedReferralEnvelope } from "./referral.js";
import type {
  Hex,
  MarginStateWire,
  MarginTierWire,
  NextMarginAccount,
  OrderBookCleanup,
  ProlongPeriod,
} from "./wire.js";
import {
  marginSession,
  normaliseHex,
  PROLONG_PERIODS,
  periodForSeconds,
  prolongPeriodIndex,
  sameHex,
} from "./wire.js";

/**
 * The margin child's session never expires on its own — the contract
 * overwrites both the expiry and the contract scope. A far-future stamp
 * keeps the ABI happy and the intent readable.
 */
export const MARGIN_SESSION_EXPIRY = 4_102_444_800;

/** How long to wait for a registration to be indexed before giving up. */
const REGISTRATION_INDEX_TIMEOUT_MS = 60_000;
const REGISTRATION_POLL_MS = 1_000;

/**
 * How long to let the indexer catch up between settlement rounds.
 *
 * The margin state is served from an indexer, so a read immediately after a
 * repay still shows the pre-repay figure.
 */
const SETTLE_INDEX_DELAY_MS = 3_000;

/** The deployment's margin wiring, as `/v1/markets` serves it. */
export interface TurboWiring extends MarginWiring {
  /** The collateral asset's decimals — the scale of every raw figure. */
  collateralDecimals: number;
  /** The band the chain shocks marks by, bps. */
  stressBandBps: number | null;
}

/** One open position, in trader-facing terms. */
export interface TurboPosition {
  /** The market this position is on. */
  market: Market;
  /** The base asset. */
  assetId: Hex;
  /** Signed base quantity: positive is long, negative is short. */
  quantity: bigint;
  /** `"long"` or `"short"`. */
  side: "long" | "short";
  /** What the pool marks it at right now, raw collateral units. */
  markValue: bigint;
  /** In-kind debt behind a short, base units. */
  debt: bigint;
}

/** A readable view of the account. */
export interface TurboSnapshot {
  marginAccountId: Hex;
  /** Null when the account has no live session. */
  tier: MarginTierWire | null;
  /** The credit line, raw collateral units. */
  creditLine: bigint;
  /** The trader's own money: `V - k`. */
  equity: bigint;
  /** What a new buy may cost. */
  availableToTrade: bigint;
  /** Seconds of session life remaining, from SERVER time. */
  secondsRemaining: number | null;
  /**
   * Close-only: the pool will admit no new exposure.
   *
   * The pool's own freeze test — STRESSED equity against the live freeze
   * line — not a comparison of raw equity to the tier's `open_buffer`,
   * which reads false on exactly the accounts that need topping up.
   */
  frozen: boolean;
  /**
   * Keeper-eligible. Still recoverable — this is not a teardown.
   *
   * Stated in `V` against the live liquidation line, which on a prepaid
   * session is an anchored floor allowed to sit below `k` itself.
   */
  liquidatable: boolean;
  limits: MarginLimits | null;
}

/** Options shared by {@link TurboClient.long} and {@link TurboClient.short}. */
export interface TurboOrderOptions {
  /**
   * Limit price. Required unless the market is being taken at the book's
   * own top — see {@link TurboOrderOptions.orderType}.
   *
   * A price is needed even for a market order, because the ESCROW the
   * order forwards is priced from it and the funding leg must cover that
   * escrow exactly. Omit it and the best bid/ask is fetched and used.
   */
  price?: Numeric;
  /** Defaults to `"Spot"`. */
  orderType?: OrderType;
  /** Return the created orders in the response. Defaults to `true`. */
  collectOrders?: boolean;
  /**
   * Attach a take-profit to the position this opens.
   *
   * Rides the SAME batch as the order and the funding leg, so the
   * protection exists the moment the position does.
   *
   * Must be priced — give `limitPrice` or `slippageBps`. A margin account
   * refuses an unbounded market trigger, because an unpriced order cannot
   * be walked for risk.
   */
  takeProfit?: ProtectionSpec;
  /** Attach a stop-loss. Same rules as {@link TurboOrderOptions.takeProfit}. */
  stopLoss?: ProtectionSpec;
}

/** Size a position by base quantity or by collateral notional, not both. */
export type TurboSize =
  | { quantity: Numeric; notional?: never }
  | { notional: Numeric; quantity?: never };

/** The result of opening a Turbo account. */
export interface TurboOpenResult {
  marginAccountId: Hex;
  index: number;
  /** The tx that registered the account; null when an existing one was adopted. */
  registerTxId: string | null;
  /** The tx that started the session; null when it was already live. */
  startTxId: string | null;
}

/** How far to scan for a parent's existing children. */
const DISCOVERY_DEPTH = 8;

/**
 * Whether the chain (and the indexer) know about this child yet.
 *
 * `/v1/margin/state` is the authority: it refuses an unregistered child
 * with "unknown margin account" and serves a state — session or not — once
 * the registration event has been indexed.
 */
async function isRegisteredAccount(api: TurboHost["api"], marginAccountId: Hex): Promise<boolean> {
  try {
    await api.getMarginState(marginAccountId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk indices upward until an unregistered child turns up: those below it
 * are the owner's, and it is the next one they can open.
 *
 * Needed because plenty of deployments serve neither `margin_accounts` nor
 * `next_margin_account` on `/v1/accounts` — testnet answers
 * `{trade_account_id, trade_account, session}` and nothing else. A child's
 * id is a pure function of `(oracle, parent, index)`, so it can be derived
 * for any index; whether it is REGISTERED is the separate question that
 * `/v1/margin/state` answers.
 */
async function walkMarginAccounts(
  api: TurboHost["api"],
  parentContractId: Hex,
): Promise<{ accounts: NextMarginAccount[]; next: NextMarginAccount | null }> {
  const accounts: NextMarginAccount[] = [];
  let previousId: Hex | null = null;

  for (let index = 0; index < DISCOVERY_DEPTH; index++) {
    const candidate = await api.getNextMarginAccount(parentContractId, index);
    if (!candidate?.contract_id) break;
    const id = normaliseHex(candidate.contract_id);

    // A deployment that IGNORES `index` answers with the same id every
    // time. Walking further would spin on one account forever.
    if (previousId && id === previousId) break;
    previousId = id;

    if (await isRegisteredAccount(api, id)) {
      accounts.push({ contract_id: id, index });
      continue;
    }
    return { accounts, next: { contract_id: id, index } };
  }
  return { accounts, next: null };
}

/**
 * Trade a Turbo (margin) account.
 *
 * Obtain one from {@link O2Client.turbo} rather than constructing it.
 */
export class TurboClient {
  private readonly host: TurboHost;
  private wiringCache: TurboWiring | null = null;
  private accountId: Hex | null = null;
  /**
   * Where each margin child's parallel-nonce cursor has reached.
   *
   * A margin batch is accepted under a PARALLEL nonce only, and a parallel
   * position is burned whether or not the batch lands — so this only ever
   * moves forward. A brand-new child's window base is 0, which is why the
   * cursor starts at (word 0, bit 0).
   *
   * In-memory: a fresh process re-walks positions the previous one burned
   * and the chain refuses them, so a long-lived caller should keep one
   * client rather than rebuilding it per trade.
   */
  private readonly nonceCursors = new Map<Hex, { word: bigint; bit: number }>();
  /** Which session key each child is known to be armed with. */
  private readonly armedKeys = new Map<Hex, string>();

  constructor(host: TurboHost) {
    this.host = host;
  }

  // ── Wiring and discovery ────────────────────────────────────────

  /**
   * The deployment's margin wiring.
   *
   * Cached: it is fetch-once configuration, and every sizing decision needs
   * the collateral asset id. Throws when margin is not wired at all, which
   * is the honest answer to "trade Turbo here" on a deployment where Turbo
   * is off.
   */
  async wiring(): Promise<TurboWiring> {
    if (this.wiringCache) return this.wiringCache;
    const markets = await this.host.fetchMarkets();
    const raw = markets.margin;
    if (!raw?.margin_pool_id || !raw?.collateral_asset_id) {
      throw new O2Error(
        "Turbo is not available on this deployment — /v1/markets carries no margin wiring.",
      );
    }
    const collateralAssetId = normaliseHex(raw.collateral_asset_id);
    const collateralMarket = markets.markets.find(
      (m) => sameHex(m.quote.asset, collateralAssetId) || sameHex(m.base.asset, collateralAssetId),
    );
    const collateralDecimals = collateralMarket
      ? sameHex(collateralMarket.quote.asset, collateralAssetId)
        ? collateralMarket.quote.decimals
        : collateralMarket.base.decimals
      : 6;

    this.wiringCache = {
      poolId: normaliseHex(raw.margin_pool_id),
      registryId: markets.accounts_registry_id as Hex,
      collateralAssetId,
      parentAccountId: this.host.ensureSession().tradeAccountId as Hex,
      collateralDecimals,
      stressBandBps: raw.stress_band_bps === undefined ? null : Number(raw.stress_band_bps),
    };
    return this.wiringCache;
  }

  /**
   * The margin children this owner already has, plus the id of the next one
   * they could open.
   *
   * The `next` id is a pure function of `(oracle, parent, index)`, which is
   * what makes it signable before the account exists.
   */
  async accounts(): Promise<{ accounts: NextMarginAccount[]; next: NextMarginAccount | null }> {
    const session = this.host.ensureSession();
    const info = (await this.host.api.getAccount({
      owner: session.ownerAddress,
    })) as unknown as {
      margin_accounts?: NextMarginAccount[];
      next_margin_account?: NextMarginAccount | null;
      trade_account_id?: string;
    };

    // THE NEWER SHAPE, when the deployment serves it.
    if (info.margin_accounts !== undefined || info.next_margin_account !== undefined) {
      const accounts = info.margin_accounts ?? [];
      // `/v1/accounts` stops predicting once the owner already has an
      // account, even when the next index is perfectly openable — which is
      // exactly the state a trader is in right after closing one.
      let next = info.next_margin_account ?? null;
      if (!next && info.trade_account_id) {
        next = await this.host.api.getNextMarginAccount(info.trade_account_id as Hex);
      }
      return { accounts, next };
    }

    // DERIVE IT, because plenty of deployments carry neither field.
    //
    // Testnet's `/v1/accounts` answers `{trade_account_id, trade_account,
    // session}` and nothing else, so keying discovery off `margin_accounts`
    // reported every owner as having no accounts and made
    // `waitForRegistration` unsatisfiable — a registration that had
    // genuinely landed on chain looked like it never arrived.
    //
    // A child's id is a pure function of `(oracle, parent, index)`, and
    // `/v1/margin/next-account` will derive it for any index. Whether that
    // id is REGISTERED is then a separate question, answered by whether
    // `/v1/margin/state` knows it: an unregistered child is refused with
    // "unknown margin account".
    if (!info.trade_account_id) return { accounts: [], next: null };
    return walkMarginAccounts(this.host.api, info.trade_account_id as Hex);
  }

  /**
   * Every margin contract this owner's SESSION must be scoped to.
   *
   * The trade account runs `is_contract_allowed` per call, so a target
   * outside the session's signed `contract_ids` is refused with
   * `MarginAccountNotInSessionScope` — and the scope cannot be widened
   * afterwards, because it is part of what the wallet signed. Hence this is
   * gathered at session-CREATION time and deliberately covers accounts that
   * do not exist yet.
   *
   * Best effort throughout: margin may not be wired here, and a failure
   * must not stop an ordinary session being created.
   */
  static async sessionScope(
    api: TurboHost["api"],
    ownerAddress: string,
    depth = 3,
  ): Promise<Hex[]> {
    const scope = new Set<Hex>();
    try {
      const markets = await api.getMarkets();
      const raw = markets.margin;
      if (!raw?.margin_pool_id) return [];
      scope.add(normaliseHex(raw.margin_pool_id));
      // THE REGISTRY, TOO. `RegisterMarginAccount` targets it, so a scope
      // without it opens no account at all — `turbo.open()` is refused with
      // `MarginAccountNotInSessionScope` and no retry helps, because the
      // scope is part of what the wallet signed.
      if (markets.accounts_registry_id) {
        scope.add(normaliseHex(markets.accounts_registry_id));
      }
    } catch {
      return [];
    }

    let parent: string | undefined;
    let apiNext: NextMarginAccount | null = null;
    let apiServesMarginFields = false;
    try {
      const info = (await api.getAccount({ owner: ownerAddress })) as unknown as {
        margin_accounts?: NextMarginAccount[];
        next_margin_account?: NextMarginAccount | null;
        trade_account_id?: string;
      };
      parent = info.trade_account_id;
      apiServesMarginFields =
        info.margin_accounts !== undefined || info.next_margin_account !== undefined;
      for (const account of info.margin_accounts ?? []) {
        scope.add(normaliseHex(account.contract_id));
      }
      if (info.next_margin_account) {
        apiNext = info.next_margin_account;
        scope.add(normaliseHex(info.next_margin_account.contract_id));
      }
    } catch {
      // Discovery failed; the pool and registry alone are still worth
      // scoping — they are what every account shares.
    }

    if (parent) {
      let from = apiNext?.index ?? 0;

      // DERIVE THE EXISTING CHILDREN when `/v1/accounts` does not carry
      // them. Testnet answers `{trade_account_id, trade_account, session}`
      // and nothing else, and their absence would silently leave every
      // account the trader already owns outside the signed scope — which
      // cannot be repaired without a fresh wallet signature.
      if (!apiServesMarginFields) {
        const walked = await walkMarginAccounts(api, parent as Hex).catch(() => ({
          accounts: [] as NextMarginAccount[],
          next: null,
        }));
        for (const account of walked.accounts) scope.add(normaliseHex(account.contract_id));
        if (walked.next) scope.add(normaliseHex(walked.next.contract_id));
        from = walked.next?.index ?? walked.accounts.length;
      }

      // Then the next few they COULD open, so one signature carries them
      // through a second and a third. Asked from the next FREE index
      // upward, never from absolute zero: those slots may already be taken,
      // and re-adding ids already in scope buys nothing.
      const predictions = await Promise.all(
        Array.from({ length: depth }, (_, offset) =>
          api.getNextMarginAccount(parent as Hex, from + offset).catch(() => null),
        ),
      );
      for (const p of predictions) {
        if (p?.contract_id) scope.add(normaliseHex(p.contract_id));
      }
    }

    return [...scope];
  }

  /** Point this client at a specific margin account. */
  use(marginAccountId: Hex): this {
    this.accountId = normaliseHex(marginAccountId);
    return this;
  }

  /**
   * The margin account this client is operating.
   *
   * Resolves to the owner's first existing child when none was named.
   */
  async marginAccountId(): Promise<Hex> {
    if (this.accountId) return this.accountId;
    const { accounts } = await this.accounts();
    const first = accounts[0];
    if (!first) {
      throw new O2Error("No Turbo account for this owner. Call turbo.open() first.");
    }
    this.accountId = normaliseHex(first.contract_id);
    return this.accountId;
  }

  // ── Reads ───────────────────────────────────────────────────────

  /**
   * The tiers currently ON SALE.
   *
   * `/v1/margin/tiers` serves retired versions alongside live ones, and on
   * testnet the first entry is a disabled tier — so `tiers()[0]` would open
   * nothing and the pool answers "tier N is disabled and no longer sells
   * new sessions" only after the batch is signed. Filtered here so the
   * obvious call is the correct one.
   *
   * @param options.includeDisabled - Return retired tiers too, for
   *   displaying the history of what an account was opened onto.
   */
  async tiers(options: { includeDisabled?: boolean } = {}): Promise<MarginTierWire[]> {
    const all = await this.host.api.getMarginTiers();
    if (options.includeDisabled) return all;
    // `enabled` is absent on older payloads, where every served tier is
    // sellable — so only an explicit `false` disqualifies one.
    return all.filter((tier) => tier.enabled !== false);
  }

  /**
   * Which terms a tier will actually sell.
   *
   * A PREPAID tier sells exactly one — `turbo.term_seconds`, a flat week on
   * the deployed tiers — and `open_session` refuses every other period.
   * That refusal arrives from the pool AFTER the batch is signed, which is
   * the wrong place to learn it, so {@link TurboClient.open} reads this
   * instead and defaults to it.
   *
   * A legacy tier sells all four.
   */
  sellablePeriods(tier: MarginTierWire): ProlongPeriod[] {
    const term = tier.turbo?.term_seconds;
    if (term === undefined) return [...PROLONG_PERIODS];
    const period = periodForSeconds(term);
    // A term that matches no period is not something to guess about.
    return period ? [period] : [];
  }

  /**
   * The cheapest tier a caller could open right now, by the collateral it
   * demands. `null` when nothing is on sale.
   */
  async cheapestTier(period?: ProlongPeriod): Promise<MarginTierWire | null> {
    const tiers = (await this.tiers()).filter(
      (tier) => period === undefined || this.sellablePeriods(tier).includes(period),
    );
    if (tiers.length === 0) return null;
    return tiers.reduce((best, tier) =>
      this.openingCost(tier, period) < this.openingCost(best, period) ? tier : best,
    );
  }

  /**
   * What opening this tier costs, all in — the collateral it requires plus
   * the premium the entry pays.
   *
   * The entry BUYS ITS FIRST TERM, so it is not `required_collateral`
   * alone: the pool charges `open_fee + prolong_fee[period]` out of the
   * same forwarded amount, and forwarding only the collateral opens
   * nothing.
   */
  openingCost(tier: MarginTierWire, period?: ProlongPeriod): bigint {
    const term = period ?? this.sellablePeriods(tier)[0] ?? "Month";
    return (
      big(tier.required_collateral) +
      big(tier.open_fee) +
      big(tier.prolong_fee[prolongPeriodIndex(term)])
    );
  }

  /** The live state of the margin account. */
  async state(marginAccountId?: Hex): Promise<MarginStateWire> {
    return this.host.api.getMarginState(marginAccountId ?? (await this.marginAccountId()));
  }

  /** The pool's collateral float and per-asset inventory. */
  async poolInventory(): Promise<{ float: bigint | null; inventory: Map<Hex, bigint> }> {
    const wiring = await this.wiring();
    try {
      const pool = await this.host.api.getMarginPool();
      const inventory = new Map<Hex, bigint>();
      for (const row of pool.inventory ?? []) {
        inventory.set(normaliseHex(row.asset_id), big(row.amount));
      }
      return { float: inventory.get(wiring.collateralAssetId) ?? 0n, inventory };
    } catch {
      // A float we could not read is UNKNOWN, not zero: reading it as zero
      // would refuse every draw. The chain refuses independently.
      return { float: null, inventory: new Map() };
    }
  }

  /**
   * The full gate stack for this account — every on-chain rule a Turbo
   * order must clear, derived from one state snapshot.
   */
  async limits(marginAccountId?: Hex): Promise<MarginLimits | null> {
    const wiring = await this.wiring();
    const [wire, pool] = await Promise.all([this.state(marginAccountId), this.poolInventory()]);
    return marginLimits(
      wire,
      pool.float,
      wiring.stressBandBps ?? undefined,
      wiring.collateralAssetId,
    );
  }

  /** A readable summary of the account. */
  async snapshot(marginAccountId?: Hex): Promise<TurboSnapshot> {
    const wiring = await this.wiring();
    const id = marginAccountId ?? (await this.marginAccountId());
    const [wire, pool] = await Promise.all([this.state(id), this.poolInventory()]);
    const limits = marginLimits(
      wire,
      pool.float,
      wiring.stressBandBps ?? undefined,
      wiring.collateralAssetId,
    );
    const session = marginSession(wire);
    const expiresAt = session?.expires_at === undefined ? null : Number(session.expires_at);

    // BOTH FLAGS COME FROM THE GATE STACK, not from arithmetic here.
    //
    // `frozen` is the pool's own freeze test — STRESSED equity against the
    // live freeze line plus its absorption cushion — which `marginLimits`
    // has already evaluated as `stressFrozen`. Comparing unstressed equity
    // to the tier's `open_buffer` is only the same thing on a legacy tier
    // at a zero band, and it reads `false` on a prepaid or stressed account
    // that the pool has already put into close-only. A caller who tops up
    // margin when `frozen` goes true would miss exactly that window.
    //
    // `liquidatable` is stated by the pool in `V`, not in equity, against
    // the live liquidation line — the anchored floor on a prepaid session,
    // which is allowed to sit below `k + maintenance` and below `k` itself.
    return {
      marginAccountId: id,
      tier: wire.tier ?? null,
      creditLine: session ? big(session.credit_line) : 0n,
      equity: limits?.equity ?? 0n,
      availableToTrade: limits?.spendable ?? 0n,
      secondsRemaining: expiresAt === null ? null : Math.max(0, expiresAt - wire.now),
      frozen: limits?.stressFrozen ?? false,
      liquidatable: limits ? limits.markToMarket <= limits.liquidationThreshold : false,
      limits,
    };
  }

  /**
   * Open positions, derived from the account's balances and the oracle.
   *
   * A negative quantity is a short: the account owes the asset in kind.
   */
  async positions(marginAccountId?: Hex): Promise<TurboPosition[]> {
    const wiring = await this.wiring();
    const [wire, markets] = await Promise.all([
      this.state(marginAccountId),
      this.host.fetchMarkets(),
    ]);
    const out: TurboPosition[] = [];
    for (const row of wire.balances) {
      if (sameHex(row.asset_id, wiring.collateralAssetId)) continue;
      const held = big(row.on_account) + big(row.received) + big(row.locked) + big(row.settled);
      const debt = big(row.debt);
      const quantity = held - debt;
      if (quantity === 0n) continue;
      const market = markets.markets.find((m) => sameHex(m.base.asset, row.asset_id));
      if (!market) continue;
      const price = wire.prices.find((p) => sameHex(p.asset_id, row.asset_id));
      const mark = price ? (quantity >= 0n ? big(price.bid) : big(price.ask)) : 0n;
      const scale = 10n ** BigInt(18 + (price?.asset_decimals ?? 0) - wire.collateral_decimals);
      out.push({
        market,
        assetId: normaliseHex(row.asset_id),
        quantity,
        side: quantity >= 0n ? "long" : "short",
        markValue: scale > 0n ? (quantity * mark) / scale : 0n,
        debt,
      });
    }
    return out;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Open a Turbo account.
   *
   * TWO session-signed submissions, in order, and they cannot be merged:
   * the backend's validator wants the child ABSENT from storage to register
   * it and PRESENT to start a session on it, and storage only learns of it
   * once the on-chain registration event is INDEXED. Hence the wait.
   *
   * `StartMarginSession` and `SetMarginAccountSession` do share that
   * precondition, so they ride one signature.
   *
   * Costs no wallet prompt: every margin action is session-signed.
   */
  async open(params: {
    tierId: number | string;
    /** Margin PLUS the tier's premium, in the collateral asset's base units. */
    collateral: bigint | string;
    /**
     * The first term the entry buys.
     *
     * Optional: a prepaid tier sells exactly one term and the pool refuses
     * every other, so the tier's own is used when this is omitted. Passing
     * one it does not sell throws here rather than after the batch is
     * signed.
     */
    period?: ProlongPeriod;
    /** Called as each stage begins — opening is not instantaneous. */
    onProgress?: (stage: "registering" | "waiting_for_registration" | "starting") => void;
  }): Promise<TurboOpenResult> {
    const session = this.host.ensureSession();
    const wiring = await this.wiring();

    // WHICH TERM THIS TIER ACTUALLY SELLS.
    //
    // A prepaid tier sells one — a flat week on the deployed tiers — and
    // `open_session` refuses anything else. Learning that from the pool
    // means learning it after the batch is signed and a registration has
    // already landed, so resolve it here.
    const tier = (await this.tiers({ includeDisabled: true })).find(
      (candidate) => String(candidate.tier_id) === String(params.tierId),
    );
    const sellable = tier ? this.sellablePeriods(tier) : [...PROLONG_PERIODS];
    if (tier?.enabled === false) {
      throw new O2Error(`Tier ${params.tierId} is disabled and no longer sells new sessions.`);
    }
    const period = params.period ?? sellable[0];
    if (!period) {
      throw new O2Error(`Tier ${params.tierId} publishes a term this SDK cannot map to a period.`);
    }
    if (params.period && !sellable.includes(params.period)) {
      throw new O2Error(
        `Tier ${params.tierId} sells ${sellable.join(", ") || "no"} term(s), not ${params.period}.`,
      );
    }

    // RESUME before registering. The two steps are separately signed, so a
    // caller can land step 1 and lose the run before step 2 — and
    // registering again would strand the first account forever.
    const { accounts, next } = await this.accounts();
    const existing = await this.findResumable(accounts);
    const target = existing ?? next;
    if (!target) {
      throw new O2Error("Turbo accounts are not available — the margin wiring is unresolved.");
    }
    const marginAccountId = normaliseHex(target.contract_id);
    const collateral = BigInt(params.collateral);

    let registerTxId: string | null = null;
    if (!existing) {
      params.onProgress?.("registering");
      const action = registerMarginAccountAction(marginAccountId, target.index);
      const response = await this.submitAsParent([action], wiring, session, {
        endpoint: "marginAccounts",
      });
      registerTxId = response.txId ?? null;

      // The next steps validate THROUGH storage, which the indexer feeds.
      params.onProgress?.("waiting_for_registration");
      await this.waitForRegistration(marginAccountId);
    }

    params.onProgress?.("starting");
    // The SESSION KEY, not the account: arming the child with the trade
    // account's own identity would leave no key able to sign its orders.
    const sessionId: Identity = { Address: session.sessionAddress };
    const actions: MarginAction[] = [
      startMarginSessionAction(marginAccountId, params.tierId, collateral, period),
      setMarginAccountSessionAction({
        marginAccountId,
        marginNonce: newMarginAccountNonce(),
        sessionId,
        expiry: MARGIN_SESSION_EXPIRY,
      }),
    ];
    const start = await this.submitAsParent(actions, wiring, session);

    this.accountId = marginAccountId;
    this.armedKeys.set(marginAccountId, session.sessionAddress);
    return {
      marginAccountId,
      index: target.index,
      registerTxId,
      startTxId: start.txId ?? null,
    };
  }

  /**
   * Top up a live session's margin.
   *
   * Goes STRAIGHT to the pool — `add_collateral` never touches the child.
   */
  async addMargin(amount: bigint | string, marginAccountId?: Hex): Promise<SessionActionsResponse> {
    const session = this.host.ensureSession();
    const wiring = await this.wiring();
    const id = marginAccountId ?? (await this.marginAccountId());
    return this.submitAsParent([addMarginCollateralAction(id, amount)], wiring, session);
  }

  /**
   * Buy more session life.
   *
   * Not every tier sells it. A PREPAID tier publishes `prolong_seconds` of
   * zero for every period — it sells one fixed term and rolls over rather
   * than extending — and `prolong_session` reverts on it. That revert
   * arrives as an undecodable `require` from the pool, so the tier is
   * consulted here and the refusal explains itself instead.
   */
  async extend(
    period: ProlongPeriod,
    times: number = 1,
    marginAccountId?: Hex,
  ): Promise<SessionActionsResponse> {
    const id = marginAccountId ?? (await this.marginAccountId());
    const tier = (await this.state(id)).tier;
    if (tier) {
      const seconds = big(tier.prolong_seconds?.[prolongPeriodIndex(period)]);
      if (seconds <= 0n) {
        throw new O2Error(
          `Tier ${tier.tier_id} does not sell extensions (${period} is worth 0 seconds on it). ` +
            "Prepaid tiers run a fixed term and roll over instead of extending.",
        );
      }
    }
    return this.submitAsChild([prolongSessionAction(period, times)], id);
  }

  /**
   * Arm or disarm auto-extension.
   *
   * The tier publishes which periods it will auto-renew at
   * (`auto_prolong_periods`); an empty list means auto-extension is not
   * offered at all and the pool reverts. Disarming (`null`) is always
   * allowed — it only clears whatever was set.
   */
  async setAutoExtend(
    period: ProlongPeriod | null,
    marginAccountId?: Hex,
  ): Promise<SessionActionsResponse> {
    const id = marginAccountId ?? (await this.marginAccountId());
    if (period !== null) {
      const tier = (await this.state(id)).tier;
      const offered = tier?.auto_prolong_periods ?? [];
      if (tier && !offered.includes(period)) {
        throw new O2Error(
          offered.length === 0
            ? `Tier ${tier.tier_id} does not offer auto-extension.`
            : `Tier ${tier.tier_id} auto-extends at ${offered.join(", ")} — not ${period}.`,
        );
      }
    }
    return this.submitAsChild([setAutoProlongAction(period)], id);
  }

  /**
   * Hand borrowed assets back to the pool in kind.
   *
   * A short leaves an IN-KIND DEBT that closing the position does not by
   * itself retire: buying the base back puts the coins on the account, but
   * the pool is still owed them. `closeAccount` refuses while any remain
   * ("still carries N in-kind debt(s)"), so this is the step between a
   * closed short and a closed account.
   *
   * Repays what the account holds, then converts any remainder straight out
   * of posted collateral — the only exit for a short that moved against the
   * trader, who cannot hand back an asset they no longer have.
   *
   * @returns the assets that could not be fully retired.
   */
  async repayInKind(
    options: { marginAccountId?: Hex; fromCollateral?: boolean; strict?: boolean } = {},
  ): Promise<Hex[]> {
    const id = options.marginAccountId ?? (await this.marginAccountId());
    const wiring = await this.wiring();
    const markets = await this.host.fetchMarkets();
    const wire = await this.state(id);
    const stillOwed: Hex[] = [];

    for (const row of wire.balances) {
      const owed = big(row.debt);
      if (owed <= 0n) continue;
      const assetId = normaliseHex(row.asset_id);
      // The collateral is drawn, not borrowed; its obligation is
      // `drawn_quote` and settles through `repayDrawn`.
      if (sameHex(assetId, wiring.collateralAssetId)) continue;

      // SWEEP BEFORE REPAYING. Buying a short back leaves the base SETTLED
      // on the book, not on the account — `on_account` reads 0 while
      // `settled` holds the coins. Sizing the repay off `on_account` alone
      // therefore repaid NOTHING and fell through to collateral netting,
      // which the pool refuses when the collateral is worth less than the
      // debt. `Repay` forwards coins, so they have to be home first.
      const market = markets.markets.find((m) => sameHex(m.base.asset, assetId));
      const held = big(row.on_account) + (market ? big(row.settled) : 0n);
      const payable = min(owed, held);
      let remaining = owed;

      if (payable > 0n) {
        try {
          if (market && big(row.settled) > 0n) {
            await this.submitMixed(
              [
                { SettleBalance: { to: { ContractId: id } } },
                { Repay: { asset_id: assetId, amount: payable.toString() } },
              ],
              market,
              id,
              wiring,
              {},
            );
          } else {
            await this.submitAsChild([repayAction(assetId, payable)], id);
          }
          remaining = owed - payable;
        } catch (error) {
          if (options.strict) throw error;
          stillOwed.push(assetId);
          continue;
        }
      }

      if (remaining > 0n && options.fromCollateral !== false) {
        // Priced at the ask and charged a fee — not value-neutral for the
        // pool, which is left holding an asset to reacquire. It is still
        // the only exit for a debt the account cannot cover in kind, and
        // after the sweep above the remainder is usually dust.
        try {
          await this.submitAsChild([repayBaseFromCollateralAction(assetId, remaining)], id);
          remaining = 0n;
        } catch (error) {
          if (options.strict) throw error;
          /* otherwise reported through the return value */
        }
      }
      if (remaining > 0n) stillOwed.push(assetId);
    }
    return stillOwed;
  }

  /** Claim an asset out of the margin account, back to the parent. */
  async claim(
    assetId: Hex,
    amount: bigint | string,
    marginAccountId?: Hex,
  ): Promise<SessionActionsResponse> {
    const session = this.host.ensureSession();
    const wiring = await this.wiring();
    const id = marginAccountId ?? (await this.marginAccountId());
    return this.submitAsParent(
      [withdrawFromMarginAccountAction(id, assetId, amount)],
      wiring,
      session,
    );
  }

  /**
   * Close the account cleanly.
   *
   * The pool's one precondition is that no in-kind debts remain — positions
   * are swept in kind rather than sold, so leaving never forces a market
   * exit. The cleanup list is fetched at call time because the chain
   * re-verifies it: a stale list reverts rather than stranding value.
   */
  async closeAccount(
    marginAccountId?: Hex,
    options: { settleDrawnQuote?: boolean; flattenPositions?: boolean } = {},
  ): Promise<SessionActionsResponse> {
    const session = this.host.ensureSession();
    const wiring = await this.wiring();
    const id = marginAccountId ?? (await this.marginAccountId());

    // CLEAR THE DRAW FIRST, because the pool refuses a close while any
    // remains: "still owes N of drawn quote; return or net it away before
    // closing". Returning it needs cash the account may not hold after a
    // losing trade, so fall back to netting it against posted collateral —
    // the only exit that moves no coins.
    //
    // Opt out with `settleDrawnQuote: false` to drive the sequence by hand.
    if (options.settleDrawnQuote !== false) {
      // RESTING ORDERS FIRST OF ALL. A trigger or a limit order left on
      // the child LOCKS the very base a repay needs to forward, so the
      // debt cannot be retired while they stand — and `close_session`'s
      // own cleanup list runs too late to help, because the pool refuses
      // the close before it gets there.
      await this.cancelChildOrders(id).catch(() => null);

      // THEN FLATTEN WHAT IS STILL OPEN.
      //
      // A clean close demands `drawn_quote == 0`, and on an account whose
      // draw is still sitting in a position there is no way to get there
      // without selling it: `ReturnQuote` needs cash the account does not
      // hold and `RepayFromCollateral` needs collateral the line already
      // converted. Closing the positions is the only route, so
      // `closeAccount` takes it rather than reporting a dead end.
      //
      // Pass `flattenPositions: false` to drive the sequence by hand.
      if (options.flattenPositions !== false) {
        for (const position of await this.positions(id).catch(() => [])) {
          await this.closePosition(position.market, { marginAccountId: id }).catch(() => null);
        }
        // Let the fills index before anything is sized against them.
        await new Promise((resolve) => setTimeout(resolve, SETTLE_INDEX_DELAY_MS));
        await this.cancelChildOrders(id).catch(() => null);
      }

      // IN-KIND DEBTS NEXT. A closed short still leaves the pool owed the
      // asset, and the close is refused while any remain — "still carries
      // N in-kind debt(s)". Retiring them can also free quote, so this runs
      // before the drawn-quote settlement rather than after.
      await this.repayInKind({ marginAccountId: id }).catch(() => []);
      await this.settleDrawnQuote(id);
    }

    const cleanups: OrderBookCleanup[] = await this.host.api.getMarginCloseCleanups(id);
    try {
      return await this.submitAsParent([closeMarginSessionAction(id, cleanups)], wiring, session);
    } catch (error) {
      // SAY WHAT TO DO ABOUT IT. An account whose draw is still tied up in
      // a position it cannot fund buying back has no self-serve exit:
      // `ReturnQuote` needs cash it does not hold and
      // `RepayFromCollateral` needs collateral the line already converted.
      // Adding margin gives the netting something to work with — verified
      // against a stuck account, which closed cleanly straight afterwards.
      const message = String((error as Error)?.message ?? error);
      if (/still owes .* drawn quote|in-kind debt/i.test(message)) {
        throw new O2Error(
          `${message} — add margin (turbo.addMargin) so the netting has collateral to work against, then close again.`,
        );
      }
      throw error;
    }
  }

  /**
   * Cancel every resting order the child holds, spot and trigger alike.
   *
   * Runs as the CHILD, one batch per market, five ids at a time.
   */
  private async cancelChildOrders(marginAccountId: Hex): Promise<void> {
    const markets = await this.host.fetchMarkets();
    const wiring = await this.wiring();

    for (const market of markets.markets) {
      const active = await this.host.api
        .getActiveOrders(
          market.market_id,
          marginAccountId as unknown as TradeAccountId,
          "desc",
          200,
        )
        .catch(() => null);
      if (!active?.entries?.length) continue;

      const actions: Record<string, unknown>[] = [];
      for (const entry of active.entries) {
        if (entry.kind === "trigger") {
          actions.push({ CancelTriggerOrder: { order_id: entry.order_id } });
          continue;
        }
        actions.push({ CancelOrder: { order_id: entry.order_id } });
        for (const child of (entry as { triggers?: { order_id: string }[] }).triggers ?? []) {
          actions.push({ CancelTriggerOrder: { order_id: child.order_id } });
        }
      }

      for (let i = 0; i < actions.length; i += 5) {
        await this.submitMixed(actions.slice(i, i + 5), market, marginAccountId, wiring, {}).catch(
          () => null,
        );
      }
      // Bring whatever those cancels freed home, so the repay can forward it.
      await this.submitMixed(
        [{ SettleBalance: { to: { ContractId: marginAccountId } } }],
        market,
        marginAccountId,
        wiring,
        {},
      ).catch(() => null);
    }
  }

  /**
   * Drive `drawn_quote` to zero, which a clean close requires.
   *
   * LOOPS, because one round does not finish the job: each repay is sized
   * against a snapshot, and by the time the batch executes the figure has
   * moved — fees accrue, and the `ReturnQuote` leg itself changes what the
   * next round can net. A single pass took a 9,999,774,597 draw down to
   * 68,911,645 and the pool still refused the close.
   *
   * Each round returns cash first (cheap, value-neutral) and then nets the
   * remainder against posted collateral, which is the only exit for a draw
   * the account no longer holds the cash to return. Stops on zero, on no
   * progress, or after a bounded number of rounds — never spins.
   */
  private async settleDrawnQuote(marginAccountId: Hex, rounds = 6): Promise<bigint> {
    let previous: bigint | null = null;
    let stalled = 0;

    for (let round = 0; round < rounds; round++) {
      const drawn = big(
        marginSession(await this.state(marginAccountId).catch(() => null))?.drawn_quote,
      );
      if (drawn <= 0n) return 0n;

      // NOT PROGRESS-CHECKED ON ONE READ. The margin state is served from
      // an indexer, so the read right after a repay routinely still shows
      // the pre-repay figure — treating that as "stalled" abandoned the
      // whole settlement after a single round and left the original draw
      // untouched. Two consecutive non-decreases are needed before giving
      // up, and the close reports the real reason if it comes to that.
      if (previous !== null && drawn >= previous) {
        if (++stalled >= 2) return drawn;
      } else {
        stalled = 0;
      }
      previous = drawn;

      await this.repayDrawn(undefined, { marginAccountId }).catch(() => null);
      await this.repayDrawn(undefined, { marginAccountId, fromCollateral: true }).catch(() => null);
      // Let the indexer catch up before the next round sizes against it.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_INDEX_DELAY_MS));
    }
    return big(marginSession(await this.state(marginAccountId).catch(() => null))?.drawn_quote);
  }

  // ── Trading ─────────────────────────────────────────────────────

  /**
   * Go long: buy, funded by a draw against the credit line.
   *
   * One batch, in order: sweep the book so settled cash is where the
   * chain's custody check looks, draw whatever the account's own cash
   * cannot cover, then buy.
   *
   * The sweep is not housekeeping. Custody counts only what is ON the
   * account while settled funds sit on the book, so an account with plenty
   * of settled cash is refused for want of coins it already owns — and the
   * draw, sized against the same figure, correctly concludes it needs
   * nothing. Sweeping first makes both true at once.
   */
  async long(
    market: string | Market,
    size: TurboSize,
    options: TurboOrderOptions & { marginAccountId?: Hex } = {},
  ): Promise<SessionActionsResponse> {
    return this.trade("buy", market, size, options);
  }

  /**
   * Go short: borrow the asset in kind, then sell it.
   *
   * A Turbo account holds no base until it buys some — the collateral went
   * to the pool — so selling means `pool.borrow(asset, qty)` in the same
   * batch. Only assets the tier lists AND the pool actually holds can be
   * shorted; everything else is long-only.
   *
   * A `ReturnQuote` leg rides ahead of the borrow when it is needed: the
   * loan cap gives no credit for cash the account holds, so after closing a
   * long the proceeds sit there while `drawn_quote` still consumes the
   * line. Handing that cash back re-opens the line the borrow needs.
   */
  async short(
    market: string | Market,
    size: TurboSize,
    options: TurboOrderOptions & { marginAccountId?: Hex } = {},
  ): Promise<SessionActionsResponse> {
    return this.trade("sell", market, size, options);
  }

  /**
   * Close a position: trade the opposite side for the whole quantity.
   *
   * The funding legs CLAMP here rather than refusing, which is the
   * opposite of an opening trade and deliberate: a close loops. Taking
   * less this round retires debt and the next round takes more, whereas
   * an open has no next round.
   *
   * When they clamp, the ORDER shrinks with them. A full-size order behind
   * a clamped funding leg is the custody revert the open/close split
   * exists to avoid, just moved one step later — so call this again to
   * close the remainder.
   *
   * This submits the closing order. Retiring the debt the position leaves
   * behind — `repayDrawn` for a long, buying back for a short — is a
   * separate step, because the fill is not known at signing time.
   */
  async closePosition(
    market: string | Market,
    options: TurboOrderOptions & { quantity?: Numeric; marginAccountId?: Hex } = {},
  ): Promise<SessionActionsResponse> {
    const markets = await this.host.fetchMarkets();
    const resolved = typeof market === "string" ? this.host.resolveMarket(markets, market) : market;
    const positions = await this.positions(options.marginAccountId);
    const position = positions.find((p) => p.market.market_id === resolved.market_id);
    if (!position) {
      throw new O2Error(`No open Turbo position on ${resolved.market_id}`);
    }
    const quantity =
      options.quantity !== undefined
        ? options.quantity
        : position.quantity < 0n
          ? -position.quantity
          : position.quantity;
    const side = position.side === "long" ? "sell" : "buy";
    return this.trade(side, resolved, { quantity }, { ...options, reducing: true });
  }

  /**
   * Hand drawn quote back to the pool.
   *
   * Two routes, and the difference matters. `ReturnQuote` pays the draw
   * back with cash the account HOLDS; `RepayFromCollateral` nets it against
   * the account's own posted collateral and moves no coins at all. The
   * second is the only exit for a trader whose position moved against them
   * — they cannot return quote they no longer have, and a clean close
   * demands `drawn_quote == 0`.
   */
  async repayDrawn(
    amount?: bigint | string,
    options: { fromCollateral?: boolean; marginAccountId?: Hex } = {},
  ): Promise<SessionActionsResponse | null> {
    const id = options.marginAccountId ?? (await this.marginAccountId());
    const wire = await this.state(id);
    const session = marginSession(wire);
    const drawn = session ? big(session.drawn_quote) : 0n;
    if (drawn <= 0n) return null;

    if (options.fromCollateral) {
      // BOUNDED BY THE COLLATERAL ACTUALLY POSTED, not just by the draw.
      //
      // The netting drops `collateral` and `drawn_quote` together, so the
      // pool requires enough of the former to absorb it and reverts
      // (FAILED_REQUIRE) otherwise — after the batch is signed. Fees have
      // already been taken out of the posted collateral by this point, so
      // "repay everything drawn" is routinely more than the account can
      // net.
      const posted = big(session?.collateral) - big(session?.fees_accrued);
      const ceiling = min(drawn, posted > 0n ? posted : 0n);
      const target = amount === undefined ? ceiling : min(BigInt(amount), ceiling);
      if (target <= 0n) return null;
      return this.submitAsChild([repayFromCollateralAction(target)], id);
    }

    const limits = await this.limits(id);
    const payable = limits ? limits.returnableQuote : 0n;
    const target = amount === undefined ? min(drawn, payable) : min(BigInt(amount), payable);
    if (target <= 0n) return null;
    return this.submitAsChild([returnQuoteAction(target)], id);
  }

  /** The most of one asset this account may sell — held plus borrowable. */
  async maxSell(assetId: Hex, marginAccountId?: Hex): Promise<bigint> {
    const wiring = await this.wiring();
    const id = marginAccountId ?? (await this.marginAccountId());
    const [wire, pool] = await Promise.all([this.state(id), this.poolInventory()]);
    const limits = marginLimits(
      wire,
      pool.float,
      wiring.stressBandBps ?? undefined,
      wiring.collateralAssetId,
    );
    return marginShortableBase(wire, limits, assetId, pool.inventory);
  }

  // ── Referral ────────────────────────────────────────────────────

  /**
   * The Turbo referral programme.
   *
   * Signed with the SESSION key: minting a code on someone else's address
   * is the first half of an attribution takeover, and activation is
   * permanent.
   */
  get referral() {
    const host = this.host;
    return {
      /** Whether this wallet was referred, and whether its discount is live. */
      status: async (refereeAddress?: string): Promise<TurboReferralStatus> => {
        const session = host.ensureSession();
        return host.api.getTurboReferralStatus(refereeAddress ?? session.ownerAddress);
      },

      /**
       * Mint (or re-read) this owner's referral code. Idempotent — an
       * existing code comes back with `created: false`.
       *
       * @param code - A vanity code to attempt. It gets exactly ONE try,
       *   because only the caller can decide what to attempt instead.
       */
      mintCode: async (code?: string): Promise<TurboReferralCode> => {
        const session = host.ensureSession();
        const envelope = buildSignedReferralEnvelope(session.sessionPrivateKey, {
          action: "turbo_referral_code",
          traderId: session.ownerAddress,
          code,
        });
        return host.api.createTurboReferralCode(envelope);
      },

      /**
       * Bind this wallet to a referrer's code.
       *
       * PERMANENT and first-code-wins. Gate any discounted purchase on the
       * returned `discount_active`, never on the call merely succeeding.
       */
      activate: async (code: string): Promise<TurboReferralActivation> => {
        const session = host.ensureSession();
        const envelope = buildSignedReferralEnvelope(session.sessionPrivateKey, {
          action: "turbo_referral_activate",
          traderId: session.ownerAddress,
          code,
        });
        return host.api.activateTurboReferral(envelope);
      },
    };
  }

  // ── Internals ───────────────────────────────────────────────────

  /**
   * Mint the next parallel nonce for a margin child.
   *
   * The window is 8 words of 128 bits, so the cursor rolls the bit first
   * and carries into the word. The expiry is what the backend range-checks;
   * it is not the account's own deadline.
   */
  /**
   * Seed this child's cursor from the chain's OWN window.
   *
   * Guessing does not work, and it fails two different ways: a spent
   * position is refused as "already used", and a word the window has slid
   * past is refused as "out of sliding window". Walking blindly from word
   * 0 only finds a window that has slid a handful of words, and never
   * recovers from an overshoot. `/v1/accounts/window` answers both
   * questions outright, which is what the Python SDK has always done.
   *
   * Read once per child and then tracked locally; re-read whenever the
   * chain says the cursor is out of the window.
   */
  private async seedNonceCursor(marginAccountId: Hex): Promise<void> {
    // Guarded rather than just `.catch`: a host built against an older api
    // surface has no such method, and calling it would throw synchronously,
    // past any promise handler.
    const window = await Promise.resolve()
      .then(() => this.host.api.getAccountWindow?.(marginAccountId, 0) ?? null)
      .catch(() => null);
    if (!window) {
      // No window to read: fall back to the start, which is right for a
      // fresh account and self-corrects through the retry otherwise.
      this.nonceCursors.set(marginAccountId, { word: 0n, bit: 0 });
      return;
    }
    this.nonceCursors.set(marginAccountId, firstFreePosition(window));
  }

  /** Mint the next parallel nonce, seeding from the window on first use. */
  private async mintParallelNonce(marginAccountId: Hex): Promise<string> {
    if (!this.nonceCursors.has(marginAccountId)) {
      await this.seedNonceCursor(marginAccountId);
    }
    const cursor = this.nonceCursors.get(marginAccountId) ?? { word: 0n, bit: 0 };
    const nonce = encodeParallelNonce({
      nonceSessionId: 0,
      timestamp: Math.floor(Date.now() / 1000) + OWNER_NONCE_TTL_SECONDS,
      wordPosition: cursor.word,
      bitmapPosition: cursor.bit,
    });
    const nextBit = cursor.bit + 1;
    this.nonceCursors.set(
      marginAccountId,
      nextBit >= NONCE_BITMAP_SIZE
        ? { word: cursor.word + 1n, bit: 0 }
        : { word: cursor.word, bit: nextBit },
    );
    return nonce;
  }

  /**
   * Make sure this child validates against the key we are about to sign
   * with, re-arming it if not.
   *
   * PROACTIVE, not reactive. A child pointed at a rotated-away key does
   * not fail in one recognisable way: `set_session` mismatches surface as
   * `InvalidUserSig`, but a `settle_balance` on the same stale session
   * comes back as a bare `Revert(FAILED_REQUIRE)` with nothing to match
   * on. Reading the armed key costs one request per child per client and
   * removes the guesswork entirely.
   */
  private async ensureArmed(marginAccountId: Hex): Promise<void> {
    const session = this.host.ensureSession();
    if (this.armedKeys.get(marginAccountId) === session.sessionAddress) return;

    const info = await this.host.api
      .getAccount({ tradeAccountId: marginAccountId as unknown as TradeAccountId })
      .catch(() => null);
    const armed = (info?.session?.session_id as { Address?: string } | undefined)?.Address;
    if (!armed || !sameHex(armed, session.sessionAddress)) {
      await this.rearm(marginAccountId);
    }
    this.armedKeys.set(marginAccountId, session.sessionAddress);
  }

  /**
   * Re-point a margin child at the session key that is live NOW.
   *
   * A child holds whatever key was armed when it was last told — by
   * `open()`, or by a previous re-arm. Rotating the PARENT's session
   * (any `createSession` call) does not touch it, so the child keeps
   * validating against a key nobody signs with any more and every batch
   * comes back `InvalidUserSig`. The account is not broken; it is pointed
   * at yesterday's key.
   *
   * Session-signed, so it costs no wallet prompt. Runs as the PARENT,
   * which is the only identity the child's `only_parent()` guard accepts.
   */
  async rearm(marginAccountId?: Hex): Promise<SessionActionsResponse> {
    const session = this.host.ensureSession();
    const wiring = await this.wiring();
    const id = marginAccountId ?? (await this.marginAccountId());
    return this.submitAsParent(
      [
        setMarginAccountSessionAction({
          marginAccountId: id,
          marginNonce: newMarginAccountNonce(),
          sessionId: { Address: session.sessionAddress },
          expiry: MARGIN_SESSION_EXPIRY,
        }),
      ],
      wiring,
      session,
    );
  }

  /**
   * Submit a child batch, walking past nonce positions already burned.
   *
   * The window cannot be read back, so a collision is discovered only by
   * being told — and being told costs one round trip, not a failed trade.
   * Only a nonce complaint is retried; anything else is a real answer.
   */
  private async submitWithNonceRetry(
    marginAccountId: Hex,
    send: (parallelNonce: string) => Promise<SessionActionsResponse>,
    attempts = 8,
  ): Promise<SessionActionsResponse> {
    let last: unknown;
    let rearmed = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await send(await this.mintParallelNonce(marginAccountId));
      } catch (error) {
        const message = String((error as Error)?.message ?? error);

        // THE CHILD IS POINTED AT AN OLD KEY. Rotating the parent's
        // session leaves the child validating against whatever was armed
        // when it was opened, so a perfectly good batch is unsignable no
        // matter how it is rebuilt. Re-arming is itself session-signed —
        // no wallet prompt — so the retry costs a round trip rather than
        // an interaction. Once only: a second failure is a real answer.
        if (/InvalidUserSig/i.test(message) && !rearmed) {
          rearmed = true;
          await this.rearm(marginAccountId).catch(() => null);
          last = error;
          continue;
        }
        // A SPENT POSITION AND A STALE WORD NEED DIFFERENT ANSWERS.
        // "nonce already used" means this position is gone — take the
        // next bit. "word position out of sliding window" means the
        // window has slid past this word entirely, and no bit inside it
        // will do; move to the next word.
        // RE-READ, don't step. The window may have slid by any amount,
        // and stepping one word at a time both caps out and cannot
        // recover from an overshoot — the cursor only moves forward.
        if (/sliding window/i.test(message)) {
          this.nonceCursors.delete(marginAccountId);
          await this.seedNonceCursor(marginAccountId).catch(() => null);
          last = error;
          continue;
        }
        if (!/nonce/i.test(message)) throw error;
        last = error;
      }
    }
    throw last;
  }

  /**
   * Build and submit one trade batch.
   *
   * Both halves of every leg are built together — the typed action and the
   * call it must be matched by — because the backend re-derives the call
   * and verifies the signature against ITS derivation. Emit one without the
   * other and the batch is rejected.
   */
  private async trade(
    side: "buy" | "sell",
    market: string | Market,
    size: TurboSize,
    options: TurboOrderOptions & { reducing?: boolean; marginAccountId?: Hex } = {},
  ): Promise<SessionActionsResponse> {
    const wiring = await this.wiring();
    // NAMED ACCOUNT WINS. `closeAccount` may be tearing down an account
    // that is not this client's default, and trading the default one
    // instead would close a position the caller never asked about.
    const marginAccountId = options.marginAccountId ?? (await this.marginAccountId());
    const markets = await this.host.fetchMarkets();
    const resolved = typeof market === "string" ? this.host.resolveMarket(markets, market) : market;

    const [wire, pool] = await Promise.all([this.state(marginAccountId), this.poolInventory()]);
    const limits = marginLimits(
      wire,
      pool.float,
      wiring.stressBandBps ?? undefined,
      wiring.collateralAssetId,
    );
    if (!limits) {
      throw new O2Error(
        "This Turbo account has no live session — open one with turbo.open() first.",
      );
    }

    const price = options.price ?? (await this.bookTop(resolved, side));
    const { scaledPrice, scaledQuantity } = this.resolveSize(resolved, price, size);
    if (scaledQuantity <= 0n) throw new O2Error("Turbo order quantity must be positive");

    // The ESCROW — the asset and amount `create_order` will actually
    // forward — is what decides the funding leg. Forwarding COLLATERAL (a
    // buy) needs a Draw; forwarding BASE (a sell) needs a Borrow, because
    // on a credit line you do not own the asset you are selling.
    const escrowIsQuote = side === "buy";
    const quoteCostOf = (quantity: bigint): bigint =>
      (scaledPrice * quantity) / 10n ** BigInt(resolved.base.decimals);

    // ADDING exposure must be fully funded; a REDUCING trade may clamp.
    // A clamped leg behind a full-size opening order is a custody revert
    // with extra steps — there is no second round to make up a shortfall.
    const requireFull = options.reducing !== true;

    const actions: MarginAction[] = [];
    const settleTo: Identity = { ContractId: marginAccountId };

    // SWEEP FIRST — see `long`.
    const spotActions: Record<string, unknown>[] = [{ SettleBalance: { to: settleTo } }];

    // FRACTIONAL PRICE FIRST, so the funding is sized on the quantity the
    // order will actually carry.
    //
    // `create_order` requires `price * quantity` to divide by
    // `10^base_decimals` and reverts `OrderCreationError::FractionalPrice`
    // otherwise. `normalizeCreateOrderValues` applies this for a quantity
    // the caller stated, but a notional-sized or clamp-reduced quantity is
    // computed here and would bypass it. The adjustment only ever rounds
    // DOWN, so re-applying it after a clamp can never outrun the funding.
    // PROTECTION IS RESOLVED BEFORE THE FUNDING IS SIZED.
    //
    // An inherited trigger leg carries the parent's quantity but is judged
    // at its OWN price, so attaching one can shrink the order — and the
    // funding legs are sized from that quantity. Resolving the legs first
    // means the Draw or Borrow is sized against the number the order will
    // actually carry. Sizing them first and shrinking afterwards left a
    // protected short holding in-kind debt it never sold, and a protected
    // long holding extra drawn quote; both block a clean `closeAccount`.
    const protection = [options.takeProfit, options.stopLoss].filter(
      (spec): spec is ProtectionSpec => spec !== undefined,
    );
    for (const spec of protection) {
      if (spec.limitPrice === undefined && spec.slippageBps === undefined) {
        throw new O2Error(
          "A Turbo trigger must be priced — pass limitPrice or slippageBps. " +
            "The pool refuses an unbounded market trigger because it cannot walk an unpriced order for risk.",
        );
      }
    }

    const scaleSpec = (spec: ProtectionSpec): ProtectionSpec => ({
      ...spec,
      triggerPrice: this.host.normalizeCreateOrderValues(
        resolved,
        spec.triggerPrice,
        "1",
        "triggerPrice",
        "quantity",
      ).scaledPrice,
      ...(spec.limitPrice !== undefined
        ? {
            limitPrice: this.host.normalizeCreateOrderValues(
              resolved,
              spec.limitPrice,
              "1",
              "limitPrice",
              "quantity",
            ).scaledPrice,
          }
        : {}),
      // SCALED LIKE EVERY OTHER QUANTITY. A caller passing "0.5" meant
      // half a unit, not half a base unit; sending the raw string is
      // either rejected outright or sized a billion times wrong.
      ...(spec.quantity !== undefined
        ? {
            quantity: this.host.normalizeCreateOrderValues(
              resolved,
              scaledPrice,
              spec.quantity,
              "price",
              "quantity",
            ).scaledQuantity,
          }
        : {}),
    });

    const legs = protection.map((spec) =>
      protectionLeg(
        scaleSpec(spec),
        side,
        PARENT_ORDER_PLACEHOLDER,
        priceTick(resolved.quote.decimals, resolved.quote.max_precision),
      ),
    );

    // EVERY price this batch is judged at binds the quantity, so the fit
    // covers the spot price and each trigger's own.
    const judgedPrices = [scaledPrice, ...legs.map((leg) => triggerLockPrice(leg))];
    const fitPrice = (quantity: bigint): bigint => {
      if (
        legs.length === 0 &&
        validateFractionalPrice(scaledPrice, quantity, resolved.base.decimals)
      ) {
        return quantity;
      }
      return adjustQuantityForPrices(judgedPrices, quantity, resolved.base.decimals);
    };

    // The order quantity is not fixed until the funding is: a clamped
    // funding leg behind a full-size order is the very custody revert the
    // open/close split exists to avoid, and a close that clamps must
    // therefore SHRINK THE ORDER to what it can actually fund. It loops,
    // so the remainder is the next round's problem, not a reverted batch.
    let orderQuantity = fitPrice(scaledQuantity);
    if (orderQuantity <= 0n) {
      throw new O2Error(
        `A quantity of ${scaledQuantity} cannot satisfy this market's fractional-price rule at price ${scaledPrice}; try a larger size.`,
      );
    }

    if (escrowIsQuote) {
      const escrowAmount = quoteCostOf(orderQuantity);
      const needed = marginDrawAmount(limits, escrowAmount);
      if (needed > 0n) {
        const amount = min(needed, limits.drawable);
        if (amount < needed) {
          if (requireFull) {
            throw new O2Error(
              `Not enough available credit: this order escrows ${escrowAmount} but the line can only draw ${limits.drawable}.`,
            );
          }
          // Fund what we can, then buy only what that funds. `own` is the
          // cash the draw was sized on top of, so the affordable escrow is
          // the two together.
          const own = escrowAmount - needed;
          const affordable = own + amount;
          orderQuantity = fitPrice(
            (affordable * 10n ** BigInt(resolved.base.decimals)) / scaledPrice,
          );
          if (orderQuantity <= 0n) {
            throw new O2Error(
              "Nothing of this position can be closed right now: the line has no room to draw and the account holds no spendable cash.",
            );
          }
        }
        if (amount > 0n) actions.push(drawAction(amount));
      }
    } else {
      const assetId = normaliseHex(resolved.base.asset);
      if (sameHex(assetId, wiring.collateralAssetId)) {
        throw new O2Error("The collateral asset is drawn, never borrowed — it cannot be shorted.");
      }
      const row = wire.balances.find((b) => sameHex(b.asset_id, assetId));
      // COUNT SETTLED, because this batch sweeps before it sells.
      //
      // The `SettleBalance` above brings settled base home BEFORE the order
      // runs, so those coins are on the account by the time custody is
      // checked. Sizing against `on_account` alone therefore borrows over
      // the top of base the account already owns — harmless on the net
      // position (it holds and owes the same excess) but it leaves an
      // in-kind debt that eats the loan cap and blocks a clean
      // `closeAccount`, which is exactly what closing a filled long would
      // have done every time.
      //
      // The caveat is that `settled` is per ASSET while a batch sweeps one
      // BOOK, so base settled on a DIFFERENT market quoting the same asset
      // is counted here but not swept. That is rare, loud when it happens
      // (a custody revert the caller can retry after settling), and the
      // safer trade against a silent debt on every close.
      const onHand = row ? big(row.on_account) + big(row.settled) : 0n;
      const needed = max(0n, orderQuantity - onHand);
      if (needed > 0n) {
        const borrowable = marginBorrowableBase(wire, limits, assetId, pool.inventory);
        const amount = min(needed, borrowable);
        if (amount < needed) {
          if (requireFull) {
            throw new O2Error(
              `Size unavailable to short: ${needed} needed, ${borrowable} borrowable (tier asset list, pool inventory and loan cap all bind).`,
            );
          }
          // Sell only what the account will actually hold.
          orderQuantity = fitPrice(onHand + amount);
          if (orderQuantity <= 0n) {
            throw new O2Error(
              "Nothing of this position can be closed right now: the account holds none of the asset and the pool will lend none.",
            );
          }
        }
        if (amount > 0n) {
          // FREE THE LINE FIRST, sized to the shortfall only. Handing back
          // more is harmless bookkeeping but shrinks the cash a later buy
          // spends without a fresh draw.
          const price = wire.prices.find((p) => sameHex(p.asset_id, assetId));
          if (price && limits.returnableQuote > 0n && limits.loanHeadroom === 0n) {
            const scale = 10n ** BigInt(18 + price.asset_decimals - wire.collateral_decimals);
            const cost = (amount * big(price.ask) + scale - 1n) / scale;
            const give = min(cost, limits.returnableQuote);
            if (give > 0n) actions.push(returnQuoteAction(give));
          }
          actions.push(borrowAction(assetId, amount));
        }
      }
    }

    // The legs were resolved before the funding was sized — see above —
    // so the order simply carries them.
    if (legs.length > 0) {
      spotActions.push({
        CreateOrderWithTriggers: {
          side: capitalizeSide(side),
          price: scaledPrice.toString(),
          quantity: orderQuantity.toString(),
          order_type: scaleOrderType(options.orderType ?? "Spot", resolved),
          trigger_1: legs[0],
          ...(legs[1] ? { trigger_2: legs[1] } : {}),
        },
      });
    } else {
      spotActions.push({
        CreateOrder: {
          side: capitalizeSide(side),
          price: scaledPrice.toString(),
          quantity: orderQuantity.toString(),
          order_type: scaleOrderType(options.orderType ?? "Spot", resolved),
        },
      });
    }

    // The batch runs IN ORDER: sweep, fund, order. The funding legs must
    // sit between the sweep and the order, so the order finds the coins.
    const ordered = [spotActions[0], ...actions, spotActions[1]] as Record<string, unknown>[];

    return this.submitMixed(ordered, resolved, marginAccountId, wiring, {
      collectOrders: options.collectOrders ?? true,
    });
  }

  /** Scale a size expressed either as base quantity or collateral notional. */
  private resolveSize(
    market: Market,
    price: Numeric,
    size: TurboSize,
  ): { scaledPrice: bigint; scaledQuantity: bigint } {
    if (size.quantity !== undefined) {
      return this.host.normalizeCreateOrderValues(
        market,
        price,
        size.quantity,
        "price",
        "quantity",
      );
    }

    // A NOTIONAL IS A QUOTE AMOUNT, so it scales by the QUOTE's decimals —
    // not the base's, which is what `normalizeCreateOrderValues` would do
    // to anything passed in its quantity slot. On a 9-decimal base against
    // 6-decimal collateral that is a 1,000x error, and it sizes an order
    // the line cannot possibly fund.
    const { scaledPrice } = this.host.normalizeCreateOrderValues(
      market,
      price,
      "1",
      "price",
      "quantity",
    );
    if (scaledPrice <= 0n) throw new O2Error("Cannot size by notional at a zero price");

    const notionalRaw =
      typeof size.notional === "bigint"
        ? size.notional
        : scaleDecimalString(String(size.notional), market.quote.decimals);
    if (notionalRaw <= 0n) throw new O2Error("Turbo notional must be positive");

    // quantity = notional / price, in base units.
    const scaledQuantity = (notionalRaw * 10n ** BigInt(market.base.decimals)) / scaledPrice;
    return { scaledPrice, scaledQuantity };
  }

  /** The book's own top on the side this order will take. */
  private async bookTop(market: Market, side: "buy" | "sell"): Promise<bigint> {
    const depth = await this.host.api.getDepth(market.market_id, 10, 1);
    const level = side === "buy" ? depth.asks?.[0] : depth.bids?.[0];
    if (!level) {
      throw new O2Error(
        `No ${side === "buy" ? "ask" : "bid"} on ${market.market_id} to price this order — pass an explicit price.`,
      );
    }
    return typeof level.price === "bigint" ? level.price : BigInt(level.price);
  }

  /** Submit a batch of pure margin actions AS the margin child. */
  private async submitAsChild(
    actions: MarginAction[],
    marginAccountId: Hex,
  ): Promise<SessionActionsResponse> {
    const wiring = await this.wiring();
    const markets = await this.host.fetchMarkets();
    const carrier = markets.markets[0];
    if (!carrier) throw new O2Error("No markets available to carry the batch");

    await this.ensureArmed(marginAccountId);
    const scoped: MarginWiring = { ...wiring, marginAccountId };
    const calls = actions.map((a) => marginActionToCall(a, scoped));
    return this.submitWithNonceRetry(marginAccountId, (parallelNonce) =>
      this.host.submitPrepared({
        marketActions: [
          {
            market_id: carrier.market_id,
            actions: actions as unknown as Record<string, unknown>[],
          },
        ],
        calls,
        tradeAccountId: marginAccountId,
        // The child's owner is the PARENT contract, not the wallet.
        ownerId: wiring.parentAccountId,
        // Margin batches are accepted under a parallel nonce only.
        parallelNonce,
      }),
    );
  }

  /**
   * Submit parent-driven margin actions AS the parent trade account.
   *
   * A session batch is keyed by market while these target the child, the
   * pool or the registry — so any listed market carries them.
   */
  private async submitAsParent(
    actions: MarginAction[],
    wiring: TurboWiring,
    session: SessionState,
    options: { endpoint?: "session" | "marginAccounts" } = {},
  ): Promise<SessionActionsResponse> {
    const markets = await this.host.fetchMarkets();
    const carrier = markets.markets[0];
    if (!carrier) throw new O2Error("No markets available to carry the batch");

    const scoped: MarginWiring = { ...wiring, parentAccountId: session.tradeAccountId as Hex };
    const calls = actions.map((a) => marginActionToCall(a, scoped));
    return this.host.submitPrepared({
      marketActions: [
        { market_id: carrier.market_id, actions: actions as unknown as Record<string, unknown>[] },
      ],
      calls,
      tradeAccountId: session.tradeAccountId,
      endpoint: options.endpoint,
    });
  }

  /** Submit a batch mixing spot order actions with margin funding legs. */
  private async submitMixed(
    actions: Record<string, unknown>[],
    market: Market,
    marginAccountId: Hex,
    wiring: TurboWiring,
    options: { collectOrders?: boolean },
  ): Promise<SessionActionsResponse> {
    await this.ensureArmed(marginAccountId);
    const scoped: MarginWiring = { ...wiring, marginAccountId };
    const calls: ContractCall[] = actions.map((action) => {
      const key = Object.keys(action)[0] as string;
      if (
        key === "SettleBalance" ||
        key === "CreateOrder" ||
        key === "CancelOrder" ||
        key === "CreateOrderWithTriggers" ||
        key === "CreateTriggerOrder" ||
        key === "CreateTriggerOrders" ||
        key === "CancelTriggerOrder"
      ) {
        return this.host.spotActionToCall(action, market);
      }
      return marginActionToCall(action as unknown as MarginAction, scoped);
    });

    return this.submitWithNonceRetry(marginAccountId, (parallelNonce) =>
      this.host.submitPrepared({
        marketActions: [{ market_id: market.market_id, actions }],
        calls,
        // Trading runs AS the margin child: balances live there, so a
        // settle to the parent would move the session's money out of the
        // session.
        tradeAccountId: marginAccountId,
        // And the child is owned by the PARENT contract, so that is the
        // owner id the batch is authorised under.
        ownerId: wiring.parentAccountId,
        parallelNonce,
        collectOrders: options.collectOrders,
      }),
    );
  }

  /**
   * A registered-but-unstarted account to adopt, if there is one.
   *
   * Such an account is invisible to every Turbo surface (they key off a
   * live SESSION), so registering again would strand it forever.
   */
  private async findResumable(accounts: NextMarginAccount[]): Promise<NextMarginAccount | null> {
    for (const account of accounts) {
      try {
        const wire = await this.host.api.getMarginState(normaliseHex(account.contract_id));
        if (!marginSession(wire)) return account;
      } catch {
        // Unreadable state is not evidence of anything; skip it.
      }
    }
    return null;
  }

  /**
   * Poll until the registration has been indexed.
   *
   * Asks `/v1/margin/state` rather than re-listing the owner's accounts:
   * the listing is derived and, on deployments whose `/v1/accounts` carries
   * no margin fields, could never report the new child at all — so a
   * registration that had genuinely landed looked like it never arrived.
   */
  private async waitForRegistration(marginAccountId: Hex): Promise<void> {
    const deadline = Date.now() + REGISTRATION_INDEX_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await isRegisteredAccount(this.host.api, marginAccountId)) return;
      await new Promise((resolve) => setTimeout(resolve, REGISTRATION_POLL_MS));
    }
    throw new O2Error(
      `Timed out waiting for margin account ${marginAccountId} to be indexed. ` +
        "The registration may still land — call turbo.open() again to resume.",
    );
  }
}

/** Re-exported so callers can type a market id without reaching into models. */
export type { MarketId, MarketsResponse };
