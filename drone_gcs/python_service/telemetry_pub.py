import asyncio
import json
import logging
import time

import zmq
import zmq.asyncio
from replay_manager import ReplayManager

logger = logging.getLogger(__name__)

class TelemetryPublisher:
    def __init__(self, port: int = 5556, preflight_manager=None, *,
                 health=None, metrics=None,
                 send_max_retries: int = 3, send_backoff_ms: int = 50):
        self.port = port
        self.context = zmq.asyncio.Context()
        self.socket = self.context.socket(zmq.PUB)
        self.running = False
        self._next_adsb_pub = {}
        self.preflight_manager = preflight_manager
        # Phase 5A: optional observability hooks (health + metrics) and a bounded
        # retry policy for transient ZMQ send failures. All optional so legacy
        # callers (and tests) constructing TelemetryPublisher(port=...) keep working.
        self.health = health
        self.metrics = metrics
        self.send_max_retries = max(0, int(send_max_retries))
        self.send_backoff_ms = max(1, int(send_backoff_ms))

        # Initialize ReplayManager with a callback to our socket
        async def _publish_callback(payload):
            await self._send_zmq(payload)
        self.replay_manager = ReplayManager(publish_callback=_publish_callback)

    def start(self):
        bind_addr = f"tcp://127.0.0.1:{self.port}"
        self.socket.bind(bind_addr)
        self.running = True
        if self.health:
            self.health.set_publisher_up(True)
        if self.metrics:
            try:
                self.metrics.zmq_publisher_up.set(1)
            except Exception:
                logger.exception("failed to set zmq_publisher_up gauge")
        logger.info("ZeroMQ Telemetry Publisher bound", extra={"bind_addr": bind_addr})

    async def _send_zmq(self, payload: dict):
        if self.replay_manager and self.replay_manager.is_recording:
            self.replay_manager.record_event(payload)
        # Bounded retry with linear backoff — a transient send failure no longer
        # silently drops the frame; only an exhausted retry budget does, and that
        # is counted so it's visible in /metrics.
        attempt = 0
        while True:
            try:
                await self.socket.send_string(json.dumps(payload))
                if self.metrics:
                    try:
                        self.metrics.telemetry_frames_published.labels(
                            drone_id=str(payload.get("drone_id") or "default"),
                            type=str(payload.get("type") or "UNKNOWN"),
                        ).inc()
                    except Exception:
                        pass
                return
            except Exception as e:
                attempt += 1
                if self.metrics:
                    try:
                        self.metrics.telemetry_publish_errors.inc()
                    except Exception:
                        pass
                if attempt > self.send_max_retries:
                    logger.error("ZMQ Publish error (giving up)",
                                 extra={"error": str(e), "attempts": attempt})
                    return
                await asyncio.sleep(self.send_backoff_ms / 1000.0 * attempt)
            
    async def _publish_for_link(self, link_manager, drone_id=None, preflight_manager=None):
        """One 10 Hz tick's worth of messages for a single drone link.

        drone_id is additive on every payload — omitted (None → key stripped)
        in legacy single-drone mode so wire shape is byte-identical to before.
        """
        def _env(payload: dict) -> dict:
            if drone_id is not None:
                payload["drone_id"] = drone_id
            return payload

        status_payload = _env({
            "type": "CONNECTION_STATUS",
            "data": {
                "connection_state": link_manager.connection_state.value,
                "primary_sysid": link_manager.primary_sysid,
                "last_heartbeat": link_manager.last_heartbeat_time,
                "running": link_manager.running,
                "vehicles": link_manager.list_vehicles_payload(),
            }
        })
        await self._send_zmq(status_payload)

        if hasattr(link_manager, "parameter_manager") and link_manager.parameter_manager:
            await self._send_zmq(_env({
                "type": "PARAM_SYNC_STATUS",
                "data": link_manager.parameter_manager.to_status()
            }))

        if hasattr(link_manager, "command_manager") and link_manager.command_manager:
            await self._send_zmq(_env({
                "type": "COMMAND_STATUS",
                "data": link_manager.command_manager.to_status()
            }))

        if hasattr(link_manager, "mission_manager") and link_manager.mission_manager:
            await self._send_zmq(_env({
                "type": "MISSION_SYNC_STATUS",
                "data": link_manager.mission_manager.transfer_status
            }))

        now = time.time()
        adsb_key = drone_id or "__default__"
        if now >= self._next_adsb_pub.get(adsb_key, 0.0) and getattr(link_manager, "adsb_store", None):
            self._next_adsb_pub[adsb_key] = now + 1.0
            tracks = link_manager.adsb_store.to_list()
            await self._send_zmq(_env({"type": "ADSB_UPDATE", "tracks": tracks}))

        pf = preflight_manager or self.preflight_manager
        for _sysid, vehicle in sorted(link_manager.vehicles.items()):
            await self._send_zmq(_env({
                "type": "TELEMETRY_UPDATE",
                "vehicle_id": vehicle.sysid,
                "data": vehicle.to_dict()
            }))

            if pf:
                preflight_status = pf.evaluate(vehicle)
                await self._send_zmq(_env({
                    "type": "PREFLIGHT_STATUS",
                    "vehicle_id": vehicle.sysid,
                    "data": preflight_status
                }))

    async def publish_loop(self, source):
        """Continuously publish vehicle state at 10Hz.

        source is either a LinkManager (legacy single-drone mode) or a
        fleet SessionRegistry (publishes every session, tagged with drone_id).
        """
        is_registry = hasattr(source, "all") and hasattr(source, "fleet_summary")
        while self.running:
            tick_start = time.time()
            try:
                if source and is_registry:
                    sessions = source.all()
                    for session in sessions:
                        await self._publish_for_link(
                            session.link_manager,
                            drone_id=session.drone_id,
                            preflight_manager=session.preflight_manager,
                        )
                        if self.metrics:
                            try:
                                self.metrics.drone_last_seen_age.labels(
                                    drone_id=str(session.drone_id)
                                ).set(max(0.0, time.time() - session.last_seen))
                            except Exception:
                                pass
                    if self.metrics:
                        try:
                            self.metrics.fleet_drones.set(len(sessions))
                            self.metrics.fleet_drones_online.set(
                                sum(1 for s in sessions if s.online)
                            )
                        except Exception:
                            pass
                elif source:
                    await self._publish_for_link(source)
                # A tick that completes (even with zero sessions) proves the loop
                # is alive — feed that to readiness + metrics.
                if self.health:
                    self.health.record_tick(tick_start)
                if self.metrics:
                    try:
                        self.metrics.telemetry_ticks.inc()
                        self.metrics.telemetry_tick_duration.observe(time.time() - tick_start)
                    except Exception:
                        pass
            except Exception:
                # One bad tick must never kill the loop (F3-class resilience on the
                # publisher side). Count it and keep going.
                logger.exception("telemetry publish tick failed")
                if self.metrics:
                    try:
                        self.metrics.telemetry_tick_failures.inc()
                    except Exception:
                        pass

            # 10 Hz
            await asyncio.sleep(0.1)
            
    def stop(self):
        self.running = False
        if self.health:
            self.health.set_publisher_up(False)
        if self.metrics:
            try:
                self.metrics.zmq_publisher_up.set(0)
            except Exception:
                logger.exception("failed to clear zmq_publisher_up gauge")
        try:
            self.socket.close()
        except Exception:
            logger.exception("ZMQ socket close failed")
        try:
            self.context.term()
        except Exception:
            logger.exception("ZMQ context term failed")
