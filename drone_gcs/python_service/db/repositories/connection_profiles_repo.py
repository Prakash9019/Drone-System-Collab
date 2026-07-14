"""Per-drone connection profiles (improvement 1) — a drone owns many transport
configurations; exactly one is active. The active profile's connection string
is mirrored onto drones.connection_string for backward-compatible readers.
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import select, update

from db.repositories.base import BaseRepository, row_to_dict
from db.schema import connection_profiles, drones


class ConnectionProfilesRepo(BaseRepository):
    async def list(self, drone_id: str) -> List[Dict[str, Any]]:
        async with self._sm() as session:
            rows = (await session.execute(
                select(connection_profiles)
                .where(connection_profiles.c.drone_id == drone_id)
                .order_by(connection_profiles.c.priority)
            )).fetchall()
        return [row_to_dict(r) for r in rows]

    async def get(self, profile_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(
                select(connection_profiles).where(connection_profiles.c.id == profile_id)
            )).first()
        return row_to_dict(row)

    async def get_active(self, drone_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(
                select(connection_profiles).where(
                    connection_profiles.c.drone_id == drone_id,
                    connection_profiles.c.is_active == 1,
                )
            )).first()
        return row_to_dict(row)

    async def add(
        self, *, drone_id: str, org_id: str, name: str, kind: str,
        connection_string: str, baudrate: Optional[int] = None,
        udp_forwarding: Optional[list] = None, priority: int = 100,
        metadata: Optional[dict] = None, activate: bool = False,
    ) -> Dict[str, Any]:
        profile_id = uuid.uuid4().hex
        async with self._sm() as session:
            async with session.begin():
                # First profile for a drone is always active; else honour `activate`.
                existing = (await session.execute(
                    select(connection_profiles.c.id).where(connection_profiles.c.drone_id == drone_id)
                )).fetchall()
                make_active = activate or not existing
                if make_active:
                    await session.execute(
                        update(connection_profiles)
                        .where(connection_profiles.c.drone_id == drone_id)
                        .values(is_active=0)
                    )
                await session.execute(connection_profiles.insert().values(
                    id=profile_id, drone_id=drone_id, org_id=org_id, name=name, kind=kind,
                    connection_string=connection_string, baudrate=baudrate,
                    udp_forwarding=list(udp_forwarding) if udp_forwarding else None,
                    priority=priority, is_active=1 if make_active else 0,
                    metadata_json=metadata or None, created_at=time.time(),
                ))
                if make_active:
                    await self._mirror_to_drone(session, drone_id, connection_string, baudrate)
        got = await self.get(profile_id)
        assert got is not None
        return got

    async def activate(self, profile_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            async with session.begin():
                prof = (await session.execute(
                    select(connection_profiles).where(connection_profiles.c.id == profile_id)
                )).first()
                if prof is None:
                    return None
                prof = dict(prof._mapping)
                await session.execute(
                    update(connection_profiles)
                    .where(connection_profiles.c.drone_id == prof["drone_id"])
                    .values(is_active=0)
                )
                await session.execute(
                    update(connection_profiles)
                    .where(connection_profiles.c.id == profile_id)
                    .values(is_active=1)
                )
                await self._mirror_to_drone(
                    session, prof["drone_id"], prof["connection_string"], prof.get("baudrate")
                )
        return await self.get(profile_id)

    async def delete(self, profile_id: str) -> bool:
        async with self._sm() as session:
            async with session.begin():
                res = await session.execute(
                    connection_profiles.delete().where(connection_profiles.c.id == profile_id)
                )
            return res.rowcount > 0

    @staticmethod
    async def _mirror_to_drone(session, drone_id: str, connection_string: str,
                               baudrate: Optional[int]) -> None:
        values: Dict[str, Any] = {"connection_string": connection_string}
        if baudrate is not None:
            values["baudrate"] = baudrate
        await session.execute(update(drones).where(drones.c.id == drone_id).values(**values))
