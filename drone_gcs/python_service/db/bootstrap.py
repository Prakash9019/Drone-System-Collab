"""One call that stands up the whole persistence layer at boot — used by
main.py's lifespan, guarded by FLEET_PERSISTENCE_ENABLED so it is a no-op (and
imports nothing heavy) when persistence is off.
"""
from __future__ import annotations

import logging

import os

from db.base import init_engine
from db.migrate import run_migrations_sync
from db.repositories import RepositoryHub, build_hub
from db.repositories.objectstore import build_object_store
from db.settings import DBSettings, load_db_settings

logger = logging.getLogger(__name__)

# Existing on-disk recordings layout — matched exactly so fs-backed rows need no
# data movement (ADR-005).
_DEFAULT_RECORDINGS_ROOT = os.path.join(os.path.dirname(os.path.dirname(__file__)), "recordings")


async def bootstrap_persistence(settings: DBSettings | None = None) -> RepositoryHub:
    """Init engine, run migrations (if DB_AUTO_MIGRATE), return a RepositoryHub.

    Migrations run synchronously; at boot the event loop is idle so the brief
    block is acceptable (Phase 5B doc §10).
    """
    settings = settings or load_db_settings()
    if settings.auto_migrate:
        run_migrations_sync(settings)
        logger.info("DB migrated to head")
    engine = init_engine(settings)
    from db.base import get_sessionmaker
    object_store = build_object_store(settings.object_store_url, default_root=_DEFAULT_RECORDINGS_ROOT)
    hub = build_hub(get_sessionmaker(), object_store=object_store)
    logger.info("Persistence layer ready")
    return hub
