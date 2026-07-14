"""Retention pruning for the org-scoped, timestamp-bearing tables
(commands_audit, alerts, recordings). Telemetry pruning lives in telemetry_repo
(it owns partitioning). This keeps all retention SQL inside the repo layer.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import Table, delete

from db.repositories.base import BaseRepository
from db.schema import alerts, commands_audit, recordings

# table → the timestamp column pruning compares against
_TS_COL = {
    "commands_audit": commands_audit.c.issued_at,
    "alerts": alerts.c.triggered_at,
    "recordings": recordings.c.created_at,
}
_TABLE = {"commands_audit": commands_audit, "alerts": alerts, "recordings": recordings}


class RetentionRepo(BaseRepository):
    async def prune_table(self, table_name: str, *, cutoff: float,
                          org_id: Optional[str] = None) -> int:
        table: Table = _TABLE[table_name]
        ts_col = _TS_COL[table_name]
        conds = [ts_col < cutoff]
        if org_id is not None:
            conds.append(table.c.org_id == org_id)
        if table_name == "alerts":
            conds.append(alerts.c.cleared_at.isnot(None))   # keep active alerts regardless of age
        async with self._sm() as session:
            async with session.begin():
                res = await session.execute(delete(table).where(*conds))
            return res.rowcount or 0
