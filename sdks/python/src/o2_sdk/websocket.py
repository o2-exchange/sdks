"""WebSocket client for real-time O2 Exchange data streams.

Supports subscriptions for depth, orders, trades, balances, and nonce updates
with auto-reconnect and exponential backoff.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator

import websockets
from websockets.asyncio.client import ClientConnection

from .config import NetworkConfig
from .models import (
    BalanceUpdate,
    DepthUpdate,
    NonceUpdate,
    OrderUpdate,
    TradeUpdate,
)

logger = logging.getLogger("o2_sdk.websocket")


class O2WebSocket:
    """Async WebSocket client for O2 Exchange real-time data.

    Features:
    - Auto-reconnect with exponential backoff
    - Subscription tracking and automatic re-subscribe on reconnect
    - Per-subscriber message queues for safe concurrent access
    - Heartbeat ping/pong to detect silent disconnections
    - Configurable max reconnect attempts
    """

    def __init__(
        self,
        config: NetworkConfig,
        ping_interval: float = 30.0,
        pong_timeout: float = 60.0,
        max_reconnect_attempts: int = 10,
    ):
        self._config = config
        self._ws: ClientConnection | None = None
        self._subscriptions: list[dict] = []
        # Per-subscriber fan-out: each stream_*() call registers its own queue.
        # Key = action queue key (e.g. "depth", "orders"), value = list of queues.
        self._subscriber_queues: dict[str, list[asyncio.Queue]] = {}
        self._listener_task: asyncio.Task | None = None
        self._ping_task: asyncio.Task | None = None
        self._connected = False
        self._reconnect_delay = 1.0
        self._max_reconnect_delay = 60.0
        self._should_run = False
        self._ping_interval = ping_interval
        self._pong_timeout = pong_timeout
        self._max_reconnect_attempts = max_reconnect_attempts
        self._reconnect_attempts = 0
        self._last_pong: float = 0.0

    async def connect(self) -> O2WebSocket:
        """Connect to the WebSocket endpoint."""
        self._should_run = True
        self._reconnect_attempts = 0
        await self._do_connect()
        return self

    async def _do_connect(self) -> None:
        try:
            self._ws = await websockets.connect(self._config.ws_url)
            self._connected = True
            self._reconnect_delay = 1.0
            self._reconnect_attempts = 0
            self._last_pong = asyncio.get_event_loop().time()
            logger.info("WebSocket connected to %s", self._config.ws_url)

            # Re-subscribe on reconnect
            for sub in self._subscriptions:
                await self._send(sub)

            # Start listener
            if self._listener_task is None or self._listener_task.done():
                self._listener_task = asyncio.create_task(self._listen())

            # Start ping task
            if self._ping_task is None or self._ping_task.done():
                self._ping_task = asyncio.create_task(self._ping_loop())
        except Exception as e:
            logger.error("WebSocket connection failed: %s", e)
            if self._should_run:
                await self._reconnect()

    async def _ping_loop(self) -> None:
        """Send periodic pings and trigger reconnect on pong timeout."""
        try:
            while self._should_run and self._connected:
                await asyncio.sleep(self._ping_interval)
                if not self._should_run or not self._connected:
                    return

                # Check pong timeout
                now = asyncio.get_event_loop().time()
                if now - self._last_pong > self._pong_timeout:
                    logger.warning("Pong timeout (%.1fs), triggering reconnect", self._pong_timeout)
                    if self._ws:
                        await self._ws.close()
                    return

                # Send ping
                if self._ws:
                    try:
                        await self._ws.ping()
                        logger.debug("Sent ping")
                    except Exception:
                        return
        except asyncio.CancelledError:
            return

    async def _reconnect(self) -> None:
        self._connected = False
        while self._should_run:
            if (
                self._max_reconnect_attempts > 0
                and self._reconnect_attempts >= self._max_reconnect_attempts
            ):
                logger.error(
                    "Max reconnect attempts (%d) reached, stopping",
                    self._max_reconnect_attempts,
                )
                self._should_run = False
                self._signal_all_queues(None)
                return
            self._reconnect_attempts += 1
            logger.info(
                "Reconnecting in %.1fs (attempt %d)...",
                self._reconnect_delay,
                self._reconnect_attempts,
            )
            await asyncio.sleep(self._reconnect_delay)
            self._reconnect_delay = min(self._reconnect_delay * 2, self._max_reconnect_delay)
            try:
                await self._do_connect()
                return
            except Exception as e:
                logger.error("Reconnect failed: %s", e)

    async def disconnect(self) -> None:
        """Disconnect from the WebSocket."""
        logger.info("WebSocket disconnecting")
        self._should_run = False
        self._connected = False
        if self._ping_task and not self._ping_task.done():
            self._ping_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._ping_task
        if self._listener_task and not self._listener_task.done():
            self._listener_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._listener_task
        if self._ws:
            await self._ws.close()
            self._ws = None
        # Signal all subscriber queues to stop
        self._signal_all_queues(None)

    def _signal_all_queues(self, sentinel: object) -> None:
        """Push a sentinel value to every subscriber queue.

        Drains each queue first so the sentinel is never lost due to a full
        queue — buffered data is worthless once shutdown is signalled.
        """
        for queues in self._subscriber_queues.values():
            for q in queues:
                while not q.empty():
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                q.put_nowait(sentinel)

    async def _send(self, message: dict) -> None:
        if self._ws:
            logger.debug("WS send: %s", message.get("action", message))
            await self._ws.send(json.dumps(message))

    async def _listen(self) -> None:
        try:
            while self._should_run and self._ws:
                try:
                    raw = await self._ws.recv()
                    # Any data received counts as proof of liveness
                    self._last_pong = asyncio.get_event_loop().time()
                    data = json.loads(raw)
                    action = data.get("action", "")
                    self._dispatch(action, data)
                except websockets.ConnectionClosed:
                    logger.warning("WebSocket connection closed")
                    if self._should_run:
                        await self._reconnect()
                    return
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.error("WebSocket listener error: %s", e)
            if self._should_run:
                await self._reconnect()

    def _dispatch(self, action: str, data: dict) -> None:
        """Route messages to all subscriber queues for the matching action type."""
        key = self._action_to_queue_key(action)
        if key and key in self._subscriber_queues:
            for q in self._subscriber_queues[key]:
                try:
                    q.put_nowait(data)
                except asyncio.QueueFull:
                    logger.warning("Subscriber queue full for %s, dropping message", key)
            logger.debug(
                "WS dispatched %s -> %d %s subscriber(s)",
                action,
                len(self._subscriber_queues[key]),
                key,
            )
        elif key is None and action:
            logger.warning("WS unhandled action: %s", action)

    def _action_to_queue_key(self, action: str) -> str | None:
        if action in ("subscribe_depth", "subscribe_depth_update"):
            return "depth"
        elif action == "subscribe_orders":
            return "orders"
        elif action == "subscribe_trades":
            return "trades"
        elif action == "subscribe_balances":
            return "balances"
        elif action == "subscribe_nonce":
            return "nonce"
        return None

    def _register_queue(self, key: str) -> asyncio.Queue:
        """Create and register a new subscriber queue for the given action key."""
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        if key not in self._subscriber_queues:
            self._subscriber_queues[key] = []
        self._subscriber_queues[key].append(q)
        return q

    def _unregister_queue(self, key: str, q: asyncio.Queue) -> None:
        """Remove a subscriber queue when the consumer exits."""
        if key in self._subscriber_queues:
            with contextlib.suppress(ValueError):
                self._subscriber_queues[key].remove(q)
            if not self._subscriber_queues[key]:
                del self._subscriber_queues[key]

    def _add_subscription(self, sub: dict) -> None:
        """Add a subscription for reconnect tracking, deduplicating by content."""
        if sub not in self._subscriptions:
            self._subscriptions.append(sub)

    # -----------------------------------------------------------------------
    # Subscription methods
    # -----------------------------------------------------------------------

    async def stream_depth(
        self, market_id: str, precision: str = "10"
    ) -> AsyncIterator[DepthUpdate]:
        """Subscribe to order book depth updates."""
        sub = {
            "action": "subscribe_depth",
            "market_id": market_id,
            "precision": precision,
        }
        self._add_subscription(sub)
        await self._send(sub)
        queue = self._register_queue("depth")
        try:
            while self._should_run:
                msg = await queue.get()
                if msg is None:
                    return
                if msg.get("market_id") == market_id:
                    yield DepthUpdate.from_dict(msg)
        finally:
            self._unregister_queue("depth", queue)

    async def stream_orders(self, identities: list[dict]) -> AsyncIterator[OrderUpdate]:
        """Subscribe to order updates for the given identities."""
        sub = {"action": "subscribe_orders", "identities": identities}
        self._add_subscription(sub)
        await self._send(sub)
        queue = self._register_queue("orders")
        try:
            while self._should_run:
                msg = await queue.get()
                if msg is None:
                    return
                yield OrderUpdate.from_dict(msg)
        finally:
            self._unregister_queue("orders", queue)

    async def stream_trades(self, market_id: str) -> AsyncIterator[TradeUpdate]:
        """Subscribe to trade updates for the given market."""
        sub = {"action": "subscribe_trades", "market_id": market_id}
        self._add_subscription(sub)
        await self._send(sub)
        queue = self._register_queue("trades")
        try:
            while self._should_run:
                msg = await queue.get()
                if msg is None:
                    return
                if msg.get("market_id") == market_id:
                    yield TradeUpdate.from_dict(msg)
        finally:
            self._unregister_queue("trades", queue)

    async def stream_balances(self, identities: list[dict]) -> AsyncIterator[BalanceUpdate]:
        """Subscribe to balance updates for the given identities."""
        sub = {"action": "subscribe_balances", "identities": identities}
        self._add_subscription(sub)
        await self._send(sub)
        queue = self._register_queue("balances")
        try:
            while self._should_run:
                msg = await queue.get()
                if msg is None:
                    return
                yield BalanceUpdate.from_dict(msg)
        finally:
            self._unregister_queue("balances", queue)

    async def stream_nonce(self, identities: list[dict]) -> AsyncIterator[NonceUpdate]:
        """Subscribe to nonce updates for the given identities."""
        sub = {"action": "subscribe_nonce", "identities": identities}
        self._add_subscription(sub)
        await self._send(sub)
        queue = self._register_queue("nonce")
        try:
            while self._should_run:
                msg = await queue.get()
                if msg is None:
                    return
                yield NonceUpdate.from_dict(msg)
        finally:
            self._unregister_queue("nonce", queue)

    # -----------------------------------------------------------------------
    # Unsubscribe methods
    # -----------------------------------------------------------------------

    async def unsubscribe_depth(self, market_id: str) -> None:
        await self._send({"action": "unsubscribe_depth", "market_id": market_id})
        self._subscriptions = [
            s
            for s in self._subscriptions
            if not (s.get("action") == "subscribe_depth" and s.get("market_id") == market_id)
        ]

    async def unsubscribe_orders(self) -> None:
        await self._send({"action": "unsubscribe_orders"})
        self._subscriptions = [
            s for s in self._subscriptions if s.get("action") != "subscribe_orders"
        ]

    async def unsubscribe_trades(self, market_id: str) -> None:
        await self._send({"action": "unsubscribe_trades", "market_id": market_id})
        self._subscriptions = [
            s
            for s in self._subscriptions
            if not (s.get("action") == "subscribe_trades" and s.get("market_id") == market_id)
        ]

    async def unsubscribe_balances(self, identities: list[dict]) -> None:
        await self._send({"action": "unsubscribe_balances", "identities": identities})
        self._subscriptions = [
            s for s in self._subscriptions if s.get("action") != "subscribe_balances"
        ]

    async def unsubscribe_nonce(self, identities: list[dict]) -> None:
        await self._send({"action": "unsubscribe_nonce", "identities": identities})
        self._subscriptions = [
            s for s in self._subscriptions if s.get("action") != "subscribe_nonce"
        ]
