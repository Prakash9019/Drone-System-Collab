import asyncio
import json
import logging
import time

import zmq
import zmq.asyncio

logger = logging.getLogger(__name__)

class TelemetryPublisher:
    def __init__(self, port: int = 5556):
        self.port = port
        self.context = zmq.asyncio.Context()
        self.socket = self.context.socket(zmq.PUB)
        self.running = False
        self._next_adsb_pub = 0.0
        
    def start(self):
        bind_addr = f"tcp://127.0.0.1:{self.port}"
        self.socket.bind(bind_addr)
        self.running = True
        logger.info(f"ZeroMQ Telemetry Publisher bound to {bind_addr}")
        
    async def publish_loop(self, link_manager):
        """Continuously publish vehicle state at 10Hz."""
        while self.running:
            if link_manager:
                status_payload = {
                    "type": "CONNECTION_STATUS",
                    "data": {
                        "connection_state": link_manager.connection_state.value,
                        "primary_sysid": link_manager.primary_sysid,
                        "last_heartbeat": link_manager.last_heartbeat_time,
                        "running": link_manager.running,
                        "vehicles": link_manager.list_vehicles_payload(),
                    }
                }
                try:
                    await self.socket.send_string(json.dumps(status_payload))
                except Exception as e:
                    logger.error(f"ZMQ Publish status error: {e}")

                if hasattr(link_manager, "parameter_manager") and link_manager.parameter_manager:
                    try:
                        await self.socket.send_string(json.dumps({
                            "type": "PARAM_SYNC_STATUS",
                            "data": link_manager.parameter_manager.to_status()
                        }))
                    except Exception as e:
                        logger.error(f"ZMQ Publish param status error: {e}")

                now = time.time()
                if now >= self._next_adsb_pub and link_manager and getattr(link_manager, "adsb_store", None):
                    self._next_adsb_pub = now + 1.0
                    try:
                        tracks = link_manager.adsb_store.to_list()
                        await self.socket.send_string(
                            json.dumps({"type": "ADSB_UPDATE", "tracks": tracks})
                        )
                    except Exception as e:
                        logger.error(f"ZMQ Publish ADSB error: {e}")

            if link_manager:
                for _sysid, vehicle in sorted(link_manager.vehicles.items()):
                    payload = {
                        "type": "TELEMETRY_UPDATE",
                        "vehicle_id": vehicle.sysid,
                        "data": vehicle.to_dict()
                    }
                    try:
                        await self.socket.send_string(json.dumps(payload))
                    except Exception as e:
                        logger.error(f"ZMQ Publish error: {e}")
            
            # 10 Hz
            await asyncio.sleep(0.1)
            
    def stop(self):
        self.running = False
        self.socket.close()
        self.context.term()
