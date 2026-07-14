"""Command audit — the first record of who commanded what, when, and the
outcome. Written at command completion (accept/reject/timeout) so `result` is
known. Covers every route because the hook lives in CommandManager, through
which all commands flow.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from db.repositories.base import BaseRepository, row_to_dict
from db.schema import commands_audit


class CommandsRepo(BaseRepository):
    async def record_command(
        self, *, drone_id: str, org_id: str, sysid: int, command: int,
        params: Optional[dict] = None, result: Optional[int] = None,
        result_text: Optional[str] = None, reason: Optional[str] = None,
        source_route: Optional[str] = None, operator_id: Optional[str] = None,
        flight_id: Optional[str] = None, issued_at: Optional[float] = None,
    ) -> None:
        async with self._sm() as session:
            async with session.begin():
                await session.execute(commands_audit.insert().values(
                    drone_id=drone_id, org_id=org_id, operator_id=operator_id,
                    flight_id=flight_id, sysid=sysid, command=command,
                    params=params or None, issued_at=issued_at if issued_at is not None else time.time(),
                    result=result, result_text=result_text, reason=reason,
                    source_route=source_route,
                ))

    async def list_for_drone(self, drone_id: str, *, limit: int = 100) -> List[Dict[str, Any]]:
        async with self._sm() as session:
            rows = (await session.execute(
                select(commands_audit).where(commands_audit.c.drone_id == drone_id)
                .order_by(commands_audit.c.issued_at.desc()).limit(limit)
            )).fetchall()
        return [row_to_dict(r) for r in rows]
