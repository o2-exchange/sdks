"""WebSocket client for real-time O2 Exchange data streams.

Supports subscriptions for depth, orders, trades, balances, and nonce updates
with auto-reconnect and exponential backoff.

Lifecycle events (connected, disconnected, reconnecting, etc.) are available
via ``stream_lifecycle()`` so callers can re-sync state from REST after a
reconnect — critical for financial applications where missed messages can
cause incorrect position tracking.
"""

from __future__ import annotations

import asyncio
import contextlib
import enum
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass

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


# ---------------------------------------------------------------------------
# Lifecycle events
# ---------------------------------------------------------------------------

class ConnectionState(enum.Enum):
    """WebSocket connection lifecycle states."""

    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    RECONNECTING = "reconnecting"
    RECONNECTED = "reconnected"
    CLOSED = "closed"  # terminal — max retries or explicit disconnect


@dataclass(frozen=True)
class ConnectionEvent:
    """Emitted on WebSocket lifecycle transitions.

    Attributes:
        state: The new connection state.
        attempt: Reconnect attempt number (0 when not reconnecting).
        message: Human-readable description of what happened.
    """

    state: ConnectionState
    attempt: int = 0
    message: str = ""


class O2WebSocket:
    """Async WebSocket client for O2 Exchange real-time data.

    Features:
    - Auto-reconnect with exponential backoff
    - Subscription tracking and automatic re-subscribe on reconnect
    - Per-subscriber message queues for safe concurrent access
    - Heartbeat ping/pong to detect silent disconnections
    - Lifecycle event channel for connection state awareness
    - Configurable max reconnect attempts

    Financial safety:
    After a reconnect the server replays the current order-book snapshot,
    but in-flight messages during the disconnect window are lost.  Callers
    should subscribe to ``stream_lifecycle()`` and re-sync critical state
    (balances, open orders) from the REST API whenever they receive a
    ``RECONNECTED`` event.
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

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> O2WebSocket:
        """Connect to the WebSocket endpoint."""
        self._should_run = True
        self._reconnect_attempts = 0
        await self._do_connect()
        self._emit_lifecycle(ConnectionState.CONNECTED, message="Initial connection")
        self._ensure_background_tasks()
        return self

    async def _do_connect(self) -> None:
        self._ws = await websockets.connect(self._config.ws_url)
        self._connected = True
        self._reconnect_delay = 1.0
        self._reconnect_attempts = 0
        logger.info("WebSocket connected to %s", self._config.ws_url)

        # Re-subscribe on reconnect
        for sub in self._subscriptions:
            await self._send(sub)

    def _ensure_background_tasks(self) -> None:
        """Start listener and ping tasks if they are not already running."""
        if self._listener_task is None or self._listener_task.done():
            self._listener_task = asyncio.create_task(self._listen())
        if self._ping_task is None or self._ping_task.done():
            self._ping_task = asyncio.create_task(self._ping_loop())

    async def _ping_loop(self) -> None:
        """Send periodic pings and trigger reconnect on pong timeout.

        Liveness is determined by the WebSocket protocol-level pong response,
        NOT by whether application data has arrived.  This is critical because
        a subscription may legitimately receive no data for long periods (e.g.
        ``stream_depth`` at precision 0 on a quiet market).  Reconnecting in
        that case would be incorrect — the connection is alive, there's just
        nothing to report.
        """
        try:
            while self._should_run and self._connected:
                await asyncio.sleep(self._ping_interval)
                if not self._should_run or not self._connected:
                    return

                if not self._ws:
                    return

                try:
                    # ws.ping() returns a Future that resolves when the
                    # protocol-level pong frame arrives.  If the server is
                    # alive, this completes well within pong_timeout.
                    pong_waiter = await self._ws.ping()
                    await asyncio.wait_for(pong_waiter, timeout=self._pong_timeout)
                    logger.debug("Ping/pong OK")
                except asyncio.TimeoutError:
                    logger.warning(
                        "Pong timeout (%.1fs), triggering reconnect",
                        self._pong_timeout,
                    )
                    if self._ws:
                        await self._ws.close()
                    return
                except Exception:
                    # Connection error during ping — let listener handle it
                    return
        except asyncio.CancelledError:
            return

    async def _reconnect(self) -> None:
        """Reconnect with exponential backoff.

        CancelledError is intentionally NOT caught here so that
        ``disconnect()`` can interrupt a reconnect that's mid-backoff-sleep.
        """
        self._connected = False
        self._emit_lifecycle(ConnectionState.DISCONNECTED, message="Connection lost")

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
                self._emit_lifecycle(
                    ConnectionState.CLOSED,
                    message=f"Max reconnect attempts ({self._max_reconnect_attempts}) exhausted",
                )
                self._signal_all_queues(None)
                return

            self._reconnect_attempts += 1
            self._emit_lifecycle(
                ConnectionState.RECONNECTING,
                attempt=self._reconnect_attempts,
                message=f"Reconnecting in {self._reconnect_delay:.1f}s "
                f"(attempt {self._reconnect_attempts})",
            )
            logger.info(
                "Reconnecting in %.1fs (attempt %d)...",
                self._reconnect_delay,
                self._reconnect_attempts,
            )
            # CancelledError can interrupt this sleep — that's intentional.
            await asyncio.sleep(self._reconnect_delay)
            self._reconnect_delay = min(
                self._reconnect_delay * 2, self._max_reconnect_delay
            )
            try:
                await self._do_connect()
                # Restart ping task (listener is the caller, so it's still alive)
                if self._ping_task is None or self._ping_task.done():
                    self._ping_task = asyncio.create_task(self._ping_loop())
                self._emit_lifecycle(
                    ConnectionState.RECONNECTED,
                    attempt=self._reconnect_attempts,
                    message="Reconnected — consumers should re-sync from REST",
                )
                return
            except asyncio.CancelledError:
                raise  # Let disconnect() kill the reconnect loop
            except Exception as e:
                logger.error("Reconnect failed: %s", e)

    async def disconnect(self) -> None:
        """Disconnect from the WebSocket.

        Designed to complete in bounded time even when the connection is in
        a broken state.  The steps are ordered so that consumer generators
        are unblocked as early as possible:

        1. Signal shutdown (``_should_run = False``)
        2. Signal all subscriber queues *first* — unblocks any consumer
           sitting in ``queue.get()`` before we attempt the (potentially
           slow) WS close handshake.
        3. Cancel internal tasks with a timeout.
        4. Close the WS connection with a timeout — a broken TCP connection
           can hang for minutes without one.
        """
        logger.info("WebSocket disconnecting")
        self._should_run = False
        self._connected = False

        # Signal consumers FIRST so they can exit while we clean up.
        self._emit_lifecycle(ConnectionState.CLOSED, message="Disconnected by client")
        self._signal_all_queues(None)

        # Cancel internal tasks with a bounded wait.  If _reconnect() is
        # mid-backoff the cancel interrupts the sleep; the 5s timeout is
        # a safety net in case CancelledError is unexpectedly suppressed.
        for task_name, task in [
            ("ping", self._ping_task),
            ("listener", self._listener_task),
        ]:
            if task and not task.done():
                task.cancel()
                try:
                    await asyncio.wait_for(
                        asyncio.shield(task), timeout=5.0
                    )
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    logger.warning("WS %s task did not exit cleanly", task_name)

        # Close the underlying WS connection.  A half-open TCP socket can
        # hang for the OS keepalive timeout (minutes) without this guard.
        if self._ws:
            try:
                await asyncio.wait_for(self._ws.close(), timeout=5.0)
            except (asyncio.TimeoutError, Exception) as e:
                logger.warning("WS close timed out or errored: %s", e)
            self._ws = None

    # ------------------------------------------------------------------
    # Internal message routing
    # ------------------------------------------------------------------

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

    def _emit_lifecycle(
        self,
        state: ConnectionState,
        attempt: int = 0,
        message: str = "",
    ) -> None:
        """Push a lifecycle event to all lifecycle subscribers."""
        event = ConnectionEvent(state=state, attempt=attempt, message=message)
        logger.info("WS lifecycle: %s — %s", state.value, message)
        if "lifecycle" in self._subscriber_queues:
            for q in self._subscriber_queues["lifecycle"]:
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    # Drain and retry — lifecycle events must not be lost
                    while not q.empty():
                        try:
                            q.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                    q.put_nowait(event)

    async def _send(self, message: dict) -> None:
        if self._ws:
            logger.debug("WS send: %s", message.get("action", message))
            await self._ws.send(json.dumps(message))

    async def _listen(self) -> None:
        """Read messages from the WebSocket and dispatch to subscriber queues.

        On connection loss this method handles reconnection internally and
        continues reading — it does NOT return after a reconnect, which was
        the root cause of the "orphaned queue" hang in previous versions.
        """
        try:
            while self._should_run:
                if not self._ws or not self._connected:
                    await asyncio.sleep(0.1)
                    continue
                try:
                    raw = await self._ws.recv()
                    data = json.loads(raw)
                    action = data.get("action", "")
                    self._dispatch(action, data)
                except websockets.ConnectionClosed:
                    logger.warning("WebSocket connection closed")
                    if self._should_run:
                        await self._reconnect()
                        # After reconnect, loop back to recv() on the new
                        # connection instead of returning.  _do_connect()
                        # already set self._ws to the new connection.
                        continue
                    return
                except asyncio.CancelledError:
                    return
                except Exception as e:
                    logger.error("WebSocket listener error: %s", e)
                    if self._should_run:
                        await self._reconnect()
                        continue
                    return
        except asyncio.CancelledError:
            return

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

    # ------------------------------------------------------------------
    # Subscription methods
    # ------------------------------------------------------------------

    async def stream_lifecycle(self) -> AsyncIterator[ConnectionEvent]:
        """Stream WebSocket connection lifecycle events.

        Yields ``ConnectionEvent`` objects whenever the connection state
        changes.  Use this to detect reconnects and re-sync state from the
        REST API — messages received during the disconnect window are lost.

        Example::

            async for event in ws.stream_lifecycle():
                if event.state == ConnectionState.RECONNECTED:
                    balances = await client.get_balances(account)
                    orders = await client.get_orders(account)
                    # ... rebuild local state ...
                elif event.state == ConnectionState.CLOSED:
                    break  # terminal, no more events
        """
        queue = self._register_queue("lifecycle")
        try:
            while self._should_run:
                msg = await queue.get()
                if msg is None:
                    return
                yield msg
        finally:
            self._unregister_queue("lifecycle", queue)

    async def stream_depth(
        self, market_id: str, precision: str = "1"
    ) -> AsyncIterator[DepthUpdate]:
        """Subscribe to order book depth updates.

        Args:
            market_id: The market ID (hex string).
            precision: Depth aggregation level as a precision index (default ``"1"``).
                Valid range: ``"1"``--``"18"``. The value is treated as an exponent:
                the wire value sent is ``10^precision``. Precision 1 = finest level
                (sends 10 on the wire → backend Precision(1) → live delta streaming).
                Higher values give coarser bucketing. Do NOT pass raw powers of 10
                (e.g. pass ``"1"``, not ``"10"``).

        Note:
            Prefer :meth:`O2Client.stream_depth` which validates precision
            and resolves market pairs by name.
        """
        wire_precision = str(10 ** int(precision))
        sub = {
            "action": "subscribe_depth",
            "market_id": market_id,
            "precision": wire_precision,
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

    # ------------------------------------------------------------------
    # Unsubscribe methods
    # ------------------------------------------------------------------

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
