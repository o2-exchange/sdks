"""High-level O2 Exchange client.

Orchestrates wallet management, account lifecycle, session management,
trading, market data, and WebSocket streaming.
"""

from __future__ import annotations

import logging
import time
from typing import Any, AsyncIterator, Optional, Union

from .api import O2Api
from .config import Network, NetworkConfig, get_config
from .crypto import (
    EvmWallet,
    Wallet,
    evm_personal_sign,
    generate_evm_wallet,
    generate_wallet,
    load_evm_wallet,
    load_wallet,
    personal_sign,
    raw_sign,
)
from .encoding import (
    GAS_MAX,
    action_to_call,
    build_actions_signing_bytes,
    build_session_signing_bytes,
    encode_identity,
)
from .errors import O2Error
from .models import (
    AccountInfo,
    ActionsResponse,
    Balance,
    Bar,
    BalanceUpdate,
    DepthSnapshot,
    DepthUpdate,
    FaucetResponse,
    Market,
    MarketsResponse,
    NonceUpdate,
    Order,
    OrderUpdate,
    SessionInfo,
    Trade,
    TradeUpdate,
    WhitelistResponse,
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
        custom_config: Optional[NetworkConfig] = None,
    ):
        self._config = custom_config or get_config(network)
        self._network = network
        self.api = O2Api(self._config)
        self._ws: Optional[O2WebSocket] = None
        self._markets_cache: Optional[MarketsResponse] = None
        self._nonce_cache: dict[str, int] = {}

    async def close(self) -> None:
        """Close all connections."""
        await self.api.close()
        if self._ws:
            await self._ws.disconnect()

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

    async def setup_account(self, wallet: Union[Wallet, EvmWallet]) -> AccountInfo:
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
            account = await self.api.get_account(
                trade_account_id=result.trade_account_id
            )

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
        owner: Union[Wallet, EvmWallet],
        markets: list[str],
        expiry_days: int = 30,
    ) -> SessionInfo:
        """Create a trading session.

        Args:
            owner: The owner wallet (Fuel or EVM)
            markets: List of market pair strings (e.g., ["FUEL/USDC"]) or contract IDs
            expiry_days: Session expiry in days (default 30)

        Returns:
            SessionInfo with session keys and trading state
        """
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

        # Sign with owner (personalSign for Fuel, evm_personal_sign for EVM)
        if isinstance(owner, EvmWallet):
            signature = evm_personal_sign(owner.private_key, signing_bytes)
        else:
            signature = personal_sign(owner.private_key, signing_bytes)

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
        self._nonce_cache[account.trade_account_id] = nonce + 1

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
        side: str,
        price: float,
        quantity: float,
        order_type: str = "Spot",
        order_type_data: Optional[dict] = None,
        settle_first: bool = True,
        collect_orders: bool = True,
    ) -> ActionsResponse:
        """Place an order with automatic encoding, signing, and nonce management.

        Args:
            session: Active trading session
            market: Market pair (e.g., "FUEL/USDC") or market_id
            side: "Buy" or "Sell"
            price: Human-readable price (auto-scaled)
            quantity: Human-readable quantity (auto-scaled)
            order_type: "Spot", "Market", "Limit", "FillOrKill", "PostOnly", "BoundedMarket"
            order_type_data: Extra data for Limit/BoundedMarket types
            settle_first: If True, prepend SettleBalance action
            collect_orders: If True, return created order details

        Returns:
            ActionsResponse with tx_id and optional orders
        """
        markets_resp = await self._get_markets_cached()
        market_obj = self._resolve_market(markets_resp, market)

        # Scale price and quantity
        scaled_price = market_obj.scale_price(price)
        scaled_quantity = market_obj.scale_quantity(quantity)

        # Adjust quantity for FractionalPrice constraint
        scaled_quantity = market_obj.adjust_quantity(scaled_price, scaled_quantity)

        # Validate
        market_obj.validate_order(scaled_price, scaled_quantity)

        # Build order type for the API
        ot: Any
        if order_type in ("Spot", "Market", "FillOrKill", "PostOnly"):
            ot = order_type
        elif order_type == "Limit" and order_type_data:
            limit_price = market_obj.scale_price(order_type_data.get("price", price))
            timestamp = int(order_type_data.get("timestamp", int(time.time())))
            ot = {"Limit": [str(limit_price), str(timestamp)]}
        elif order_type == "BoundedMarket" and order_type_data:
            max_price = market_obj.scale_price(order_type_data["max_price"])
            min_price = market_obj.scale_price(order_type_data["min_price"])
            ot = {"BoundedMarket": {"max_price": str(max_price), "min_price": str(min_price)}}
        else:
            ot = order_type

        # Build actions
        actions_list: list[dict] = []
        if settle_first:
            actions_list.append({
                "SettleBalance": {
                    "to": {"ContractId": session.trade_account_id}
                }
            })
        actions_list.append({
            "CreateOrder": {
                "side": side,
                "price": str(scaled_price),
                "quantity": str(scaled_quantity),
                "order_type": ot,
            }
        })

        return await self.batch_actions(
            session=session,
            actions=[{"market_id": market_obj.market_id, "actions": actions_list}],
            collect_orders=collect_orders,
        )

    async def cancel_order(
        self,
        session: SessionInfo,
        order_id: str,
        market: Optional[str] = None,
        market_id: Optional[str] = None,
    ) -> ActionsResponse:
        """Cancel an order."""
        if market_id is None:
            if market is None:
                raise ValueError("Either market or market_id must be provided")
            markets_resp = await self._get_markets_cached()
            market_obj = self._resolve_market(markets_resp, market)
            market_id = market_obj.market_id

        actions = [{
            "market_id": market_id,
            "actions": [{"CancelOrder": {"order_id": order_id}}],
        }]
        return await self.batch_actions(session=session, actions=actions)

    async def cancel_all_orders(
        self, session: SessionInfo, market: str
    ) -> ActionsResponse:
        """Cancel all open orders for a market (up to 5 per batch)."""
        markets_resp = await self._get_markets_cached()
        market_obj = self._resolve_market(markets_resp, market)

        orders_resp = await self.api.get_orders(
            market_id=market_obj.market_id,
            contract=session.trade_account_id,
            direction="desc",
            count=5,
            is_open=True,
        )

        if not orders_resp.orders:
            return ActionsResponse(tx_id=None, message="No open orders")

        cancel_actions = [
            {"CancelOrder": {"order_id": o.order_id}}
            for o in orders_resp.orders
        ]
        actions = [{"market_id": market_obj.market_id, "actions": cancel_actions}]
        return await self.batch_actions(session=session, actions=actions)

    async def settle_balance(
        self, session: SessionInfo, market: str
    ) -> ActionsResponse:
        """Settle balance for a market."""
        markets_resp = await self._get_markets_cached()
        market_obj = self._resolve_market(markets_resp, market)

        actions = [{
            "market_id": market_obj.market_id,
            "actions": [{
                "SettleBalance": {
                    "to": {"ContractId": session.trade_account_id}
                }
            }],
        }]
        return await self.batch_actions(session=session, actions=actions)

    async def batch_actions(
        self,
        session: SessionInfo,
        actions: list[dict],
        collect_orders: bool = False,
    ) -> ActionsResponse:
        """Submit a batch of actions with automatic signing and nonce management.

        Args:
            session: Active trading session
            actions: List of market-grouped actions
            collect_orders: If True, return created order details
        """
        markets_resp = await self._get_markets_cached()

        # Get current nonce
        nonce = await self._get_nonce(session.trade_account_id)

        # Convert actions to calls
        calls: list[dict] = []
        for market_group in actions:
            m_id = market_group["market_id"]
            market_info = self._get_market_info_by_id(markets_resp, m_id)
            for action in market_group["actions"]:
                call = action_to_call(action, market_info)
                calls.append(call)

        # Build signing bytes and sign with session key
        signing_bytes = build_actions_signing_bytes(nonce, calls)
        signature = raw_sign(session.session_private_key, signing_bytes)

        # Submit
        request = {
            "actions": actions,
            "signature": {"Secp256k1": "0x" + signature.hex()},
            "nonce": str(nonce),
            "trade_account_id": session.trade_account_id,
            "session_id": session.session_id.to_dict(),
            "collect_orders": collect_orders,
        }

        try:
            result = await self.api.submit_actions(session.owner_address, request)
            # Increment nonce on success
            self._nonce_cache[session.trade_account_id] = nonce + 1
            session.nonce = nonce + 1
            return result
        except O2Error:
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

    async def get_depth(
        self, market: str, precision: int = 10
    ) -> DepthSnapshot:
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

    async def get_balances(
        self, account: Union[AccountInfo, str]
    ) -> dict[str, Balance]:
        """Get balances keyed by asset symbol.

        Args:
            account: AccountInfo or trade_account_id string
        """
        if isinstance(account, str):
            trade_account_id = account
        else:
            trade_account_id = account.trade_account_id

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
        account: Union[AccountInfo, str],
        market: str,
        is_open: Optional[bool] = None,
        count: int = 20,
    ) -> list[Order]:
        """Get orders for an account on a market."""
        trade_account_id = (
            account if isinstance(account, str) else account.trade_account_id
        )
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

    async def stream_depth(
        self, market: str, precision: int = 10
    ) -> AsyncIterator[DepthUpdate]:
        """Stream order book depth updates."""
        market_obj = await self._resolve_market_async(market)
        ws = await self._ensure_ws()
        async for update in ws.stream_depth(market_obj.market_id, str(precision)):
            yield update

    async def stream_orders(
        self, account: Union[AccountInfo, str]
    ) -> AsyncIterator[OrderUpdate]:
        """Stream order updates for an account."""
        trade_account_id = (
            account if isinstance(account, str) else account.trade_account_id
        )
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

    async def stream_balances(
        self, account: Union[AccountInfo, str]
    ) -> AsyncIterator[BalanceUpdate]:
        """Stream balance updates for an account."""
        trade_account_id = (
            account if isinstance(account, str) else account.trade_account_id
        )
        ws = await self._ensure_ws()
        identities = [{"ContractId": trade_account_id}]
        async for update in ws.stream_balances(identities):
            yield update

    async def stream_nonce(
        self, account: Union[AccountInfo, str]
    ) -> AsyncIterator[NonceUpdate]:
        """Stream nonce updates for an account."""
        trade_account_id = (
            account if isinstance(account, str) else account.trade_account_id
        )
        ws = await self._ensure_ws()
        identities = [{"ContractId": trade_account_id}]
        async for update in ws.stream_nonce(identities):
            yield update

    # -----------------------------------------------------------------------
    # Withdrawals
    # -----------------------------------------------------------------------

    async def withdraw(
        self,
        owner: Union[Wallet, EvmWallet],
        asset: str,
        amount: float,
        to: Optional[str] = None,
    ) -> WithdrawResponse:
        """Withdraw funds from the trading account.

        Args:
            owner: Owner wallet (required for signing)
            asset: Asset symbol (e.g., "USDC") or asset_id
            amount: Human-readable amount to withdraw
            to: Destination address (defaults to owner address)
        """
        markets_resp = await self._get_markets_cached()
        account = await self.api.get_account(owner=owner.b256_address)
        if not account.exists:
            raise O2Error(message="Account not found")

        nonce = account.nonce
        destination = to or owner.b256_address

        # Resolve asset
        asset_id, decimals = self._resolve_asset(markets_resp, asset)
        scaled_amount = int(amount * (10 ** decimals))

        # Build withdraw signing bytes
        # Withdraw uses personalSign like session creation
        from .encoding import u64_be

        func_name = b"withdraw"
        signing_bytes = bytearray()
        signing_bytes += u64_be(nonce)
        signing_bytes += u64_be(markets_resp.chain_id_int)
        signing_bytes += u64_be(len(func_name))
        signing_bytes += func_name
        # to identity
        signing_bytes += u64_be(0)  # Address discriminant
        signing_bytes += bytes.fromhex(destination[2:])
        # asset_id
        signing_bytes += bytes.fromhex(asset_id[2:])
        # amount
        signing_bytes += u64_be(scaled_amount)

        if isinstance(owner, EvmWallet):
            from .crypto import evm_personal_sign as sign_fn
        else:
            from .crypto import personal_sign as sign_fn

        signature = sign_fn(owner.private_key, bytes(signing_bytes))

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
        account = await self.api.get_account(
            trade_account_id=session.trade_account_id
        )
        nonce = account.nonce
        self._nonce_cache[session.trade_account_id] = nonce
        session.nonce = nonce
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

    def _get_market_info_by_id(
        self, markets_resp: MarketsResponse, market_id: str
    ) -> dict:
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

    def _resolve_asset(
        self, markets_resp: MarketsResponse, symbol_or_id: str
    ) -> tuple[str, int]:
        """Resolve an asset symbol or ID to (asset_id, decimals)."""
        for m in markets_resp.markets:
            if m.base.symbol == symbol_or_id or m.base.asset == symbol_or_id:
                return m.base.asset, m.base.decimals
            if m.quote.symbol == symbol_or_id or m.quote.asset == symbol_or_id:
                return m.quote.asset, m.quote.decimals
        raise O2Error(message=f"Asset not found: {symbol_or_id}")
