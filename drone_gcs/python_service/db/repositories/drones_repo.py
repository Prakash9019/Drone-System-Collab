"""Drone registry persistence — the table that replaces the RAM-only registry
as the source of truth (closes F1).
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from sqlalchemy import select, update

from db.repositories.base import BaseRepository, row_to_dict
from db.schema import drones

DEFAULT_ORG_ID = "default"


class DronesRepo(BaseRepository):
    async def upsert(
        self,
        *,
        drone_id: str,
        name: str,
        org_id: str = DEFAULT_ORG_ID,
        connection_string: str = "auto",
        baudrate: int = 115200,
        udp_forwarding: Optional[list] = None,
        auto_connect: bool = False,
        metadata: Optional[dict] = None,
        created_at: Optional[float] = None,
    ) -> Dict[str, Any]:
        values = {
            "id": drone_id,
            "org_id": org_id,
            "name": name,
            "connection_string": connection_string,
            "baudrate": baudrate,
            "udp_forwarding": list(udp_forwarding) if udp_forwarding else None,
            "auto_connect": 1 if auto_connect else 0,
            "metadata_json": metadata or None,
            "created_at": created_at if created_at is not None else time.time(),
        }
        async with self._sm() as session:
            async with session.begin():
                await self._upsert(session, drones, drones.c.id, drone_id, values)
        got = await self.get(drone_id)
        assert got is not None
        return got

    async def get(self, drone_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(select(drones).where(drones.c.id == drone_id))).first()
        return row_to_dict(row)

    async def list_for_rehydrate(self, org_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Every non-archived drone — the boot rehydration scan."""
        stmt = select(drones).where(drones.c.archived_at.is_(None))
        if org_id is not None:
            stmt = stmt.where(drones.c.org_id == org_id)
        async with self._sm() as session:
            rows = (await session.execute(stmt)).fetchall()
        return [row_to_dict(r) for r in rows]

    async def archive(self, drone_id: str) -> bool:
        async with self._sm() as session:
            async with session.begin():
                res = await session.execute(
                    update(drones).where(drones.c.id == drone_id, drones.c.archived_at.is_(None))
                    .values(archived_at=time.time())
                )
            return res.rowcount > 0

    async def update_last_seen(
        self, drone_id: str, *, last_seen_at: float,
        conn_state: Optional[str] = None, primary_sysid: Optional[int] = None,
    ) -> None:
        values: Dict[str, Any] = {"last_seen_at": last_seen_at}
        if conn_state is not None:
            values["last_conn_state"] = conn_state
        if primary_sysid is not None:
            values["primary_sysid"] = primary_sysid
        async with self._sm() as session:
            async with session.begin():
                await session.execute(update(drones).where(drones.c.id == drone_id).values(**values))

    async def set_connection(self, drone_id: str, *, connection_string: str, baudrate: Optional[int] = None) -> None:
        """Mirror the active connection profile onto the drone row (kept for
        backward-compat readers of drones.connection_string)."""
        values: Dict[str, Any] = {"connection_string": connection_string}
        if baudrate is not None:
            values["baudrate"] = baudrate
        async with self._sm() as session:
            async with session.begin():
                await session.execute(update(drones).where(drones.c.id == drone_id).values(**values))
