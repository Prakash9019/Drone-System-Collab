"""Builds the command-audit sink registered with CommandManager. Resolves the
flight_id (from the FlightTracker) at write time and attributes the org. The
sink swallows its own errors so auditing can never affect command execution.
"""
from __future__ import annotations

import logging
from typing import Callable, Optional

logger = logging.getLogger(__name__)


def build_command_audit_sink(commands_repo, *, org_id: str = "default",
                             flight_tracker=None) -> Callable[[dict], "object"]:
    async def sink(record: dict) -> None:
        drone_id = record.get("drone_id")
        if not drone_id:
            return  # legacy single-drone path with no drone identity — nothing to attribute
        flight_id: Optional[str] = None
        if flight_tracker is not None:
            try:
                flight_id = flight_tracker.active_flight_id(drone_id)
            except Exception:
                flight_id = None
        await commands_repo.record_command(
            drone_id=drone_id, org_id=org_id, sysid=record["sysid"], command=record["command"],
            params=record.get("params"), result=record.get("result"),
            result_text=record.get("result_text"), reason=record.get("reason"),
            source_route=record.get("source_route"), flight_id=flight_id,
            operator_id=None,  # populated in Phase 5C when auth attaches an operator
            issued_at=record.get("issued_at"),
        )

    return sink
