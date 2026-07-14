"""Programmatic Alembic runner so the app can migrate at boot (guarded by
DB_AUTO_MIGRATE). Recommended default true for SQLite/dev; for Postgres/prod,
set DB_AUTO_MIGRATE=false and run `alembic upgrade head` as an explicit deploy
step (Phase 5B doc §10).
"""
from __future__ import annotations

import logging
import os

from alembic import command
from alembic.config import Config

from db.settings import DBSettings

logger = logging.getLogger(__name__)

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE_ROOT = os.path.dirname(_HERE)
_ALEMBIC_INI = os.path.join(_SERVICE_ROOT, "alembic.ini")


def _config(settings: DBSettings) -> Config:
    cfg = Config(_ALEMBIC_INI)
    cfg.set_main_option("script_location", os.path.join(_SERVICE_ROOT, "db", "migrations"))
    cfg.set_main_option("sqlalchemy.url", settings.sync_url())
    return cfg


def run_migrations_sync(settings: DBSettings) -> None:
    """Upgrade the database to head. Synchronous — call before the event loop
    is under load (e.g. at lifespan startup) or via a thread executor."""
    logger.info("Running DB migrations to head")
    command.upgrade(_config(settings), "head")


def current_revision_sync(settings: DBSettings) -> str | None:
    from alembic.runtime.migration import MigrationContext
    from sqlalchemy import create_engine

    engine = create_engine(settings.sync_url())
    try:
        with engine.connect() as conn:
            return MigrationContext.configure(conn).get_current_revision()
    finally:
        engine.dispose()
