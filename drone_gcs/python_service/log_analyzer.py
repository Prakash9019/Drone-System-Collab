"""Lightweight MAVLink log summaries (.tlog / ArduPilot dataflash .bin)."""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from pymavlink import mavutil

logger = logging.getLogger(__name__)

MAX_TLOG_MESSAGES_DEFAULT = 80_000
MAX_BIN_MESSAGES_DEFAULT = 200_000


def _top_counts(counts: Dict[str, int], limit: int = 80) -> List[Dict[str, Any]]:
    items = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    return [{"message": k, "count": v} for k, v in items[:limit]]


def analyze_tlog(path: str, max_messages: int = MAX_TLOG_MESSAGES_DEFAULT) -> Dict[str, Any]:
    counts: Dict[str, int] = {}
    t_first: Optional[float] = None
    t_last: Optional[float] = None
    n = 0
    mlog = mavutil.mavlink_connection(path)
    try:
        while n < max_messages:
            msg = mlog.recv_match(blocking=False)
            if msg is None:
                break
            n += 1
            typ = msg.get_type()
            if typ == "BAD_DATA":
                continue
            counts[typ] = counts.get(typ, 0) + 1
            ts = getattr(msg, "_timestamp", None)
            if isinstance(ts, (int, float)):
                if t_first is None:
                    t_first = float(ts)
                t_last = float(ts)
    finally:
        try:
            mlog.close()
        except Exception:
            pass

    duration_s = None
    if t_first is not None and t_last is not None and t_last >= t_first:
        duration_s = t_last - t_first

    return {
        "format": "tlog",
        "filename": os.path.basename(path),
        "samples_read": n,
        "unique_types": len(counts),
        "duration_s": duration_s,
        "message_counts": _top_counts(counts),
    }


def analyze_bin(path: str, max_messages: int = MAX_BIN_MESSAGES_DEFAULT) -> Dict[str, Any]:
    from pymavlink.DFReader import DFReader

    counts: Dict[str, int] = {}
    n = 0
    reader = DFReader(path)
    try:
        while n < max_messages:
            msg = reader.recv_msg()
            if msg is None:
                break
            n += 1
            typ = msg.get_type()
            if typ == "BAD_DATA":
                continue
            counts[typ] = counts.get(typ, 0) + 1
    finally:
        try:
            reader.close()
        except Exception:
            pass

    return {
        "format": "dataflash",
        "filename": os.path.basename(path),
        "samples_read": n,
        "unique_types": len(counts),
        "duration_s": None,
        "message_counts": _top_counts(counts),
    }


def analyze_file(path: str) -> Dict[str, Any]:
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in (".tlog", ".log"):
            return analyze_tlog(path)
        if ext in (".bin", ".BIN"):
            return analyze_bin(path)
        return {
            "format": "unknown",
            "filename": os.path.basename(path),
            "error": f"Unsupported extension {ext!r}; use .tlog or .bin",
            "message_counts": [],
            "samples_read": 0,
            "unique_types": 0,
            "duration_s": None,
        }
    except Exception as e:
        logger.exception("Log analysis failed")
        return {
            "format": "error",
            "filename": os.path.basename(path),
            "error": str(e),
            "message_counts": [],
            "samples_read": 0,
            "unique_types": 0,
            "duration_s": None,
        }


def analysis_to_csv(result: Dict[str, Any]) -> str:
    """CSV for message counts (same rows as API message_counts list)."""
    lines = ["message,count"]
    for row in result.get("message_counts") or []:
        msg = str(row.get("message", "")).replace('"', '""')
        lines.append(f'"{msg}",{int(row.get("count", 0))}')
    return "\n".join(lines) + "\n"
