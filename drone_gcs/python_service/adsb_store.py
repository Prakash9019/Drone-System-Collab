"""In-memory ADS-B traffic from MAVLink ADSB_VEHICLE (Phase C)."""

from __future__ import annotations

import time
from typing import Any, Dict, List


def _decode_callsign(raw: Any) -> str:
    if raw is None:
        return ""
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="ignore").rstrip("\x00").strip()
    return str(raw).strip()


class AdsbTrafficStore:
    def __init__(self, max_tracks: int = 100, stale_s: float = 120.0):
        self._by_icao: Dict[int, Dict[str, Any]] = {}
        self.max_tracks = max_tracks
        self.stale_s = stale_s

    def clear(self) -> None:
        self._by_icao.clear()

    def ingest(self, msg: Any) -> None:
        if msg.get_type() != "ADSB_VEHICLE":
            return
        now = time.time()
        icao = int(getattr(msg, "icao_address", 0) or 0)
        if icao <= 0:
            return
        lat_e7 = int(getattr(msg, "lat", 0) or 0)
        lon_e7 = int(getattr(msg, "lon", 0) or 0)
        lat = lat_e7 / 1e7
        lng = lon_e7 / 1e7
        if abs(lat) > 90.0 or abs(lng) > 180.0 or (lat == 0.0 and lng == 0.0):
            return
        alt_mm = int(getattr(msg, "altitude", 0) or 0)
        alt_m = alt_mm / 1000.0
        heading_cd = int(getattr(msg, "heading", 0) or 0)
        heading = (heading_cd / 100.0) % 360.0 if heading_cd else 0.0

        self._by_icao[icao] = {
            "icao": icao,
            "callsign": _decode_callsign(getattr(msg, "callsign", b"")) or None,
            "lat": lat,
            "lng": lng,
            "alt_m": alt_m,
            "heading": heading,
            "hor_velocity_ms": float(getattr(msg, "hor_velocity", 0) or 0) / 100.0,
            "ver_velocity_ms": float(getattr(msg, "ver_velocity", 0) or 0) / 100.0,
            "emitter_type": int(getattr(msg, "emitter_type", 0) or 0),
            "squawk": int(getattr(msg, "squawk", 0) or 0),
            "last_seen": now,
        }
        self._prune(now)

    def _prune(self, now: float) -> None:
        stale = [k for k, v in self._by_icao.items() if now - float(v["last_seen"]) > self.stale_s]
        for k in stale:
            del self._by_icao[k]
        over = len(self._by_icao) - self.max_tracks
        if over <= 0:
            return
        pairs = sorted(self._by_icao.items(), key=lambda kv: float(kv[1]["last_seen"]))
        for k, _ in pairs[:over]:
            del self._by_icao[k]

    def to_list(self) -> List[Dict[str, Any]]:
        now = time.time()
        self._prune(now)
        return sorted(self._by_icao.values(), key=lambda r: int(r["icao"]))
