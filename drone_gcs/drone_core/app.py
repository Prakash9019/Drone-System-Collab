import asyncio
import logging
from dataclasses import asdict
from typing import Any, Dict, List

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from mavlink_link import MAVLinkLink, ConnectionState
from mission import MissionItem, load_waypoints, save_waypoints
from telemetry_pub import TelemetryPublisher
from vehicle_state import VehicleState

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI(title="Drone Core API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global instances
link = MAVLinkLink()
publisher = TelemetryPublisher()
publish_task = None
active_websockets: List[WebSocket] = []
websocket_lock = asyncio.Lock()

class ConnectRequest(BaseModel):
    url: str
    baud: int = 57600

@app.on_event("startup")
async def startup_event():
    global publish_task
    publish_task = asyncio.create_task(telemetry_publish_loop())
    logger.info("Drone Core API started")

@app.on_event("shutdown")
async def shutdown_event():
    global publish_task
    if publish_task:
        publish_task.cancel()
    await link.disconnect()
    publisher.close()
    logger.info("Drone Core API shut down")

async def telemetry_publish_loop():
    """Publish telemetry at 10 Hz."""
    logger.info("Starting telemetry publish loop at 10 Hz")
    while True:
        try:
            if link.state == ConnectionState.CONNECTED:
                for sysid, state in link.vehicles.items():
                    await publisher.publish(state)
                    await broadcast_telemetry(sysid, state)
            await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Error in telemetry publish loop: %s", exc)
            await asyncio.sleep(1.0)

async def broadcast_telemetry(sysid: int, state: VehicleState) -> None:
    payload = {
        "sysid": sysid,
        "state": asdict(state),
    }
    serialized = payload

    async with websocket_lock:
        if not active_websockets:
            return
        for websocket in list(active_websockets):
            try:
                await websocket.send_json(serialized)
            except Exception as exc:
                logger.warning("Removing failed websocket client: %s", exc)
                active_websockets.remove(websocket)

@app.websocket("/ws/telemetry")
async def telemetry_websocket(ws: WebSocket):
    await ws.accept()
    async with websocket_lock:
        active_websockets.append(ws)
    logger.info("WebSocket client connected")
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    finally:
        async with websocket_lock:
            if ws in active_websockets:
                active_websockets.remove(ws)

@app.post("/api/connect")
async def connect(req: ConnectRequest):
    if link.state != ConnectionState.DISCONNECTED:
        raise HTTPException(status_code=400, detail="Already connected or connecting")
    try:
        await link.connect(req.url, baud=req.baud)
        return {"status": "connected", "sysid": link._target_system, "compid": link._target_component}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=500, detail="Connection timeout: did not receive heartbeat within timeout. Make sure MAVProxy is running and forwarding to the specified endpoint.")
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=f"Connection failed: {str(exc)}")
    except Exception as exc:
        logger.exception("Unexpected error during connect:")
        raise HTTPException(status_code=500, detail=f"Unexpected error: {type(exc).__name__}: {str(exc)}")

@app.post("/api/disconnect")
async def disconnect():
    await link.disconnect()
    return {"status": "disconnected"}

class CommandRequest(BaseModel):
    command: int
    params: List[float] = [0.0] * 7

@app.post("/api/command")
async def send_command(request: CommandRequest):
    try:
        link.send_command_long(
            request.command,
            *request.params[:7],
        )
        return {"status": "sent", "command": request.command}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

@app.post("/api/mission/upload")
async def upload_mission(items: List[MissionItem]):
    try:
        await link.upload_mission([item.to_dict() for item in items])
        return {"status": "uploaded", "count": len(items)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/mission/download")
async def download_mission():
    try:
        items = await link.download_mission()
        return {"status": "downloaded", "items": items}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

@app.post("/api/mission/import")
async def import_mission(path: str):
    try:
        items = load_waypoints(path)
        return {"status": "imported", "items": [item.to_dict() for item in items]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

@app.post("/api/mission/export")
async def export_mission(path: str, items: List[MissionItem]):
    try:
        save_waypoints(path, items)
        return {"status": "exported", "path": path}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/state")
async def get_state() -> Dict[str, Any]:
    if link.state != ConnectionState.CONNECTED:
        return {"status": link.state.value, "vehicles": {}}
    
    return {
        "status": link.state.value,
        "vehicles": {str(sysid): asdict(state) for sysid, state in link.vehicles.items()}
    }
