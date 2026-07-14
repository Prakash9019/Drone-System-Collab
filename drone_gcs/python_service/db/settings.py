"""DB-layer configuration, resolved from the environment.

Kept separate from ``observability/config.ServiceConfig`` (which is a frozen
Phase-5A contract) so persistence config can evolve without touching the
existing fail-fast boot validation. Pure: takes an env mapping, returns a
dataclass, so it is unit-testable.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping, Optional

DEFAULT_DATABASE_URL = "sqlite+aiosqlite:///./fleet.db"


def _flag(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _float(env: Mapping[str, str], key: str, default: float) -> float:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def _int(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class DBSettings:
    database_url: str
    persistence_enabled: bool          # FLEET_PERSISTENCE_ENABLED — the dark-launch gate
    auto_migrate: bool                  # run `alembic upgrade head` at boot
    telemetry_persist_hz: float         # global default; per-org org_settings overrides it
    persist_queue_max: int              # bounded async writer queue depth
    retention_telemetry_days: int
    retention_commands_days: int
    retention_alerts_days: int
    retention_recordings_days: int
    retention_logs_days: int
    object_store_url: Optional[str]     # None → local filesystem driver

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def is_postgres(self) -> bool:
        return self.database_url.startswith("postgresql")

    def sync_url(self) -> str:
        """Sync DB URL for Alembic (which runs migrations synchronously)."""
        return (
            self.database_url
            .replace("+aiosqlite", "")
            .replace("+asyncpg", "+psycopg2")
        )


def load_db_settings(env: Optional[Mapping[str, str]] = None) -> DBSettings:
    if env is None:
        env = os.environ
    return DBSettings(
        database_url=(env.get("DATABASE_URL") or DEFAULT_DATABASE_URL).strip(),
        persistence_enabled=_flag(env, "FLEET_PERSISTENCE_ENABLED", False),
        auto_migrate=_flag(env, "DB_AUTO_MIGRATE", True),
        telemetry_persist_hz=_float(env, "TELEMETRY_PERSIST_HZ", 1.0),
        persist_queue_max=_int(env, "TELEMETRY_PERSIST_QUEUE_MAX", 10000),
        retention_telemetry_days=_int(env, "RETENTION_TELEMETRY_DAYS", 90),
        retention_commands_days=_int(env, "RETENTION_COMMANDS_DAYS", 365),
        retention_alerts_days=_int(env, "RETENTION_ALERTS_DAYS", 365),
        retention_recordings_days=_int(env, "RETENTION_RECORDINGS_DAYS", 365),
        retention_logs_days=_int(env, "RETENTION_LOGS_DAYS", 30),
        object_store_url=(env.get("OBJECT_STORE_URL") or "").strip() or None,
    )
