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
    """Async WebSocket client for O2 Exchange real-time data."""

    def __init__(self, config: NetworkConfig):
        self._config = config
        self._ws: ClientConnection | None = None
        self._subscriptions: list[dict] = []
        self._message_queues: dict[str, asyncio.Queue] = {}
        self._listener_task: asyncio.Task | None = None
        self._connected = False
        self._reconnect_delay = 1.0
        self._max_reconnect_delay = 60.0
        self._should_run = False

    async def connect(self) -> O2WebSocket:
        """Connect to the WebSocket endpoint."""
        self._should_run = True
        await self._do_connect()
        return self

    async def _do_connect(self) -> None:
        try:
            self._ws = await websockets.connect(self._config.ws_url)
            self._connected = True
            self._reconnect_delay = 1.0
            logger.info("WebSocket connected to %s", self._config.ws_url)

            # Re-subscribe on reconnect
            for sub in self._subscriptions:
                await self._send(sub)

            # Start listener
            if self._listener_task is None or self._listener_task.done():
                self._listener_task = asyncio.create_task(self._listen())
        except Exception as e:
            logger.error("WebSocket connection failed: %s", e)
            if self._should_run:
                await self._reconnect()

    async def _reconnect(self) -> None:
        self._connected = False
        while self._should_run:
            logger.info("Reconnecting in %.1fs...", self._reconnect_delay)
            await asyncio.sleep(self._reconnect_delay)
            self._reconnect_delay = min(self._reconnect_delay * 2, self._max_reconnect_delay)
            try:
                await self._do_connect()
                return
            except Exception as e:
                logger.error("Reconnect failed: %s", e)

    async def disconnect(self) -> None:
        """Disconnect from the WebSocket."""
        self._should_run = False
        self._connected = False
        if self._listener_task and not self._listener_task.done():
            self._listener_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._listener_task
        if self._ws:
            await self._ws.close()
            self._ws = None
        # Signal all queues to stop
        for q in self._message_queues.values():
            await q.put(None)

    async def _send(self, message: dict) -> None:
        if self._ws:
            await self._ws.send(json.dumps(message))

    async def _listen(self) -> None:
        try:
            while self._should_run and self._ws:
                try:
                    raw = await self._ws.recv()
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
        # Route messages to the appropriate queue based on action
        key = self._action_to_queue_key(action)
        if key and key in self._message_queues:
            try:
                self._message_queues[key].put_nowait(data)
            except asyncio.QueueFull:
                logger.warning("Queue full for %s, dropping message", key)

    def _action_to_queue_key(self, action: str) -> str | None:
        if action in ("subscribe_depth", "subscribe_depth_update"):
            return "depth"
        elif action == "subscribe_orders":
            return "orders"
        elif action == "trades":
            return "trades"
        elif action == "subscribe_balances":
            return "balances"
        elif action == "nonce":
            return "nonce"
        return None

    def _get_queue(self, key: str) -> asyncio.Queue:
        if key not in self._message_queues:
            self._message_queues[key] = asyncio.Queue(maxsize=1000)
        return self._message_queues[key]

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
        self._subscriptions.append(sub)
        await self._send(sub)
        queue = self._get_queue("depth")
        while self._should_run:
            msg = await queue.get()
            if msg is None:
                return
            if msg.get("market_id") == market_id:
                yield DepthUpdate.from_dict(msg)

    async def stream_orders(self, identities: list[dict]) -> AsyncIterator[OrderUpdate]:
        """Subscribe to order updates for the given identities."""
        sub = {"action": "subscribe_orders", "identities": identities}
        self._subscriptions.append(sub)
        await self._send(sub)
        queue = self._get_queue("orders")
        while self._should_run:
            msg = await queue.get()
            if msg is None:
                return
            yield OrderUpdate.from_dict(msg)

    async def stream_trades(self, market_id: str) -> AsyncIterator[TradeUpdate]:
        """Subscribe to trade updates for the given market."""
        sub = {"action": "subscribe_trades", "market_id": market_id}
        self._subscriptions.append(sub)
        await self._send(sub)
        queue = self._get_queue("trades")
        while self._should_run:
            msg = await queue.get()
            if msg is None:
                return
            if msg.get("market_id") == market_id:
                yield TradeUpdate.from_dict(msg)

    async def stream_balances(self, identities: list[dict]) -> AsyncIterator[BalanceUpdate]:
        """Subscribe to balance updates for the given identities."""
        sub = {"action": "subscribe_balances", "identities": identities}
        self._subscriptions.append(sub)
        await self._send(sub)
        queue = self._get_queue("balances")
        while self._should_run:
            msg = await queue.get()
            if msg is None:
                return
            yield BalanceUpdate.from_dict(msg)

    async def stream_nonce(self, identities: list[dict]) -> AsyncIterator[NonceUpdate]:
        """Subscribe to nonce updates for the given identities."""
        sub = {"action": "subscribe_nonce", "identities": identities}
        self._subscriptions.append(sub)
        await self._send(sub)
        queue = self._get_queue("nonce")
        while self._should_run:
            msg = await queue.get()
            if msg is None:
                return
            yield NonceUpdate.from_dict(msg)

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
