"""TelemetryWriter — a bounded async queue drained into telemetry_history.

enqueue() is a non-blocking, synchronous call from the sampler tick: it appends
a row and, if the queue is full, drops the OLDEST sample and counts it. It never
awaits, never blocks — so a slow or down database can never back-pressure the
sampler (and, transitively, can never touch the real-time ZMQ publish loop).
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class TelemetryWriter:
    def __init__(
        self, telemetry_repo, *, queue_max: int = 10000, batch_size: int = 500,
        flush_interval_s: float = 1.0, metrics=None,
    ) -> None:
        self._repo = telemetry_repo
        self._q: deque = deque()
        self._queue_max = max(1, queue_max)
        self._batch_size = batch_size
        self._flush_interval = flush_interval_s
        self._metrics = metrics
        self._running = False
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._drain_loop())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        await self._flush()   # best-effort final flush

    def enqueue(self, drone_id: str, flight_id: Optional[str], snap: Dict[str, Any], now: float) -> None:
        if len(self._q) >= self._queue_max:
            self._q.popleft()                     # drop-oldest
            if self._metrics:
                self._metrics.telemetry_persist_dropped.inc()
        self._q.append({
            "drone_id": drone_id,
            "flight_id": flight_id,
            "sysid": snap.get("sysid"),
            "recorded_at": now,
            "lat": snap.get("lat"),
            "lon": snap.get("lon"),
            "alt_rel": snap.get("alt_rel"),
            "alt_amsl": snap.get("alt_amsl"),
            "heading": snap.get("heading"),
            "groundspeed": snap.get("groundspeed"),
            "batt_voltage": snap.get("batt_voltage"),
            "batt_remaining": snap.get("batt_remaining"),
            "mode": snap.get("mode"),
            "armed": 1 if snap.get("armed") else 0,
            "gps_fix": snap.get("gps_fix"),
            "satellites": snap.get("satellites"),
            "sensors": snap.get("sensors"),
        })
        if self._metrics:
            self._metrics.telemetry_persist_queue_depth.set(len(self._q))

    async def _drain_loop(self) -> None:
        while self._running:
            await asyncio.sleep(self._flush_interval)
            try:
                await self._flush()
            except Exception:
                logger.exception("telemetry writer flush failed")

    async def _flush(self) -> None:
        if not self._q:
            return
        batch = []
        while self._q and len(batch) < self._batch_size:
            batch.append(self._q.popleft())
        written = await self._repo.write_batch(batch)
        if self._metrics:
            self._metrics.telemetry_persist_written.inc(written)
            self._metrics.telemetry_persist_queue_depth.set(len(self._q))
