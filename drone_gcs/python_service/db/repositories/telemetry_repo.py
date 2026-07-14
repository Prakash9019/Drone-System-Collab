"""telemetry_history persistence — the highest-volume table and the ONLY file
that knows the partitioning/pruning strategy (ADR-003). Callers never branch on
dialect: they call write_batch / query_track / prune.

Partitioning (Phase 5B doc §5.2):
- SQLite (default): bounded batched DELETE for retention (implemented here).
- PostgreSQL: declarative range partitioning by day — the prune() path drops
  expired partitions instead of row-deletes; wired when a Postgres deployment
  needs it (kept behind this same method so callers are unaffected).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import and_, delete, select

from db.repositories.base import BaseRepository, row_to_dict
from db.schema import drones, flights, telemetry_history

_COLUMNS = (
    "drone_id", "flight_id", "sysid", "recorded_at", "lat", "lon", "alt_rel",
    "alt_amsl", "heading", "groundspeed", "batt_voltage", "batt_remaining",
    "mode", "armed", "gps_fix", "satellites", "sensors",
)


class TelemetryRepo(BaseRepository):
    async def write_batch(self, rows: Sequence[Dict[str, Any]]) -> int:
        if not rows:
            return 0
        clean = [{k: r.get(k) for k in _COLUMNS} for r in rows]
        async with self._sm() as session:
            async with session.begin():
                await session.execute(telemetry_history.insert(), clean)
        return len(clean)

    async def query_track(
        self, drone_id: str, *, t0: Optional[float] = None, t1: Optional[float] = None,
        limit: int = 5000,
    ) -> List[Dict[str, Any]]:
        conds = [telemetry_history.c.drone_id == drone_id]
        if t0 is not None:
            conds.append(telemetry_history.c.recorded_at >= t0)
        if t1 is not None:
            conds.append(telemetry_history.c.recorded_at <= t1)
        stmt = (
            select(telemetry_history).where(and_(*conds))
            .order_by(telemetry_history.c.recorded_at).limit(limit)
        )
        async with self._sm() as session:
            rows = (await session.execute(stmt)).fetchall()
        return [row_to_dict(r) for r in rows]

    async def count_for_drone(self, drone_id: str) -> int:
        from sqlalchemy import func
        async with self._sm() as session:
            n = (await session.execute(
                select(func.count()).select_from(telemetry_history)
                .where(telemetry_history.c.drone_id == drone_id)
            )).scalar_one()
        return int(n)

    async def prune(self, *, cutoff: float, org_id: Optional[str] = None,
                    batch_size: int = 5000, max_batches: int = 1000) -> int:
        """Delete telemetry older than `cutoff`, EXCEPT rows whose flight is on
        retention_hold. Optionally scoped to one org's drones (telemetry_history
        has no org_id, so we join through drones). Bounded batched delete so a
        huge backlog can't lock the DB in one statement. Returns rows deleted."""
        held = select(flights.c.id).where(flights.c.retention_hold == 1)
        conds = [
            telemetry_history.c.recorded_at < cutoff,
            (telemetry_history.c.flight_id.notin_(held) | telemetry_history.c.flight_id.is_(None)),
        ]
        if org_id is not None:
            conds.append(
                telemetry_history.c.drone_id.in_(
                    select(drones.c.id).where(drones.c.org_id == org_id)
                )
            )
        total = 0
        async with self._sm() as session:
            for _ in range(max_batches):
                async with session.begin():
                    ids = (await session.execute(
                        select(telemetry_history.c.id).where(and_(*conds)).limit(batch_size)
                    )).scalars().all()
                    if not ids:
                        break
                    await session.execute(
                        delete(telemetry_history).where(telemetry_history.c.id.in_(ids))
                    )
                    total += len(ids)
                if len(ids) < batch_size:
                    break
        return total
