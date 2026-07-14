"""Async engine + session factory — the only place that constructs the DB
connection. Domain code never imports this; repositories do.

SQLite gets ``foreign_keys=ON`` (so the ON DELETE RESTRICT/CASCADE/SET NULL
rules in schema.py actually fire) and ``journal_mode=WAL`` (concurrent readers
alongside the single writer). PostgreSQL needs neither — MVCC + real FKs are on
by default.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from db.schema import metadata
from db.settings import DBSettings

logger = logging.getLogger(__name__)

_engine: Optional[AsyncEngine] = None
_sessionmaker: Optional[async_sessionmaker[AsyncSession]] = None


def _install_sqlite_pragmas(engine: AsyncEngine) -> None:
    @event.listens_for(engine.sync_engine, "connect")
    def _set_pragmas(dbapi_conn, _record):  # noqa: ANN001
        cur = dbapi_conn.cursor()
        try:
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA busy_timeout=5000")
        finally:
            cur.close()


def create_engine_from_settings(settings: DBSettings) -> AsyncEngine:
    """Build (but do not store) an AsyncEngine for the given settings."""
    engine = create_async_engine(settings.database_url, future=True, pool_pre_ping=True)
    if settings.is_sqlite:
        _install_sqlite_pragmas(engine)
    return engine


def init_engine(settings: DBSettings) -> AsyncEngine:
    """Initialise the process-wide engine + sessionmaker. Idempotent."""
    global _engine, _sessionmaker
    if _engine is not None:
        return _engine
    _engine = create_engine_from_settings(settings)
    _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)
    logger.info("DB engine initialised (%s)", _redact(settings.database_url))
    return _engine


def get_engine() -> AsyncEngine:
    if _engine is None:
        raise RuntimeError("DB engine not initialised — call init_engine() first")
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    if _sessionmaker is None:
        raise RuntimeError("DB sessionmaker not initialised — call init_engine() first")
    return _sessionmaker


async def create_all(engine: AsyncEngine) -> None:
    """Create every table from the Core metadata. Used by tests and by dev
    bootstrapping; production uses Alembic migrations (which create the same
    metadata)."""
    async with engine.begin() as conn:
        await conn.run_sync(metadata.create_all)


async def drop_all(engine: AsyncEngine) -> None:
    async with engine.begin() as conn:
        await conn.run_sync(metadata.drop_all)


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


def _redact(url: str) -> str:
    if "@" in url and "://" in url:
        scheme, rest = url.split("://", 1)
        if "@" in rest:
            return f"{scheme}://***@{rest.split('@', 1)[1]}"
    return url
