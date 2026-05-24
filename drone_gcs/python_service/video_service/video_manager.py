"""Top-level video orchestrator (mirrors QGC `VideoManager.cc`).

Owns one GstVideoReceiver (primary stream — multi-stream/thermal deferred to
phase 2). Wires settings → restart, exposes a single API surface for the
FastAPI routes.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from .gst_video_receiver import GstUnavailableError, GstVideoReceiver
from .settings import RESTART_FIELDS, SettingsStore, VideoSettings, VideoSource

logger = logging.getLogger(__name__)


_MAX_BACKOFF_S = 60.0
_BASE_BACKOFF_S = 2.0


def _classify_error(msg: str) -> str:
    """Turn a raw GStreamer error into a human-readable diagnosis."""
    m = msg.lower()
    if "403" in m or "forbidden" in m or "unauthorized" in m or "401" in m:
        return f"Auth failed (403 Forbidden) — check RTSP username/password. [{msg}]"
    if "connection refused" in m or "failed to connect" in m or "generic error" in m:
        return f"Server unreachable — check URL and network. [{msg}]"
    if "timeout" in m or "timed out" in m:
        return f"Connection timed out — server may be offline or behind firewall. [{msg}]"
    if "404" in m or "not found" in m:
        return f"Stream not found (404) — check stream name in URL. [{msg}]"
    if "eos" in m or "ended" in m:
        return f"Stream ended — source stopped transmitting. [{msg}]"
    return msg


class VideoManager:
    def __init__(self) -> None:
        self._store = SettingsStore()
        self._receiver: GstVideoReceiver | None = None
        self._lock = asyncio.Lock()
        self._gst_error: str | None = None
        self._restart_pending: asyncio.Task | None = None
        self._fail_count: int = 0

    # ─── Properties ────────────────────────────────────────────────────────
    @property
    def settings(self) -> VideoSettings:
        return self._store.settings

    def state(self) -> dict[str, Any]:
        rx = self._receiver.state() if self._receiver else {
            "active": False,
            "encoding": None,
            "peer_count": 0,
            "last_buffer_age_s": None,
            "last_error": None,
        }
        # Prefer the classified manager-level error; fall back to raw receiver error
        error = self._gst_error or rx.get("last_error")
        return {
            **rx,
            "gst_error": error,
            "fail_count": self._fail_count,
            "settings": self._store.settings.to_dict(),
        }

    # ─── Lifecycle ─────────────────────────────────────────────────────────
    async def start(self) -> dict[str, Any]:
        """Start the pipeline using current settings. Idempotent."""
        async with self._lock:
            if self._receiver is not None:
                return self.state()
            if self._store.settings.video_source == VideoSource.DISABLED:
                return self.state()
            if not self._store.settings.stream_enabled:
                return self.state()
            uri = self._store.settings.stream_uri()
            if uri is None:
                self._gst_error = "Source has no URL/port configured"
                return self.state()
            try:
                receiver = GstVideoReceiver(self._store.settings)
                receiver.on_timeout = self._on_receiver_timeout
                await receiver.start()
                self._receiver = receiver
                self._gst_error = None
                self._fail_count = 0
            except GstUnavailableError as e:
                logger.warning("GStreamer unavailable: %s", e)
                self._gst_error = str(e)
                self._fail_count += 1
            except Exception as e:
                logger.exception("video pipeline start failed")
                self._gst_error = _classify_error(str(e))
                self._fail_count += 1
            return self.state()

    async def stop(self) -> dict[str, Any]:
        async with self._lock:
            rx = self._receiver
            self._receiver = None
        if rx:
            await rx.stop()
        return self.state()

    async def shutdown(self) -> None:
        await self.stop()

    # ─── Settings ──────────────────────────────────────────────────────────
    async def update_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        changed = self._store.patch(patch)
        needs_restart = bool(changed & RESTART_FIELDS)
        logger.info("video settings patched: changed=%s restart=%s", changed, needs_restart)
        if needs_restart:
            await self._restart()
        return self.state()

    async def _restart(self) -> None:
        await self.stop()
        await self.start()

    # ─── Peers (signaling endpoint calls these) ────────────────────────────
    async def attach_peer(self, send_to_client):  # type: ignore[no-untyped-def]
        """Auto-start the pipeline if needed, then create a peer."""
        if self._receiver is None:
            await self.start()
        if self._receiver is None:
            raise RuntimeError(self._gst_error or "video pipeline not running")
        return await self._receiver.add_peer(send_to_client)

    async def detach_peer(self, peer_id: str) -> None:
        if self._receiver is not None:
            await self._receiver.remove_peer(peer_id)

    # ─── Watchdog response ─────────────────────────────────────────────────
    async def _on_receiver_timeout(self) -> None:
        # Capture the last GST error from the receiver before it's torn down
        if self._receiver and self._receiver._last_error:
            self._gst_error = _classify_error(self._receiver._last_error)
        logger.warning("receiver watchdog fired — scheduling restart (fail_count=%d)", self._fail_count)
        if self._restart_pending and not self._restart_pending.done():
            return
        self._restart_pending = asyncio.create_task(self._delayed_restart())

    async def _delayed_restart(self) -> None:
        # Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s cap
        # fail_count is incremented by start() on each failed attempt and reset on success
        delay = min(_BASE_BACKOFF_S * (2 ** self._fail_count), _MAX_BACKOFF_S)
        logger.info("backoff restart in %.1fs (fail_count=%d)", delay, self._fail_count)
        try:
            await asyncio.sleep(delay)
            await self._restart()
        except Exception:
            logger.exception("delayed restart failed")


# ─── Process-wide singleton ────────────────────────────────────────────────────
_singleton: VideoManager | None = None


def get_video_manager() -> VideoManager:
    global _singleton
    if _singleton is None:
        _singleton = VideoManager()
    return _singleton
