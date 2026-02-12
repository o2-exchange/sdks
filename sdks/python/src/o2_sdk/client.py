"""High-level O2 Exchange client.

Orchestrates wallet management, account lifecycle, session management,
trading, market data, and WebSocket streaming.
"""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator

from .api import O2Api
from .config import Network, NetworkConfig, get_config
from .crypto import (
    EvmWallet,
    Signer,
    Wallet,
    generate_evm_wallet,
    generate_wallet,
    load_evm_wallet,
    load_wallet,
    raw_sign,
)
from .encoding import (
    action_to_call,
    build_actions_signing_bytes,
    build_session_signing_bytes,
    build_withdraw_signing_bytes,
)
from .errors import O2Error, SessionExpired
from .models import (
    AccountInfo,
    Action,
    ActionsResponse,
    Balance,
    BalanceUpdate,
    Bar,
    BoundedMarketOrder,
    CancelOrderAction,
    CreateOrderAction,
    DepthSnapshot,
    DepthUpdate,
    Id,
    LimitOrder,
    Market,
    MarketActions,
    MarketsResponse,
    NonceUpdate,
    Order,
    OrderSide,
    OrderType,
    OrderUpdate,
    SessionInfo,
    SettleBalanceAction,
    Trade,
    TradeUpdate,
    WithdrawResponse,
)
from .websocket import O2WebSocket

logger = logging.getLogger("o2_sdk.client")


class O2Client:
    """High-level client for the O2 Exchange.

    Orchestrates wallet management, account lifecycle, session management,
    trading operations, market data retrieval, and WebSocket streaming.
    """

    def __init__(
        self,
        network: Network = Network.TESTNET,
        custom_config: NetworkConfig | None = None,
    ):
        self._config = custom_config or get_config(network)
        self._network = network
        self.api = O2Api(self._config)
        self._ws: O2WebSocket | None = None
        self._markets_cache: MarketsResponse | None = None
        self._nonce_cache: dict[str, int] = {}

    async def close(self) -> None:
        """Close all connections."""
        await self.api.close()
        if self._ws:
            await self._ws.disconnect()

    async def __aenter__(self) -> O2Client:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    # -----------------------------------------------------------------------
    # Wallet management
    # -----------------------------------------------------------------------

    @staticmethod
    def generate_wallet() -> Wallet:
        """Generate a new Fuel-native wallet."""
        return generate_wallet()

    @staticmethod
    def generate_evm_wallet() -> EvmWallet:
        """Generate a new EVM-compatible wallet."""
        return generate_evm_wallet()

    @staticmethod
    def load_wallet(private_key_hex: str) -> Wallet:
        """Load a Fuel-native wallet from a private key."""
        return load_wallet(private_key_hex)

    @staticmethod
    def load_evm_wallet(private_key_hex: str) -> EvmWallet:
        """Load an EVM-compatible wallet from a private key."""
        return load_evm_wallet(private_key_hex)

    # -----------------------------------------------------------------------
    # Account lifecycle (idempotent)
    # -----------------------------------------------------------------------

    async def setup_account(self, wallet: Signer) -> AccountInfo:
        """Set up a trading account idempotently.

        1. Check if account exists (GET /v1/accounts)
        2. Create if needed (POST /v1/accounts)
        3. Mint via faucet if testnet/devnet (handle cooldown gracefully)
        4. Whitelist account
        5. Return AccountInfo

        Safe to call on every bot startup.
        """
        # Step 1: Check for existing account
        account = await self.api.get_account(owner=wallet.b256_address)

        if not account.exists:
            # Step 2: Create account
            logger.info("Creating trading account for %s", wallet.b256_address)
            result = await self.api.create_account(wallet.b256_address)
            account = await self.api.get_account(trade_account_id=result.trade_account_id)

        trade_account_id = account.trade_account_id

        # Step 3: Faucet (testnet/devnet only, non-fatal)
        if self._config.faucet_url and trade_account_id:
            try:
                resp = await self.api.mint_to_contract(trade_account_id)
                if resp.success:
                    logger.info("Faucet mint successful")
                else:
                    logger.warning("Faucet: %s", resp.error)
            except Exception as e:
                logger.warning("Faucet mint failed (non-fatal): %s", e)

        # Step 4: Whitelist (idempotent)
        if trade_account_id:
            try:
                wl = await self.api.whitelist_account(trade_account_id)
                if wl.already_whitelisted:
                    logger.info("Account already whitelisted")
                else:
                    logger.info("Account whitelisted successfully")
            except Exception as e:
                logger.warning("Whitelist failed (non-fatal): %s", e)

        return account

    # -----------------------------------------------------------------------
    # Session management
    # -----------------------------------------------------------------------

    async def create_session(
        self,
        owner: Signer,
        markets: list[str],
        expiry_days: int = 30,
    ) -> SessionInfo:
        """Create a trading session.

        Args:
            owner: A signer for the owner account (Wallet, EvmWallet,
                ExternalSigner, ExternalEvmSigner, or any :class:`Signer`)
            markets: List of market pair strings (e.g., ["FUEL/USDC"]) or contract IDs
            expiry_days: Session expiry in days (default 30)

        Returns:
            SessionInfo with session keys and trading state
        """
        logger.info("Creating session for markets=%s, expiry_days=%d", markets, expiry_days)

        # Resolve markets
        markets_resp = await self._get_markets_cached()
        contract_ids: list[str] = []
        for m_name in markets:
            market = self._resolve_market(markets_resp, m_name)
            if market.contract_id not in contract_ids:
                contract_ids.append(market.contract_id)

        chain_id = markets_resp.chain_id_int

        # Get account info and nonce
        account = await self.api.get_account(owner=owner.b256_address)
        if not account.exists:
            raise O2Error(message="Account not found. Call setup_account() first.")
        nonce = account.nonce
        logger.debug("Session nonce=%d, chain_id=%d", nonce, chain_id)

        # Generate session wallet
        session_wallet = generate_wallet()

        # Build signing bytes
        contract_id_bytes = [bytes.fromhex(c[2:]) for c in contract_ids]
        expiry = int(time.time()) + (expiry_days * 24 * 60 * 60)

        signing_bytes = build_session_signing_bytes(
            nonce=nonce,
            chain_id=chain_id,
            session_address=session_wallet.address_bytes,
            contract_ids=contract_id_bytes,
            expiry=expiry,
        )

        # Sign with owner (delegates to Signer.personal_sign which handles
        # Fuel vs EVM message framing internally)
        logger.debug(
            "Signing session with owner.personal_sign, payload=%d bytes", len(signing_bytes)
        )
        signature = owner.personal_sign(signing_bytes)

        # Submit session request
        session_request = {
            "contract_id": account.trade_account_id,
            "session_id": {"Address": session_wallet.b256_address},
            "signature": {"Secp256k1": "0x" + signature.hex()},
            "contract_ids": contract_ids,
            "nonce": str(nonce),
            "expiry": str(expiry),
        }

        resp = await self.api.create_session(owner.b256_address, session_request)

        # Cache the nonce (session creation increments it)
        if account.trade_account_id is None:
            raise O2Error(message="Account must have a trade_account_id")
        self._nonce_cache[account.trade_account_id] = nonce + 1

        logger.info(
            "Session created: session_id=%s, account=%s",
            resp.session_id,
            resp.trade_account_id,
        )

        return SessionInfo(
            session_id=resp.session_id,
            trade_account_id=resp.trade_account_id,
            contract_ids=resp.contract_ids,
            session_expiry=resp.session_expiry,
            session_private_key=session_wallet.private_key,
            owner_address=owner.b256_address,
            nonce=nonce + 1,
        )

    # -----------------------------------------------------------------------
    # Trading
    # -----------------------------------------------------------------------

    async def create_order(
        self,
        session: SessionInfo,
        market: str,
        side: OrderSide,
        price: float,
        quantity: float,
        order_type: OrderType | LimitOrder | BoundedMarketOrder = OrderType.SPOT,
        settle_first: bool = True,
        collect_orders: bool = True,
    ) -> ActionsResponse:
        """Place an order with automatic encoding, signing, and nonce management.

        Args:
            session: Active trading session
            market: Market pair (e.g., "FUEL/USDC") or market_id
            side: OrderSide.BUY or OrderSide.SELL
            price: Human-readable price (auto-scaled)
            quantity: Human-readable quantity (auto-scaled)
            order_type: OrderType.SPOT, OrderType.MARKET, OrderType.FILL_OR_KILL,
                OrderType.POST_ONLY, LimitOrder(...), or BoundedMarketOrder(...)
            settle_first: If True, prepend SettleBalance action
            collect_orders: If True, return created order details

        Returns:
            ActionsResponse with tx_id and optional orders
        """
        if isinstance(order_type, OrderType):
            ot_label = order_type.value
        elif isinstance(order_type, LimitOrder):
            ot_label = "Limit"
        else:
            ot_label = "BoundedMarket"

        logger.info(
            "Creating %s %s order: market=%s price=%s qty=%s",
            side.value,
            ot_label,
            market,
            price,
            quantity,
        )

        markets_resp = await self._get_markets_cached()
        market_obj = self._resolve_market(markets_resp, market)

        # Scale price and quantity
        scaled_price = market_obj.scale_price(price)
        scaled_quantity = market_obj.scale_quantity(quantity)

        # Adjust quantity for FractionalPrice constraint
        scaled_quantity = market_obj.adjust_quantity(scaled_price, scaled_quantity)

        logger.debug(
            "Scaled order: price=%d qty=%d (market_id=%s)",
            scaled_price,
            scaled_quantity,
            market_obj.market_id,
        )

        # Validate
        market_obj.validate_order(scaled_price, scaled_quantity)

        # Build the order type for the action
        action_ot: OrderType | LimitOrder | BoundedMarketOrder
        if isinstance(order_type, LimitOrder):
            action_ot = LimitOrder(
                price=market_obj.scale_price(order_type.price),
                timestamp=order_type.timestamp
                if order_type.timestamp is not None
                else int(time.time()),
            )
        elif isinstance(order_type, BoundedMarketOrder):
            action_ot = BoundedMarketOrder(
                max_price=market_obj.scale_price(order_type.max_price),
                min_price=market_obj.scale_price(order_type.min_price),
            )
        else:
            action_ot = order_type

        # Build actions
        typed_actions: list[Action] = []
        if settle_first:
            typed_actions.append(SettleBalanceAction(to=session.trade_account_id))
        typed_actions.append(
            CreateOrderAction(
                side=side,
                price=str(scaled_price),
                quantity=str(scaled_quantity),
                order_type=action_ot,
            )
        )

        return await self.batch_actions(
            session=session,
            actions=[MarketActions(market_id=market_obj.market_id, actions=typed_actions)],
            collect_orders=collect_orders,
        )

    async def cancel_order(
        self,
        session: SessionInfo,
        order_id: str,
        market: str | None = None,
        market_id: str | None = None,
    ) -> ActionsResponse:
        """Cancel an order."""
        logger.info("Cancelling order %s", order_id)
        if market_id is None:
            if market is None:
                raise ValueError("Either market or market_id must be provided")
            markets_resp = await self._get_markets_cached()
            market_obj = self._resolve_market(markets_resp, market)
            market_id = market_obj.market_id

        actions = [
            MarketActions(
                market_id=market_id,
                actions=[CancelOrderAction(order_id=Id(order_id))],
            )
        ]
        return await self.batch_actions(session=session, actions=actions)

    async def cancel_all_orders(self, session: SessionInfo, market: str) -> list[ActionsResponse]:
        """Cancel all open orders for a market.

        Fetches up to 200 open orders and cancels them in batches of 5.
        Returns a list of ActionsResponse (one per batch).
        """
        logger.info("Cancelling all open orders for market=%s", market)
        markets_resp = await self._get_markets_cached()
        market_obj = self._resolve_market(markets_resp, market)

        orders_resp = await self.api.get_orders(
            market_id=market_obj.market_id,
            contract=session.trade_account_id,
            direction="desc",
            count=200,
            is_open=True,
        )

        if not orders_resp.orders:
            logger.info("No open orders to cancel")
            return []

        results: list[ActionsResponse] = []
        # Cancel in chunks of 5
        for i in range(0, len(orders_resp.orders), 5):
            chunk = orders_resp.orders[i : i + 5]
            cancel_actions: list[Action] = [CancelOrderAction(order_id=o.order_id) for o in chunk]
            actions = [MarketActions(market_id=market_obj.market_id, actions=cancel_actions)]
            resp = await self.batch_actions(session=session, actions=actions)
            results.append(resp)

        return results

    async def settle_balance(self, session: SessionInfo, market: str) -> ActionsResponse:
        """Settle balance for a market."""
        markets_resp = await self._get_markets_cached()
        market_obj = self._resolve_market(markets_resp, market)

        actions = [
            MarketActions(
                market_id=market_obj.market_id,
                actions=[SettleBalanceAction(to=session.trade_account_id)],
            )
        ]
        return await self.batch_actions(session=session, actions=actions)

    async def batch_actions(
        self,
        session: SessionInfo,
        actions: list[MarketActions],
        collect_orders: bool = False,
    ) -> ActionsResponse:
        """Submit a batch of actions with automatic signing and nonce management.

        Args:
            session: Active trading session
            actions: List of MarketActions (market-grouped typed actions)
            collect_orders: If True, return created order details
        """
        # Check session expiry before submitting on-chain
        if session.session_expiry:
            try:
                expiry_ts = int(session.session_expiry)
                if time.time() >= expiry_ts:
                    raise SessionExpired(
                        message="Session has expired. Create a new session before submitting actions."
                    )
            except ValueError:
                pass  # Non-numeric expiry format, skip check

        markets_resp = await self._get_markets_cached()

        # Convert typed actions to dicts once
        actions_dicts = [ma.to_dict() for ma in actions]

        # Get current nonce
        nonce = await self._get_nonce(session.trade_account_id)
        logger.debug("Submitting actions with nonce=%d, actions=%s", nonce, actions_dicts)

        # Convert actions to calls
        calls: list[dict] = []
        for market_group in actions_dicts:
            m_id = market_group["market_id"]
            market_info = self._get_market_info_by_id(markets_resp, m_id)
            for action in market_group["actions"]:
                call = action_to_call(action, market_info)
                calls.append(call)

        # Build signing bytes and sign with session key
        signing_bytes = build_actions_signing_bytes(nonce, calls)
        if session.session_private_key is None:
            raise O2Error(message="Session must have a private key")
        logger.debug(
            "Signing %d actions (%d bytes) with session key", len(calls), len(signing_bytes)
        )
        signature = raw_sign(session.session_private_key, signing_bytes)

        # Submit
        request = {
            "actions": actions_dicts,
            "signature": {"Secp256k1": "0x" + signature.hex()},
            "nonce": str(nonce),
            "trade_account_id": session.trade_account_id,
            "session_id": session.session_id.to_dict(),
            "collect_orders": collect_orders,
        }

        if session.owner_address is None:
            raise O2Error(message="Session must have an owner address")
        try:
            result = await self.api.submit_actions(session.owner_address, request)
            # Increment nonce on success
            self._nonce_cache[session.trade_account_id] = nonce + 1
            session.nonce = nonce + 1
            logger.info("Actions submitted: tx_id=%s, nonce=%d->%d", result.tx_id, nonce, nonce + 1)
            return result
        except O2Error as e:
            logger.warning("Actions failed (nonce=%d): %s", nonce, e)
            # Nonce increments even on revert, so re-fetch
            await self.refresh_nonce(session)
            raise

    # -----------------------------------------------------------------------
    # Market data
    # -----------------------------------------------------------------------

    async def get_markets(self) -> list[Market]:
        """Get all available markets."""
        resp = await self._get_markets_cached()
        return resp.markets

    async def get_market(self, symbol_pair: str) -> Market:
        """Get a specific market by pair symbol (e.g., "FUEL/USDC")."""
        resp = await self._get_markets_cached()
        return self._resolve_market(resp, symbol_pair)

    async def get_depth(self, market: str, precision: int = 10) -> DepthSnapshot:
        """Get order book depth for a market."""
        market_obj = await self._resolve_market_async(market)
        return await self.api.get_depth(market_obj.market_id, precision)

    async def get_trades(self, market: str, count: int = 50) -> list[Trade]:
        """Get recent trades for a market."""
        market_obj = await self._resolve_market_async(market)
        return await self.api.get_trades(market_obj.market_id, count=count)

    async def get_bars(
        self,
        market: str,
        resolution: str,
        from_ts: int,
        to_ts: int,
    ) -> list[Bar]:
        """Get OHLCV bars for a market."""
        market_obj = await self._resolve_market_async(market)
        return await self.api.get_bars(market_obj.market_id, from_ts, to_ts, resolution)

    async def get_ticker(self, market: str) -> dict:
        """Get real-time ticker for a market."""
        market_obj = await self._resolve_market_async(market)
        resp = await self.api.get_market_ticker(market_obj.market_id)
        return resp.data

    # -----------------------------------------------------------------------
    # Account data
    # -----------------------------------------------------------------------

    async def get_balances(self, account: AccountInfo | str) -> dict[str, Balance]:
        """Get balances keyed by asset symbol.

        Args:
            account: AccountInfo or trade_account_id string
        """
        trade_account_id = account if isinstance(account, str) else account.trade_account_id

        markets_resp = await self._get_markets_cached()
        result: dict[str, Balance] = {}

        seen_assets: set[str] = set()
        for m in markets_resp.markets:
            for asset_info in (m.base, m.quote):
                if asset_info.asset in seen_assets:
                    continue
                seen_assets.add(asset_info.asset)
                try:
                    balance = await self.api.get_balance(
                        asset_id=asset_info.asset,
                        contract=trade_account_id,
                    )
                    result[asset_info.symbol] = balance
                except Exception:
                    pass

        return result

    async def get_orders(
        self,
        account: AccountInfo | str,
        market: str,
        is_open: bool | None = None,
        count: int = 20,
    ) -> list[Order]:
        """Get orders for an account on a market."""
        trade_account_id = account if isinstance(account, str) else account.trade_account_id
        market_obj = await self._resolve_market_async(market)
        resp = await self.api.get_orders(
            market_id=market_obj.market_id,
            contract=trade_account_id,
            direction="desc",
            count=count,
            is_open=is_open,
        )
        return resp.orders

    async def get_order(self, market: str, order_id: str) -> Order:
        """Get a specific order."""
        market_obj = await self._resolve_market_async(market)
        return await self.api.get_order(market_obj.market_id, order_id)

    # -----------------------------------------------------------------------
    # WebSocket streaming
    # -----------------------------------------------------------------------

    async def _ensure_ws(self) -> O2WebSocket:
        if self._ws is None:
            self._ws = O2WebSocket(self._config)
            await self._ws.connect()
        return self._ws

    async def stream_depth(self, market: str, precision: int = 10) -> AsyncIterator[DepthUpdate]:
        """Stream order book depth updates."""
        market_obj = await self._resolve_market_async(market)
        ws = await self._ensure_ws()
        async for update in ws.stream_depth(market_obj.market_id, str(precision)):
            yield update

    async def stream_orders(self, account: AccountInfo | str) -> AsyncIterator[OrderUpdate]:
        """Stream order updates for an account."""
        trade_account_id = account if isinstance(account, str) else account.trade_account_id
        ws = await self._ensure_ws()
        identities = [{"ContractId": trade_account_id}]
        async for update in ws.stream_orders(identities):
            yield update

    async def stream_trades(self, market: str) -> AsyncIterator[TradeUpdate]:
        """Stream trade updates for a market."""
        market_obj = await self._resolve_market_async(market)
        ws = await self._ensure_ws()
        async for update in ws.stream_trades(market_obj.market_id):
            yield update

    async def stream_balances(self, account: AccountInfo | str) -> AsyncIterator[BalanceUpdate]:
        """Stream balance updates for an account."""
        trade_account_id = account if isinstance(account, str) else account.trade_account_id
        ws = await self._ensure_ws()
        identities = [{"ContractId": trade_account_id}]
        async for update in ws.stream_balances(identities):
            yield update

    async def stream_nonce(self, account: AccountInfo | str) -> AsyncIterator[NonceUpdate]:
        """Stream nonce updates for an account."""
        trade_account_id = account if isinstance(account, str) else account.trade_account_id
        ws = await self._ensure_ws()
        identities = [{"ContractId": trade_account_id}]
        async for update in ws.stream_nonce(identities):
            yield update

    # -----------------------------------------------------------------------
    # Withdrawals
    # -----------------------------------------------------------------------

    async def withdraw(
        self,
        owner: Signer,
        asset: str,
        amount: float,
        to: str | None = None,
    ) -> WithdrawResponse:
        """Withdraw funds from the trading account.

        Args:
            owner: A signer for the owner account (Wallet, EvmWallet,
                ExternalSigner, ExternalEvmSigner, or any :class:`Signer`)
            asset: Asset symbol (e.g., "USDC") or asset_id
            amount: Human-readable amount to withdraw
            to: Destination address (defaults to owner address)
        """
        logger.info("Withdrawing %s %s", amount, asset)

        markets_resp = await self._get_markets_cached()
        account = await self.api.get_account(owner=owner.b256_address)
        if not account.exists:
            raise O2Error(message="Account not found")

        nonce = account.nonce
        destination = to or owner.b256_address

        # Resolve asset
        asset_id, decimals = self._resolve_asset(markets_resp, asset)
        scaled_amount = int(amount * (10**decimals))
        logger.debug(
            "Withdraw: asset_id=%s, scaled_amount=%d, nonce=%d", asset_id, scaled_amount, nonce
        )

        # Build withdraw signing bytes using shared encoding function
        signing_bytes = build_withdraw_signing_bytes(
            nonce=nonce,
            chain_id=markets_resp.chain_id_int,
            to_discriminant=0,  # Address discriminant
            to_address=bytes.fromhex(destination[2:]),
            asset_id=bytes.fromhex(asset_id[2:]),
            amount=scaled_amount,
        )

        logger.debug("Signing withdrawal, payload=%d bytes", len(signing_bytes))
        signature = owner.personal_sign(bytes(signing_bytes))

        withdraw_request = {
            "trade_account_id": account.trade_account_id,
            "signature": {"Secp256k1": "0x" + signature.hex()},
            "nonce": str(nonce),
            "to": {"Address": destination},
            "asset_id": asset_id,
            "amount": str(scaled_amount),
        }

        return await self.api.withdraw(owner.b256_address, withdraw_request)

    # -----------------------------------------------------------------------
    # Nonce management
    # -----------------------------------------------------------------------

    async def get_nonce(self, trade_account_id: str) -> int:
        """Get the current nonce for a trading account."""
        return await self._get_nonce(trade_account_id)

    async def refresh_nonce(self, session: SessionInfo) -> int:
        """Re-fetch nonce from the API (manual resync)."""
        old_nonce = self._nonce_cache.get(session.trade_account_id)
        account = await self.api.get_account(trade_account_id=session.trade_account_id)
        nonce = account.nonce
        self._nonce_cache[session.trade_account_id] = nonce
        session.nonce = nonce
        logger.debug(
            "Nonce refreshed: %s -> %s (account=%s)", old_nonce, nonce, session.trade_account_id
        )
        return nonce

    async def _get_nonce(self, trade_account_id: str) -> int:
        if trade_account_id in self._nonce_cache:
            return self._nonce_cache[trade_account_id]
        account = await self.api.get_account(trade_account_id=trade_account_id)
        nonce = account.nonce
        self._nonce_cache[trade_account_id] = nonce
        return nonce

    # -----------------------------------------------------------------------
    # Internal helpers
    # -----------------------------------------------------------------------

    async def _get_markets_cached(self) -> MarketsResponse:
        if self._markets_cache is None:
            self._markets_cache = await self.api.get_markets()
        return self._markets_cache

    def _resolve_market(self, markets_resp: MarketsResponse, name_or_id: str) -> Market:
        """Resolve a market by pair name or hex ID."""
        for m in markets_resp.markets:
            if m.market_id == name_or_id or m.contract_id == name_or_id:
                return m
            if m.pair == name_or_id:
                return m
        raise O2Error(message=f"Market not found: {name_or_id}")

    async def _resolve_market_async(self, name_or_id: str) -> Market:
        markets_resp = await self._get_markets_cached()
        return self._resolve_market(markets_resp, name_or_id)

    def _get_market_info_by_id(self, markets_resp: MarketsResponse, market_id: str) -> dict:
        """Get market info dict needed by action_to_call."""
        for m in markets_resp.markets:
            if m.market_id == market_id:
                return {
                    "contract_id": m.contract_id,
                    "market_id": m.market_id,
                    "base": {"asset": m.base.asset, "decimals": m.base.decimals},
                    "quote": {"asset": m.quote.asset, "decimals": m.quote.decimals},
                    "accounts_registry_id": markets_resp.accounts_registry_id,
                }
        raise O2Error(message=f"Market ID not found: {market_id}")

    def _resolve_asset(self, markets_resp: MarketsResponse, symbol_or_id: str) -> tuple[str, int]:
        """Resolve an asset symbol or ID to (asset_id, decimals)."""
        for m in markets_resp.markets:
            if m.base.symbol == symbol_or_id or m.base.asset == symbol_or_id:
                return m.base.asset, m.base.decimals
            if m.quote.symbol == symbol_or_id or m.quote.asset == symbol_or_id:
                return m.quote.asset, m.quote.decimals
        raise O2Error(message=f"Asset not found: {symbol_or_id}")
