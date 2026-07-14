"""Alert rules (config) + fired alert instances. 5B ships CRUD only; the rule
engine that evaluates telemetry into fired alerts is Phase 8.
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import select, update

from db.repositories.base import BaseRepository, row_to_dict
from db.schema import alert_rules, alerts


class AlertsRepo(BaseRepository):
    # ── rules ─────────────────────────────────────────────────────────────────
    async def create_rule(self, *, org_id: str, name: str, metric: str, operator: str,
                          threshold: Optional[float] = None, severity: str = "warning",
                          enabled: bool = True) -> Dict[str, Any]:
        rid = uuid.uuid4().hex
        async with self._sm() as session:
            async with session.begin():
                await session.execute(alert_rules.insert().values(
                    id=rid, org_id=org_id, name=name, metric=metric, operator=operator,
                    threshold=threshold, severity=severity, enabled=1 if enabled else 0,
                    created_at=time.time(),
                ))
        return await self.get_rule(rid)

    async def get_rule(self, rule_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(select(alert_rules).where(alert_rules.c.id == rule_id))).first()
        return row_to_dict(row)

    async def list_rules(self, org_id: str) -> List[Dict[str, Any]]:
        async with self._sm() as session:
            rows = (await session.execute(
                select(alert_rules).where(alert_rules.c.org_id == org_id)
            )).fetchall()
        return [row_to_dict(r) for r in rows]

    async def set_rule_enabled(self, rule_id: str, enabled: bool) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            async with session.begin():
                await session.execute(
                    update(alert_rules).where(alert_rules.c.id == rule_id).values(enabled=1 if enabled else 0)
                )
        return await self.get_rule(rule_id)

    async def delete_rule(self, rule_id: str) -> bool:
        async with self._sm() as session:
            async with session.begin():
                res = await session.execute(alert_rules.delete().where(alert_rules.c.id == rule_id))
            return res.rowcount > 0

    # ── fired instances (Phase 8 fills these; CRUD available now) ─────────────
    async def fire(self, *, org_id: str, severity: str, message: str,
                   alert_rule_id: Optional[str] = None, drone_id: Optional[str] = None,
                   flight_id: Optional[str] = None, context: Optional[dict] = None,
                   triggered_at: Optional[float] = None) -> Dict[str, Any]:
        async with self._sm() as session:
            async with session.begin():
                res = await session.execute(alerts.insert().values(
                    org_id=org_id, alert_rule_id=alert_rule_id, drone_id=drone_id,
                    flight_id=flight_id, severity=severity, message=message,
                    triggered_at=triggered_at if triggered_at is not None else time.time(),
                    context=context or None,
                ))
                alert_id = res.inserted_primary_key[0]
        return await self._get_alert(alert_id)

    async def clear(self, alert_id: int, *, cleared_at: Optional[float] = None) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            async with session.begin():
                await session.execute(
                    update(alerts).where(alerts.c.id == alert_id)
                    .values(cleared_at=cleared_at if cleared_at is not None else time.time())
                )
        return await self._get_alert(alert_id)

    async def list_active(self, org_id: str) -> List[Dict[str, Any]]:
        async with self._sm() as session:
            rows = (await session.execute(
                select(alerts).where(alerts.c.org_id == org_id, alerts.c.cleared_at.is_(None))
                .order_by(alerts.c.triggered_at.desc())
            )).fetchall()
        return [row_to_dict(r) for r in rows]

    async def _get_alert(self, alert_id: int) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(select(alerts).where(alerts.c.id == alert_id))).first()
        return row_to_dict(row)
