"""Recordings metadata (ADR-005) — the DB stores only a pointer to the blob in
object storage. Deleting a recording deletes the blob via the driver, then the
row.
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from db.repositories.base import BaseRepository, row_to_dict
from db.schema import recordings


class RecordingsRepo(BaseRepository):
    def __init__(self, sessionmaker, object_store=None) -> None:
        super().__init__(sessionmaker)
        self._store = object_store

    async def register(
        self, *, org_id: str, backend: str, uri: str, drone_id: Optional[str] = None,
        flight_id: Optional[str] = None, size_bytes: Optional[int] = None,
        duration_s: Optional[float] = None, checksum: Optional[str] = None,
        started_at: Optional[float] = None, recording_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        now = time.time()
        rid = recording_id or uuid.uuid4().hex
        async with self._sm() as session:
            async with session.begin():
                await session.execute(recordings.insert().values(
                    id=rid, org_id=org_id, drone_id=drone_id, flight_id=flight_id,
                    backend=backend, uri=uri, size_bytes=size_bytes, duration_s=duration_s,
                    checksum=checksum, started_at=started_at if started_at is not None else now,
                    created_at=now,
                ))
        return await self.get(rid)

    async def get(self, recording_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(select(recordings).where(recordings.c.id == recording_id))).first()
        return row_to_dict(row)

    async def list(self, *, org_id: Optional[str] = None, drone_id: Optional[str] = None,
                   limit: int = 100) -> List[Dict[str, Any]]:
        stmt = select(recordings)
        if org_id is not None:
            stmt = stmt.where(recordings.c.org_id == org_id)
        if drone_id is not None:
            stmt = stmt.where(recordings.c.drone_id == drone_id)
        stmt = stmt.order_by(recordings.c.created_at.desc()).limit(limit)
        async with self._sm() as session:
            rows = (await session.execute(stmt)).fetchall()
        return [row_to_dict(r) for r in rows]

    async def delete(self, recording_id: str) -> bool:
        rec = await self.get(recording_id)
        if rec is None:
            return False
        if self._store is not None and rec["backend"] == self._store.scheme:
            try:
                self._store.delete(rec["uri"])
            except Exception:
                pass  # blob may already be gone; still drop the row
        async with self._sm() as session:
            async with session.begin():
                await session.execute(recordings.delete().where(recordings.c.id == recording_id))
        return True
