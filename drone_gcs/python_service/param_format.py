"""Mission Planner / QGroundControl style .param file parsing and export."""

from __future__ import annotations

import re
from typing import Any, Dict, List


def _strip_inline_comment(s: str) -> str:
    s = s.strip()
    if "//" in s:
        s = s.split("//", 1)[0].strip()
    if "#" in s:
        s = s.split("#", 1)[0].strip()
    return s.strip()


def parse_param_text(text: str) -> Dict[str, float]:
    """
    Parse ArduPilot .param text: one NAME VALUE per line (whitespace or comma between).
    Skips QGC file header lines, comments, and blank lines.
    """
    out: Dict[str, float] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#") or line.startswith("//"):
            continue
        if line.upper().startswith("QGC"):
            continue
        m = re.match(r"^([A-Za-z0-9_]+)\s*[,]\s*([-+0-9.eE]+)\s*$", line)
        if m:
            name, val_s = m.group(1).upper(), m.group(2)
        else:
            parts = line.split(None, 1)
            if len(parts) < 2:
                continue
            name = parts[0].strip().upper()
            if not re.match(r"^[A-Z0-9_]+$", name):
                continue
            rest = _strip_inline_comment(parts[1])
            val_tokens = rest.split()
            if not val_tokens:
                continue
            val_s = val_tokens[0]
        try:
            out[name] = float(val_s)
        except ValueError:
            continue
    return out


def format_param_text(params: Dict[str, float]) -> str:
    """Tab-separated .param body (Mission Planner compatible)."""
    lines = ["# ArduPilot parameters", ""]
    for k in sorted(params.keys()):
        lines.append(f"{k}\t{params[k]}")
    return "\n".join(lines) + "\n"


def diff_param_dicts(left: Dict[str, float], right: Dict[str, float]) -> List[Dict[str, Any]]:
    """Key union diff for offline .param vs .param."""
    keys = sorted(set(left) | set(right))
    out: List[Dict[str, Any]] = []
    for k in keys:
        a = left.get(k)
        b = right.get(k)
        if a is None and b is None:
            continue
        if a is None or b is None or abs(float(a) - float(b)) > 1e-6:
            out.append({"param_id": k, "left": a, "right": b})
    return out
