"""Builds GStreamer source bins for each supported protocol.

Knobs copied verbatim from QGC `GstVideoReceiver.cc:_makeSource` (lines 672-883):
- rtspsrc: latency=25, do-rtcp=TRUE, tcp-timeout=5e6, udp-reconnect=TRUE,
           drop-on-latency=TRUE, retry=3
- udpsrc:  buffer-size=8*1024*1024, RTP caps filter on H264/H265
- rtpjitterbuffer: do-lost=TRUE, drop-on-latency=lowLatency
"""
from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlparse

from .settings import VideoSettings, VideoSource

logger = logging.getLogger(__name__)


def _make(Gst: Any, factory: str, name: str | None = None) -> Any:
    el = Gst.ElementFactory.make(factory, name)
    if el is None:
        raise RuntimeError(f"GStreamer element factory '{factory}' not available")
    return el


def build_source_bin(Gst: Any, settings: VideoSettings) -> tuple[Any, str]:
    """Create a `Gst.Bin` exposing a single ghost src pad carrying H.264/H.265 RTP
    (or already-parsed video for MPEG-TS) ready to feed a `tee`.

    Returns (bin, encoding) where encoding ∈ {"H264", "H265"}.
    """
    src = settings.video_source
    low_latency = settings.low_latency_mode
    bin_ = Gst.Bin.new("source-bin")

    if src == VideoSource.RTSP:
        if not settings.rtsp_url:
            raise ValueError("rtsp_url is empty")
        rtspsrc = _make(Gst, "rtspsrc", "rtspsrc")
        rtspsrc.set_property("location", settings.rtsp_url)
        rtspsrc.set_property("latency", 25)
        rtspsrc.set_property("do-rtcp", True)
        rtspsrc.set_property("tcp-timeout", 5_000_000)
        rtspsrc.set_property("udp-reconnect", True)
        rtspsrc.set_property("drop-on-latency", True)
        rtspsrc.set_property("retry", 3)
        depay = _make(Gst, "rtph264depay", "depay")
        parser = _make(Gst, "h264parse", "parser")
        bin_.add(rtspsrc)
        bin_.add(depay)
        bin_.add(parser)
        depay.link(parser)
        # rtspsrc has dynamic pads — link in pad-added callback
        ghost = Gst.GhostPad.new_no_target("src", Gst.PadDirection.SRC)
        bin_.add_pad(ghost)
        parser_src = parser.get_static_pad("src")

        def _on_pad_added(_src: Any, pad: Any) -> None:
            caps = pad.get_current_caps()
            if not caps:
                return
            name = caps.get_structure(0).get_name()
            # Accept either application/x-rtp (we'll let it flow through depay)
            if "rtp" in name:
                sink_pad = depay.get_static_pad("sink")
                if sink_pad and not sink_pad.is_linked():
                    pad.link(sink_pad)
                    ghost.set_target(parser_src)

        rtspsrc.connect("pad-added", _on_pad_added)
        return bin_, "H264"

    if src in (VideoSource.UDP_H264, VideoSource.UDP_H265):
        encoding = "H264" if src == VideoSource.UDP_H264 else "H265"
        udpsrc = _make(Gst, "udpsrc", "udpsrc")
        udpsrc.set_property("port", settings.udp_port)
        udpsrc.set_property("buffer-size", 8 * 1024 * 1024)
        caps_str = (
            "application/x-rtp, media=(string)video, clock-rate=(int)90000, "
            f"encoding-name=(string){encoding}, payload=(int)96"
        )
        udpsrc.set_property("caps", Gst.Caps.from_string(caps_str))
        jitter = _make(Gst, "rtpjitterbuffer", "jitter")
        jitter.set_property("do-lost", True)
        jitter.set_property("drop-on-latency", low_latency)
        depay = _make(
            Gst,
            "rtph264depay" if encoding == "H264" else "rtph265depay",
            "depay",
        )
        parser = _make(
            Gst,
            "h264parse" if encoding == "H264" else "h265parse",
            "parser",
        )
        bin_.add(udpsrc)
        bin_.add(jitter)
        bin_.add(depay)
        bin_.add(parser)
        udpsrc.link(jitter)
        jitter.link(depay)
        depay.link(parser)
        ghost = Gst.GhostPad.new("src", parser.get_static_pad("src"))
        bin_.add_pad(ghost)
        return bin_, encoding

    if src == VideoSource.UDP_MPEGTS:
        udpsrc = _make(Gst, "udpsrc", "udpsrc")
        udpsrc.set_property("port", settings.udp_port)
        udpsrc.set_property("buffer-size", 8 * 1024 * 1024)
        udpsrc.set_property(
            "caps", Gst.Caps.from_string("video/mpegts, systemstream=true, packetsize=188")
        )
        tsdemux = _make(Gst, "tsdemux", "tsdemux")
        parser = _make(Gst, "h264parse", "parser")
        bin_.add(udpsrc)
        bin_.add(tsdemux)
        bin_.add(parser)
        udpsrc.link(tsdemux)
        ghost = Gst.GhostPad.new("src", parser.get_static_pad("src"))
        bin_.add_pad(ghost)

        def _on_ts_pad(_dem: Any, pad: Any) -> None:
            caps = pad.get_current_caps()
            if not caps:
                return
            name = caps.get_structure(0).get_name()
            if name == "video/x-h264":
                sink_pad = parser.get_static_pad("sink")
                if sink_pad and not sink_pad.is_linked():
                    pad.link(sink_pad)

        tsdemux.connect("pad-added", _on_ts_pad)
        return bin_, "H264"

    if src == VideoSource.TCP_MPEGTS:
        if not settings.tcp_url:
            raise ValueError("tcp_url is empty")
        parsed = urlparse(settings.tcp_url if "://" in settings.tcp_url else f"tcp://{settings.tcp_url}")
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 5000
        tcpsrc = _make(Gst, "tcpclientsrc", "tcpsrc")
        tcpsrc.set_property("host", host)
        tcpsrc.set_property("port", port)
        tsdemux = _make(Gst, "tsdemux", "tsdemux")
        parser = _make(Gst, "h264parse", "parser")
        bin_.add(tcpsrc)
        bin_.add(tsdemux)
        bin_.add(parser)
        tcpsrc.link(tsdemux)
        ghost = Gst.GhostPad.new("src", parser.get_static_pad("src"))
        bin_.add_pad(ghost)

        def _on_ts_pad(_dem: Any, pad: Any) -> None:
            caps = pad.get_current_caps()
            if not caps:
                return
            name = caps.get_structure(0).get_name()
            if name == "video/x-h264":
                sink_pad = parser.get_static_pad("sink")
                if sink_pad and not sink_pad.is_linked():
                    pad.link(sink_pad)

        tsdemux.connect("pad-added", _on_ts_pad)
        return bin_, "H264"

    raise ValueError(f"Unsupported video source: {src}")
