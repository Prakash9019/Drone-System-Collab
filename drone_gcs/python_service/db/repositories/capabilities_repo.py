"""Drone capabilities (improvement 2) — installed hardware / supported features
as open-vocabulary rows, so a new capability is data, not a migration.
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import select, update

from db.repositories.base import BaseRepository, row_to_dict
from db.schema import drone_capabilities


class CapabilitiesRepo(BaseRepository):
    async def list(self, drone_id: str) -> List[Dict[str, Any]]:
        async with self._sm() as session:
            rows = (await session.execute(
                select(drone_capabilities).where(drone_capabilities.c.drone_id == drone_id)
            )).fetchall()
        return [row_to_dict(r) for r in rows]

    async def set(self, *, drone_id: str, capability: str, present: bool = True,
                  spec: Optional[dict] = None) -> Dict[str, Any]:
        """Upsert a capability on (drone_id, capability)."""
        async with self._sm() as session:
            async with session.begin():
                existing = (await session.execute(
                    select(drone_capabilities.c.id).where(
                        drone_capabilities.c.drone_id == drone_id,
                        drone_capabilities.c.capability == capability,
                    )
                )).first()
                if existing is None:
                    await session.execute(drone_capabilities.insert().values(
                        id=uuid.uuid4().hex, drone_id=drone_id, capability=capability,
                        present=1 if present else 0, spec=spec or None,
                        created_at=time.time(),
                    ))
                else:
                    await session.execute(
                        update(drone_capabilities)
                        .where(drone_capabilities.c.id == existing[0])
                        .values(present=1 if present else 0, spec=spec or None, updated_at=time.time())
                    )
        rows = await self.list(drone_id)
        return next(r for r in rows if r["capability"] == capability)

    async def remove(self, *, drone_id: str, capability: str) -> bool:
        async with self._sm() as session:
            async with session.begin():
                res = await session.execute(
                    drone_capabilities.delete().where(
                        drone_capabilities.c.drone_id == drone_id,
                        drone_capabilities.c.capability == capability,
                    )
                )
            return res.rowcount > 0

    async def drones_with(self, capability: str) -> List[str]:
        """drone_ids that have `capability` present — the 'all thermal drones'
        filter."""
        async with self._sm() as session:
            rows = (await session.execute(
                select(drone_capabilities.c.drone_id).where(
                    drone_capabilities.c.capability == capability,
                    drone_capabilities.c.present == 1,
                )
            )).fetchall()
        return [r[0] for r in rows]
