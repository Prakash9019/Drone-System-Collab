"""Per-drone session.

Bundles what used to be process-global singletons in main.py — LinkManager,
MissionManager, ParameterSyncManager, PreflightManager, optional CameraManager,
and calibration progress state — so N drones can run isolated in one process.

Isolation guarantee: every manager here holds a reference to THIS session's
LinkManager only. A disconnect, reconnect storm, or exception in one session
cannot touch another session's link or state.
"""
from __future__ import annotations

import time
import uuid
import logging
from typing import Any, Callable, Dict, Optional

from mavlink_link import LinkManager
from mission_manager import MissionManager
from parameter_manager import ParameterSyncManager
from preflight_manager import PreflightManager
from vehicle_state import ConnectionState

logger = logging.getLogger(__name__)

# Accel cal positions: 0=none, 1=Level, 2=Left, 3=Right, 4=NoseDown, 5=NoseUp, 6=Back


class DroneSession:
    def __init__(
        self,
        *,
        drone_id: Optional[str] = None,
        name: Optional[str] = None,
        connection_string: str = "auto",
        baudrate: int = 115200,
        udp_forwarding_endpoints: Optional[list] = None,
        metadata: Optional[Dict[str, Any]] = None,
        camera_manager_factory: Optional[Callable[[LinkManager], Any]] = None,
    ) -> None:
        self.drone_id = drone_id or uuid.uuid4().hex[:12]
        self.name = name or self.drone_id
        self.metadata: Dict[str, Any] = dict(metadata or {})
        self.created_at = time.time()

        self.link_manager = LinkManager(
            connection_string=connection_string,
            baudrate=baudrate,
            udp_forwarding_endpoints=list(udp_forwarding_endpoints or []),
        )
        self.mission_manager = MissionManager(self.link_manager)
        self.link_manager.mission_manager = self.mission_manager
        self.parameter_manager = ParameterSyncManager(self.link_manager)
        self.link_manager.parameter_manager = self.parameter_manager
        self.preflight_manager = PreflightManager()

        # Video/camera wiring is optional: the video subsystem is still a
        # process-wide singleton (converted to a per-stream registry in Phase 6),
        # so only one session may own a CameraManager for now.
        self.camera_manager = None
        if camera_manager_factory is not None:
            self.camera_manager = camera_manager_factory(self.link_manager)
            self.link_manager.camera_manager = self.camera_manager

        # Calibration progress — was module-global in main.py, now per-drone so
        # two vehicles can calibrate concurrently.
        self.mag_cal_data: Dict[int, Dict[str, Any]] = {}
        self.accel_cal_pos: int = 0
        self.link_manager._mag_cal_cb = self._on_mag_cal
        self.link_manager._accel_cal_pos_cb = self._on_accel_cal_pos

    # ── calibration callbacks (moved verbatim from main.py) ────────────────
    def _on_mag_cal(self, mtype: str, msg) -> None:
        cid = int(getattr(msg, "compass_id", 0))
        if mtype == "MAG_CAL_PROGRESS":
            self.mag_cal_data[cid] = {
                "type": "progress",
                "pct": float(getattr(msg, "completion_pct", 0)),
                "cal_status": int(getattr(msg, "cal_status", 0)),
                "ts": time.time(),
            }
        elif mtype == "MAG_CAL_REPORT":
            self.mag_cal_data[cid] = {
                "type": "report",
                "cal_status": int(getattr(msg, "cal_status", 0)),
                "fitness": float(getattr(msg, "fitness", 0.0)),
                "ofs_x": float(getattr(msg, "ofs_x", 0)),
                "ofs_y": float(getattr(msg, "ofs_y", 0)),
                "ofs_z": float(getattr(msg, "ofs_z", 0)),
                "autosaved": int(getattr(msg, "autosaved", 0)),
                "ts": time.time(),
            }

    def _on_accel_cal_pos(self, pos: int) -> None:
        self.accel_cal_pos = pos

    # ── lifecycle ───────────────────────────────────────────────────────────
    async def connect(self, connection_string: Optional[str] = None, baudrate: Optional[int] = None) -> bool:
        lm = self.link_manager
        if connection_string:
            lm.original_connection_string = connection_string
            lm.connection_string = connection_string
        if baudrate:
            lm.baudrate = baudrate
        ok = await lm.connect()
        if ok:
            self.parameter_manager.load_cache()
        return ok

    async def disconnect(self) -> None:
        await self.link_manager.close()

    async def close(self) -> None:
        """Full teardown — used when the drone is deregistered."""
        try:
            await self.link_manager.close()
        except Exception:
            logger.exception("session %s: link close failed", self.drone_id)

    # ── health / status ──────────────────────────────────────────────────────
    @property
    def connection_state(self) -> ConnectionState:
        return self.link_manager.connection_state

    @property
    def online(self) -> bool:
        return self.link_manager.connection_state in (ConnectionState.CONNECTED, ConnectionState.ACTIVE)

    @property
    def last_seen(self) -> float:
        return max(self.link_manager.last_message_time, self.link_manager.last_heartbeat_time)

    def to_summary(self) -> Dict[str, Any]:
        lm = self.link_manager
        return {
            "drone_id": self.drone_id,
            "name": self.name,
            "metadata": self.metadata,
            "created_at": self.created_at,
            "connection_string": lm.connection_string,
            "baudrate": lm.baudrate,
            "connection_state": lm.connection_state.value,
            "online": self.online,
            "last_seen": self.last_seen,
            "last_heartbeat": lm.last_heartbeat_time,
            "primary_sysid": lm.primary_sysid,
            "vehicles": lm.list_vehicles_payload(),
            "mission_transfer": self.mission_manager.transfer_status,
            "param_sync": self.parameter_manager.to_status(),
            "has_camera": self.camera_manager is not None,
        }
