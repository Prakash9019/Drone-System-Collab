"""FlightTracker — synthesizes flights from armed transitions.

Fed one snapshot per drone per sample tick (by the persistence sampler). Holds
a small in-memory rollup per open flight (max altitude, distance, last/last
position) and drives flights_repo.open_flight / close_flight. Link-loss and
shutdown closures are explicit so an unclean end still yields a flight record.
"""
from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def _haversine_m(lat1, lon1, lat2, lon2) -> float:
    if None in (lat1, lon1, lat2, lon2):
        return 0.0
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _valid(lat, lon) -> bool:
    return lat not in (None, 0.0) and lon not in (None, 0.0)


@dataclass
class _Open:
    flight_id: str
    sysid: Optional[int]
    max_alt_rel: float = 0.0
    distance_m: float = 0.0
    last_lat: Optional[float] = None
    last_lon: Optional[float] = None
    end_lat: Optional[float] = None
    end_lon: Optional[float] = None


class FlightTracker:
    def __init__(self, flights_repo, *, org_id: str = "default") -> None:
        self._repo = flights_repo
        self._org_id = org_id
        self._open: Dict[str, _Open] = {}       # drone_id → open-flight rollup
        self._armed: Dict[str, bool] = {}        # last-seen armed per drone

    def active_flight_id(self, drone_id: str) -> Optional[str]:
        o = self._open.get(drone_id)
        return o.flight_id if o else None

    async def observe(
        self, *, drone_id: str, sysid: Optional[int], armed: bool,
        mode: Optional[str] = None, lat: Optional[float] = None,
        lon: Optional[float] = None, alt_rel: Optional[float] = None,
        now: Optional[float] = None,
    ) -> None:
        now = now if now is not None else time.time()
        was = self._armed.get(drone_id, False)
        self._armed[drone_id] = armed

        if armed and not was:
            await self._open_flight(drone_id, sysid, mode, lat, lon, now)
        elif not armed and was:
            await self._close_flight(drone_id, now, "disarm")

        # accumulate rollup while armed
        o = self._open.get(drone_id)
        if o is not None and armed:
            if alt_rel is not None and alt_rel > o.max_alt_rel:
                o.max_alt_rel = alt_rel
            if _valid(lat, lon):
                if _valid(o.last_lat, o.last_lon):
                    o.distance_m += _haversine_m(o.last_lat, o.last_lon, lat, lon)
                o.last_lat, o.last_lon = lat, lon
                o.end_lat, o.end_lon = lat, lon

    async def close_on_link_loss(self, drone_id: str, *, now: Optional[float] = None) -> None:
        """A drone with an open flight went offline past the grace window — close
        the flight so the record isn't left dangling."""
        if drone_id in self._open:
            self._armed[drone_id] = False
            await self._close_flight(drone_id, now or time.time(), "link_lost")

    async def close_all(self, *, reason: str = "shutdown") -> None:
        for drone_id in list(self._open.keys()):
            await self._close_flight(drone_id, time.time(), reason)

    # ── internals ─────────────────────────────────────────────────────────────
    async def _open_flight(self, drone_id, sysid, mode, lat, lon, now) -> None:
        if drone_id in self._open:
            return
        try:
            row = await self._repo.open_flight(
                drone_id=drone_id, org_id=self._org_id, sysid=sysid, armed_at=now,
                start_mode=mode,
                start_lat=lat if _valid(lat, lon) else None,
                start_lon=lon if _valid(lat, lon) else None,
            )
        except Exception:
            logger.exception("flight open failed for drone %s", drone_id)
            return
        self._open[drone_id] = _Open(flight_id=row["id"], sysid=sysid)
        logger.info("Flight opened: drone=%s flight=%s", drone_id, row["id"])

    async def _close_flight(self, drone_id, now, reason) -> None:
        o = self._open.pop(drone_id, None)
        if o is None:
            return
        try:
            await self._repo.close_flight(
                o.flight_id, disarmed_at=now, end_reason=reason,
                max_alt_rel=o.max_alt_rel or None,
                distance_m=o.distance_m or None,
                end_lat=o.end_lat, end_lon=o.end_lon,
            )
            logger.info("Flight closed: drone=%s flight=%s reason=%s", drone_id, o.flight_id, reason)
        except Exception:
            logger.exception("flight close failed for drone %s", drone_id)
