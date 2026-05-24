from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Persist next to other JSON config (osd_profiles.json sits in python_service/)
_SETTINGS_PATH = Path(__file__).resolve().parent.parent / "video_settings.json"


class VideoSource(str, Enum):
    DISABLED = "DISABLED"
    RTSP = "RTSP"
    UDP_H264 = "UDP_H264"
    UDP_H265 = "UDP_H265"
    TCP_MPEGTS = "TCP_MPEGTS"
    UDP_MPEGTS = "UDP_MPEGTS"
    MAVLINK_AUTO = "MAVLINK_AUTO"


class RecordingFormat(str, Enum):
    MP4 = "MP4"
    MKV = "MKV"
    MOV = "MOV"


class VideoFit(str, Enum):
    FIT_WIDTH = "FIT_WIDTH"
    FIT_HEIGHT = "FIT_HEIGHT"
    FILL = "FILL"
    NO_CROP = "NO_CROP"


@dataclass
class VideoSettings:
    """Mirror of QGC VideoSettings (Settings/VideoSettings.h) adapted to our stack."""

    video_source: VideoSource = VideoSource.DISABLED
    rtsp_url: str = ""
    rtsp_username: str = ""
    rtsp_password: str = ""
    rtsp_tcp_transport: bool = False
    udp_port: int = 5600
    tcp_url: str = ""
    aspect_ratio: float = 0.0  # 0 = auto-detect from stream
    video_fit: VideoFit = VideoFit.FIT_HEIGHT
    grid_lines: bool = False
    recording_format: RecordingFormat = RecordingFormat.MP4
    max_video_size_mb: int = 10240
    enable_storage_limit: bool = False
    stream_enabled: bool = True
    disable_when_disarmed: bool = False
    low_latency_mode: bool = False
    stream_timeout_s: int = 8
    frame_smoothing_enabled: bool = False

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        # enums serialise to their .value via asdict on dataclass with str enum
        d["video_source"] = self.video_source.value
        d["video_fit"] = self.video_fit.value
        d["recording_format"] = self.recording_format.value
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "VideoSettings":
        kwargs: dict[str, Any] = {}
        for f in cls.__dataclass_fields__.values():  # type: ignore[attr-defined]
            if f.name not in data:
                continue
            val = data[f.name]
            if f.name == "video_source":
                kwargs[f.name] = VideoSource(val)
            elif f.name == "video_fit":
                kwargs[f.name] = VideoFit(val)
            elif f.name == "recording_format":
                kwargs[f.name] = RecordingFormat(val)
            else:
                kwargs[f.name] = val
        return cls(**kwargs)

    def apply_patch(self, patch: dict[str, Any]) -> set[str]:
        """Apply a partial update; return the set of changed field names."""
        changed: set[str] = set()
        for key, value in patch.items():
            if key not in self.__dataclass_fields__:  # type: ignore[attr-defined]
                continue
            if key == "video_source":
                value = VideoSource(value)
            elif key == "video_fit":
                value = VideoFit(value)
            elif key == "recording_format":
                value = RecordingFormat(value)
            elif key == "udp_port":
                value = int(value)
            elif key == "max_video_size_mb":
                value = int(value)
            elif key == "stream_timeout_s":
                value = int(value)
            elif key == "aspect_ratio":
                value = float(value)
            elif isinstance(getattr(self, key), bool):
                value = bool(value)
            else:
                value = str(value)
            if getattr(self, key) != value:
                setattr(self, key, value)
                changed.add(key)
        return changed

    def stream_uri(self) -> str | None:
        """Resolve the active source to a GStreamer-compatible URI, or None if disabled."""
        if self.video_source == VideoSource.RTSP:
            return self.rtsp_url.strip() or None
        if self.video_source == VideoSource.UDP_H264:
            return f"udp://0.0.0.0:{self.udp_port}"
        if self.video_source == VideoSource.UDP_H265:
            return f"udp265://0.0.0.0:{self.udp_port}"
        if self.video_source == VideoSource.UDP_MPEGTS:
            return f"udpts://0.0.0.0:{self.udp_port}"
        if self.video_source == VideoSource.TCP_MPEGTS:
            return self.tcp_url.strip() or None
        return None


# ─── Restart-relevant field set ────────────────────────────────────────────────
# Fields whose change forces a pipeline rebuild (the rest are render-only or UI).
RESTART_FIELDS: frozenset[str] = frozenset(
    {
        "video_source",
        "rtsp_url",
        "rtsp_username",
        "rtsp_password",
        "rtsp_tcp_transport",
        "udp_port",
        "tcp_url",
        "low_latency_mode",
        "stream_enabled",
        "stream_timeout_s",
    }
)


class SettingsStore:
    """Thread-safe load/save of VideoSettings to a JSON file on disk."""

    def __init__(self, path: Path = _SETTINGS_PATH) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._settings = self._load()

    def _load(self) -> VideoSettings:
        try:
            if self._path.exists():
                with open(self._path) as f:
                    return VideoSettings.from_dict(json.load(f))
        except Exception:
            logger.exception("Failed to load video settings, using defaults")
        return VideoSettings()

    def save(self) -> None:
        with self._lock:
            try:
                tmp = self._path.with_suffix(".tmp")
                with open(tmp, "w") as f:
                    json.dump(self._settings.to_dict(), f, indent=2)
                os.replace(tmp, self._path)
            except Exception:
                logger.exception("Failed to persist video settings")

    @property
    def settings(self) -> VideoSettings:
        return self._settings

    def patch(self, patch: dict[str, Any]) -> set[str]:
        with self._lock:
            changed = self._settings.apply_patch(patch)
        if changed:
            self.save()
        return changed
