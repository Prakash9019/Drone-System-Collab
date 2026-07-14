"""RetentionManager — hourly sweep applying per-org retention windows across
telemetry, commands, alerts, and recordings. Each window is resolved per org
(org_settings column, else env default). Flights are never pruned (the small
regulatory artifact); rows under a retention_hold flight are exempt.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

logger = logging.getLogger(__name__)

_DAY = 86400.0


class RetentionManager:
    def __init__(self, hub, resolver, *, interval_s: float = 3600.0, metrics=None) -> None:
        self._hub = hub
        self._resolver = resolver
        self._interval = interval_s
        self._metrics = metrics
        self._running = False
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    async def _loop(self) -> None:
        while self._running:
            try:
                await self.run_once()
            except Exception:
                logger.exception("retention sweep failed")
            await asyncio.sleep(self._interval)

    async def run_once(self, now: Optional[float] = None) -> dict:
        now = now if now is not None else time.time()
        pruned = {"telemetry_history": 0, "commands_audit": 0, "alerts": 0, "recordings": 0}
        orgs = await self._hub.org.list_orgs()
        for org in orgs:
            org_id = org["id"]
            tel_cut = now - await self._resolver.retention_days(org_id, "retention_telemetry_days") * _DAY
            cmd_cut = now - await self._resolver.retention_days(org_id, "retention_commands_days") * _DAY
            alert_cut = now - await self._resolver.retention_days(org_id, "retention_alerts_days") * _DAY
            rec_cut = now - await self._resolver.retention_days(org_id, "retention_recordings_days") * _DAY

            pruned["telemetry_history"] += await self._hub.telemetry.prune(cutoff=tel_cut, org_id=org_id)
            pruned["commands_audit"] += await self._hub.retention.prune_table(
                "commands_audit", cutoff=cmd_cut, org_id=org_id)
            pruned["alerts"] += await self._hub.retention.prune_table(
                "alerts", cutoff=alert_cut, org_id=org_id)
            pruned["recordings"] += await self._hub.retention.prune_table(
                "recordings", cutoff=rec_cut, org_id=org_id)

        if self._metrics:
            for table, count in pruned.items():
                if count:
                    self._metrics.retention_rows_pruned.labels(table=table).inc(count)
            self._metrics.retention_last_run_at.set(now)
        total = sum(pruned.values())
        if total:
            logger.info("Retention sweep pruned %d rows", total, extra={"pruned": pruned})
        return pruned
