"""Recording branch for GstVideoReceiver (mirrors QGC's tee+valve+mux+filesink).

Built fresh per recording session (one active recording at a time — unlike the
per-peer WebRTC branches, recordings aren't concurrent, so there's no benefit to
keeping the branch resident when idle) and torn down on stop.

Audit fix (gap #9): explicitly implements the keyframe-gated pad probe QGC uses to
make files playable from t=0. In real QGC this is two pieces: the probe install
(GstVideoReceiver.cc:504-514) and the callback logic (GstVideoReceiver.cc:1714-1730,
`_keyframeWatch`) — drop every buffer until the first keyframe, then reset the pad's
running-time offset so t=0 in the file is that keyframe, not a black/undecodable
lead-in of delta frames with no reference.
"""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_MUX_BY_FORMAT = {
    "MP4": "mp4mux",
    "MOV": "qtmux",
    "MKV": "matroskamux",
}

# mp4mux/qtmux need a moment after EOS to rewrite trailer/moov atoms. `faststart`
# (set below) means a hard-kill mid-recording still leaves a playable file, so this
# wait is bounded rather than blocking indefinitely on a muxer that's stuck.
_EOS_FLUSH_TIMEOUT_S = 2.0


class Recorder:
    """One active recording branch, tapped off the receiver's `tee`."""

    def __init__(self, Gst: Any, pipeline: Any, tee: Any, encoding: str) -> None:
        self._Gst = Gst
        self._pipeline = pipeline
        self._tee = tee
        self._encoding = encoding
        self._elements: list[Any] = []
        self._tee_pad: Any | None = None
        self._filepath: str | None = None
        self._started_at: float | None = None

    @property
    def active(self) -> bool:
        return self._filepath is not None

    @property
    def filepath(self) -> str | None:
        return self._filepath

    @property
    def elapsed_s(self) -> float | None:
        if self._started_at is None:
            return None
        return round(time.monotonic() - self._started_at, 1)

    def _make(self, factory: str, name: str | None = None) -> Any:
        el = self._Gst.ElementFactory.make(factory, name)
        if el is None:
            raise RuntimeError(f"GStreamer element '{factory}' not available")
        return el

    # ─── Lifecycle (call from a worker thread / executor — these block briefly) ────
    def start(self, filepath: str, fmt: str) -> None:
        if self.active:
            raise RuntimeError("recording already in progress")
        Gst = self._Gst
        Path(filepath).parent.mkdir(parents=True, exist_ok=True)

        queue = self._make("queue", "rec-queue")
        queue.set_property("leaky", 0)  # no-leak — recording must not silently drop frames
        valve = self._make("valve", "rec-valve")
        valve.set_property("drop", True)  # stays closed until the keyframe probe opens it
        parser = self._make(
            "h264parse" if self._encoding == "H264" else "h265parse", "rec-parser"
        )
        parser.set_property("config-interval", -1)

        mux_factory = _MUX_BY_FORMAT.get(fmt, "mp4mux")
        mux = self._make(mux_factory, "rec-mux")
        if fmt in ("MP4", "MOV"):
            # QGC: GstVideoReceiver.cc:894-976 (_makeFileSink) — faststart + periodic moov
            # rewrite so a file killed mid-recording is still playable.
            mux.set_property("faststart", True)
            mux.set_property("reserved-moov-update-period", 1_000_000_000)

        filesink = self._make("filesink", "rec-filesink")
        filesink.set_property("location", filepath)
        filesink.set_property("sync", False)

        for el in (queue, valve, parser, mux, filesink):
            self._pipeline.add(el)
        queue.link(valve)
        valve.link(parser)
        parser.link(mux)
        mux.link(filesink)
        for el in (queue, valve, parser, mux, filesink):
            el.sync_state_with_parent()

        tee_pad_template = self._tee.get_pad_template("src_%u")
        tee_pad = self._tee.request_pad(tee_pad_template, None, None)
        tee_pad.link(queue.get_static_pad("sink"))

        # Audit fix (gap #9): keyframe-gated valve open.
        valve_src_pad = valve.get_static_pad("src")

        def _keyframe_watch(pad: Any, info: Any) -> Any:
            buf = info.get_buffer()
            if buf is None:
                return Gst.PadProbeReturn.OK
            if buf.has_flags(Gst.BufferFlags.DELTA_UNIT):
                # Not a keyframe yet — drop it, mirrors QGC dropping until first IDR.
                return Gst.PadProbeReturn.DROP
            # First keyframe: reset the pad's running-time offset so t=0 in the
            # recorded file is *this* buffer, then stop probing.
            pad.set_offset(-buf.pts)
            return Gst.PadProbeReturn.REMOVE

        valve_src_pad.add_probe(Gst.PadProbeType.BUFFER, _keyframe_watch)
        valve.set_property("drop", False)

        self._elements = [queue, valve, parser, mux, filesink]
        self._tee_pad = tee_pad
        self._filepath = filepath
        self._started_at = time.monotonic()
        logger.info("recording started: %s (%s)", filepath, fmt)

    def stop(self) -> str | None:
        """Blocking — run via `loop.run_in_executor` from async callers."""
        if not self.active:
            return None
        Gst = self._Gst
        filepath = self._filepath
        queue, valve, parser, mux, filesink = self._elements

        # Drain the branch with a real EOS so the muxer finalizes a valid trailer/moov
        # instead of leaving a truncated file — wait (bounded) for it to reach filesink.
        eos_seen = threading.Event()
        fs_pad = filesink.get_static_pad("sink")

        def _on_eos(_pad: Any, info: Any) -> Any:
            event = info.get_event()
            if event is not None and event.type == Gst.EventType.EOS:
                eos_seen.set()
            return Gst.PadProbeReturn.OK

        probe_id = fs_pad.add_probe(Gst.PadProbeType.EVENT_DOWNSTREAM, _on_eos)
        queue.get_static_pad("sink").send_event(Gst.Event.new_eos())
        if not eos_seen.wait(timeout=_EOS_FLUSH_TIMEOUT_S):
            logger.warning("recorder EOS flush timed out after %.1fs — file relies on faststart for integrity", _EOS_FLUSH_TIMEOUT_S)
        fs_pad.remove_probe(probe_id)

        try:
            if self._tee_pad is not None:
                self._tee_pad.unlink(queue.get_static_pad("sink"))
                self._tee.release_request_pad(self._tee_pad)
            for el in self._elements:
                el.set_state(Gst.State.NULL)
                self._pipeline.remove(el)
        except Exception:
            logger.exception("recorder teardown error")

        self._elements = []
        self._tee_pad = None
        self._filepath = None
        self._started_at = None
        logger.info("recording stopped: %s", filepath)
        return filepath
