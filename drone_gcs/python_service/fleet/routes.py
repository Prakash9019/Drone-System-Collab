"""Fleet API routes — drone_id-scoped counterparts of the legacy single-drone routes.

Legacy unscoped routes in main.py keep working against the "default" session;
these routes address any registered session explicitly. Route logic mirrors the
legacy handlers 1:1 so behavior stays identical per drone.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from fleet.session_registry import SessionRegistry
from fleet.drone_session import DroneSession
from mission_models import MissionTransferRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/fleet", tags=["fleet"])

_registry: Optional[SessionRegistry] = None


def set_registry(registry: SessionRegistry) -> None:
    global _registry
    _registry = registry


def _require_session(drone_id: str) -> DroneSession:
    if _registry is None:
        raise HTTPException(status_code=500, detail="Fleet registry not initialized")
    try:
        return _registry.require(drone_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown drone_id: {drone_id}")


# ── request models ───────────────────────────────────────────────────────────
class DroneRegistration(BaseModel):
    drone_id: str | None = None
    name: str | None = None
    connection_string: str = "auto"
    baudrate: int = 115200
    udp_forwarding_endpoints: list[str] = []
    metadata: dict = {}
    auto_connect: bool = False


class ConnectionStartRequest(BaseModel):
    connection_string: str | None = None
    baudrate: int | None = None


class CommandRequest(BaseModel):
    command: int
    p1: float = 0
    p2: float = 0
    p3: float = 0
    p4: float = 0
    p5: float = 0
    p6: float = 0
    p7: float = 0


class ModeRequest(BaseModel):
    mode: str


class VehicleSelectRequest(BaseModel):
    sysid: int


class ParameterSetRequest(BaseModel):
    param_id: str
    param_value: float


# ── fleet-level ──────────────────────────────────────────────────────────────
@router.get("")
async def fleet_summary():
    if _registry is None:
        raise HTTPException(status_code=500, detail="Fleet registry not initialized")
    return _registry.fleet_summary()


@router.get("/drones")
async def list_drones():
    if _registry is None:
        raise HTTPException(status_code=500, detail="Fleet registry not initialized")
    return {"drones": [s.to_summary() for s in _registry.all()]}


@router.post("/drones", status_code=201)
async def register_drone(req: DroneRegistration):
    if _registry is None:
        raise HTTPException(status_code=500, detail="Fleet registry not initialized")
    try:
        session = _registry.create(
            drone_id=req.drone_id,
            name=req.name,
            connection_string=req.connection_string,
            baudrate=req.baudrate,
            udp_forwarding_endpoints=req.udp_forwarding_endpoints,
            metadata=req.metadata,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if req.auto_connect:
        await session.connect()
    return session.to_summary()


@router.delete("/drones/{drone_id}")
async def deregister_drone(drone_id: str):
    if _registry is None:
        raise HTTPException(status_code=500, detail="Fleet registry not initialized")
    try:
        removed = await _registry.remove(drone_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not removed:
        raise HTTPException(status_code=404, detail=f"Unknown drone_id: {drone_id}")
    return {"status": "removed", "drone_id": drone_id}


# ── per-drone: identity / connection ─────────────────────────────────────────
@router.get("/drones/{drone_id}")
async def drone_summary(drone_id: str):
    return _require_session(drone_id).to_summary()


@router.post("/drones/{drone_id}/connection/start")
async def drone_connection_start(drone_id: str, req: ConnectionStartRequest):
    session = _require_session(drone_id)
    lm = session.link_manager
    if lm._connect_lock.locked():
        return {
            "status": "connect_in_progress",
            "connection_state": lm.connection_state.value,
            "diagnostics": lm.connection_diagnostics(),
        }
    success = await session.connect(req.connection_string, req.baudrate)
    return {
        "status": "connected" if success else "failed",
        "connection_state": lm.connection_state.value,
        "diagnostics": lm.connection_diagnostics(),
    }


@router.post("/drones/{drone_id}/connection/stop")
async def drone_connection_stop(drone_id: str):
    session = _require_session(drone_id)
    await session.disconnect()
    return {"status": "stopped"}


@router.get("/drones/{drone_id}/connection/status")
async def drone_connection_status(drone_id: str):
    lm = _require_session(drone_id).link_manager
    return {
        "connection_state": lm.connection_state.value,
        "primary_sysid": lm.primary_sysid,
        "last_heartbeat": lm.last_heartbeat_time,
        "running": lm.running,
        "vehicles": lm.list_vehicles_payload(),
        "diagnostics": lm.connection_diagnostics(),
    }


# ── per-drone: state / vehicles ──────────────────────────────────────────────
@router.get("/drones/{drone_id}/state")
async def drone_state(drone_id: str):
    lm = _require_session(drone_id).link_manager
    if not lm.primary_sysid:
        return {"error": "No vehicle connected", "connection_state": lm.connection_state.value}
    vehicle = lm.vehicles.get(lm.primary_sysid)
    if vehicle:
        return vehicle.to_dict()
    return {"error": "Vehicle state not found"}


@router.get("/drones/{drone_id}/vehicles")
async def drone_vehicles(drone_id: str):
    lm = _require_session(drone_id).link_manager
    return {"primary_sysid": lm.primary_sysid, "vehicles": lm.list_vehicles_payload()}


@router.post("/drones/{drone_id}/vehicles/select")
async def drone_vehicle_select(drone_id: str, req: VehicleSelectRequest):
    lm = _require_session(drone_id).link_manager
    if not lm.select_primary(int(req.sysid)):
        raise HTTPException(status_code=400, detail="Unknown vehicle sysid")
    return {"status": "ok", "primary_sysid": lm.primary_sysid}


# ── per-drone: commands / mode ───────────────────────────────────────────────
@router.post("/drones/{drone_id}/command")
async def drone_command(drone_id: str, req: CommandRequest):
    lm = _require_session(drone_id).link_manager
    if not lm.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    out = await lm.send_command(
        lm.primary_sysid, lm.primary_compid, req.command,
        req.p1, req.p2, req.p3, req.p4, req.p5, req.p6, req.p7,
    )
    return {"status": "success" if out.get("accepted") else "failed", **out}


@router.post("/drones/{drone_id}/mode")
async def drone_set_mode(drone_id: str, req: ModeRequest):
    lm = _require_session(drone_id).link_manager
    if not lm.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    if lm.set_mode(lm.primary_sysid, req.mode):
        return {"status": "success"}
    raise HTTPException(status_code=500, detail="Failed to set mode")


# ── per-drone: mission ───────────────────────────────────────────────────────
@router.get("/drones/{drone_id}/mission")
async def drone_get_mission(drone_id: str, mission_type: str = "MISSION"):
    session = _require_session(drone_id)
    items = await session.mission_manager.download_mission(mission_type=mission_type)
    ts = session.mission_manager.transfer_status or {}
    if ts.get("ok") is False:
        raise HTTPException(status_code=500, detail={
            "error": "mission_download_failed",
            "mission_type": mission_type.upper(),
            "transfer": ts,
        })
    return {"items": [item.to_dict() for item in items], "mission_type": mission_type.upper()}


@router.post("/drones/{drone_id}/mission/upload")
async def drone_upload_mission(drone_id: str, request: MissionTransferRequest):
    session = _require_session(drone_id)
    success = await session.mission_manager.upload_mission(request.items, mission_type=request.mission_type)
    if success:
        return {"status": "success", "mission_type": request.mission_type.upper()}
    raise HTTPException(status_code=500, detail={
        "error": "mission_upload_failed",
        "mission_type": request.mission_type.upper(),
        "transfer": session.mission_manager.transfer_status,
    })


@router.get("/drones/{drone_id}/mission/transfer/status")
async def drone_mission_transfer_status(drone_id: str):
    return _require_session(drone_id).mission_manager.transfer_status


# ── per-drone: parameters ────────────────────────────────────────────────────
@router.post("/drones/{drone_id}/parameters/refresh")
async def drone_parameters_refresh(drone_id: str):
    session = _require_session(drone_id)
    if not session.link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    ok = await session.parameter_manager.fetch_all()
    return {"status": "success" if ok else "partial", "sync_status": session.parameter_manager.to_status()}


@router.get("/drones/{drone_id}/parameters/status")
async def drone_parameters_status(drone_id: str):
    return _require_session(drone_id).parameter_manager.to_status()


@router.post("/drones/{drone_id}/parameters/set")
async def drone_parameters_set(drone_id: str, req: ParameterSetRequest):
    session = _require_session(drone_id)
    if not session.link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    result = await session.parameter_manager.set_parameter_verified(req.param_id, req.param_value)
    if result.get("ok"):
        return {"status": "success", "value": result.get("value")}
    raise HTTPException(status_code=500, detail={
        "error": result.get("error", "Set parameter failed"),
        "rolled_back": result.get("rolled_back", False),
    })
