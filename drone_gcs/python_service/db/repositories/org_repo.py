"""Organizations, per-org settings (telemetry persist rate + retention windows,
improvements 4 & 5), and feature flags (improvement 6). A NULL setting column
means "fall back to the env/global default".
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import select, update

from db.repositories.base import BaseRepository, row_to_dict
from db.schema import org_settings, organization_feature_flags, organizations

RETENTION_KEYS = (
    "retention_telemetry_days", "retention_alerts_days", "retention_commands_days",
    "retention_recordings_days", "retention_logs_days",
)


class OrgRepo(BaseRepository):
    # ── organizations ─────────────────────────────────────────────────────────
    async def create_org(self, *, org_id: Optional[str] = None, name: str, slug: str,
                         metadata: Optional[dict] = None) -> Dict[str, Any]:
        oid = org_id or uuid.uuid4().hex
        async with self._sm() as session:
            async with session.begin():
                await session.execute(organizations.insert().values(
                    id=oid, name=name, slug=slug, created_at=time.time(),
                    metadata_json=metadata or None,
                ))
        return await self.get_org(oid)

    async def get_org(self, org_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(select(organizations).where(organizations.c.id == org_id))).first()
        return row_to_dict(row)

    async def list_orgs(self) -> List[Dict[str, Any]]:
        async with self._sm() as session:
            rows = (await session.execute(select(organizations))).fetchall()
        return [row_to_dict(r) for r in rows]

    # ── settings (improvements 4 & 5) ─────────────────────────────────────────
    async def get_settings(self, org_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(
                select(org_settings).where(org_settings.c.org_id == org_id)
            )).first()
        return row_to_dict(row)

    async def upsert_settings(self, org_id: str, **values: Any) -> Dict[str, Any]:
        allowed = {"telemetry_persist_hz", *RETENTION_KEYS}
        payload = {k: v for k, v in values.items() if k in allowed}
        payload["updated_at"] = time.time()
        async with self._sm() as session:
            async with session.begin():
                exists = (await session.execute(
                    select(org_settings.c.org_id).where(org_settings.c.org_id == org_id)
                )).first()
                if exists is None:
                    await session.execute(org_settings.insert().values(org_id=org_id, **payload))
                else:
                    await session.execute(
                        update(org_settings).where(org_settings.c.org_id == org_id).values(**payload)
                    )
        return await self.get_settings(org_id)

    # ── feature flags (improvement 6) ─────────────────────────────────────────
    async def set_flag(self, *, org_id: str, flag: str, enabled: bool,
                       value: Optional[dict] = None) -> Dict[str, Any]:
        async with self._sm() as session:
            async with session.begin():
                existing = (await session.execute(
                    select(organization_feature_flags.c.id).where(
                        organization_feature_flags.c.org_id == org_id,
                        organization_feature_flags.c.flag == flag,
                    )
                )).first()
                vals = {"enabled": 1 if enabled else 0, "value": value or None, "updated_at": time.time()}
                if existing is None:
                    await session.execute(organization_feature_flags.insert().values(
                        id=uuid.uuid4().hex, org_id=org_id, flag=flag, **vals,
                    ))
                else:
                    await session.execute(
                        update(organization_feature_flags)
                        .where(organization_feature_flags.c.id == existing[0]).values(**vals)
                    )
        return await self.get_flag(org_id=org_id, flag=flag)

    async def get_flag(self, *, org_id: str, flag: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(
                select(organization_feature_flags).where(
                    organization_feature_flags.c.org_id == org_id,
                    organization_feature_flags.c.flag == flag,
                )
            )).first()
        return row_to_dict(row)

    async def list_flags(self, org_id: str) -> List[Dict[str, Any]]:
        async with self._sm() as session:
            rows = (await session.execute(
                select(organization_feature_flags).where(organization_feature_flags.c.org_id == org_id)
            )).fetchall()
        return [row_to_dict(r) for r in rows]
