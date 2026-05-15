"""WebRTC sender via GStreamer's `webrtcbin`.

The encoded H.264 from the upstream `tee` is RTP-payloaded and handed to
webrtcbin, which negotiates SDP/ICE with the browser. No transcode — the
browser does the decode on its GPU, matching QGC's "encoded end-to-end"
property.

Per-peer instances are owned by GstVideoReceiver and torn down when the
peer disconnects.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)


class WebRTCPeer:
    """One browser ↔ one webrtcbin. Lives until the WebSocket closes."""

    def __init__(
        self,
        Gst: Any,
        GstWebRTC: Any,
        GstSdp: Any,
        pipeline: Any,
        tee: Any,
        encoding: str,
        send_to_client: Callable[[dict[str, Any]], Awaitable[None]],
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self._Gst = Gst
        self._GstWebRTC = GstWebRTC
        self._GstSdp = GstSdp
        self._pipeline = pipeline
        self._tee = tee
        self._encoding = encoding
        self._send = send_to_client
        self._loop = loop
        self.peer_id = uuid.uuid4().hex[:8]
        self._closed = False

        self._queue = self._make("queue")
        self._queue.set_property("leaky", 2)  # downstream-drop
        self._queue.set_property("max-size-buffers", 2)
        self._queue.set_property("max-size-bytes", 0)
        self._queue.set_property("max-size-time", 0)

        if encoding == "H264":
            self._payloader = self._make("rtph264pay")
            self._payloader.set_property("config-interval", -1)  # SPS/PPS in-band on every IDR
            self._payloader.set_property("pt", 96)
            self._payloader.set_property("aggregate-mode", 1)
            payload_caps = (
                "application/x-rtp, media=(string)video, encoding-name=(string)H264,"
                " payload=(int)96, clock-rate=(int)90000,"
                " packetization-mode=(string)1, profile-level-id=(string)42e01f"
            )
        else:
            self._payloader = self._make("rtph265pay")
            self._payloader.set_property("config-interval", -1)
            self._payloader.set_property("pt", 96)
            payload_caps = (
                "application/x-rtp, media=(string)video, encoding-name=(string)H265,"
                " payload=(int)96, clock-rate=(int)90000"
            )
        self._capsfilter = self._make("capsfilter")
        self._capsfilter.set_property("caps", Gst.Caps.from_string(payload_caps))

        self._webrtc = self._make("webrtcbin", f"webrtc-{self.peer_id}")
        self._webrtc.set_property("bundle-policy", "max-bundle")
        self._webrtc.set_property("stun-server", "stun://stun.l.google.com:19302")
        self._webrtc.connect("on-negotiation-needed", self._on_negotiation_needed)
        self._webrtc.connect("on-ice-candidate", self._on_ice_candidate)
        self._webrtc.connect(
            "notify::ice-connection-state", self._on_ice_state_change
        )

        for el in (self._queue, self._payloader, self._capsfilter, self._webrtc):
            self._pipeline.add(el)
            el.sync_state_with_parent()

        # tee → queue → payloader → capsfilter → webrtcbin
        tee_pad_template = self._tee.get_pad_template("src_%u")
        self._tee_pad = self._tee.request_pad(tee_pad_template, None, None)
        queue_sink = self._queue.get_static_pad("sink")
        self._tee_pad.link(queue_sink)
        self._queue.link(self._payloader)
        self._payloader.link(self._capsfilter)
        self._capsfilter.link(self._webrtc)

    # ─── Gst helpers ───────────────────────────────────────────────────────
    def _make(self, factory: str) -> Any:
        el = self._Gst.ElementFactory.make(factory, None)
        if el is None:
            raise RuntimeError(f"GStreamer element '{factory}' not available")
        return el

    # ─── Signaling: signals from webrtcbin (GStreamer thread) ──────────────
    def _on_negotiation_needed(self, _webrtc: Any) -> None:
        promise = self._Gst.Promise.new_with_change_func(
            self._on_offer_created, self._webrtc, None
        )
        self._webrtc.emit("create-offer", None, promise)

    def _on_offer_created(self, promise: Any, _webrtc: Any, _user: Any) -> None:
        promise.wait()
        reply = promise.get_reply()
        offer = reply.get_value("offer")
        promise = self._Gst.Promise.new()
        self._webrtc.emit("set-local-description", offer, promise)
        promise.interrupt()
        sdp_text = offer.sdp.as_text()
        asyncio.run_coroutine_threadsafe(
            self._send({"type": "offer", "sdp": sdp_text}), self._loop
        )

    def _on_ice_candidate(self, _webrtc: Any, mlineindex: int, candidate: str) -> None:
        asyncio.run_coroutine_threadsafe(
            self._send(
                {
                    "type": "ice",
                    "candidate": {"candidate": candidate, "sdpMLineIndex": mlineindex},
                }
            ),
            self._loop,
        )

    def _on_ice_state_change(self, _webrtc: Any, _pspec: Any) -> None:
        state = self._webrtc.get_property("ice-connection-state")
        # GstWebRTCICEConnectionState: 0=new 1=checking 2=connected 3=completed 4=failed 5=disconnected 6=closed
        logger.debug("peer %s ice state=%s", self.peer_id, state)
        if state in (4, 6):  # failed or closed
            asyncio.run_coroutine_threadsafe(self.close(), self._loop)

    # ─── Signaling: messages from client ───────────────────────────────────
    async def on_client_message(self, msg: dict[str, Any]) -> None:
        msg_type = msg.get("type")
        if msg_type == "answer":
            self._apply_answer(msg.get("sdp", ""))
        elif msg_type == "ice":
            candidate = msg.get("candidate", {})
            self._webrtc.emit(
                "add-ice-candidate",
                int(candidate.get("sdpMLineIndex", 0)),
                candidate.get("candidate", ""),
            )

    def _apply_answer(self, sdp_text: str) -> None:
        _res, sdp_msg = self._GstSdp.SDPMessage.new_from_text(sdp_text)
        answer = self._GstWebRTC.WebRTCSessionDescription.new(
            self._GstWebRTC.WebRTCSDPType.ANSWER, sdp_msg
        )
        promise = self._Gst.Promise.new()
        self._webrtc.emit("set-remote-description", answer, promise)
        promise.interrupt()

    # ─── Teardown ──────────────────────────────────────────────────────────
    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            # Unlink tee pad and release
            self._tee_pad.unlink(self._queue.get_static_pad("sink"))
            self._tee.release_request_pad(self._tee_pad)
            for el in (self._webrtc, self._capsfilter, self._payloader, self._queue):
                el.set_state(self._Gst.State.NULL)
                self._pipeline.remove(el)
        except Exception:
            logger.exception("peer %s teardown error", self.peer_id)
