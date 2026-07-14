"""Resolves per-org policy (telemetry persist Hz + retention windows) with a
short TTL cache, falling back to env/global defaults when an org sets no
override. This is the mechanism that makes persistence frequency and retention
per-organization instead of hardcoded (improvements 4 & 5).
"""
from __future__ import annotations

import time
from typing import Dict, Optional, Tuple

from db.settings import DBSettings


class OrgSettingsResolver:
    def __init__(self, org_repo, db_settings: DBSettings, *, ttl_s: float = 30.0) -> None:
        self._repo = org_repo
        self._ttl = ttl_s
        self._cache: Dict[str, Tuple[float, Optional[dict]]] = {}
        self._default_hz = db_settings.telemetry_persist_hz
        self._default_retention = {
            "retention_telemetry_days": db_settings.retention_telemetry_days,
            "retention_alerts_days": db_settings.retention_alerts_days,
            "retention_commands_days": db_settings.retention_commands_days,
            "retention_recordings_days": db_settings.retention_recordings_days,
            "retention_logs_days": db_settings.retention_logs_days,
        }

    def invalidate(self, org_id: Optional[str] = None) -> None:
        if org_id is None:
            self._cache.clear()
        else:
            self._cache.pop(org_id, None)

    async def _settings(self, org_id: str) -> Optional[dict]:
        now = time.time()
        cached = self._cache.get(org_id)
        if cached and now - cached[0] < self._ttl:
            return cached[1]
        row = await self._repo.get_settings(org_id)
        self._cache[org_id] = (now, row)
        return row

    async def persist_hz(self, org_id: str) -> float:
        row = await self._settings(org_id)
        if row and row.get("telemetry_persist_hz"):
            return float(row["telemetry_persist_hz"])
        return self._default_hz

    async def retention_days(self, org_id: str, key: str) -> int:
        row = await self._settings(org_id)
        if row and row.get(key) is not None:
            return int(row[key])
        return int(self._default_retention[key])
