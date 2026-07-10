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
