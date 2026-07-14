"""PersistenceSampler — the single low-rate loop that samples the live fleet
for the database. It NEVER touches the ZMQ publish loop; it reads the same
DroneSession vehicle state independently at a per-org-configurable rate.

M4 responsibility: drive the FlightTracker from armed transitions + link loss.
M5 extends this loop to enqueue 1 Hz telemetry rows for the async writer.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def _num(v) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f


class PersistenceSampler:
    def __init__(
        self, registry, repos, tracker, *,
        org_id: str = "default", sample_hz: float = 1.0,
        link_loss_grace_s: float = 10.0,
        telemetry_writer=None, resolver=None,
    ) -> None:
        self._registry = registry
        self._repos = repos
        self._tracker = tracker
        self._org_id = org_id
        # The loop polls at sample_hz; per-drone telemetry WRITES are gated to the
        # resolved per-org persist rate (≤ poll rate). Flight detection runs every
        # poll tick regardless.
        self._sample_hz = max(0.01, sample_hz)
        self._grace_s = link_loss_grace_s
        self._writer = telemetry_writer            # TelemetryWriter | None
        self._resolver = resolver                  # OrgSettingsResolver | None
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._offline_since: Dict[str, float] = {}
        self._last_write: Dict[str, float] = {}    # drone_id → last telemetry-persist ts

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self.run_loop())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        # close any flights still open so shutdown yields complete records
        try:
            await self._tracker.close_all(reason="shutdown")
        except Exception:
            logger.exception("sampler: close_all on shutdown failed")

    async def run_loop(self) -> None:
        interval = 1.0 / self._sample_hz
        while self._running:
            tick = time.time()
            try:
                await self._sample_once(tick)
            except Exception:
                # One bad tick must never kill the loop (same resilience rule as
                # the telemetry publisher).
                logger.exception("persistence sample tick failed")
            elapsed = time.time() - tick
            await asyncio.sleep(max(0.0, interval - elapsed))

    async def _sample_once(self, now: float) -> None:
        for session in self._registry.all():
            drone_id = session.drone_id
            online = session.online
            vehicles = getattr(session.link_manager, "vehicles", {}) or {}

            if not online:
                # link down: after grace, close any open flight for this drone
                if self._tracker.active_flight_id(drone_id) is not None:
                    since = self._offline_since.setdefault(drone_id, now)
                    if now - since >= self._grace_s:
                        await self._tracker.close_on_link_loss(drone_id, now=now)
                        self._offline_since.pop(drone_id, None)
                continue
            self._offline_since.pop(drone_id, None)

            for sysid, vehicle in vehicles.items():
                snap = self._extract(sysid, vehicle)
                await self._tracker.observe(
                    drone_id=drone_id, sysid=snap["sysid"], armed=snap["armed"],
                    mode=snap["mode"], lat=snap["lat"], lon=snap["lon"],
                    alt_rel=snap["alt_rel"], now=now,
                )
                if self._writer is not None and await self._should_write(drone_id, now):
                    flight_id = self._tracker.active_flight_id(drone_id)
                    self._writer.enqueue(drone_id, flight_id, snap, now)
                    self._last_write[drone_id] = now

    async def _should_write(self, drone_id: str, now: float) -> bool:
        """Per-org rate gate: write at most once per (1 / persist_hz) seconds."""
        hz = self._sample_hz
        if self._resolver is not None:
            try:
                hz = await self._resolver.persist_hz(self._org_id)
            except Exception:
                logger.exception("resolver.persist_hz failed; using loop rate")
        interval = 1.0 / max(0.001, hz)
        last = self._last_write.get(drone_id)
        # small epsilon so a steady loop cadence isn't off-by-one due to jitter
        return last is None or (now - last) >= interval - 1e-3

    @staticmethod
    def _extract(sysid, vehicle) -> Dict[str, Any]:
        status = getattr(vehicle, "status", None)
        pos = getattr(vehicle, "position", None)
        vel = getattr(vehicle, "velocity", None)
        batt = getattr(vehicle, "battery", None)
        return {
            "sysid": int(getattr(vehicle, "sysid", sysid) or sysid),
            "armed": bool(getattr(status, "armed", False)),
            "mode": getattr(status, "mode", None),
            "gps_fix": getattr(status, "gps_fix", None),
            "satellites": getattr(status, "satellites", None),
            "lat": _num(getattr(pos, "lat", None)),
            "lon": _num(getattr(pos, "lng", None)),   # NB: VehicleState uses `lng`
            "alt_rel": _num(getattr(pos, "alt_rel", None)),
            "alt_amsl": _num(getattr(pos, "alt_amsl", None)),
            "heading": _num(getattr(vel, "heading", None)),
            "groundspeed": _num(getattr(vel, "groundspeed", None)),
            "batt_voltage": _num(getattr(batt, "voltage", None)),
            "batt_remaining": getattr(batt, "remaining", None),
        }
