import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, BackgroundTasks, HTTPException
from pydantic import BaseModel
import uvicorn
from typing import List
from mavlink_link import LinkManager
from mission_manager import MissionManager
from mission_models import MissionItem
from telemetry_pub import TelemetryPublisher

# Setup basic logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s')
logger = logging.getLogger(__name__)

link_manager = None
mission_manager = None
telemetry_publisher = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global link_manager, mission_manager, telemetry_publisher
    logger.info("Starting up MAVLink Service...")
    
    # Use auto-detect by default to find serial ports, fallback to SITL if needed
    # connection_string = "auto"
    # connection_string = "udp:127.0.0.1:14550"

    connection_string = "/dev/tty.SIYI-6801129585"
    baudrate = 115200

    udp_endpoints = ["udpout:127.0.0.1:14550"] # Example forwarding endpoint
    
    link_manager = LinkManager(
        connection_string=connection_string,
        baudrate=baudrate,
        udp_forwarding_endpoints=[]
    )
    mission_manager = MissionManager(link_manager)
    link_manager.mission_manager = mission_manager
    
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

class MissionUploadRequest(BaseModel):
    items: List[MissionItem]

@app.get("/state")
async def get_state():
    if not link_manager or not link_manager.primary_sysid:
        return {"error": "No vehicle connected", "connection_state": link_manager.connection_state.value if link_manager else "DISCONNECTED"}
    
    vehicle = link_manager.vehicles.get(link_manager.primary_sysid)
    if vehicle:
        return vehicle.to_dict()
    return {"error": "Vehicle state not found"}

@app.get("/mission")
async def get_mission():
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    
    items = await mission_manager.download_mission()
    return {"items": [item.to_dict() for item in items]}

@app.post("/mission/upload")
async def upload_mission(request: MissionUploadRequest):
    if not mission_manager:
        raise HTTPException(status_code=500, detail="Mission manager not initialized")
    
    success = await mission_manager.upload_mission(request.items)
    if success:
        return {"status": "success"}
    else:
        raise HTTPException(status_code=500, detail="Mission upload failed")

class ParameterSetRequest(BaseModel):
    param_id: str
    param_value: float

class FlyToRequest(BaseModel):
    lat: float
    lng: float
    alt: float

# ---- REST Endpoints ----

@app.post("/connection/start")
async def start_connection():
    if not link_manager:
        raise HTTPException(status_code=500, detail="Link manager not initialized")

    if link_manager._connect_lock.locked():
        return {"status": "connect_in_progress", "connection_state": link_manager.connection_state.value}

    success = await link_manager.connect()
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
        "running": link_manager.running
    }


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
        
    success = await link_manager.send_command(
        link_manager.primary_sysid, link_manager.primary_compid,
        req.command, req.p1, req.p2, req.p3, req.p4, req.p5, req.p6, req.p7
    )
    if success:
        return {"status": "success"}
    raise HTTPException(status_code=500, detail="Command failed")

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

@app.post("/parameters/refresh")
async def refresh_parameters():
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
        
    link_manager.fetch_parameters(link_manager.primary_sysid, link_manager.primary_compid)
    return {"status": "success"}

class ParamSetRequest(BaseModel):
    param_id: str
    param_value: float

@app.post("/parameters/set")
async def set_parameter(req: ParamSetRequest):
    if not link_manager or not link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
        
    success = link_manager.set_parameter(
        link_manager.primary_sysid, link_manager.primary_compid,
        req.param_id, req.param_value
    )
    if success:
        return {"status": "success"}
    raise HTTPException(status_code=500, detail="Set parameter failed")

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
