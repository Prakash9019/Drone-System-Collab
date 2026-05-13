"""
Mission Planner–style SITL orchestration helpers (no full ArduPilot clone required for *planning*,
but launching sim_vehicle still needs a tree or Docker — see capabilities payload).
"""

from __future__ import annotations

import asyncio
import logging
import platform
import sys
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Default home used in MissionPlanner/GCSViews/SITL.cs when map home is unset
MP_DEFAULT_SITL_HOME = "-35.3633515,149.1652412,584,353"


def simulation_capabilities(sitl_manager: Optional[Any], sitl_cmd: str = "") -> Dict[str, Any]:
    probe: Dict[str, Any] = {}
    if sitl_manager:
        probe = sitl_manager.probe_sim_vehicle(sitl_cmd)
    return {
        "platform": sys.platform,
        "machine": platform.machine(),
        "default_sitl_home": MP_DEFAULT_SITL_HOME,
        "recommended_mavlink_after_start": "udp:127.0.0.1:14550",
        "sim_vehicle_probe": probe,
        "mission_planner_notes": (
            "Mission Planner does not embed the simulator: it downloads Windows SITL binaries from "
            "firmware.ardupilot.org/Tools/MissionPlanner/sitl/ or runs downloaded Linux SITL builds, "
            "then connects TCP/UDP. Drone_GCS launches Tools/autotest/sim_vehicle.py when ARDUPILOT_HOME "
            "or a local tree is available, forwards MAVProxy --out to UDP 14550 by default, and can "
            "auto-connect the link after start."
        ),
        "no_clone_options": [
            "Set ARDUPILOT_HOME to any existing ArduPilot checkout (one-time git clone elsewhere).",
            "Use Docker to run sim_vehicle inside a container with --network host (see docker_hint).",
            "On Windows, install Mission Planner once and point SITL_CMD at its sitl folder sim_vehicle if exposed.",
        ],
        "docker_hint": (
            "docker run --rm --network host -it -v \"$HOME/ardupilot:/ardupilot\" "
            "ardupilot/ardupilot-dev:latest bash -lc "
            "'cd /ardupilot && Tools/autotest/sim_vehicle.py -v ArduCopter -f quad "
            "--out udp:127.0.0.1:14550'"
        ),
    }


async def schedule_sitl_auto_connect(
    link_manager: Optional[Any],
    connection_string: str,
    delay_s: float,
) -> Dict[str, Any]:
    """
    After sim_vehicle + MAVProxy are up, point LinkManager at the usual SITL UDP port and connect.
    Mirrors Mission Planner switching to the SITL link after process start.
    """
    await asyncio.sleep(max(0.5, float(delay_s)))
    if not link_manager:
        return {"ok": False, "error": "no_link_manager"}
    cs = (connection_string or "udp:127.0.0.1:14550").strip()
    if not cs:
        return {"ok": False, "error": "empty_connection_string"}
    try:
        current_state = getattr(getattr(link_manager, "connection_state", None), "value", "")
        current_cs = (getattr(link_manager, "connection_string", "") or "").strip()
        running = bool(getattr(link_manager, "running", False))

        # If we are already on the requested endpoint and healthy, do nothing.
        if running and current_cs == cs and current_state in ("CONNECTED", "ACTIVE"):
            logger.info("SITL auto-connect skipped (already connected): %s", cs)
            return {"ok": True, "skipped": True, "connection_state": current_state}

        # Switch transport only when changing endpoints. Avoid needless close/open churn.
        if running and current_cs and current_cs != cs:
            logger.info("SITL auto-connect switching endpoint %s -> %s", current_cs, cs)
            try:
                await link_manager.close()
            except Exception:
                pass
            await asyncio.sleep(0.25)

        link_manager.original_connection_string = cs
        link_manager.connection_string = cs

        # SITL/MAVProxy may need a few seconds after process spawn.
        attempts = 3
        for attempt in range(1, attempts + 1):
            ok = await link_manager.connect()
            state = getattr(getattr(link_manager, "connection_state", None), "value", "UNKNOWN")
            if ok:
                logger.info("SITL auto-connect finished ok=%s state=%s url=%s attempt=%d", ok, state, cs, attempt)
                return {"ok": True, "connection_state": state, "attempt": attempt}
            if attempt < attempts:
                await asyncio.sleep(1.0 + (attempt * 0.5))
        state = getattr(getattr(link_manager, "connection_state", None), "value", "UNKNOWN")
        logger.warning("SITL auto-connect failed after retries state=%s url=%s", state, cs)
        return {"ok": False, "connection_state": state, "attempts": attempts}
    except Exception as e:
        logger.warning("SITL auto-connect failed: %s", e)
        return {"ok": False, "error": str(e)}
