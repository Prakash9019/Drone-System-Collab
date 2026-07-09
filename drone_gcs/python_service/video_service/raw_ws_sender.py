"""WebCodecs fallback: raw H.264/H.265 NAL units over a binary WebSocket.

Taps the same `tee` as the WebRTC peers but pulls encoded access units via
`appsink` instead of packetizing for RTP — the browser's `VideoDecoder` consumes
the NAL units directly. Each WS binary frame is `[timestamp_us: u64 big-endian][NAL
payload]`; SPS/PPS are in-band on every keyframe because `h264parse`/`h265parse`
upstream already run with `config-interval=-1` (or equivalent) in the source bin.

This is the low-latency/browser-support fallback path from the plan (§2.2, §4.4) —
used when `webrtcbin` is unavailable or a user wants the absolute-minimum-latency
WebCodecs path on a supporting browser (Chrome/Edge/Safari 16.4+).
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)


class RawWsSender:
    """One browser ↔ one appsink tap. Lives until the WebSocket closes."""

    def __init__(
        self,
        Gst: Any,
        pipeline: Any,
        tee: Any,
        encoding: str,
        send_bytes: Callable[[bytes], Awaitable[None]],
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self._Gst = Gst
        self._pipeline = pipeline
        self._tee = tee
        self._encoding = encoding
        self._send = send_bytes
        self._loop = loop
        self.peer_id = uuid.uuid4().hex[:8]
        self._closed = False

        self._queue = self._make("queue")
        self._queue.set_property("leaky", 2)  # downstream-drop — never block the tee
        self._queue.set_property("max-size-buffers", 4)
        self._queue.set_property("max-size-bytes", 0)
        self._queue.set_property("max-size-time", 0)

        self._appsink = self._make("appsink")
        self._appsink.set_property("emit-signals", True)
        self._appsink.set_property("sync", False)
        self._appsink.set_property("max-buffers", 4)
        self._appsink.set_property("drop", True)
        self._appsink.connect("new-sample", self._on_new_sample)

        for el in (self._queue, self._appsink):
            self._pipeline.add(el)
            el.sync_state_with_parent()
        self._queue.link(self._appsink)

        tee_pad_template = self._tee.get_pad_template("src_%u")
        self._tee_pad = self._tee.request_pad(tee_pad_template, None, None)
        self._tee_pad.link(self._queue.get_static_pad("sink"))

    def _make(self, factory: str, name: str | None = None) -> Any:
        el = self._Gst.ElementFactory.make(factory, name)
        if el is None:
            raise RuntimeError(f"GStreamer element '{factory}' not available")
        return el

    # ─── Sample pull (GStreamer streaming thread) ──────────────────────────
    def _on_new_sample(self, sink: Any) -> Any:
        Gst = self._Gst
        sample = sink.emit("pull-sample")
        if sample is None:
            return Gst.FlowReturn.OK
        buf = sample.get_buffer()
        ok, mapinfo = buf.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.FlowReturn.OK
        try:
            ts_us = int(buf.pts / 1000) if buf.pts != Gst.CLOCK_TIME_NONE else 0
            frame = ts_us.to_bytes(8, "big") + bytes(mapinfo.data)
        finally:
            buf.unmap(mapinfo)
        if not self._closed:
            asyncio.run_coroutine_threadsafe(self._send(frame), self._loop)
        return Gst.FlowReturn.OK

    # ─── Teardown ──────────────────────────────────────────────────────────
    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._tee_pad.unlink(self._queue.get_static_pad("sink"))
            self._tee.release_request_pad(self._tee_pad)
            for el in (self._appsink, self._queue):
                el.set_state(self._Gst.State.NULL)
                self._pipeline.remove(el)
        except Exception:
            logger.exception("raw ws sender %s teardown error", self.peer_id)
