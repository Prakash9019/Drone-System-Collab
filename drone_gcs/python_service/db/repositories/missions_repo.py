"""Missions (improvement 3): reusable templates, bound instances, execution-
history runs — three distinct lifecycles. 5B ships CRUD + history append; the
MAVLink execution wiring (through the unchanged mission_manager) lands later.
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import select, update

from db.repositories.base import BaseRepository, row_to_dict
from db.schema import mission_instances, mission_runs, mission_templates


class MissionsRepo(BaseRepository):
    # ── templates ─────────────────────────────────────────────────────────────
    async def create_template(self, *, org_id: str, name: str, definition: dict,
                              description: Optional[str] = None, version: int = 1,
                              created_by: Optional[str] = None) -> Dict[str, Any]:
        tid = uuid.uuid4().hex
        async with self._sm() as session:
            async with session.begin():
                await session.execute(mission_templates.insert().values(
                    id=tid, org_id=org_id, name=name, description=description,
                    version=version, definition=definition, created_by=created_by,
                    created_at=time.time(),
                ))
        return await self.get_template(tid)

    async def get_template(self, template_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(
                select(mission_templates).where(mission_templates.c.id == template_id)
            )).first()
        return row_to_dict(row)

    async def list_templates(self, org_id: str, *, include_archived: bool = False) -> List[Dict[str, Any]]:
        stmt = select(mission_templates).where(mission_templates.c.org_id == org_id)
        if not include_archived:
            stmt = stmt.where(mission_templates.c.archived_at.is_(None))
        async with self._sm() as session:
            rows = (await session.execute(stmt.order_by(mission_templates.c.name))).fetchall()
        return [row_to_dict(r) for r in rows]

    async def archive_template(self, template_id: str) -> bool:
        async with self._sm() as session:
            async with session.begin():
                res = await session.execute(
                    update(mission_templates).where(mission_templates.c.id == template_id)
                    .values(archived_at=time.time())
                )
            return res.rowcount > 0

    # ── instances ─────────────────────────────────────────────────────────────
    async def create_instance(self, *, org_id: str, name: str,
                              template_id: Optional[str] = None, drone_id: Optional[str] = None,
                              params: Optional[dict] = None, status: str = "draft",
                              created_by: Optional[str] = None) -> Dict[str, Any]:
        iid = uuid.uuid4().hex
        async with self._sm() as session:
            async with session.begin():
                await session.execute(mission_instances.insert().values(
                    id=iid, org_id=org_id, template_id=template_id, drone_id=drone_id,
                    name=name, params=params or None, status=status, created_by=created_by,
                    created_at=time.time(),
                ))
        return await self.get_instance(iid)

    async def get_instance(self, instance_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(
                select(mission_instances).where(mission_instances.c.id == instance_id)
            )).first()
        return row_to_dict(row)

    async def list_instances(self, org_id: str, *, drone_id: Optional[str] = None) -> List[Dict[str, Any]]:
        stmt = select(mission_instances).where(mission_instances.c.org_id == org_id)
        if drone_id is not None:
            stmt = stmt.where(mission_instances.c.drone_id == drone_id)
        async with self._sm() as session:
            rows = (await session.execute(stmt.order_by(mission_instances.c.created_at.desc()))).fetchall()
        return [row_to_dict(r) for r in rows]

    async def set_instance_status(self, instance_id: str, status: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            async with session.begin():
                await session.execute(
                    update(mission_instances).where(mission_instances.c.id == instance_id).values(status=status)
                )
        return await self.get_instance(instance_id)

    # ── runs (execution history) ──────────────────────────────────────────────
    async def start_run(self, *, org_id: str, drone_id: str,
                        instance_id: Optional[str] = None, template_id: Optional[str] = None,
                        flight_id: Optional[str] = None, started_at: Optional[float] = None) -> Dict[str, Any]:
        now = time.time()
        run_id = uuid.uuid4().hex
        async with self._sm() as session:
            async with session.begin():
                await session.execute(mission_runs.insert().values(
                    id=run_id, org_id=org_id, drone_id=drone_id, instance_id=instance_id,
                    template_id=template_id, flight_id=flight_id,
                    started_at=started_at if started_at is not None else now, created_at=now,
                ))
        return await self.get_run(run_id)

    async def finish_run(self, run_id: str, *, outcome: str, progress: Optional[dict] = None,
                        ended_at: Optional[float] = None) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            async with session.begin():
                await session.execute(
                    update(mission_runs).where(mission_runs.c.id == run_id).values(
                        outcome=outcome, progress=progress or None,
                        ended_at=ended_at if ended_at is not None else time.time(),
                    )
                )
        return await self.get_run(run_id)

    async def get_run(self, run_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(select(mission_runs).where(mission_runs.c.id == run_id))).first()
        return row_to_dict(row)

    async def list_runs(self, *, drone_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        async with self._sm() as session:
            rows = (await session.execute(
                select(mission_runs).where(mission_runs.c.drone_id == drone_id)
                .order_by(mission_runs.c.started_at.desc()).limit(limit)
            )).fetchall()
        return [row_to_dict(r) for r in rows]
