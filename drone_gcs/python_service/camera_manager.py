"""MAVLink camera discovery (mirrors QGC `QGCCameraManager.cc` + `VehicleCameraControl.cc`).

Listens for HEARTBEAT from camera-component IDs, requests CAMERA_INFORMATION, then
VIDEO_STREAM_INFORMATION per stream, and feeds discovered stream URIs into
`VideoManager.update_settings()` — the auto-configure path QGC calls
`VideoManager::_updateAutoStream`.

Audit fixes applied here (see VIDEO_SUBSYSTEM_PLAN_AUDIT.md):
  - gap #14: alternates `MAV_CMD_REQUEST_MESSAGE(CAMERA_INFORMATION)` with the legacy
    `MAV_CMD_REQUEST_CAMERA_INFORMATION` command by retry parity
    (QGCCameraManager.cc:534-604) — some firmware (older ArduPilot/PX4) only
    implements one of the two, so a request-once approach silently never gets a
    response from those vehicles.
  - gap #3: stream IDs are 1-based and the stream count is fully dynamic, taken from
    the `VIDEO_STREAM_INFORMATION.count` field (VehicleCameraControl.cc:1989-1991,
    ":1686") — not a hardcoded "stream_id 0..4" range as the original plan assumed.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from pymavlink import mavutil

logger = logging.getLogger(__name__)

# Stable, dialect-independent MAVLink common.xml message IDs (MAVLink Camera
# Protocol v2). `mavutil.mavlink` may be bound to an older dialect module that
# predates these messages as named Python constants even though the wire format
# (and `msg.get_type()` string dispatch used below) works fine once an actual
# MAVLink2 CAMERA_INFORMATION/VIDEO_STREAM_INFORMATION packet is received.
_MSG_ID_CAMERA_INFORMATION = 259
_MSG_ID_VIDEO_STREAM_INFORMATION = 269

_VIDEO_STREAM_ENCODING_H264 = 1
_VIDEO_STREAM_ENCODING_H265 = 2

_CAMERA_COMPIDS = range(
    mavutil.mavlink.MAV_COMP_ID_CAMERA, mavutil.mavlink.MAV_COMP_ID_CAMERA6 + 1
)

_BASE_RETRY_INTERVAL_S = 1.0
_MAX_RETRIES = 6


@dataclass
class CameraInfo:
    sysid: int
    compid: int
    vendor_name: str = ""
    model_name: str = ""
    firmware_version: int = 0
    resolution_h: int = 0
    resolution_v: int = 0
    flags: int = 0
    have_camera_info: bool = False
    expected_stream_count: int = 1
    streams: dict[int, dict[str, Any]] = field(default_factory=dict)
    retry_count: int = 0
    last_request_ts: float = 0.0
    discovered_ts: float = field(default_factory=time.monotonic)

    def to_dict(self) -> dict[str, Any]:
        return {
            "sysid": self.sysid,
            "compid": self.compid,
            "vendor_name": self.vendor_name,
            "model_name": self.model_name,
            "have_camera_info": self.have_camera_info,
            "resolution_h": self.resolution_h,
            "resolution_v": self.resolution_v,
            "stream_count": len(self.streams),
            "expected_stream_count": self.expected_stream_count,
            "streams": [
                {"stream_id": sid, **info} for sid, info in sorted(self.streams.items())
            ],
        }


class CameraManager:
    """Discovers MAVLink cameras and their video streams; auto-configures VideoManager."""

    def __init__(self, link_manager: Any, video_manager: Any) -> None:
        self.lm = link_manager
        self.vm = video_manager
        self._cameras: dict[tuple[int, int], CameraInfo] = {}
        self._retry_task: asyncio.Task | None = None
        self._active_key: tuple[int, int] | None = None

    # ─── Public API (for FastAPI routes) ───────────────────────────────────
    def list_cameras(self) -> list[dict[str, Any]]:
        return [c.to_dict() for c in self._cameras.values()]

    async def select_stream(self, sysid: int, compid: int, stream_id: int) -> bool:
        cam = self._cameras.get((sysid, compid))
        if not cam or stream_id not in cam.streams:
            return False
        self._active_key = (sysid, compid)
        await self._apply_stream(cam.streams[stream_id])
        return True

    # ─── Message dispatch (called from LinkManager.read_loop) ─────────────
    def handle_message(self, msg: Any) -> None:
        mtype = msg.get_type()
        sysid = msg.get_srcSystem()
        compid = msg.get_srcComponent()

        if mtype == "HEARTBEAT":
            if compid in _CAMERA_COMPIDS:
                self._on_camera_heartbeat(sysid, compid)
            return
        if mtype == "CAMERA_INFORMATION":
            self._on_camera_information(sysid, compid, msg)
            return
        if mtype == "VIDEO_STREAM_INFORMATION":
            self._on_video_stream_information(sysid, compid, msg)
            return

    def _on_camera_heartbeat(self, sysid: int, compid: int) -> None:
        key = (sysid, compid)
        if key in self._cameras:
            return
        self._cameras[key] = CameraInfo(sysid=sysid, compid=compid)
        logger.info("camera discovered: sysid=%d compid=%d", sysid, compid)
        self._ensure_retry_task()

    def _on_camera_information(self, sysid: int, compid: int, msg: Any) -> None:
        key = (sysid, compid)
        cam = self._cameras.get(key)
        if cam is None:
            cam = CameraInfo(sysid=sysid, compid=compid)
            self._cameras[key] = cam
        cam.have_camera_info = True
        cam.retry_count = 0
        cam.vendor_name = _decode_bytes(getattr(msg, "vendor_name", b""))
        cam.model_name = _decode_bytes(getattr(msg, "model_name", b""))
        cam.firmware_version = int(getattr(msg, "firmware_version", 0))
        cam.resolution_h = int(getattr(msg, "resolution_h", 0))
        cam.resolution_v = int(getattr(msg, "resolution_v", 0))
        cam.flags = int(getattr(msg, "flags", 0))
        logger.info(
            "CAMERA_INFORMATION: %s %s (sysid=%d compid=%d)",
            cam.vendor_name, cam.model_name, sysid, compid,
        )
        # QGC requests VIDEO_STREAM_INFORMATION once CAMERA_INFORMATION arrives
        # (QGCCameraManager.cc:309-346).
        self._request_video_stream_info(cam, stream_id=1)

    def _on_video_stream_information(self, sysid: int, compid: int, msg: Any) -> None:
        cam = self._cameras.get((sysid, compid))
        if cam is None:
            return
        stream_id = int(getattr(msg, "stream_id", 0))
        if stream_id <= 0:
            return
        cam.expected_stream_count = max(1, int(getattr(msg, "count", 1)))
        uri = _decode_bytes(getattr(msg, "uri", b""))
        cam.streams[stream_id] = {
            "type": int(getattr(msg, "type", 0)),
            "encoding": int(getattr(msg, "encoding", 0)),
            "uri": uri,
            "framerate": float(getattr(msg, "framerate", 0.0)),
            "bitrate": int(getattr(msg, "bitrate", 0)),
            "resolution_h": int(getattr(msg, "resolution_h", 0)),
            "resolution_v": int(getattr(msg, "resolution_v", 0)),
            "flags": int(getattr(msg, "flags", 0)),
            "name": _decode_bytes(getattr(msg, "name", b"")),
        }
        logger.info(
            "VIDEO_STREAM_INFORMATION: stream_id=%d/%d uri=%s (sysid=%d compid=%d)",
            stream_id, cam.expected_stream_count, uri, sysid, compid,
        )

        # Audit fix (gap #3): dynamic 1-based enumeration, not a hardcoded 0..4 range.
        if len(cam.streams) < cam.expected_stream_count:
            self._request_video_stream_info(cam, stream_id=len(cam.streams) + 1)
            return

        # All streams discovered — auto-select the first stream, matching QGC's
        # streamChanged -> VideoManager._updateAutoStream flow.
        if self._active_key is None or self._active_key == (sysid, compid):
            self._active_key = (sysid, compid)
            first = cam.streams.get(1) or next(iter(cam.streams.values()))
            asyncio.create_task(self._apply_stream(first))

    # ─── Requesting CAMERA_INFORMATION (retry loop) ────────────────────────
    def _ensure_retry_task(self) -> None:
        if self._retry_task is None or self._retry_task.done():
            self._retry_task = asyncio.create_task(self._retry_loop())

    async def _retry_loop(self) -> None:
        try:
            while True:
                pending = [
                    c for c in self._cameras.values()
                    if not c.have_camera_info and c.retry_count < _MAX_RETRIES
                ]
                if not pending:
                    return
                for cam in pending:
                    self._request_camera_information(cam)
                    cam.retry_count += 1
                    cam.last_request_ts = time.monotonic()
                # Exponential backoff from the 2nd retry onward, matching QGC's
                # _handleCameraInfoRetry (QGCCameraManager.cc:559-604).
                worst = max(c.retry_count for c in pending)
                delay = (
                    min(_BASE_RETRY_INTERVAL_S * (2 ** min(worst - 1, 4)), 30.0)
                    if worst >= 2
                    else _BASE_RETRY_INTERVAL_S
                )
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            raise

    def _request_camera_information(self, cam: CameraInfo) -> None:
        if not self.lm.conn:
            return
        # Audit fix (gap #14): alternate request mechanism by retry parity.
        if cam.retry_count % 2 == 0:
            self.lm.conn.mav.command_long_send(
                cam.sysid, cam.compid,
                mavutil.mavlink.MAV_CMD_REQUEST_MESSAGE,
                cam.retry_count,
                _MSG_ID_CAMERA_INFORMATION, 0, 0, 0, 0, 0, 0,
            )
        else:
            self.lm.conn.mav.command_long_send(
                cam.sysid, cam.compid,
                mavutil.mavlink.MAV_CMD_REQUEST_CAMERA_INFORMATION,
                cam.retry_count,
                1, 0, 0, 0, 0, 0, 0,
            )

    def _request_video_stream_info(self, cam: CameraInfo, stream_id: int) -> None:
        if not self.lm.conn:
            return
        self.lm.conn.mav.command_long_send(
            cam.sysid, cam.compid,
            mavutil.mavlink.MAV_CMD_REQUEST_MESSAGE,
            0,
            _MSG_ID_VIDEO_STREAM_INFORMATION, float(stream_id), 0, 0, 0, 0, 0,
        )

    # ─── Auto-configure VideoManager (mirrors VideoManager::_updateAutoStream) ────
    async def _apply_stream(self, stream: dict[str, Any]) -> None:
        m = mavutil.mavlink
        stype = stream["type"]
        encoding = stream["encoding"]
        uri = stream["uri"]
        patch: dict[str, Any] = {}

        if stype == m.VIDEO_STREAM_TYPE_RTSP:
            patch = {"video_source": "RTSP", "rtsp_url": uri}
        elif stype == m.VIDEO_STREAM_TYPE_TCP_MPEG:
            patch = {"video_source": "TCP_MPEGTS", "tcp_url": uri if "://" in uri else f"tcp://{uri}"}
        elif stype == m.VIDEO_STREAM_TYPE_RTPUDP:
            port = _extract_port(uri, default=5600)
            if encoding == _VIDEO_STREAM_ENCODING_H265:
                patch = {"video_source": "UDP_H265", "udp_port": port}
            else:
                patch = {"video_source": "UDP_H264", "udp_port": port}
        elif stype == m.VIDEO_STREAM_TYPE_MPEG_TS_H264:
            port = _extract_port(uri, default=5600)
            patch = {"video_source": "UDP_MPEGTS", "udp_port": port}
        else:
            logger.warning("unsupported VIDEO_STREAM_TYPE %s", stype)
            return

        logger.info("auto-stream configured: %s", patch)
        await self.vm.update_settings(patch)


def _decode_bytes(val: Any) -> str:
    if isinstance(val, bytes):
        return val.split(b"\x00", 1)[0].decode("utf-8", errors="replace")
    if isinstance(val, (list, tuple)):
        return _decode_bytes(bytes(bytearray(b for b in val if isinstance(b, int))))
    return str(val or "")


def _extract_port(uri: str, default: int) -> int:
    if not uri:
        return default
    try:
        if "://" in uri:
            uri = uri.split("://", 1)[1]
        if ":" in uri:
            return int(uri.rsplit(":", 1)[1])
    except (ValueError, IndexError):
        pass
    return default
