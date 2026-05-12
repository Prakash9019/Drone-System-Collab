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
        try:
            await link_manager.close()
        except Exception:
            pass
        await asyncio.sleep(0.35)
        link_manager.original_connection_string = cs
        link_manager.connection_string = cs
        ok = await link_manager.connect()
        logger.info("SITL auto-connect finished ok=%s state=%s url=%s", ok, link_manager.connection_state, cs)
        return {"ok": bool(ok), "connection_state": link_manager.connection_state.value}
    except Exception as e:
        logger.warning("SITL auto-connect failed: %s", e)
        return {"ok": False, "error": str(e)}
