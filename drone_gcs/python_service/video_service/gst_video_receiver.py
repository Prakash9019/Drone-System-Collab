"""GStreamer-backed video receiver (mirrors QGC GstVideoReceiver.cc).

Topology:

    source_bin ─→ tee ─┬─→ (one queue+webrtcbin per WebRTC peer)
                       ├─→ (one queue+appsink per WebCodecs/raw-NAL peer)
                       └─→ (queue+valve+mux+filesink — recorder.py, built on demand)

Each receiver has:
- one Gst.Pipeline
- one main bus listener thread (GLib main loop)
- one asyncio watchdog
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from .pipeline_factory import build_source_bin
from .raw_ws_sender import RawWsSender
from .recorder import Recorder
from .settings import VideoSettings
from .subtitle_writer import SubtitleWriter
from .webrtc_sender import WebRTCPeer

logger = logging.getLogger(__name__)

# python_service/recordings/ already exists and is used by other subsystems for
# saved artifacts — reuse it rather than inventing a new convention.
_DEFAULT_RECORDINGS_DIR = Path(__file__).resolve().parent.parent / "recordings"


class GstUnavailableError(RuntimeError):
    """Raised when gi/Gst aren't importable on this host."""


def _import_gst() -> tuple[Any, Any, Any, Any]:
    """Lazy import so the GCS doesn't crash on hosts without GStreamer."""
    try:
        import gi  # type: ignore

        gi.require_version("Gst", "1.0")
        gi.require_version("GstWebRTC", "1.0")
        gi.require_version("GstSdp", "1.0")
        from gi.repository import GLib, Gst, GstSdp, GstWebRTC  # type: ignore
    except (ImportError, ValueError) as e:
        raise GstUnavailableError(f"GStreamer Python bindings not available: {e}") from e
    return Gst, GstWebRTC, GstSdp, GLib


_GST_INITIALIZED = False


def _ensure_gst_init() -> tuple[Any, Any, Any, Any]:
    """Initialize GStreamer exactly once per process."""
    global _GST_INITIALIZED
    Gst, GstWebRTC, GstSdp, GLib = _import_gst()
    if not _GST_INITIALIZED:
        Gst.init(None)
        # Verify webrtcbin availability now — fail loudly here, not mid-stream.
        wrtc = Gst.ElementFactory.find("webrtcbin")
        if wrtc is None:
            raise GstUnavailableError(
                "GStreamer plugin 'webrtcbin' missing. Install gst-plugins-bad with webrtc."
            )
        _GST_INITIALIZED = True
        logger.info("GStreamer initialized: %s", Gst.version_string())
    return Gst, GstWebRTC, GstSdp, GLib


class GstVideoReceiver:
    """One running pipeline serving 0..N WebRTC peers from a single source.

    Lifecycle:
        await start()      → build + PLAY pipeline; raises on failure
        await add_peer(...)→ register a browser
        await stop()       → tear down everything
    """

    def __init__(
        self,
        settings: VideoSettings,
        get_telemetry: Callable[[], dict[str, Any] | None] | None = None,
        recordings_dir: Path = _DEFAULT_RECORDINGS_DIR,
    ) -> None:
        self._settings = settings
        self._get_telemetry = get_telemetry or (lambda: None)
        self._recordings_dir = recordings_dir
        self._Gst, self._GstWebRTC, self._GstSdp, self._GLib = _ensure_gst_init()

        self._pipeline: Any | None = None
        self._tee: Any | None = None
        self._source_bin: Any | None = None
        self._encoding: str = "H264"
        self._bus_thread: threading.Thread | None = None
        self._glib_loop: Any | None = None

        self._peers: dict[str, WebRTCPeer] = {}
        self._peers_lock = asyncio.Lock()

        self._raw_peers: dict[str, RawWsSender] = {}
        self._raw_peers_lock = asyncio.Lock()

        self._recorder: Recorder | None = None
        self._subtitle_writer: SubtitleWriter = SubtitleWriter(self._get_telemetry)

        self._last_buffer_ts: float = 0.0
        self._watchdog_task: asyncio.Task | None = None
        self._stopped = asyncio.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._last_error: str | None = None

        self.on_timeout: Callable[[], Awaitable[None]] | None = None
        self.on_state: Callable[[dict[str, Any]], Awaitable[None]] | None = None

    # ─── Lifecycle ─────────────────────────────────────────────────────────
    async def start(self) -> None:
        if self._pipeline is not None:
            return
        Gst = self._Gst
        pipeline = Gst.Pipeline.new("video-rx")
        source_bin, encoding = build_source_bin(Gst, self._settings)
        tee = Gst.ElementFactory.make("tee", "tee")
        if tee is None:
            raise RuntimeError("tee element missing")
        tee.set_property("allow-not-linked", True)

        pipeline.add(source_bin)
        pipeline.add(tee)
        if not source_bin.link(tee):
            raise RuntimeError("failed to link source_bin → tee")

        # Pad probe on tee sink to track source liveness (mirrors _teeProbe)
        sink_pad = tee.get_static_pad("sink")

        def _on_buffer(_pad: Any, _info: Any) -> Any:
            self._last_buffer_ts = time.monotonic()
            return Gst.PadProbeReturn.OK

        sink_pad.add_probe(Gst.PadProbeType.BUFFER, _on_buffer)

        self._pipeline = pipeline
        self._tee = tee
        self._source_bin = source_bin
        self._encoding = encoding

        # Start GLib main loop on a dedicated thread for bus signals
        self._glib_loop = self._GLib.MainLoop.new(None, False)
        self._bus_thread = threading.Thread(target=self._glib_loop.run, daemon=True)
        self._bus_thread.start()

        bus = pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self._on_bus_message)

        ret = pipeline.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError("pipeline failed to enter PLAYING state")

        self._loop = asyncio.get_running_loop()
        self._last_buffer_ts = time.monotonic()
        self._watchdog_task = asyncio.create_task(self._watchdog())
        logger.info(
            "video receiver started: source=%s encoding=%s",
            self._settings.video_source.value,
            encoding,
        )
        await self._emit_state()

    async def stop(self) -> None:
        if self._pipeline is None:
            return
        # Stop any in-progress recording first so the file is finalized properly
        # rather than left truncated by the pipeline teardown below.
        if self._recorder is not None and self._recorder.active:
            await self.stop_recording()

        # Close all peers
        async with self._peers_lock:
            for peer in list(self._peers.values()):
                await peer.close()
            self._peers.clear()
        async with self._raw_peers_lock:
            for peer in list(self._raw_peers.values()):
                await peer.close()
            self._raw_peers.clear()

        if self._watchdog_task:
            self._watchdog_task.cancel()
            try:
                await self._watchdog_task
            except asyncio.CancelledError:
                pass
            self._watchdog_task = None

        self._pipeline.set_state(self._Gst.State.NULL)
        if self._glib_loop and self._glib_loop.is_running():
            self._glib_loop.quit()
        if self._bus_thread:
            self._bus_thread.join(timeout=2.0)
        self._pipeline = None
        self._tee = None
        self._source_bin = None
        self._stopped.set()
        logger.info("video receiver stopped")
        await self._emit_state()

    # ─── Peers ─────────────────────────────────────────────────────────────
    async def add_peer(
        self, send_to_client: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> WebRTCPeer:
        if self._pipeline is None or self._tee is None:
            raise RuntimeError("pipeline not running")
        loop = asyncio.get_running_loop()
        peer = WebRTCPeer(
            self._Gst,
            self._GstWebRTC,
            self._GstSdp,
            self._pipeline,
            self._tee,
            self._encoding,
            send_to_client,
            loop,
        )
        async with self._peers_lock:
            self._peers[peer.peer_id] = peer
        logger.info("peer added: %s (total=%d)", peer.peer_id, len(self._peers))
        return peer

    async def remove_peer(self, peer_id: str) -> None:
        async with self._peers_lock:
            peer = self._peers.pop(peer_id, None)
        if peer:
            await peer.close()
            logger.info("peer removed: %s (total=%d)", peer_id, len(self._peers))

    # ─── Raw-NAL peers (WebCodecs fallback) ────────────────────────────────
    async def add_raw_peer(
        self, send_bytes: Callable[[bytes], Awaitable[None]]
    ) -> RawWsSender:
        if self._pipeline is None or self._tee is None:
            raise RuntimeError("pipeline not running")
        loop = asyncio.get_running_loop()
        peer = RawWsSender(
            self._Gst, self._pipeline, self._tee, self._encoding, send_bytes, loop
        )
        async with self._raw_peers_lock:
            self._raw_peers[peer.peer_id] = peer
        logger.info("raw peer added: %s (total=%d)", peer.peer_id, len(self._raw_peers))
        return peer

    async def remove_raw_peer(self, peer_id: str) -> None:
        async with self._raw_peers_lock:
            peer = self._raw_peers.pop(peer_id, None)
        if peer:
            await peer.close()
            logger.info("raw peer removed: %s (total=%d)", peer_id, len(self._raw_peers))

    # ─── Recording (mirrors VideoManager::startRecording/stopRecording) ───
    async def start_recording(self, fmt: str | None = None) -> dict[str, Any]:
        if self._pipeline is None or self._tee is None:
            raise RuntimeError("pipeline not running")
        if self._recorder is not None and self._recorder.active:
            raise RuntimeError("recording already in progress")

        fmt = fmt or self._settings.recording_format.value
        ext = {"MP4": "mp4", "MOV": "mov", "MKV": "mkv"}.get(fmt, "mp4")
        self._recordings_dir.mkdir(parents=True, exist_ok=True)
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filepath = str(self._recordings_dir / f"video_{timestamp}.{ext}")

        loop = asyncio.get_running_loop()
        recorder = Recorder(self._Gst, self._pipeline, self._tee, self._encoding)
        await loop.run_in_executor(None, recorder.start, filepath, fmt)
        self._recorder = recorder

        # SubtitleWriter is wired to the recording lifecycle only — never to live
        # display — matching VideoManager.cc:952-968 (audit gaps #1/#2 fix point).
        self._subtitle_writer.start(filepath)
        logger.info("recording started: %s", filepath)
        return {"active": True, "filepath": filepath, "format": fmt}

    async def stop_recording(self) -> dict[str, Any]:
        if self._recorder is None or not self._recorder.active:
            return {"active": False, "filepath": None}
        self._subtitle_writer.stop()
        loop = asyncio.get_running_loop()
        filepath = await loop.run_in_executor(None, self._recorder.stop)
        logger.info("recording stopped: %s", filepath)
        return {"active": False, "filepath": filepath}

    def recording_state(self) -> dict[str, Any]:
        if self._recorder is None or not self._recorder.active:
            return {"active": False, "filepath": None, "elapsed_s": None}
        return {
            "active": True,
            "filepath": self._recorder.filepath,
            "elapsed_s": self._recorder.elapsed_s,
        }

    # ─── Snapshot (one decoded frame → PNG) ─────────────────────────────────
    async def snapshot(self) -> bytes:
        """Tap the tee with a throwaway decode branch, grab one frame as PNG."""
        if self._pipeline is None or self._tee is None:
            raise RuntimeError("pipeline not running")
        Gst = self._Gst
        loop = asyncio.get_running_loop()
        future: asyncio.Future[bytes] = loop.create_future()

        queue = Gst.ElementFactory.make("queue", None)
        decodebin = Gst.ElementFactory.make("decodebin3", None)
        convert = Gst.ElementFactory.make("videoconvert", None)
        pngenc = Gst.ElementFactory.make("pngenc", None)
        sink = Gst.ElementFactory.make("appsink", None)
        if not all((queue, decodebin, convert, pngenc, sink)):
            raise RuntimeError("snapshot pipeline elements unavailable (missing pngenc?)")
        sink.set_property("emit-signals", True)
        sink.set_property("sync", False)
        sink.set_property("max-buffers", 1)
        sink.set_property("drop", True)

        for el in (queue, decodebin, convert, pngenc, sink):
            self._pipeline.add(el)

        def _on_decoder_pad(_db: Any, pad: Any) -> None:
            # decodebin3 can fire pad-added before caps finish negotiating, so a
            # caps-based video/audio filter here is unreliable — our source is
            # video-only (no audio track requested), so just link whatever pad shows up.
            sink_pad = convert.get_static_pad("sink")
            if sink_pad and not sink_pad.is_linked():
                pad.link(sink_pad)

        decodebin.connect("pad-added", _on_decoder_pad)

        def _on_new_sample(appsink: Any) -> Any:
            sample = appsink.emit("pull-sample")
            if sample is not None and not future.done():
                buf = sample.get_buffer()
                ok, mapinfo = buf.map(Gst.MapFlags.READ)
                if ok:
                    data = bytes(mapinfo.data)
                    buf.unmap(mapinfo)
                    loop.call_soon_threadsafe(future.set_result, data)
            return Gst.FlowReturn.OK

        sink.connect("new-sample", _on_new_sample)

        queue.link(decodebin)
        convert.link(pngenc)
        pngenc.link(sink)
        for el in (queue, decodebin, convert, pngenc, sink):
            el.sync_state_with_parent()

        tee_pad_template = self._tee.get_pad_template("src_%u")
        tee_pad = self._tee.request_pad(tee_pad_template, None, None)
        tee_pad.link(queue.get_static_pad("sink"))

        try:
            data = await asyncio.wait_for(future, timeout=5.0)
        finally:
            try:
                tee_pad.unlink(queue.get_static_pad("sink"))
                self._tee.release_request_pad(tee_pad)
                for el in (queue, decodebin, convert, pngenc, sink):
                    el.set_state(Gst.State.NULL)
                    self._pipeline.remove(el)
            except Exception:
                logger.exception("snapshot branch teardown error")
        return data

    # ─── Watchdog (mirrors GstVideoReceiver.cc::_watchdog) ─────────────────
    async def _watchdog(self) -> None:
        timeout = max(2, int(self._settings.stream_timeout_s))
        try:
            while True:
                await asyncio.sleep(1.0)
                if self._last_buffer_ts == 0:
                    continue
                elapsed = time.monotonic() - self._last_buffer_ts
                if elapsed > timeout:
                    logger.warning(
                        "stream timeout: no buffers for %.1fs (timeout=%ds)",
                        elapsed,
                        timeout,
                    )
                    if self.on_timeout:
                        try:
                            await self.on_timeout()
                        except Exception:
                            logger.exception("on_timeout handler raised")
                    return
        except asyncio.CancelledError:
            raise

    # ─── Bus handler (called from GLib thread) ─────────────────────────────
    def _on_bus_message(self, _bus: Any, msg: Any) -> None:
        t = msg.type
        Gst = self._Gst
        if t == Gst.MessageType.ERROR:
            err, debug = msg.parse_error()
            logger.error("gst error: %s | %s", err.message, debug)
            self._last_error = f"{err.message} | {debug}" if debug else err.message
            # Immediately fire the timeout callback so the manager can restart
            # without waiting the full watchdog window.
            if self.on_timeout and self._loop and not self._stopped.is_set():
                asyncio.run_coroutine_threadsafe(self.on_timeout(), self._loop)
        elif t == Gst.MessageType.WARNING:
            err, debug = msg.parse_warning()
            logger.warning("gst warning: %s | %s", err.message, debug)
        elif t == Gst.MessageType.EOS:
            logger.info("gst EOS")
            self._last_error = "Stream ended (EOS)"
            if self.on_timeout and self._loop and not self._stopped.is_set():
                asyncio.run_coroutine_threadsafe(self.on_timeout(), self._loop)
        # STREAM_COLLECTION audio-stream filtering omitted — drone streams are usually video-only

    # ─── State publication ────────────────────────────────────────────────
    async def _emit_state(self) -> None:
        if self.on_state:
            try:
                await self.on_state(self.state())
            except Exception:
                logger.exception("on_state handler raised")

    def state(self) -> dict[str, Any]:
        return {
            "active": self._pipeline is not None,
            "encoding": self._encoding if self._pipeline else None,
            "peer_count": len(self._peers),
            "raw_peer_count": len(self._raw_peers),
            "last_buffer_age_s": (
                round(time.monotonic() - self._last_buffer_ts, 2)
                if self._last_buffer_ts
                else None
            ),
            "last_error": self._last_error,
            "recording": self.recording_state(),
        }
