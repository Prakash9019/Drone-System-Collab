from __future__ import annotations

import asyncio
import logging
import os
import shlex
import shutil
import tempfile
from contextlib import asynccontextmanager
from fastapi import FastAPI, BackgroundTasks, File, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
import uvicorn
from typing import List
from mavlink_link import LinkManager
from mission_manager import MissionManager
from mission_models import MissionItem, MissionTransferRequest
from telemetry_pub import TelemetryPublisher
from parameter_manager import ParameterSyncManager
from sitl_manager import SITLManager
from sitl_orchestrator import schedule_sitl_auto_connect, simulation_capabilities
from osd_manager import OSDProfileManager
from log_analyzer import analyze_file, analysis_to_csv
from parameter_metadata import get_metadata_map
from connection_manager import list_serial_ports_detailed
from param_format import parse_param_text, format_param_text, diff_param_dicts

# Setup basic logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s')
logger = logging.getLogger(__name__)

link_manager = None
mission_manager = None
telemetry_publisher = None
parameter_manager = None
sitl_manager = None
osd_manager = None

_sitl_bg_tasks: set[asyncio.Task] = set()


def _register_bg_task(task: asyncio.Task) -> None:
    _sitl_bg_tasks.add(task)
    task.add_done_callback(lambda t: _sitl_bg_tasks.discard(t))


@asynccontextmanager
async def lifespan(app: FastAPI):
    global link_manager, mission_manager, telemetry_publisher, parameter_manager, sitl_manager, osd_manager
    logger.info("Starting up MAVLink Service...")
    
    # Use auto-detect by default to find serial ports, fallback to SITL if needed
    # connection_string = "auto"
    # connection_string = "udp:127.0.0.1:14550"

    connection_string = os.environ.get("DRONE_CONNECTION_STRING", "auto")
    baudrate = int(os.environ.get("DRONE_BAUDRATE", "115200"))
    fwd = os.environ.get("DRONE_UDP_FORWARD", "").strip()
    udp_endpoints = [x.strip() for x in fwd.split(",") if x.strip()]
    
    link_manager = LinkManager(
        connection_string=connection_string,
        baudrate=baudrate,
        udp_forwarding_endpoints=udp_endpoints,
    )
    mission_manager = MissionManager(link_manager)
    link_manager.mission_manager = mission_manager
    parameter_manager = ParameterSyncManager(link_manager)
    link_manager.parameter_manager = parameter_manager
    sitl_manager = SITLManager()
    osd_manager = OSDProfileManager()
    
    # Setup ZMQ Telemetry Publisher
    telemetry_publisher = TelemetryPublisher(port=5556)
    telemetry_publisher.start()
    
    tasks = [
        asyncio.create_task(telemetry_publisher.publish_loop(link_manager))
    ]
    
    yield
    
    logger.info("Shutting down MAVLink Service...")
    
    # Cancel all background tasks managed by lifespan
    for t in tasks:
        t.cancel()
    
    if telemetry_publisher:
        telemetry_publisher.stop()
    if link_manager:
        await link_manager.close()
        
    await asyncio.gather(*tasks, return_exceptions=True)

app = FastAPI(lifespan=lifespan, title="Drone GCS Python Service")

@app.get("/state")
async def get_state():
    if not link_manager or not link_manager.primary_sysid:
        return {"error": "No vehicle connected", "connection_state": link_manager.connection_state.value if link_manager else "DISCONNECTED"}
    
    vehicle = link_manager.vehicles.get(link_manager.primary_sysid)
    if vehicle:
        return vehicle.to_dict()
    return {"error": "Vehicle state not found"}

@app.get("/mission")
async def get_mission(mission_type: str = "MISSION"):
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    
    items = await mission_manager.download_mission(mission_type=mission_type)
    return {"items": [item.to_dict() for item in items], "mission_type": mission_type.upper()}


@app.get("/mission/transfer/status")
async def mission_transfer_status():
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    return mission_manager.transfer_status

@app.post("/mission/upload")
async def upload_mission(request: MissionTransferRequest):
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    
    success = await mission_manager.upload_mission(request.items, mission_type=request.mission_type)
    if success:
        return {"status": "success", "mission_type": request.mission_type.upper()}
    else:
        raise HTTPException(status_code=500, detail="Mission upload failed")

@app.get("/fence")
async def get_fence():
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    items = await mission_manager.download_mission(mission_type="FENCE")
    return {"items": [item.to_dict() for item in items], "mission_type": "FENCE"}

@app.post("/fence/upload")
async def upload_fence(request: MissionTransferRequest):
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    success = await mission_manager.upload_mission(request.items, mission_type="FENCE")
    if success:
        return {"status": "success", "mission_type": "FENCE"}
    raise HTTPException(status_code=500, detail="Fence upload failed")

@app.get("/fence/status")
async def fence_status():
    params = {}
    if parameter_manager:
        params = parameter_manager.parameters
    return {
        "enabled": bool(int(params.get("FENCE_ENABLE", 0))),
        "action": int(params.get("FENCE_ACTION", 0)),
        "radius": float(params.get("FENCE_RADIUS", 0.0)),
        "alt_max": float(params.get("FENCE_ALT_MAX", 0.0)),
        "alt_min": float(params.get("FENCE_ALT_MIN", 0.0)),
    }

class FenceConfigRequest(BaseModel):
    enabled: bool
    action: int
    radius: float
    alt_max: float
    alt_min: float

@app.post("/fence/config")
async def fence_config(req: FenceConfigRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")

    writes = [
        ("FENCE_ENABLE", 1.0 if req.enabled else 0.0),
        ("FENCE_ACTION", float(req.action)),
        ("FENCE_RADIUS", float(req.radius)),
        ("FENCE_ALT_MAX", float(req.alt_max)),
        ("FENCE_ALT_MIN", float(req.alt_min)),
    ]
    failures = []
    for param_id, value in writes:
        result = await parameter_manager.set_parameter_verified(param_id, value)
        if not result.get("ok"):
            failures.append({
                "param_id": param_id,
                "error": result.get("error", "failed"),
                "rolled_back": result.get("rolled_back", False),
            })

    if failures:
        raise HTTPException(status_code=500, detail={"status": "partial_failed", "failures": failures})
    return {"status": "success"}

@app.get("/rally")
async def get_rally():
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    items = await mission_manager.download_mission(mission_type="RALLY")
    return {"items": [item.to_dict() for item in items], "mission_type": "RALLY"}

@app.post("/rally/upload")
async def upload_rally(request: MissionTransferRequest):
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    success = await mission_manager.upload_mission(request.items, mission_type="RALLY")
    if success:
        return {"status": "success", "mission_type": "RALLY"}
    raise HTTPException(status_code=500, detail="Rally upload failed")

class ParameterSetRequest(BaseModel):
    param_id: str
    param_value: float

class FlyToRequest(BaseModel):
    lat: float
    lng: float
    alt: float

class ConnectionStartRequest(BaseModel):
    connection_string: str | None = None
    baudrate: int | None = None

# ---- REST Endpoints ----

@app.post("/connection/start")
async def start_connection(req: ConnectionStartRequest):
    if not link_manager:
        raise HTTPException(status_code=500, detail="Link manager not initialized")

    if req.connection_string:
        link_manager.original_connection_string = req.connection_string
        link_manager.connection_string = req.connection_string
    if req.baudrate:
        link_manager.baudrate = req.baudrate

    if link_manager._connect_lock.locked():
        return {"status": "connect_in_progress", "connection_state": link_manager.connection_state.value}

    success = await link_manager.connect()
    if success and parameter_manager:
        parameter_manager.load_cache()
    return {
        "status": "connected" if success else "failed",
        "connection_state": link_manager.connection_state.value
    }

@app.post("/connection/stop")
async def stop_connection():
    if not link_manager:
        raise HTTPException(status_code=500, detail="Link manager not initialized")
        
    await link_manager.close()
    return {"status": "stopped"}

@app.get("/connection/status")
async def connection_status():
    if not link_manager:
        raise HTTPException(status_code=500, detail="Link manager not initialized")
    return {
        "connection_state": link_manager.connection_state.value,
        "primary_sysid": link_manager.primary_sysid,
        "last_heartbeat": link_manager.last_heartbeat_time,
        "running": link_manager.running,
        "vehicles": link_manager.list_vehicles_payload(),
    }


@app.get("/connection/ports")
async def connection_ports():
    try:
        return {"ports": list_serial_ports_detailed()}
    except Exception as e:
        logger.warning("Serial port listing failed: %s", e)
        return {"ports": [], "error": str(e)}


@app.get("/vehicles")
async def list_vehicles():
    if not link_manager:
        raise HTTPException(status_code=500, detail="Link manager not initialized")
    return {
        "primary_sysid": link_manager.primary_sysid,
        "vehicles": link_manager.list_vehicles_payload(),
    }


class VehicleSelectRequest(BaseModel):
    sysid: int


@app.post("/vehicles/select")
async def select_vehicle(req: VehicleSelectRequest):
    if not link_manager:
        raise HTTPException(status_code=500, detail="Link manager not initialized")
    if not link_manager.select_primary(int(req.sysid)):
        raise HTTPException(status_code=400, detail="Unknown vehicle sysid")
    return {"status": "ok", "primary_sysid": link_manager.primary_sysid}


@app.get("/adsb/traffic")
async def adsb_traffic():
    if not link_manager or not getattr(link_manager, "adsb_store", None):
        raise HTTPException(status_code=500, detail="Link manager not initialized")
    tracks = link_manager.adsb_store.to_list()
    return {"count": len(tracks), "tracks": tracks}


@app.post("/logs/analyze")
async def logs_analyze(file: UploadFile = File(...)):
    name = (file.filename or "upload").strip()
    ext = os.path.splitext(name)[1].lower() or ".tlog"
    if ext not in (".tlog", ".log", ".bin"):
        ext = ".tlog"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            tmp_path = tmp.name
            shutil.copyfileobj(file.file, tmp)
        result = analyze_file(tmp_path)
        if result.get("message_counts") is not None:
            result = {**result, "csv": analysis_to_csv(result)}
        return result
    finally:
        try:
            file.file.close()
        except Exception:
            pass
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@app.get("/parameters/metadata")
async def parameters_metadata():
    meta = get_metadata_map()
    return {"count": len(meta), "params": meta}


class CommandRequest(BaseModel):
    command: int
    p1: float = 0
    p2: float = 0
    p3: float = 0
    p4: float = 0
    p5: float = 0
    p6: float = 0
    p7: float = 0

@app.post("/command")
async def send_command(req: CommandRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")

    out = await link_manager.send_command(
        link_manager.primary_sysid,
        link_manager.primary_compid,
        req.command,
        req.p1,
        req.p2,
        req.p3,
        req.p4,
        req.p5,
        req.p6,
        req.p7,
    )
    return {"status": "success" if out.get("accepted") else "failed", **out}


@app.get("/vehicle/flight_modes")
async def flight_modes():
    if not link_manager:
        raise HTTPException(status_code=500, detail="Link manager not initialized")
    return {"modes": link_manager.list_flight_modes()}

class ModeRequest(BaseModel):
    mode: str

@app.post("/mode")
async def set_mode(req: ModeRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
        
    success = link_manager.set_mode(link_manager.primary_sysid, req.mode)
    if success:
        return {"status": "success"}
    raise HTTPException(status_code=500, detail="Failed to set mode")

@app.post("/flyto")
async def fly_to(req: FlyToRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")

    success = await link_manager.fly_to_here(link_manager.primary_sysid, link_manager.primary_compid, req.lat, req.lng, req.alt)
    if success:
        return {"status": "success"}
    raise HTTPException(status_code=500, detail="Failed to fly to location")


class SetHomeRequest(BaseModel):
    lat: float
    lng: float
    alt: float = 0.0


@app.post("/vehicle/set_home")
async def vehicle_set_home(req: SetHomeRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    out = await link_manager.set_home_location(
        link_manager.primary_sysid,
        link_manager.primary_compid,
        req.lat,
        req.lng,
        req.alt,
    )
    return {"status": "success" if out.get("accepted") else "failed", **out}


@app.post("/vehicle/roi")
async def vehicle_set_roi(req: FlyToRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    out = await link_manager.set_roi_location(
        link_manager.primary_sysid,
        link_manager.primary_compid,
        req.lat,
        req.lng,
        req.alt,
    )
    return {"status": "success" if out.get("accepted") else "failed", **out}


@app.post("/vehicle/roi/clear")
async def vehicle_clear_roi():
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    out = await link_manager.clear_roi(link_manager.primary_sysid, link_manager.primary_compid)
    return {"status": "success" if out.get("accepted") else "failed", **out}


@app.post("/parameters/refresh")
async def refresh_parameters():
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
        
    ok = await parameter_manager.fetch_all()
    return {"status": "success" if ok else "partial", "sync_status": parameter_manager.to_status()}

class ParamSetRequest(BaseModel):
    param_id: str
    param_value: float

class ParameterImportRequest(BaseModel):
    parameters: dict[str, float]

class CalibrationRequest(BaseModel):
    kind: str

@app.post("/parameters/set")
async def set_parameter(req: ParamSetRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")

    result = await parameter_manager.set_parameter_verified(req.param_id, req.param_value)
    if result.get("ok"):
        return {"status": "success", "value": result.get("value")}
    raise HTTPException(
        status_code=500,
        detail={
            "error": result.get("error", "Set parameter failed"),
            "rolled_back": result.get("rolled_back", False),
        }
    )

@app.get("/parameters/export")
async def export_parameters():
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    params = dict(parameter_manager.parameters or {})
    return {"count": len(params), "parameters": params}

@app.post("/parameters/import")
async def import_parameters(req: ParameterImportRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")

    failures = []
    ok = 0
    for pid, val in req.parameters.items():
        result = await parameter_manager.set_parameter_verified(str(pid), float(val))
        if result.get("ok"):
            ok += 1
        else:
            failures.append({
                "param_id": pid,
                "error": result.get("error", "failed"),
                "rolled_back": result.get("rolled_back", False),
            })
    return {"status": "success" if not failures else "partial", "ok": ok, "failed": len(failures), "failures": failures}

@app.post("/parameters/compare")
async def compare_parameters(req: ParameterImportRequest):
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    current = parameter_manager.parameters or {}
    diffs = []
    for pid, incoming in req.parameters.items():
        cur = current.get(pid)
        if cur is None or abs(float(cur) - float(incoming)) > 1e-6:
            diffs.append({"param_id": pid, "current": cur, "incoming": incoming})
    return {"count": len(diffs), "diffs": diffs}


class ParameterParamTextRequest(BaseModel):
    text: str


@app.get("/parameters/export/param")
async def export_parameters_param():
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    params = dict(parameter_manager.parameters or {})
    body = format_param_text(params)
    return PlainTextResponse(
        content=body,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="parameters.param"'},
    )


@app.post("/parameters/import/param")
async def import_parameters_param(req: ParameterParamTextRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    parameters = parse_param_text(req.text or "")
    if not parameters:
        raise HTTPException(status_code=400, detail="No valid parameters found in .param text")

    failures = []
    ok = 0
    for pid, val in parameters.items():
        result = await parameter_manager.set_parameter_verified(str(pid), float(val))
        if result.get("ok"):
            ok += 1
        else:
            failures.append({
                "param_id": pid,
                "error": result.get("error", "failed"),
                "rolled_back": result.get("rolled_back", False),
            })
    return {"status": "success" if not failures else "partial", "ok": ok, "failed": len(failures), "failures": failures, "parsed": len(parameters)}


@app.post("/parameters/compare/param")
async def compare_parameters_param(req: ParameterParamTextRequest):
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    incoming = parse_param_text(req.text or "")
    if not incoming:
        raise HTTPException(status_code=400, detail="No valid parameters found in .param text")
    current = parameter_manager.parameters or {}
    diffs = []
    for pid, val in incoming.items():
        cur = current.get(pid)
        if cur is None or abs(float(cur) - float(val)) > 1e-6:
            diffs.append({"param_id": pid, "current": cur, "incoming": val})
    return {"count": len(diffs), "diffs": diffs, "parsed": len(incoming)}


class TwoParamTextRequest(BaseModel):
    a: str = ""
    b: str = ""


@app.post("/parameters/diff/two-param")
async def diff_two_param_files(req: TwoParamTextRequest):
    left = parse_param_text(req.a or "")
    right = parse_param_text(req.b or "")
    if not left and not right:
        raise HTTPException(status_code=400, detail="Both parameter texts are empty")
    diffs = diff_param_dicts(left, right)
    return {"count": len(diffs), "diffs": diffs, "parsed_left": len(left), "parsed_right": len(right)}


@app.post("/calibration/run")
async def run_calibration(req: CalibrationRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    kind = (req.kind or "").strip().lower()
    if not kind:
        raise HTTPException(status_code=400, detail="Calibration kind is required")

    # MAV_CMD_PREFLIGHT_CALIBRATION = 241
    # p5 accel, p6 compass, p7 level
    presets = {
        "accelerometer": {"command": 241, "p5": 1},
        "compass": {"command": 241, "p6": 1},
        "level": {"command": 241, "p7": 1},
        "esc": {"command": 241, "p1": 3},
    }
    if kind == "reboot":
        payload = {"command": 246, "p1": 1}  # MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN
    else:
        payload = presets.get(kind)
    if not payload:
        raise HTTPException(status_code=400, detail=f"Unsupported calibration kind: {kind}")

    out = await link_manager.send_command(
        link_manager.primary_sysid,
        link_manager.primary_compid,
        payload["command"],
        payload.get("p1", 0),
        payload.get("p2", 0),
        payload.get("p3", 0),
        payload.get("p4", 0),
        payload.get("p5", 0),
        payload.get("p6", 0),
        payload.get("p7", 0),
    )
    return {"status": "success" if out.get("accepted") else "failed", "kind": kind, **out}

@app.get("/mavlink/inspector")
async def mavlink_inspector():
    if not link_manager:
        raise HTTPException(status_code=500, detail="Link manager not initialized")
    counts = dict(link_manager.message_counts)
    top = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    return {
        "window_started_at": link_manager.message_counts_window_started_at,
        "total_types": len(counts),
        "counts": [{"message": k, "count": v} for k, v in top],
    }

@app.get("/parameters/status")
async def parameters_status():
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    return parameter_manager.to_status()

@app.post("/parameters/cache/load")
async def load_parameter_cache(max_age_s: float = 3600.0):
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    ok = parameter_manager.load_cache(max_age_s=max_age_s)
    return {"status": "loaded" if ok else "not_loaded", "sync_status": parameter_manager.to_status()}

class SimulationStartRequest(BaseModel):
    vehicle: str = "ArduCopter"
    model: str = "quad"
    home: str = ""
    wipe: bool = False
    speedup: int = 1
    sitl_cmd: str = ""
    extra_sim_args: str = ""
    append_default_mavproxy_out: bool = True
    auto_connect: bool = True
    auto_connect_delay_s: float = 3.5
    mavlink_connection_string: str = "udp:127.0.0.1:14550"


@app.get("/simulation/capabilities")
async def simulation_capabilities_route(sitl_cmd: str = ""):
    if not sitl_manager:
        raise HTTPException(status_code=500, detail="SITL manager not initialized")
    return simulation_capabilities(sitl_manager, sitl_cmd)


@app.post("/simulation/start")
async def simulation_start(req: SimulationStartRequest):
    if not sitl_manager:
        raise HTTPException(status_code=500, detail="SITL manager not initialized")
    extra_list = shlex.split(req.extra_sim_args) if req.extra_sim_args.strip() else []
    result = await sitl_manager.start(
        req.vehicle,
        req.model,
        req.home,
        req.wipe,
        req.speedup,
        req.sitl_cmd,
        extra_sim_args=extra_list,
        append_default_mavproxy_out=req.append_default_mavproxy_out,
    )
    if (
        result.get("status") == "started"
        and req.auto_connect
        and link_manager
        and req.mavlink_connection_string.strip()
    ):
        task = asyncio.create_task(
            schedule_sitl_auto_connect(
                link_manager,
                req.mavlink_connection_string.strip(),
                req.auto_connect_delay_s,
            )
        )
        _register_bg_task(task)
    return result

@app.post("/simulation/stop")
async def simulation_stop():
    if not sitl_manager:
        raise HTTPException(status_code=500, detail="SITL manager not initialized")
    return await sitl_manager.stop()

@app.post("/simulation/reset")
async def simulation_reset():
    if not sitl_manager:
        raise HTTPException(status_code=500, detail="SITL manager not initialized")
    return await sitl_manager.reset()

@app.get("/simulation/status")
async def simulation_status():
    if not sitl_manager:
        raise HTTPException(status_code=500, detail="SITL manager not initialized")
    return sitl_manager.status()

@app.get("/simulation/logs")
async def simulation_logs(limit: int = 200):
    if not sitl_manager:
        raise HTTPException(status_code=500, detail="SITL manager not initialized")
    return sitl_manager.get_logs(limit=limit)


@app.get("/simulation/sim_vehicle")
async def simulation_sim_vehicle_probe(sitl_cmd: str = ""):
    if not sitl_manager:
        raise HTTPException(status_code=500, detail="SITL manager not initialized")
    return sitl_manager.probe_sim_vehicle(sitl_cmd)


class SimProfileRequest(BaseModel):
    name: str
    config: dict

@app.get("/simulation/profiles")
async def simulation_profiles():
    if not sitl_manager:
        raise HTTPException(status_code=500, detail="SITL manager not initialized")
    return {"profiles": sitl_manager.list_profiles()}

@app.post("/simulation/profiles")
async def simulation_profile_save(req: SimProfileRequest):
    if not sitl_manager:
        raise HTTPException(status_code=500, detail="SITL manager not initialized")
    return sitl_manager.save_profile(req.name, req.config)

@app.delete("/simulation/profiles/{name}")
async def simulation_profile_delete(name: str):
    if not sitl_manager:
        raise HTTPException(status_code=500, detail="SITL manager not initialized")
    return sitl_manager.delete_profile(name)

class OSDProfileRequest(BaseModel):
    profile_id: str
    payload: dict

@app.get("/osd/profiles")
async def osd_profiles():
    if not osd_manager:
        raise HTTPException(status_code=500, detail="OSD manager not initialized")
    return {"profiles": osd_manager.list_profiles()}

@app.post("/osd/profiles")
async def osd_profile_save(req: OSDProfileRequest):
    if not osd_manager:
        raise HTTPException(status_code=500, detail="OSD manager not initialized")
    return osd_manager.save_profile(req.profile_id, req.payload)

@app.delete("/osd/profiles/{profile_id}")
async def osd_profile_delete(profile_id: str):
    if not osd_manager:
        raise HTTPException(status_code=500, detail="OSD manager not initialized")
    return osd_manager.delete_profile(profile_id)

if __name__ == "__main__":
    # IMPORTANT for serial/Bluetooth reliability:
    # running with auto-reload can leave overlapping processes during restart,
    # causing stale COM/BLE sessions and dead MAVLink links.
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
