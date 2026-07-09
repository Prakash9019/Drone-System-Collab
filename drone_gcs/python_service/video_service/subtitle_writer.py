"""Telemetry-in-recording subtitle sidecar (mirrors QGC `SubtitleWriter.cc`).

Audit fix (gaps #1, #2): the original migration plan specified this module as an
SRT ("SubRip") writer with a hardcoded 6-field set (lat/lon/alt/speed/heading/
battery). Verified against the actual QGC source, both claims were wrong:

  - QGC writes `.ass` (Advanced SubStation Alpha) — `SubtitleWriter.cc:54` builds
    `"%1/%2.ass"`, and the file has a full `[Script Info]`/`[V4+ Styles]`/`[Events]`
    header (`SubtitleWriter.cc:71-87`) with positioned `Dialogue:` lines
    (`SubtitleWriter.cc:137-138`) — a format SRT has no equivalent for.
  - The field list is NOT hardcoded. QGC dynamically reads whatever Facts are
    configured in the user's live telemetry bar (`SubtitleWriter.cc:36-48`), so the
    recorded overlay always matches what the operator was actually looking at.

This module reproduces both: `.ass` output, and a caller-supplied/dynamic field
list (`get_telemetry_fields()`) instead of a fixed set. Recording-only lifecycle,
matching QGC (`VideoManager.cc:952-968`: SubtitleWriter is wired to
`recordingStarted`/`recordingChanged`, never to a live-display signal).
"""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any, Callable, Sequence

logger = logging.getLogger(__name__)

# QGC: SubtitleWriter.h:32 `_kSampleRate = 1` — "most players do weird stuff when > 1Hz"
_SAMPLE_RATE_HZ = 1.0

# Default telemetry fields to overlay when the caller doesn't supply a custom list —
# mirrors a typical QGC telemetry-bar configuration. Each entry: (label, path-in-
# vehicle-dict, unit, format). `path` is dot-separated into the dict returned by
# `get_telemetry_fields()`'s snapshot (i.e. VehicleState.to_dict()-shaped).
DEFAULT_FIELDS: tuple[tuple[str, str, str, str], ...] = (
    ("Lat", "position.lat", "°", "{:.6f}"),
    ("Lon", "position.lng", "°", "{:.6f}"),
    ("Alt", "position.alt_rel", "m", "{:.1f}"),
    ("GSpd", "velocity.groundspeed", "m/s", "{:.1f}"),
    ("Hdg", "velocity.heading", "°", "{:.0f}"),
    ("Batt", "battery.voltage", "V", "{:.1f}"),
    ("Mode", "status.mode", "", "{}"),
)


def _dig(d: dict[str, Any], path: str) -> Any:
    cur: Any = d
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _fmt_ass_time(seconds: float) -> str:
    """ASS timestamp: H:MM:SS.cc (centiseconds)."""
    cs = int(round(seconds * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


_HEADER_TEMPLATE = (
    "[Script Info]\n"
    "Title: Drone GCS Subtitle Telemetry file\n"
    "ScriptType: v4.00+\n"
    "WrapStyle: 0\n"
    "ScaledBorderAndShadow: yes\n"
    "YCbCr Matrix: TV.601\n"
    "PlayResX: {width}\n"
    "PlayResY: {height}\n"
    "\n"
    "[V4+ Styles]\n"
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
    "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
    "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
    "Style: Default,Monospace,{font_size},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,"
    "0,0,0,0,100,100,0,0,1,2,2,1,10,10,10,1\n"
    "\n"
    "[Events]\n"
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
)

# Two-column layout: right-aligned field names, left-aligned values next to them —
# matches QGC's `namesLine`/`valuesLine` pair (SubtitleWriter.cc:137-138).
_NAMES_LINE = "Dialogue: 0,{start},{end},Default,,0,0,0,,{{\\an3\\pos({x},{y})}}{text}\n"
_VALUES_LINE = "Dialogue: 0,{start},{end},Default,,0,0,0,,{{\\pos({x},{y})}}{text}\n"


class SubtitleWriter:
    """Recording-scoped `.ass` telemetry sidecar writer.

    Lifecycle is driven entirely by the recorder: `start()` on recording-start,
    `stop()` on recording-stop. Never touched by the live-display path.
    """

    def __init__(
        self,
        get_telemetry: Callable[[], dict[str, Any] | None],
        fields: Sequence[tuple[str, str, str, str]] | None = None,
    ) -> None:
        self._get_telemetry = get_telemetry
        self._fields = tuple(fields) if fields else DEFAULT_FIELDS
        self._file: Any | None = None
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()
        self._start_ts: float | None = None
        self._path: str | None = None

    @property
    def active(self) -> bool:
        return self._file is not None

    def start(self, video_filepath: str, video_width: int = 1280, video_height: int = 720) -> None:
        with self._lock:
            if self.active:
                return
            path = str(Path(video_filepath).with_suffix(".ass"))
            font_size = max(12, round(video_height / 32))
            try:
                self._file = open(path, "w", encoding="utf-8")
                self._file.write(
                    _HEADER_TEMPLATE.format(
                        width=video_width, height=video_height, font_size=font_size
                    )
                )
                self._file.flush()
            except OSError:
                logger.exception("failed to open subtitle file %s", path)
                self._file = None
                return
            self._path = path
            self._start_ts = time.monotonic()
            self._video_width = video_width
            self._video_height = video_height
            logger.info("subtitle capture started: %s", path)
            self._schedule_next()

    def stop(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            if self._file is not None:
                try:
                    self._file.close()
                except OSError:
                    logger.exception("failed to close subtitle file")
                logger.info("subtitle capture stopped: %s", self._path)
            self._file = None
            self._path = None
            self._start_ts = None

    def _schedule_next(self) -> None:
        if not self.active:
            return
        self._timer = threading.Timer(1.0 / _SAMPLE_RATE_HZ, self._capture_tick)
        self._timer.daemon = True
        self._timer.start()

    def _capture_tick(self) -> None:
        with self._lock:
            if not self.active or self._start_ts is None:
                return
            now = time.monotonic() - self._start_ts
            self._write_sample(now)
            self._schedule_next()

    def _write_sample(self, elapsed_s: float) -> None:
        telemetry = self._get_telemetry() or {}
        names: list[str] = []
        values: list[str] = []
        for label, path, unit, fmt in self._fields:
            raw = _dig(telemetry, path)
            if raw is None:
                text = "--"
            else:
                try:
                    text = fmt.format(raw)
                except (ValueError, TypeError):
                    text = str(raw)
            names.append(f"{label}:")
            values.append(f"{text} {unit}".strip())

        start = _fmt_ass_time(elapsed_s)
        end = _fmt_ass_time(elapsed_s + 1.0 / _SAMPLE_RATE_HZ)
        name_x = round(self._video_width * 0.72)
        value_x = round(self._video_width * 0.75)
        y = round(self._video_height * 0.9)

        try:
            self._file.write(
                _NAMES_LINE.format(start=start, end=end, x=name_x, y=y, text="\\N".join(names))
            )
            self._file.write(
                _VALUES_LINE.format(start=start, end=end, x=value_x, y=y, text="\\N".join(values))
            )
            self._file.flush()
        except OSError:
            logger.exception("failed to write subtitle sample")
