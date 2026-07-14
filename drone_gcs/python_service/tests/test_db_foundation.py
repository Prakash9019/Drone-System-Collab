"""Phase 5B — M1: DB foundation (schema, engine, Alembic baseline).

Runs entirely against SQLite (in-memory for schema tests, a temp file for the
Alembic path). No MAVLink, no network.
"""
import sys
from pathlib import Path

import pytest
from sqlalchemy import insert, select

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import load_db_settings
from db.base import create_all, create_engine_from_settings, dispose_engine, init_engine
from db.schema import ALL_TABLES, connection_allowlist, drones, metadata, organizations

EXPECTED_TABLES = {
    "organizations", "users", "org_settings", "organization_feature_flags",
    "drones", "drone_credentials", "connection_profiles", "drone_capabilities",
    "flights", "telemetry_history", "commands_audit", "alert_rules", "alerts",
    "mission_templates", "mission_instances", "mission_runs",
    "provisioning_tokens", "connection_allowlist", "recordings",
}


def test_metadata_covers_every_expected_table():
    assert set(ALL_TABLES) == EXPECTED_TABLES


def test_six_new_models_present():
    for t in ("connection_profiles", "drone_capabilities", "mission_templates",
              "mission_instances", "mission_runs", "org_settings",
              "organization_feature_flags"):
        assert t in metadata.tables, f"missing new model: {t}"


# ── settings resolution ───────────────────────────────────────────────────────

def test_defaults_are_sqlite_and_dark():
    s = load_db_settings({})
    assert s.is_sqlite and not s.is_postgres
    assert s.persistence_enabled is False        # lands dark by default
    assert s.telemetry_persist_hz == 1.0
    assert s.retention_telemetry_days == 90


def test_per_env_overrides_and_sync_url():
    s = load_db_settings({
        "DATABASE_URL": "postgresql+asyncpg://u:p@h/db",
        "FLEET_PERSISTENCE_ENABLED": "true",
        "TELEMETRY_PERSIST_HZ": "2.5",
        "RETENTION_TELEMETRY_DAYS": "30",
    })
    assert s.is_postgres and not s.is_sqlite
    assert s.persistence_enabled is True
    assert s.telemetry_persist_hz == 2.5
    assert s.retention_telemetry_days == 30
    assert s.sync_url() == "postgresql+psycopg2://u:p@h/db"


# ── schema creation on SQLite ─────────────────────────────────────────────────

@pytest.fixture
async def engine():
    settings = load_db_settings({"DATABASE_URL": "sqlite+aiosqlite:///:memory:"})
    eng = create_engine_from_settings(settings)
    await create_all(eng)
    yield eng
    await eng.dispose()


async def test_create_all_builds_every_table(engine):
    from sqlalchemy import inspect

    async with engine.connect() as conn:
        names = await conn.run_sync(lambda c: inspect(c).get_table_names())
    assert EXPECTED_TABLES.issubset(set(names))


async def test_sqlite_foreign_keys_enforced(engine):
    """PRAGMA foreign_keys=ON must be active — inserting a drone under a missing
    org must be rejected."""
    from sqlalchemy.exc import IntegrityError

    async with engine.begin() as conn:
        with pytest.raises(IntegrityError):
            await conn.execute(insert(drones).values(
                id="x", org_id="nonexistent", name="x",
                connection_string="auto", baudrate=115200, created_at=1.0,
            ))


async def test_active_profile_partial_index_exists(engine):
    from sqlalchemy import inspect

    async with engine.connect() as conn:
        idx = await conn.run_sync(
            lambda c: [i["name"] for i in inspect(c).get_indexes("connection_profiles")]
        )
    assert "ix_conn_profiles_active" in idx


# ── Alembic baseline (temp file DB) ───────────────────────────────────────────

async def test_alembic_baseline_creates_schema_and_seeds(tmp_path):
    db_file = tmp_path / "fleet.db"
    settings = load_db_settings({"DATABASE_URL": f"sqlite+aiosqlite:///{db_file}"})

    from db.migrate import current_revision_sync, run_migrations_sync

    run_migrations_sync(settings)
    assert current_revision_sync(settings) == "0001_baseline"

    eng = create_engine_from_settings(settings)
    try:
        async with eng.connect() as conn:
            orgs = (await conn.execute(select(organizations.c.id))).scalars().all()
            drone_ids = (await conn.execute(select(drones.c.id))).scalars().all()
            allow = (await conn.execute(select(connection_allowlist.c.scheme))).scalars().all()
        assert "default" in orgs
        assert "default" in drone_ids
        assert set(allow) == {"tcp", "udp", "serial"}
    finally:
        await eng.dispose()


async def test_init_engine_is_idempotent():
    settings = load_db_settings({"DATABASE_URL": "sqlite+aiosqlite:///:memory:"})
    e1 = init_engine(settings)
    e2 = init_engine(settings)
    assert e1 is e2
    await dispose_engine()
