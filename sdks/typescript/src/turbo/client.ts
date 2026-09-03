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
import { O2Error } from "../errors.js";
import type {
  Identity,
  Market,
  MarketId,
  MarketsResponse,
  Numeric,
  OrderType,
  SessionActionsResponse,
} from "../models.js";
import { capitalizeSide, scaleOrderType } from "../utils.js";
import type { MarginAction } from "./actions.js";
import {
  addMarginCollateralAction,
  borrowAction,
  closeMarginSessionAction,
  drawAction,
  prolongSessionAction,
  registerMarginAccountAction,
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
import { newMarginAccountNonce } from "./parallelNonce.js";
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
import { marginSession, normaliseHex, sameHex } from "./wire.js";

/**
 * The margin child's session never expires on its own — the contract
 * overwrites both the expiry and the contract scope. A far-future stamp
 * keeps the ABI happy and the intent readable.
 */
export const MARGIN_SESSION_EXPIRY = 4_102_444_800;

/** How long to wait for a registration to be indexed before giving up. */
const REGISTRATION_INDEX_TIMEOUT_MS = 60_000;
const REGISTRATION_POLL_MS = 1_000;

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
  /** Close-only: the pool will admit no new exposure. */
  frozen: boolean;
  /** Keeper-eligible. Still recoverable — this is not a teardown. */
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

/**
 * Trade a Turbo (margin) account.
 *
 * Obtain one from {@link O2Client.turbo} rather than constructing it.
 */
export class TurboClient {
  private readonly host: TurboHost;
  private wiringCache: TurboWiring | null = null;
  private accountId: Hex | null = null;

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
    const raw = (markets as unknown as { margin?: Record<string, string> | null }).margin;
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
    const accounts = info.margin_accounts ?? [];
    // `/v1/accounts` stops predicting once the owner already has an
    // account, even when the next index is perfectly openable — which is
    // exactly the state a trader is in right after closing one. The
    // dedicated route always answers.
    let next = info.next_margin_account ?? null;
    if (!next && info.trade_account_id) {
      next = await this.host.api.getNextMarginAccount(info.trade_account_id as Hex);
    }
    return { accounts, next };
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
      const raw = (markets as unknown as { margin?: { margin_pool_id?: string } | null }).margin;
      if (raw?.margin_pool_id) scope.add(normaliseHex(raw.margin_pool_id));
    } catch {
      return [];
    }

    let parent: string | undefined;
    try {
      const info = (await api.getAccount({ owner: ownerAddress })) as unknown as {
        margin_accounts?: NextMarginAccount[];
        next_margin_account?: NextMarginAccount | null;
        trade_account_id?: string;
      };
      parent = info.trade_account_id;
      for (const account of info.margin_accounts ?? []) {
        scope.add(normaliseHex(account.contract_id));
      }
      if (info.next_margin_account) {
        scope.add(normaliseHex(info.next_margin_account.contract_id));
      }
    } catch {
      // Discovery failed; the pool alone is still worth scoping.
    }

    if (parent) {
      // Cover the next few indices too, so one signature carries the
      // trader through opening a second and third account. A deployment
      // that ignores `index` answers with the same id each time and the
      // set simply collapses — the coverage we would have had anyway.
      const predictions = await Promise.all(
        Array.from({ length: depth }, (_, offset) =>
          api.getNextMarginAccount(parent as Hex, offset).catch(() => null),
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

  /** The tiers currently on sale. */
  async tiers(): Promise<MarginTierWire[]> {
    return this.host.api.getMarginTiers();
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

    // `equity = V - k`, so both risk edges are the tier's own fields
    // compared against it — no arithmetic of our own. `frozen` is
    // close-only and `liquidatable` is keeper-eligible; NEITHER means the
    // account is gone. A liquidated session leaves no `session` at all.
    const maintenance = wire.tier ? big(wire.tier.maintenance) : 0n;
    const openBuffer = wire.tier ? big(wire.tier.open_buffer) : 0n;

    return {
      marginAccountId: id,
      tier: wire.tier ?? null,
      creditLine: session ? big(session.credit_line) : 0n,
      equity: limits?.equity ?? 0n,
      availableToTrade: limits?.spendable ?? 0n,
      secondsRemaining: expiresAt === null ? null : Math.max(0, expiresAt - wire.now),
      frozen: limits ? limits.equity < openBuffer : false,
      liquidatable: limits ? limits.equity <= maintenance : false,
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
    /** The first term the entry buys. */
    period: ProlongPeriod;
    /** Called as each stage begins — opening is not instantaneous. */
    onProgress?: (stage: "registering" | "waiting_for_registration" | "starting") => void;
  }): Promise<TurboOpenResult> {
    const session = this.host.ensureSession();
    const wiring = await this.wiring();

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
      startMarginSessionAction(marginAccountId, params.tierId, collateral, params.period),
      setMarginAccountSessionAction({
        marginAccountId,
        marginNonce: newMarginAccountNonce(),
        sessionId,
        expiry: MARGIN_SESSION_EXPIRY,
      }),
    ];
    const start = await this.submitAsParent(actions, wiring, session);

    this.accountId = marginAccountId;
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

  /** Buy more session life. */
  async extend(
    period: ProlongPeriod,
    times: number = 1,
    marginAccountId?: Hex,
  ): Promise<SessionActionsResponse> {
    return this.submitAsChild(
      [prolongSessionAction(period, times)],
      marginAccountId ?? (await this.marginAccountId()),
    );
  }

  /** Arm or disarm auto-extension. */
  async setAutoExtend(
    period: ProlongPeriod | null,
    marginAccountId?: Hex,
  ): Promise<SessionActionsResponse> {
    return this.submitAsChild(
      [setAutoProlongAction(period)],
      marginAccountId ?? (await this.marginAccountId()),
    );
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
  async closeAccount(marginAccountId?: Hex): Promise<SessionActionsResponse> {
    const session = this.host.ensureSession();
    const wiring = await this.wiring();
    const id = marginAccountId ?? (await this.marginAccountId());
    const cleanups: OrderBookCleanup[] = await this.host.api.getMarginCloseCleanups(id);
    return this.submitAsParent([closeMarginSessionAction(id, cleanups)], wiring, session);
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
    options: TurboOrderOptions = {},
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
    options: TurboOrderOptions = {},
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
   * This submits the closing order. Retiring the debt the position leaves
   * behind — `repayDrawn` for a long, buying back for a short — is a
   * separate step, because the fill is not known at signing time.
   */
  async closePosition(
    market: string | Market,
    options: TurboOrderOptions & { quantity?: Numeric } = {},
  ): Promise<SessionActionsResponse> {
    const markets = await this.host.fetchMarkets();
    const resolved = typeof market === "string" ? this.host.resolveMarket(markets, market) : market;
    const positions = await this.positions();
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
      const target = amount === undefined ? drawn : min(BigInt(amount), drawn);
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
    options: TurboOrderOptions & { reducing?: boolean } = {},
  ): Promise<SessionActionsResponse> {
    const wiring = await this.wiring();
    const marginAccountId = await this.marginAccountId();
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
    const escrowAmount = escrowIsQuote
      ? (scaledPrice * scaledQuantity) / 10n ** BigInt(resolved.base.decimals)
      : scaledQuantity;

    // ADDING exposure must be fully funded; a REDUCING trade may clamp.
    // A clamped leg behind a full-size opening order is a custody revert
    // with extra steps — there is no second round to make up a shortfall.
    const requireFull = options.reducing !== true;

    const actions: MarginAction[] = [];
    const settleTo: Identity = { ContractId: marginAccountId };

    // SWEEP FIRST — see `long`.
    const spotActions: Record<string, unknown>[] = [{ SettleBalance: { to: settleTo } }];

    if (escrowIsQuote) {
      const needed = marginDrawAmount(limits, escrowAmount);
      if (needed > 0n) {
        const amount = min(needed, limits.drawable);
        if (requireFull && amount < needed) {
          throw new O2Error(
            `Not enough available credit: this order escrows ${escrowAmount} but the line can only draw ${limits.drawable}.`,
          );
        }
        if (amount > 0n) actions.push(drawAction(amount));
      }
    } else {
      const assetId = normaliseHex(resolved.base.asset);
      if (sameHex(assetId, wiring.collateralAssetId)) {
        throw new O2Error("The collateral asset is drawn, never borrowed — it cannot be shorted.");
      }
      const row = wire.balances.find((b) => sameHex(b.asset_id, assetId));
      const onHand = row ? big(row.on_account) : 0n;
      const needed = max(0n, escrowAmount - onHand);
      if (needed > 0n) {
        const borrowable = marginBorrowableBase(wire, limits, assetId, pool.inventory);
        const amount = min(needed, borrowable);
        if (requireFull && amount < needed) {
          throw new O2Error(
            `Size unavailable to short: ${needed} needed, ${borrowable} borrowable (tier asset list, pool inventory and loan cap all bind).`,
          );
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

    spotActions.push({
      CreateOrder: {
        side: capitalizeSide(side),
        price: scaledPrice.toString(),
        quantity: scaledQuantity.toString(),
        order_type: scaleOrderType(options.orderType ?? "Spot", resolved),
      },
    });

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

    const scoped: MarginWiring = { ...wiring, marginAccountId };
    const calls = actions.map((a) => marginActionToCall(a, scoped));
    return this.host.submitPrepared({
      marketActions: [
        { market_id: carrier.market_id, actions: actions as unknown as Record<string, unknown>[] },
      ],
      calls,
      tradeAccountId: marginAccountId,
    });
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
    const scoped: MarginWiring = { ...wiring, marginAccountId };
    const calls: ContractCall[] = actions.map((action) => {
      const key = Object.keys(action)[0] as string;
      if (key === "SettleBalance" || key === "CreateOrder" || key === "CancelOrder") {
        return this.host.spotActionToCall(action, market);
      }
      return marginActionToCall(action as unknown as MarginAction, scoped);
    });

    return this.host.submitPrepared({
      marketActions: [{ market_id: market.market_id, actions }],
      calls,
      // Trading runs AS the margin child: balances live there, so a settle
      // to the parent would move the session's money out of the session.
      tradeAccountId: marginAccountId,
      collectOrders: options.collectOrders,
    });
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

  /** Poll until the registration has been indexed. */
  private async waitForRegistration(marginAccountId: Hex): Promise<void> {
    const deadline = Date.now() + REGISTRATION_INDEX_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { accounts } = await this.accounts();
      if (accounts.some((a) => sameHex(a.contract_id, marginAccountId))) return;
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
