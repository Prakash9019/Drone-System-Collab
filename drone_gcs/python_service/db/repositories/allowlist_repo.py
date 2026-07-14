"""Connection allow-list — closes F2 (unvalidated connection_string → SSRF-class
dial-out). Every connection string is parsed and matched against the org's rows
BEFORE it reaches mavutil.mavlink_connection().
"""
from __future__ import annotations

import fnmatch
import ipaddress
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select

from db.repositories.base import BaseRepository, row_to_dict
from db.schema import connection_allowlist

DEFAULT_ORG_ID = "default"


def parse_connection_string(cs: str) -> Tuple[str, Optional[str], Optional[int], Optional[str]]:
    """Return (scheme, host, port, device) for a mavutil connection string.

    Handles: 'auto', 'tcp:host:port', 'udp|udpin|udpout:host:port',
    'serial:/dev/ttyUSB0:baud', bare device paths ('/dev/ttyACM0', 'COM3').
    scheme ∈ {serial, tcp, udp}. Unknown → ('unknown', ...).
    """
    cs = (cs or "").strip()
    if cs == "" or cs.lower() == "auto":
        return ("serial", None, None, None)  # autodetect scans serial devices

    lower = cs.lower()
    if lower.startswith(("/dev/", "com")) and ":" not in cs.split("/")[-1]:
        return ("serial", None, None, cs)

    if ":" not in cs:
        # bare device name without a scheme
        return ("serial", None, None, cs)

    head, rest = cs.split(":", 1)
    head = head.lower()

    if head in ("serial",):
        parts = rest.rsplit(":", 1)
        device = parts[0]
        return ("serial", None, None, device)

    if head in ("tcp", "tcpin", "tcpout"):
        scheme = "tcp"
    elif head in ("udp", "udpin", "udpout", "udpbcast"):
        scheme = "udp"
    else:
        return ("unknown", None, None, None)

    host, port = None, None
    hp = rest.split(":")
    if len(hp) >= 1 and hp[0]:
        host = hp[0]
    if len(hp) >= 2 and hp[1]:
        try:
            port = int(hp[1])
        except ValueError:
            port = None
    return (scheme, host, port, None)


def _host_matches(pattern: Optional[str], host: Optional[str]) -> bool:
    if pattern is None or pattern == "*":
        return True
    if host is None:
        return False
    if "/" in pattern:  # CIDR
        try:
            return ipaddress.ip_address(host) in ipaddress.ip_network(pattern, strict=False)
        except ValueError:
            return False
    return fnmatch.fnmatch(host, pattern)


class AllowlistRepo(BaseRepository):
    async def list_for_org(self, org_id: str = DEFAULT_ORG_ID) -> List[Dict[str, Any]]:
        async with self._sm() as session:
            rows = (await session.execute(
                select(connection_allowlist).where(connection_allowlist.c.org_id == org_id)
            )).fetchall()
        return [row_to_dict(r) for r in rows]

    async def is_allowed(self, connection_string: str, *, org_id: str = DEFAULT_ORG_ID,
                         baudrate: Optional[int] = None) -> bool:
        scheme, host, port, device = parse_connection_string(connection_string)
        if scheme == "unknown":
            return False
        for row in await self.list_for_org(org_id):
            if row["scheme"] != scheme:
                continue
            if scheme == "serial":
                glob = row.get("device_glob")
                if device is None:            # 'auto' — any serial entry authorizes autodetect
                    return True
                if glob and fnmatch.fnmatch(device, glob):
                    return True
                continue
            # tcp/udp
            if not _host_matches(row.get("host_pattern"), host):
                continue
            pmin, pmax = row.get("port_min"), row.get("port_max")
            if port is None:
                return True                   # host allowed, no port to restrict
            if pmin is not None and port < pmin:
                continue
            if pmax is not None and port > pmax:
                continue
            return True
        return False

    async def add(self, *, org_id: str = DEFAULT_ORG_ID, scheme: str,
                  host_pattern: Optional[str] = None, port_min: Optional[int] = None,
                  port_max: Optional[int] = None, device_glob: Optional[str] = None) -> Dict[str, Any]:
        row = {
            "id": uuid.uuid4().hex, "org_id": org_id, "scheme": scheme,
            "host_pattern": host_pattern, "port_min": port_min, "port_max": port_max,
            "device_glob": device_glob, "created_at": time.time(),
        }
        async with self._sm() as session:
            async with session.begin():
                await session.execute(connection_allowlist.insert().values(**row))
        return row
