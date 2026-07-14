"""Flight records — synthesized arm→disarm sessions. No flight concept exists
in the live state; a detector (db/services/flight_tracker.py) watches armed
transitions and drives these methods.
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import select, update

from db.repositories.base import BaseRepository, row_to_dict
from db.schema import flights


class FlightsRepo(BaseRepository):
    async def open_flight(
        self, *, drone_id: str, org_id: str, sysid: Optional[int] = None,
        armed_at: Optional[float] = None, start_mode: Optional[str] = None,
        start_lat: Optional[float] = None, start_lon: Optional[float] = None,
    ) -> Dict[str, Any]:
        now = time.time()
        flight_id = uuid.uuid4().hex
        values = {
            "id": flight_id, "drone_id": drone_id, "org_id": org_id, "sysid": sysid,
            "armed_at": armed_at if armed_at is not None else now,
            "start_mode": start_mode, "start_lat": start_lat, "start_lon": start_lon,
            "retention_hold": 0, "created_at": now,
        }
        async with self._sm() as session:
            async with session.begin():
                await session.execute(flights.insert().values(**values))
        got = await self.get(flight_id)
        assert got is not None
        return got

    async def close_flight(
        self, flight_id: str, *, disarmed_at: Optional[float] = None,
        end_reason: str = "disarm", max_alt_rel: Optional[float] = None,
        distance_m: Optional[float] = None, end_lat: Optional[float] = None,
        end_lon: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        current = await self.get(flight_id)
        if current is None or current["disarmed_at"] is not None:
            return current                      # already closed / unknown — idempotent
        end = disarmed_at if disarmed_at is not None else time.time()
        duration = max(0.0, end - current["armed_at"])
        values: Dict[str, Any] = {
            "disarmed_at": end, "duration_s": duration, "end_reason": end_reason,
        }
        if max_alt_rel is not None:
            values["max_alt_rel"] = max_alt_rel
        if distance_m is not None:
            values["distance_m"] = distance_m
        if end_lat is not None:
            values["end_lat"] = end_lat
        if end_lon is not None:
            values["end_lon"] = end_lon
        async with self._sm() as session:
            async with session.begin():
                await session.execute(update(flights).where(flights.c.id == flight_id).values(**values))
        return await self.get(flight_id)

    async def get(self, flight_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(select(flights).where(flights.c.id == flight_id))).first()
        return row_to_dict(row)

    async def get_open(self, drone_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(
                select(flights).where(flights.c.drone_id == drone_id, flights.c.disarmed_at.is_(None))
                .order_by(flights.c.armed_at.desc())
            )).first()
        return row_to_dict(row)

    async def list_for_drone(self, drone_id: str, *, limit: int = 50) -> List[Dict[str, Any]]:
        async with self._sm() as session:
            rows = (await session.execute(
                select(flights).where(flights.c.drone_id == drone_id)
                .order_by(flights.c.armed_at.desc()).limit(limit)
            )).fetchall()
        return [row_to_dict(r) for r in rows]

    async def close_stale_inflight(self, *, end_reason: str = "timeout") -> int:
        """Close any flight still open (disarmed_at IS NULL) — called at boot so
        a crash mid-flight doesn't leave a permanently-open record. Returns the
        count closed."""
        now = time.time()
        async with self._sm() as session:
            async with session.begin():
                res = await session.execute(
                    update(flights).where(flights.c.disarmed_at.is_(None)).values(
                        disarmed_at=now, end_reason=end_reason,
                        duration_s=now - flights.c.armed_at,
                    )
                )
            return res.rowcount or 0
