"""Provisioning tokens (§13.11) — a drone/edge-agent redeems a single-use,
expiring, org-scoped token to mint its identity, replacing trust-on-first-use
drone_ids. 5B ships mint/redeem; the token is stored hashed, never in the clear.
"""
from __future__ import annotations

import hashlib
import secrets
import time
import uuid
from typing import Any, Dict, Optional, Tuple

from sqlalchemy import select, update

from db.repositories.base import BaseRepository, row_to_dict
from db.schema import provisioning_tokens


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class ProvisioningRepo(BaseRepository):
    async def mint(self, *, org_id: str, ttl_s: Optional[float] = None) -> Tuple[str, Dict[str, Any]]:
        """Create a token. Returns (clear_token, row). The clear token is shown
        once to the caller and never stored."""
        clear = secrets.token_urlsafe(32)
        now = time.time()
        row_id = uuid.uuid4().hex
        async with self._sm() as session:
            async with session.begin():
                await session.execute(provisioning_tokens.insert().values(
                    id=row_id, org_id=org_id, token_hash=_hash(clear),
                    expires_at=(now + ttl_s) if ttl_s else None, created_at=now,
                ))
        row = await self._get(row_id)
        return clear, row

    async def redeem(self, clear_token: str, *, created_drone_id: str,
                     now: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """Consume a valid, unexpired, unused token. Returns the row on success,
        None if the token is unknown / expired / already used."""
        now = now if now is not None else time.time()
        th = _hash(clear_token)
        async with self._sm() as session:
            async with session.begin():
                row = (await session.execute(
                    select(provisioning_tokens).where(provisioning_tokens.c.token_hash == th)
                )).first()
                if row is None:
                    return None
                data = dict(row._mapping)
                if data["used_at"] is not None:
                    return None
                if data["expires_at"] is not None and now > data["expires_at"]:
                    return None
                await session.execute(
                    update(provisioning_tokens).where(provisioning_tokens.c.id == data["id"])
                    .values(used_at=now, created_drone_id=created_drone_id)
                )
        return await self._get(data["id"])

    async def _get(self, token_id: str) -> Optional[Dict[str, Any]]:
        async with self._sm() as session:
            row = (await session.execute(
                select(provisioning_tokens).where(provisioning_tokens.c.id == token_id)
            )).first()
        return row_to_dict(row)
