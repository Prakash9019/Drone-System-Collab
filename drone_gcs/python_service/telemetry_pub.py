import asyncio
import zmq
import zmq.asyncio
import json
import logging

logger = logging.getLogger(__name__)

class TelemetryPublisher:
    def __init__(self, port: int = 5556):
        self.port = port
        self.context = zmq.asyncio.Context()
        self.socket = self.context.socket(zmq.PUB)
        self.running = False
        
    def start(self):
        bind_addr = f"tcp://127.0.0.1:{self.port}"
        self.socket.bind(bind_addr)
        self.running = True
        logger.info(f"ZeroMQ Telemetry Publisher bound to {bind_addr}")
        
    async def publish_loop(self, link_manager):
        """Continuously publish vehicle state at 10Hz."""
        while self.running:
            if link_manager and link_manager.primary_sysid:
                vehicle = link_manager.vehicles.get(link_manager.primary_sysid)
                if vehicle:
                    payload = {
                        "type": "TELEMETRY_UPDATE",
                        "vehicle_id": vehicle.sysid,
                        "data": vehicle.to_dict()
                    }
                    try:
                        # Publish as JSON string
                        await self.socket.send_string(json.dumps(payload))
                    except Exception as e:
                        logger.error(f"ZMQ Publish error: {e}")
            
            # 10 Hz
            await asyncio.sleep(0.1)
            
    def stop(self):
        self.running = False
        self.socket.close()
        self.context.term()
