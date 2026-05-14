import asyncio
import json
import logging
import time

import zmq
import zmq.asyncio
from replay_manager import ReplayManager

logger = logging.getLogger(__name__)

class TelemetryPublisher:
    def __init__(self, port: int = 5556, preflight_manager=None):
        self.port = port
        self.context = zmq.asyncio.Context()
        self.socket = self.context.socket(zmq.PUB)
        self.running = False
        self._next_adsb_pub = 0.0
        self.preflight_manager = preflight_manager
        
        # Initialize ReplayManager with a callback to our socket
        async def _publish_callback(payload):
            try:
                await self.socket.send_string(json.dumps(payload))
            except Exception as e:
                logger.error(f"ZMQ Publish callback error: {e}")
        self.replay_manager = ReplayManager(publish_callback=_publish_callback)
        
    def start(self):
        bind_addr = f"tcp://127.0.0.1:{self.port}"
        self.socket.bind(bind_addr)
        self.running = True
        logger.info(f"ZeroMQ Telemetry Publisher bound to {bind_addr}")
        
    async def _send_zmq(self, payload: dict):
        if self.replay_manager and self.replay_manager.is_recording:
            self.replay_manager.record_event(payload)
        try:
            await self.socket.send_string(json.dumps(payload))
        except Exception as e:
            logger.error(f"ZMQ Publish error: {e}")
            
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
                await self._send_zmq(status_payload)

                if hasattr(link_manager, "parameter_manager") and link_manager.parameter_manager:
                    await self._send_zmq({
                        "type": "PARAM_SYNC_STATUS",
                        "data": link_manager.parameter_manager.to_status()
                    })

                if hasattr(link_manager, "command_manager") and link_manager.command_manager:
                    await self._send_zmq({
                        "type": "COMMAND_STATUS",
                        "data": link_manager.command_manager.to_status()
                    })

                if hasattr(link_manager, "mission_manager") and link_manager.mission_manager:
                    await self._send_zmq({
                        "type": "MISSION_SYNC_STATUS",
                        "data": link_manager.mission_manager.transfer_status
                    })

                now = time.time()
                if now >= self._next_adsb_pub and link_manager and getattr(link_manager, "adsb_store", None):
                    self._next_adsb_pub = now + 1.0
                    tracks = link_manager.adsb_store.to_list()
                    await self._send_zmq({"type": "ADSB_UPDATE", "tracks": tracks})

            if link_manager:
                for _sysid, vehicle in sorted(link_manager.vehicles.items()):
                    payload = {
                        "type": "TELEMETRY_UPDATE",
                        "vehicle_id": vehicle.sysid,
                        "data": vehicle.to_dict()
                    }
                    await self._send_zmq(payload)

                    if self.preflight_manager:
                        preflight_status = self.preflight_manager.evaluate(vehicle)
                        preflight_payload = {
                            "type": "PREFLIGHT_STATUS",
                            "vehicle_id": vehicle.sysid,
                            "data": preflight_status
                        }
                        await self._send_zmq(preflight_payload)
                        
            # Broadcast replay status if needed (though playback loop handles its own, we might want periodic live status too)
            # Replay manager handles it natively now.

            # 10 Hz
            await asyncio.sleep(0.1)
            
    def stop(self):
        self.running = False
        self.socket.close()
        self.context.term()
