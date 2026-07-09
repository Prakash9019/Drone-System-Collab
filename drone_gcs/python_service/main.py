from __future__ import annotations

import asyncio
import logging
import os

# GStreamer (gi) needs Homebrew's dylibs on macOS — inject before any gi import
if os.uname().sysname == "Darwin":
    _brew_lib = "/opt/homebrew/lib"
    _dyld = os.environ.get("DYLD_LIBRARY_PATH", "")
    if _brew_lib not in _dyld:
        os.environ["DYLD_LIBRARY_PATH"] = f"{_brew_lib}:{_dyld}".rstrip(":")
import shlex
import shutil
import tempfile
import time as _time
from contextlib import asynccontextmanager
from fastapi import FastAPI, BackgroundTasks, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
import uvicorn
from typing import List
from mavlink_link import LinkManager
from mission_manager import MissionManager
from mission_models import MissionItem, MissionTransferRequest
from telemetry_pub import TelemetryPublisher
from preflight_manager import PreflightManager
from parameter_manager import ParameterSyncManager
from sitl_manager import SITLManager
from sitl_orchestrator import schedule_sitl_auto_connect, simulation_capabilities
from osd_manager import OSDProfileManager
from log_analyzer import analyze_file, analysis_to_csv
from parameter_metadata import get_metadata_map
from connection_manager import list_serial_ports_detailed
from param_format import parse_param_text, format_param_text, diff_param_dicts
from video_service import get_video_manager
from camera_manager import CameraManager

class ReplayStartRequest(BaseModel):
    session_id: str

class ReplaySeekRequest(BaseModel):
    time_s: float

# Setup basic logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s')
logger = logging.getLogger(__name__)

link_manager = None
mission_manager = None
telemetry_publisher = None
parameter_manager = None
sitl_manager = None
osd_manager = None
preflight_manager = None
camera_manager = None


def _get_primary_telemetry() -> dict | None:
    """SubtitleWriter's telemetry source — the primary vehicle's live state dict."""
    if not link_manager or not link_manager.primary_sysid:
        return None
    vehicle = link_manager.vehicles.get(link_manager.primary_sysid)
    return vehicle.to_dict() if vehicle else None

# ─── Compass calibration progress (populated via MAG_CAL callback) ────────────
_mag_cal_data: dict = {}

def _mag_cal_callback(mtype: str, msg) -> None:
    global _mag_cal_data
    cid = int(getattr(msg, 'compass_id', 0))
    if mtype == 'MAG_CAL_PROGRESS':
        _mag_cal_data[cid] = {
            'type': 'progress',
            'pct': float(getattr(msg, 'completion_pct', 0)),
            'cal_status': int(getattr(msg, 'cal_status', 0)),
            'ts': _time.time(),
        }
    elif mtype == 'MAG_CAL_REPORT':
        _mag_cal_data[cid] = {
            'type': 'report',
            'cal_status': int(getattr(msg, 'cal_status', 0)),
            'fitness': float(getattr(msg, 'fitness', 0.0)),
            'ofs_x': float(getattr(msg, 'ofs_x', 0)),
            'ofs_y': float(getattr(msg, 'ofs_y', 0)),
            'ofs_z': float(getattr(msg, 'ofs_z', 0)),
            'autosaved': int(getattr(msg, 'autosaved', 0)),
            'ts': _time.time(),
        }

# ─── Accel cal position tracking (populated when FC sends COMMAND_LONG 42429) ─
_accel_cal_pos: int = 0  # 0=none, 1=Level, 2=Left, 3=Right, 4=NoseDown, 5=NoseUp, 6=Back

def _accel_cal_pos_callback(pos: int) -> None:
    global _accel_cal_pos
    _accel_cal_pos = pos

_sitl_bg_tasks: set[asyncio.Task] = set()
_sitl_auto_connect_task: asyncio.Task | None = None


def _register_bg_task(task: asyncio.Task) -> None:
    _sitl_bg_tasks.add(task)
    task.add_done_callback(lambda t: _sitl_bg_tasks.discard(t))


@asynccontextmanager
async def lifespan(app: FastAPI):
    global link_manager, mission_manager, telemetry_publisher, parameter_manager, sitl_manager, osd_manager, preflight_manager, camera_manager
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
    preflight_manager = PreflightManager()
    # Video subsystem's telemetry source is wired up front so SubtitleWriter can
    # sample it the moment a recording starts, even before video routes are hit.
    camera_manager = CameraManager(link_manager, get_video_manager(get_telemetry=_get_primary_telemetry))
    link_manager.camera_manager = camera_manager
    # Register MAG_CAL callback for compass calibration progress
    link_manager._mag_cal_cb = _mag_cal_callback
    # Register accel cal position callback (FC sends COMMAND_LONG 42429 to request each position)
    link_manager._accel_cal_pos_cb = _accel_cal_pos_callback
    
    # Setup ZMQ Telemetry Publisher
    telemetry_publisher = TelemetryPublisher(port=5556, preflight_manager=preflight_manager)
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
    try:
        await get_video_manager().shutdown()
    except Exception:
        logger.exception("video manager shutdown failed")

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
    ts = mission_manager.transfer_status or {}
    if ts.get("ok") is False:
        raise HTTPException(status_code=500, detail={
            "error": "mission_download_failed",
            "mission_type": mission_type.upper(),
            "transfer": ts,
        })
    return {"items": [item.to_dict() for item in items], "mission_type": mission_type.upper()}


@app.get("/mission/transfer/status")
async def mission_transfer_status():
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    return mission_manager.transfer_status

@app.get("/mission/history")
async def mission_history():
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    return {"history": list(mission_manager.mission_history)}

@app.get("/preflight/history")
async def get_preflight_history():
    if not preflight_manager:
        raise HTTPException(status_code=500, detail="Preflight manager not initialized")
    return {"history": list(preflight_manager.history)}

@app.post("/replay/record/start")
async def start_recording():
    if not telemetry_publisher or not telemetry_publisher.replay_manager:
        raise HTTPException(status_code=500, detail="Replay manager not initialized")
    session_id = telemetry_publisher.replay_manager.start_recording()
    return {"session_id": session_id}

@app.post("/replay/record/stop")
async def stop_recording():
    if not telemetry_publisher or not telemetry_publisher.replay_manager:
        raise HTTPException(status_code=500, detail="Replay manager not initialized")
    telemetry_publisher.replay_manager.stop_recording()
    return {"status": "stopped"}

@app.get("/replay/sessions")
async def list_replay_sessions():
    if not telemetry_publisher or not telemetry_publisher.replay_manager:
        raise HTTPException(status_code=500, detail="Replay manager not initialized")
    sessions = telemetry_publisher.replay_manager.list_sessions()
    return {"sessions": sessions}

@app.post("/replay/playback/start")
async def start_playback(req: ReplayStartRequest):
    if not telemetry_publisher or not telemetry_publisher.replay_manager:
        raise HTTPException(status_code=500, detail="Replay manager not initialized")
    try:
        await telemetry_publisher.replay_manager.start_playback(req.session_id)
        return {"status": "playing", "session_id": req.session_id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/replay/playback/stop")
async def stop_playback():
    if not telemetry_publisher or not telemetry_publisher.replay_manager:
        raise HTTPException(status_code=500, detail="Replay manager not initialized")
    await telemetry_publisher.replay_manager.stop_playback()
    return {"status": "stopped"}

@app.post("/replay/playback/pause")
async def pause_playback():
    if telemetry_publisher and telemetry_publisher.replay_manager:
        telemetry_publisher.replay_manager.pause_playback()
    return {"status": "paused"}

@app.post("/replay/playback/resume")
async def resume_playback():
    if telemetry_publisher and telemetry_publisher.replay_manager:
        telemetry_publisher.replay_manager.resume_playback()
    return {"status": "resumed"}

@app.post("/replay/playback/seek")
async def seek_playback(req: ReplaySeekRequest):
    if telemetry_publisher and telemetry_publisher.replay_manager:
        telemetry_publisher.replay_manager.seek_playback(req.time_s)
    return {"status": "seeking", "time_s": req.time_s}

@app.post("/mission/upload")
async def upload_mission(request: MissionTransferRequest):
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    
    success = await mission_manager.upload_mission(request.items, mission_type=request.mission_type)
    if success:
        return {"status": "success", "mission_type": request.mission_type.upper()}
    else:
        raise HTTPException(status_code=500, detail={
            "error": "mission_upload_failed",
            "mission_type": request.mission_type.upper(),
            "transfer": mission_manager.transfer_status,
        })

@app.get("/fence")
async def get_fence():
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    items = await mission_manager.download_mission(mission_type="FENCE")
    ts = mission_manager.transfer_status or {}
    if ts.get("ok") is False:
        raise HTTPException(status_code=500, detail={
            "error": "fence_download_failed",
            "mission_type": "FENCE",
            "transfer": ts,
        })
    return {"items": [item.to_dict() for item in items], "mission_type": "FENCE"}

@app.post("/fence/upload")
async def upload_fence(request: MissionTransferRequest):
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    success = await mission_manager.upload_mission(request.items, mission_type="FENCE")
    if success:
        return {"status": "success", "mission_type": "FENCE"}
    raise HTTPException(status_code=500, detail={
        "error": "fence_upload_failed",
        "mission_type": "FENCE",
        "transfer": mission_manager.transfer_status,
    })

@app.get("/fence/status")
async def fence_status():
    params = {}
    if parameter_manager:
        params = parameter_manager.parameters
    fs = None
    if link_manager and link_manager.primary_sysid in link_manager.vehicles:
        v = link_manager.vehicles[link_manager.primary_sysid]
        fs = {
            "breach_status": int(v.fence_status.breach_status),
            "breach_type": int(v.fence_status.breach_type),
            "breach_count": int(v.fence_status.breach_count),
            "breach_time": int(v.fence_status.breach_time),
            "breach_mitigation": int(v.fence_status.breach_mitigation),
            "last_breach_text": v.fence_status.last_breach_text,
            "last_breach_text_ts": v.fence_status.last_breach_text_ts,
            "valid": bool(v.fence_status.valid),
        }
    return {
        "enabled": bool(int(params.get("FENCE_ENABLE", 0))),
        "action": int(params.get("FENCE_ACTION", 0)),
        "fence_type": int(params.get("FENCE_TYPE", 7)),
        "radius": float(params.get("FENCE_RADIUS", 0.0)),
        "alt_max": float(params.get("FENCE_ALT_MAX", 0.0)),
        "alt_min": float(params.get("FENCE_ALT_MIN", 0.0)),
        "margin": float(params.get("FENCE_MARGIN", 2.0)),
        "fence_status_msg": fs,
    }

class FenceConfigRequest(BaseModel):
    enabled: bool
    action: int
    radius: float
    alt_max: float
    alt_min: float
    margin: float = 2.0
    # FENCE_TYPE bitmask (1=altmax 2=circle 4=polygon 8=altmin). Optional — when None
    # FENCE_TYPE is left untouched so the user's Setup→Parameters value survives.
    fence_type: int | None = None

@app.post("/fence/config")
async def fence_config(req: FenceConfigRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")

    if req.radius > 0 and req.margin >= req.radius:
        raise HTTPException(
            status_code=400,
            detail=f"FENCE_MARGIN ({req.margin}m) must be less than FENCE_RADIUS ({req.radius}m). ArduPilot rejects this configuration with 'Circle FENCE_MARGIN is greater than FENCE_RADIUS'."
        )

    # Write order matters: set FENCE_RADIUS before FENCE_MARGIN so ArduPilot never sees
    # margin >= radius mid-write, then enable last so the fence activates only after all
    # parameters are consistent. FENCE_TYPE just before ENABLE so polygon/circle/altmax
    # selection takes effect at the same instant the fence comes online.
    writes = [
        ("FENCE_ACTION", float(req.action)),
        ("FENCE_ALT_MAX", float(req.alt_max)),
        ("FENCE_ALT_MIN", float(req.alt_min)),
        ("FENCE_RADIUS", float(req.radius)),
        ("FENCE_MARGIN", float(req.margin)),
    ]
    if req.fence_type is not None:
        writes.append(("FENCE_TYPE", float(int(req.fence_type) & 0xF)))
    writes.append(("FENCE_ENABLE", 1.0 if req.enabled else 0.0))
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
    ts = mission_manager.transfer_status or {}
    if ts.get("ok") is False:
        raise HTTPException(status_code=500, detail={
            "error": "rally_download_failed",
            "mission_type": "RALLY",
            "transfer": ts,
        })
    return {"items": [item.to_dict() for item in items], "mission_type": "RALLY"}

@app.post("/rally/upload")
async def upload_rally(request: MissionTransferRequest):
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    success = await mission_manager.upload_mission(request.items, mission_type="RALLY")
    if success:
        return {"status": "success", "mission_type": "RALLY"}
    raise HTTPException(status_code=500, detail={
        "error": "rally_upload_failed",
        "mission_type": "RALLY",
        "transfer": mission_manager.transfer_status,
    })

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
        return {
            "status": "connect_in_progress",
            "connection_state": link_manager.connection_state.value,
            "diagnostics": link_manager.connection_diagnostics(),
        }

    success = await link_manager.connect()
    if success and parameter_manager:
        parameter_manager.load_cache()
    return {
        "status": "connected" if success else "failed",
        "connection_state": link_manager.connection_state.value,
        "diagnostics": link_manager.connection_diagnostics(),
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
        "diagnostics": link_manager.connection_diagnostics(),
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


@app.post("/parameters/reset")
async def reset_parameters_to_defaults():
    """Reset all vehicle parameters to firmware defaults via MAV_CMD_PREFLIGHT_STORAGE (245, p1=2).
    A vehicle reboot is required for the reset to take full effect."""
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")

    out = await link_manager.send_command(
        link_manager.primary_sysid,
        link_manager.primary_compid,
        245,    # MAV_CMD_PREFLIGHT_STORAGE
        2.0,    # param1=2: reset to defaults
        0, 0, 0, 0, 0, 0,
    )
    if parameter_manager:
        parameter_manager.parameters.clear()
    return {
        "status": "reset_sent" if out.get("accepted") else "reset_queued",
        "message": "Parameter reset command sent. Reboot the flight controller for changes to take full effect.",
        **out,
    }


@app.post("/calibration/run")
async def run_calibration(req: CalibrationRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    kind = (req.kind or "").strip().lower()
    if not kind:
        raise HTTPException(status_code=400, detail="Calibration kind is required")

    # MAV_CMD_PREFLIGHT_CALIBRATION = 241:
    #   p1=1 gyro cal · p2=1 mag · p3=1 ground pressure · p4=1 RC cal / 2 RC trim ·
    #   p5=1 accel 6-pos · p5=2 board level · p5=4 simple accel ·
    #   p6=1 compass-motor / 2 airspeed · p7=1 ESC cal
    # MAV_CMD_DO_START_MAG_CAL = 42424: p1=0(all), p2=1(retry), p3=1(autosave)
    # Parity reference: Mission Planner ConfigAccelerometerCalibration.BUT_level_Click sends p5=2;
    # QGroundControl Vehicle.cc CalibrationLevel sets param5=2.
    presets = {
        "accelerometer": {"command": 241, "p5": 1.0},
        "compass":       {"command": 42424, "p1": 0.0, "p2": 1.0, "p3": 1.0},
        "level":         {"command": 241, "p5": 2.0},
        "esc":           {"command": 241, "p1": 3.0},
        "gyro":          {"command": 241, "p1": 1.0},
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


class AccelConfirmRequest(BaseModel):
    position: int = 0  # FC-requested position: 1=Level 2=Left 3=Right 4=NoseDown 5=NoseUp 6=Back

@app.post("/calibration/accel_confirm")
async def accel_confirm(req: AccelConfirmRequest):
    """Send ACCELCAL_VEHICLE_POS (42429) confirmation back to vehicle after user places drone."""
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    global _accel_cal_pos
    pos = req.position if req.position > 0 else _accel_cal_pos
    out = await link_manager.send_command(
        link_manager.primary_sysid,
        link_manager.primary_compid,
        42429,      # MAV_CMD_ACCELCAL_VEHICLE_POS
        float(pos), # param1: position enum (1-6) matching what FC sent
        retries=1,
    )
    return {"status": "ok" if out.get("accepted") else "sent", "position": pos, **out}


@app.post("/calibration/compass_cancel")
async def compass_cancel():
    """Send DO_CANCEL_MAG_CAL (42426) to stop compass calibration on the vehicle."""
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    global _mag_cal_data
    _mag_cal_data.clear()
    out = await link_manager.send_command(
        link_manager.primary_sysid,
        link_manager.primary_compid,
        42426,  # MAV_CMD_DO_CANCEL_MAG_CAL
        0.0,    # p1=0: cancel all compasses
        retries=1,
    )
    return {"status": "cancelled", **out}


# ─── Calibration status (STATUSTEXT + compass progress + accel pos) ──────────
@app.get("/calibration/status")
async def calibration_status_endpoint():
    msgs = []
    if link_manager and link_manager.primary_sysid:
        vs = link_manager.vehicles.get(link_manager.primary_sysid)
        if vs and hasattr(vs, 'status_messages'):
            now = _time.time()
            for m in vs.status_messages[-30:]:
                try:
                    msgs.append({
                        'text': str(getattr(m, 'text', '')),
                        'severity': int(getattr(m, 'severity', 6)),
                        'ts': float(getattr(m, 'timestamp', now)),
                    })
                except Exception:
                    pass
    # Compass progress: filter stale entries (>30s)
    now = _time.time()
    compass = {k: v for k, v in _mag_cal_data.items() if now - v.get('ts', 0) < 30}
    return {
        "messages": msgs,
        "compass_progress": compass,
        "accel_requested_pos": _accel_cal_pos,  # 0=none, 1-6=position FC is requesting
    }


# ─── Motor test ───────────────────────────────────────────────────────────────
class MotorTestRequest(BaseModel):
    motor_number: int = 1   # 1-indexed; 0 = stop all motors
    throttle_pct: float = 5.0
    duration_s: float = 2.0

@app.post("/motor_test")
async def run_motor_test(req: MotorTestRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    motor_num = int(req.motor_number)
    throttle = max(0.0, min(30.0, float(req.throttle_pct)))  # hard cap at 30%
    duration = max(0.0, min(10.0, float(req.duration_s)))

    # motor_number == 0 → stop all: fire throttle=0, duration=0 to every motor 1-8
    # Mirror MP's stopMotors() which sends N back-to-back commands in a tight loop.
    if motor_num <= 0:
        if link_manager.conn:
            for m in range(1, 9):
                try:
                    link_manager.conn.mav.command_long_send(
                        link_manager.primary_sysid,
                        link_manager.primary_compid,
                        209,        # MAV_CMD_DO_MOTOR_TEST
                        0,          # confirmation
                        float(m),   # p1: motor (1-indexed)
                        0.0,        # p2: throttle type = percent
                        0.0,        # p3: 0% throttle
                        0.0,        # p4: 0s duration
                        0.0, 0.0, 0.0,
                    )
                except Exception:
                    pass
        return {"status": "ok", "motor": "all", "throttle_pct": 0, "duration_s": 0, "stopped": True}

    motor = max(1, min(8, motor_num))
    # MAV_CMD_DO_MOTOR_TEST = 209
    out = await link_manager.send_command(
        link_manager.primary_sysid,
        link_manager.primary_compid,
        209,
        float(motor),    # p1: motor number (1-indexed)
        0.0,             # p2: throttle type 0=%, 1=PWM
        float(throttle), # p3: throttle %
        float(duration), # p4: timeout seconds
        0.0, 0.0, 0.0,
    )
    return {"status": "ok" if out.get("accepted") else "failed",
            "motor": motor, "throttle_pct": throttle, "duration_s": duration, **out}


# ─── Setup: parameter helpers ────────────────────────────────────────────────
def _get_params(keys: list) -> dict:
    if not parameter_manager:
        return {}
    return {k: parameter_manager.parameters.get(k) for k in keys}

async def _set_params_verified(updates: dict) -> dict:
    results = {}
    for pid, val in updates.items():
        try:
            out = await parameter_manager.set_parameter_verified(pid, float(val))
            results[pid] = out
        except Exception as e:
            results[pid] = {"ok": False, "error": str(e), "rolled_back": False}
    return results


# ─── Setup: Flight Modes ─────────────────────────────────────────────────────
_FLIGHT_MODE_PARAMS = ['FLTMODE1', 'FLTMODE2', 'FLTMODE3', 'FLTMODE4', 'FLTMODE5', 'FLTMODE6']

class FlightModesRequest(BaseModel):
    modes: dict

@app.get("/setup/flight_modes")
async def get_flight_modes():
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    return {"modes": _get_params(_FLIGHT_MODE_PARAMS)}

@app.post("/setup/flight_modes")
async def set_flight_modes(req: FlightModesRequest):
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    updates = {k: v for k, v in req.modes.items() if k in _FLIGHT_MODE_PARAMS}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid flight mode params")
    results = await _set_params_verified(updates)
    all_ok = all(r.get("ok", False) for r in results.values())
    return {"status": "ok" if all_ok else "partial", "results": results}


# ─── Setup: Failsafe ────────────────────────────────────────────────────────
_FAILSAFE_PARAMS = [
    'FS_BATT_ENABLE', 'FS_BATT_VOLTAGE', 'FS_BATT_MAH',
    'FS_RC_ENABLE', 'FS_GCS_ENABLE',
    'FS_EKF_ACTION', 'FS_EKF_THRESH',
    'RTL_ALT', 'LAND_SPEED',
    'FS_CRASH_CHECK', 'FS_VIBE_ENABLE',
]

class FailsafeRequest(BaseModel):
    params: dict

@app.get("/setup/failsafe")
async def get_failsafe():
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    return {"params": _get_params(_FAILSAFE_PARAMS)}

@app.post("/setup/failsafe")
async def set_failsafe(req: FailsafeRequest):
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    updates = {k: v for k, v in req.params.items() if k in _FAILSAFE_PARAMS}
    results = await _set_params_verified(updates)
    all_ok = all(r.get("ok", False) for r in results.values())
    return {"status": "ok" if all_ok else "partial", "results": results}


# ─── Setup: Battery Monitor ──────────────────────────────────────────────────
_BATTERY_PARAMS = [
    'BATT_MONITOR', 'BATT_VOLT_PIN', 'BATT_CURR_PIN',
    'BATT_VOLT_MULT', 'BATT_AMP_PERVLT',
    'BATT_CAPACITY', 'BATT_LOW_VOLT', 'BATT_CRT_VOLT',
    'BATT_LOW_MAH', 'BATT_CRT_MAH',
    'BATT_ARM_VOLT', 'BATT_ARM_MAH',
]

class BatteryConfigRequest(BaseModel):
    params: dict

@app.get("/setup/battery")
async def get_battery_config():
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    return {"params": _get_params(_BATTERY_PARAMS)}

@app.post("/setup/battery")
async def set_battery_config(req: BatteryConfigRequest):
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    updates = {k: v for k, v in req.params.items() if k in _BATTERY_PARAMS}
    results = await _set_params_verified(updates)
    all_ok = all(r.get("ok", False) for r in results.values())
    return {"status": "ok" if all_ok else "partial", "results": results}


# ─── Setup: Radio Calibration ────────────────────────────────────────────────
def _radio_param_list() -> list:
    keys = []
    for i in range(1, 17):
        for s in ['MIN', 'MAX', 'TRIM', 'DZ', 'REVERSED']:
            keys.append(f'RC{i}_{s}')
    return keys

class RadioCalRequest(BaseModel):
    params: dict

@app.get("/setup/radio")
async def get_radio_config():
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    return {"params": _get_params(_radio_param_list())}

@app.post("/setup/radio")
async def set_radio_config(req: RadioCalRequest):
    if not parameter_manager:
        raise HTTPException(status_code=500, detail="Parameter manager not initialized")
    valid = set(_radio_param_list())
    updates = {k: v for k, v in req.params.items() if k in valid}
    results = await _set_params_verified(updates)
    all_ok = all(r.get("ok", False) for r in results.values())
    return {"status": "ok" if all_ok else "partial", "results": results, "written": len(updates)}


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
    global _sitl_auto_connect_task
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
        # Keep only one auto-connect worker to avoid close/reconnect races.
        if _sitl_auto_connect_task and not _sitl_auto_connect_task.done():
            _sitl_auto_connect_task.cancel()
        task = asyncio.create_task(
            schedule_sitl_auto_connect(
                link_manager,
                req.mavlink_connection_string.strip(),
                req.auto_connect_delay_s,
            )
        )
        _sitl_auto_connect_task = task
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

@app.get("/video/state")
async def video_state():
    return get_video_manager().state()


@app.get("/video/settings")
async def video_settings_get():
    return get_video_manager().settings.to_dict()


@app.put("/video/settings")
async def video_settings_put(patch: dict):
    return await get_video_manager().update_settings(patch)


@app.post("/video/start")
async def video_start():
    return await get_video_manager().start()


@app.post("/video/stop")
async def video_stop():
    return await get_video_manager().stop()


@app.post("/video/record/start")
async def video_record_start(body: dict | None = None):
    fmt = (body or {}).get("format")
    try:
        return await get_video_manager().start_recording(fmt)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/video/record/stop")
async def video_record_stop():
    return await get_video_manager().stop_recording()


@app.post("/video/snapshot")
async def video_snapshot():
    try:
        png_bytes = await get_video_manager().snapshot()
    except (RuntimeError, asyncio.TimeoutError) as e:
        raise HTTPException(status_code=409, detail=str(e))
    from fastapi.responses import Response
    return Response(content=png_bytes, media_type="image/png")


@app.get("/cameras")
async def cameras_list():
    if not camera_manager:
        return []
    return camera_manager.list_cameras()


@app.post("/cameras/{sysid}/{compid}/{stream_id}/select")
async def cameras_select_stream(sysid: int, compid: int, stream_id: int):
    if not camera_manager:
        raise HTTPException(status_code=500, detail="camera manager not initialized")
    ok = await camera_manager.select_stream(sysid, compid, stream_id)
    if not ok:
        raise HTTPException(status_code=404, detail="camera/stream not found")
    return {"ok": True}


@app.websocket("/ws/video/raw")
async def video_raw_ws(ws: WebSocket):
    """WebCodecs fallback: binary frames `[timestamp_us: u64 BE][NAL payload]`."""
    await ws.accept()
    vm = get_video_manager()
    peer = None

    async def send_bytes(data: bytes) -> None:
        try:
            await ws.send_bytes(data)
        except Exception:
            logger.debug("raw video send failed (peer likely closed)")

    try:
        peer = await vm.attach_raw_peer(send_bytes)
    except Exception as e:
        await ws.close(code=1011, reason=str(e))
        return

    try:
        while True:
            # Client has nothing to send us on this channel; just keep the
            # connection alive and detect disconnects.
            await ws.receive()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("raw video ws loop error")
    finally:
        if peer:
            await vm.detach_raw_peer(peer.peer_id)


@app.websocket("/ws/video/signaling")
async def video_signaling(ws: WebSocket):
    """WebRTC signaling: browser ⇄ webrtcbin.

    Protocol (JSON over WS):
      server → client: {"type":"offer","sdp":...}, {"type":"ice","candidate":{...}}
      client → server: {"type":"answer","sdp":...}, {"type":"ice","candidate":{...}}
    """
    await ws.accept()
    vm = get_video_manager()
    peer = None

    async def send(msg: dict) -> None:
        try:
            await ws.send_json(msg)
        except Exception:
            logger.debug("signaling send failed (peer likely closed)")

    try:
        peer = await vm.attach_peer(send)
    except Exception as e:
        await ws.send_json({"type": "error", "message": str(e)})
        await ws.close()
        return

    try:
        while True:
            msg = await ws.receive_json()
            await peer.on_client_message(msg)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("signaling loop error")
    finally:
        if peer:
            await vm.detach_peer(peer.peer_id)


if __name__ == "__main__":
    # IMPORTANT for serial/Bluetooth reliability:
    # running with auto-reload can leave overlapping processes during restart,
    # causing stale COM/BLE sessions and dead MAVLink links.
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
