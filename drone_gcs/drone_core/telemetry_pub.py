import asyncio
import json
import logging
from dataclasses import asdict
import zmq
import zmq.asyncio

from vehicle_state import VehicleState

logger = logging.getLogger(__name__)

class TelemetryPublisher:
    def __init__(self, bind_address: str = "tcp://127.0.0.1:5556"):
        self.bind_address = bind_address
        self.context = zmq.asyncio.Context()
        self.socket = self.context.socket(zmq.PUB)
        self.socket.bind(self.bind_address)
        logger.info("ZeroMQ PUB socket bound to %s", self.bind_address)

    async def publish(self, state: VehicleState):
        """Publish vehicle state as JSON over ZeroMQ."""
        try:
            state_dict = asdict(state)
            message = json.dumps(state_dict).encode('utf-8')
            await self.socket.send_multipart([b"telemetry", message])
        except Exception as exc:
            logger.error("Failed to publish telemetry: %s", exc)

    def close(self):
        self.socket.close()
        self.context.term()
        logger.info("ZeroMQ publisher closed")
