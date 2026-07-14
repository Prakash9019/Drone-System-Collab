"""SessionRegistry — owns every DroneSession in this worker process.

The "default" session preserves single-drone backward compatibility: main.py's
legacy (unscoped) routes resolve to it, so the existing GCS keeps working
exactly as before while fleet routes address sessions by drone_id.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Dict, List, Optional

from fleet.drone_session import DroneSession

logger = logging.getLogger(__name__)

DEFAULT_DRONE_ID = "default"


class SessionRegistry:
    def __init__(self) -> None:
        self._sessions: Dict[str, DroneSession] = {}
        self._lock = asyncio.Lock()

    # ── CRUD ────────────────────────────────────────────────────────────────
    def create(
        self,
        *,
        drone_id: Optional[str] = None,
        name: Optional[str] = None,
        connection_string: str = "auto",
        baudrate: int = 115200,
        udp_forwarding_endpoints: Optional[list] = None,
        metadata: Optional[Dict[str, Any]] = None,
        camera_manager_factory: Optional[Callable] = None,
    ) -> DroneSession:
        if drone_id and drone_id in self._sessions:
            raise ValueError(f"drone_id already registered: {drone_id}")
        session = DroneSession(
            drone_id=drone_id,
            name=name,
            connection_string=connection_string,
            baudrate=baudrate,
            udp_forwarding_endpoints=udp_forwarding_endpoints,
            metadata=metadata,
            camera_manager_factory=camera_manager_factory,
        )
        if session.drone_id in self._sessions:
            raise ValueError(f"drone_id already registered: {session.drone_id}")
        self._sessions[session.drone_id] = session
        logger.info("Registered drone session %s (%s → %s)", session.drone_id, session.name, connection_string)
        return session

    def get(self, drone_id: str) -> Optional[DroneSession]:
        return self._sessions.get(drone_id)

    def require(self, drone_id: str) -> DroneSession:
        session = self._sessions.get(drone_id)
        if session is None:
            raise KeyError(drone_id)
        return session

    async def remove(self, drone_id: str) -> bool:
        if drone_id == DEFAULT_DRONE_ID:
            raise ValueError("The default session cannot be removed")
        async with self._lock:
            session = self._sessions.pop(drone_id, None)
        if session is None:
            return False
        await session.close()
        logger.info("Removed drone session %s", drone_id)
        return True

    # ── persistence / rehydration (Phase 5B, ADR-001) ────────────────────────
    async def load_from_db(self, drones_repo, *, org_id: Optional[str] = None) -> int:
        """Rehydrate the registry from the drones table at boot — the F1 fix.

        Recreates a DroneSession (RAM identity) for every non-archived drone
        that isn't already present. Does NOT auto-connect here — reconnecting
        auto_connect drones is the caller's staggered concern, so rehydration
        stays fast and side-effect-free (no transport opened). Returns the
        number of sessions rehydrated.
        """
        rows = await drones_repo.list_for_rehydrate(org_id=org_id)
        rehydrated = 0
        for row in rows:
            drone_id = row["id"]
            if drone_id in self._sessions:
                continue  # e.g. the default session, already seeded at boot
            try:
                self.create(
                    drone_id=drone_id,
                    name=row.get("name"),
                    connection_string=row.get("connection_string") or "auto",
                    baudrate=row.get("baudrate") or 115200,
                    udp_forwarding_endpoints=row.get("udp_forwarding") or None,
                    metadata=row.get("metadata_json") or None,
                )
                rehydrated += 1
            except ValueError:
                logger.warning("rehydrate: drone_id %s already present, skipping", drone_id)
        logger.info("Rehydrated %d drone session(s) from DB", rehydrated)
        return rehydrated

    def auto_connect_ids(self, drones_rows: List[Dict[str, Any]]) -> List[str]:
        """drone_ids flagged auto_connect=1 — the caller reconnects these with
        its own staggering/backoff (reusing the per-session reconnect proven at
        10 drones)."""
        return [r["id"] for r in drones_rows if r.get("auto_connect")]

    # ── views ────────────────────────────────────────────────────────────────
    @property
    def default(self) -> Optional[DroneSession]:
        return self._sessions.get(DEFAULT_DRONE_ID)

    def all(self) -> List[DroneSession]:
        return list(self._sessions.values())

    def ids(self) -> List[str]:
        return list(self._sessions.keys())

    def fleet_summary(self) -> Dict[str, Any]:
        sessions = self.all()
        return {
            "count": len(sessions),
            "online": sum(1 for s in sessions if s.online),
            "drones": [s.to_summary() for s in sessions],
        }

    # ── lifecycle ────────────────────────────────────────────────────────────
    async def close_all(self) -> None:
        for session in self.all():
            try:
                await session.close()
            except Exception:
                logger.exception("close_all: session %s failed to close", session.drone_id)
        self._sessions.clear()
