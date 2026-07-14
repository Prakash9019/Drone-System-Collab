"""Shared repository plumbing."""
from __future__ import annotations

from typing import Any, Dict, Optional

from sqlalchemy import Table
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


def row_to_dict(row: Optional[Row]) -> Optional[Dict[str, Any]]:
    if row is None:
        return None
    return dict(row._mapping)


class BaseRepository:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    async def _upsert(self, session: AsyncSession, table: Table, pk_col, pk_value, values: Dict[str, Any]) -> None:
        """Portable upsert (no dialect-specific ON CONFLICT): select-then-
        insert-or-update. Fine for low-write config/registry tables; the
        single SQLite writer and low registration concurrency make the race
        window non-issue."""
        from sqlalchemy import select, update

        existing = (await session.execute(select(pk_col).where(pk_col == pk_value))).first()
        if existing is None:
            await session.execute(table.insert().values(**values))
        else:
            mutable = {k: v for k, v in values.items() if k != pk_col.name}
            if mutable:
                await session.execute(update(table).where(pk_col == pk_value).values(**mutable))
