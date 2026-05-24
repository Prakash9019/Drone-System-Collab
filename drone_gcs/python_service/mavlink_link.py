import asyncio
import time
import logging
from pymavlink import mavutil
from typing import Dict, Optional, List, Set, Any
from vehicle_state import VehicleState, ConnectionState
from message_handlers import handle_message
from connection_manager import auto_detect_connection
from adsb_store import AdsbTrafficStore
from command_manager import CommandManager

logger = logging.getLogger(__name__)

class LinkManager:
    def __init__(self, connection_string: str = "auto", baudrate: int = 115200, udp_forwarding_endpoints: List[str] = None):
        self.original_connection_string = connection_string
        self.connection_string = connection_string
        self.baudrate = baudrate
        self.udp_forwarding_endpoints = udp_forwarding_endpoints or []
        self.conn: Optional[mavutil.mavfile] = None
        self.forward_conns: List[mavutil.mavfile] = []
        
        self.vehicles: Dict[int, VehicleState] = {}
        self.running = False
        self.primary_sysid = None
        self.primary_compid = None
        
        self.connection_state = ConnectionState.DISCONNECTED
        self.last_heartbeat_time = 0.0
        self.last_message_time = 0.0
        self.last_seq = -1
        self._tasks: List[asyncio.Task] = []
        self._connect_lock = asyncio.Lock()
        self._connect_task: Optional[asyncio.Task] = None
        self._expected_telemetry_types: Set[str] = {"SYS_STATUS", "GLOBAL_POSITION_INT", "ATTITUDE"}
        self._telemetry_seen_during_handshake: Set[str] = set()
        self.connect_timeout_s = 30.0
        self.heartbeat_timeout_s = 3.0
        self.heartbeat_required_for_connect = 2
        self.serial_settle_s = 0.6
        # Reconnect policy — exponential backoff. Mission Planner doubles the wait between attempts
        # so a flapping link doesn't hammer the serial driver / radio. Cap at 30 s to keep humans
        # in the loop while still letting a slow USB cable settle.
        self.reconnect_retry_delay_s = 1.0       # base / floor
        self.reconnect_retry_delay_max_s = 30.0  # ceiling
        self.reconnect_max_attempts = 0          # 0 = unlimited (Mission Planner default)
        self._reconnect_attempts = 0
        self._last_reconnect_attempt = 0.0
        self._next_reconnect_eta = 0.0
        # Last connect failure reason. None when not in an error state. One of:
        #   "auto_detect_failed", "transport_error", "no_heartbeat", "handshake_timeout",
        #   "max_attempts_reached", "user_disconnect", "unknown".
        self.last_error_reason: Optional[str] = None
        self.last_error_detail: Optional[str] = None
        # Rolling history of state transitions (newest last) — surfaced in /connection/status so the
        # operator can see "what happened in the last 10s" without tailing logs.
        self._state_history: List[Dict[str, Any]] = []
        self._state_history_max = 20
        self._pps_window_start = time.time()
        self._pps_window_packets = 0
        self.message_counts: Dict[str, int] = {}
        self.message_counts_window_started_at = time.time()
        self._streams_sent: Set[tuple] = set()
        self.adsb_store = AdsbTrafficStore()
        self.command_manager = CommandManager(self)

    async def connect(self):
        if self._connect_lock.locked():
            logger.warning("Connect request ignored; another connect attempt is in progress.")
            return False

        async with self._connect_lock:
            if self.running and self.connection_state in (ConnectionState.CONNECTED, ConnectionState.ACTIVE):
                logger.info("LinkManager is already connected.")
                return True

            if self.original_connection_string.lower() == "auto":
                detected = await auto_detect_connection()
                if detected:
                    parts = detected.split(":")
                    self.connection_string = parts[0]
                    if len(parts) > 1:
                        self.baudrate = int(parts[1])
                else:
                    logger.error("Auto-detection failed. Cannot connect.")
                    self._set_connection_state(
                        ConnectionState.DISCONNECTED,
                        reason="auto_detect_failed",
                        detail="No MAVLink device discovered during baud sweep.",
                    )
                    return False

            logger.info(f"Connecting to {self.connection_string} at baud {self.baudrate}")
            self._set_connection_state(ConnectionState.CONNECTING)

            try:
                self.purge_socket()
                self.conn = await self._open_transport_with_stabilization()
                self.running = True

                if not self.forward_conns:
                    for endpoint in self.udp_forwarding_endpoints:
                        logger.info(f"Setting up UDP forwarding to {endpoint}")
                        self.forward_conns.append(mavutil.mavlink_connection(endpoint, input=False))

                self._set_connection_state(ConnectionState.WAITING_FOR_HEARTBEAT)
                session_ok = await self._bootstrap_session()
                if not session_ok:
                    logger.error("Failed to validate MAVLink session during connect.")
                    await self._reset_transport()
                    self._set_connection_state(
                        ConnectionState.DISCONNECTED,
                        reason="no_heartbeat",
                        detail=f"No HEARTBEAT after {self.connect_timeout_s:.0f}s on {self.connection_string}",
                    )
                    return False

                self._set_connection_state(ConnectionState.CONNECTED)
                self._ensure_background_tasks()
                logger.info("MAVLink session validated and telemetry active.")
                return True
            except Exception as e:
                logger.error(f"Connection failed: {e}")
                await self._reset_transport()
                self._set_connection_state(
                    ConnectionState.DISCONNECTED,
                    reason="transport_error",
                    detail=str(e),
                )
                return False

    async def _open_transport_with_stabilization(self):
        """
        Mission Planner style: explicit close/pause/open/pause helps serial/BLE links
        settle after process restart, preventing stale dead sessions.
        """
        last_error = None
        for attempt in range(3):
            try:
                conn = mavutil.mavlink_connection(self.connection_string, baud=self.baudrate)
                await asyncio.sleep(self.serial_settle_s)

                # Transport-specific nudge for flaky serial/Bluetooth adapters.
                if hasattr(conn, "port"):
                    try:
                        if hasattr(conn.port, "dtr"):
                            conn.port.dtr = False
                            await asyncio.sleep(0.05)
                            conn.port.dtr = True
                        if hasattr(conn.port, "rts"):
                            conn.port.rts = False
                            await asyncio.sleep(0.05)
                            conn.port.rts = True
                    except Exception as e:
                        logger.debug(f"Serial stabilization toggle skipped: {e}")
                return conn
            except Exception as e:
                last_error = e
                logger.warning(f"Transport open attempt {attempt + 1}/3 failed: {e}")
                await asyncio.sleep(0.4)
        raise RuntimeError(f"Unable to open transport after retries: {last_error}")

    def _set_connection_state(self, state: ConnectionState, reason: Optional[str] = None, detail: Optional[str] = None):
        prev = self.connection_state
        self.connection_state = state
        if self.primary_sysid in self.vehicles:
            self.vehicles[self.primary_sysid].connection_state = state
        # Track diagnostic context on every state transition so the UI can show "why".
        if state == ConnectionState.CONNECTED:
            self.last_error_reason = None
            self.last_error_detail = None
            self._reconnect_attempts = 0
            self._next_reconnect_eta = 0.0
        elif reason is not None:
            self.last_error_reason = reason
            self.last_error_detail = detail
        if prev != state:
            self._state_history.append({
                "at": time.time(),
                "from": prev.value if hasattr(prev, "value") else str(prev),
                "to": state.value if hasattr(state, "value") else str(state),
                "reason": reason,
                "detail": detail,
            })
            if len(self._state_history) > self._state_history_max:
                self._state_history = self._state_history[-self._state_history_max:]

    def _next_backoff_delay(self) -> float:
        """Exponential backoff with jitter-free cap. attempt 1 → base, attempt N → min(base*2^(N-1), max)."""
        if self._reconnect_attempts <= 0:
            return self.reconnect_retry_delay_s
        delay = self.reconnect_retry_delay_s * (2 ** (self._reconnect_attempts - 1))
        return min(delay, self.reconnect_retry_delay_max_s)

    def connection_diagnostics(self) -> Dict[str, Any]:
        """Snapshot of reconnect state suitable for /connection/status."""
        now = time.time()
        return {
            "reconnect_attempts": self._reconnect_attempts,
            "next_reconnect_in_s": max(0.0, self._next_reconnect_eta - now) if self._next_reconnect_eta else 0.0,
            "reconnect_retry_delay_s": self._next_backoff_delay(),
            "last_error_reason": self.last_error_reason,
            "last_error_detail": self.last_error_detail,
            "max_attempts": self.reconnect_max_attempts,
            "heartbeat_age_s": (now - self.last_heartbeat_time) if self.last_heartbeat_time else None,
            "state_history": list(self._state_history),
        }

    def _ensure_vehicle(self, sysid: int, compid: int):
        if sysid not in self.vehicles:
            self.vehicles[sysid] = VehicleState(
                sysid=sysid,
                compid=compid,
                connection_state=self.connection_state
            )
        else:
            self.vehicles[sysid].compid = compid

    def _ensure_background_tasks(self):
        self._tasks = [task for task in self._tasks if not task.done()]
        if not any(task.get_name() == "read_loop" for task in self._tasks):
            self._tasks.append(asyncio.create_task(self.read_loop(), name="read_loop"))
        if not any(task.get_name() == "keep_alive_loop" for task in self._tasks):
            self._tasks.append(asyncio.create_task(self.keep_alive_loop(), name="keep_alive_loop"))

    async def _bootstrap_session(self) -> bool:
        self._telemetry_seen_during_handshake.clear()
        heartbeat_seen = False
        heartbeats_seen = 0
        stream_requested = False
        deadline = time.time() + self.connect_timeout_s
        last_gcs_heartbeat = 0.0

        while self.running and self.conn and time.time() < deadline:
            now = time.time()
            if now - last_gcs_heartbeat >= 1.0:
                self.conn.mav.heartbeat_send(
                    mavutil.mavlink.MAV_TYPE_GCS,
                    mavutil.mavlink.MAV_AUTOPILOT_INVALID,
                    0, 0, 0
                )
                last_gcs_heartbeat = now

            msg = self.conn.recv_match(blocking=False)
            if not msg:
                await asyncio.sleep(0.01)
                continue

            if msg.get_type() == "BAD_DATA":
                continue

            msg_type = msg.get_type()
            sysid = msg.get_srcSystem()
            compid = msg.get_srcComponent()
            self.last_message_time = now

            if msg_type == "HEARTBEAT" and getattr(msg, "type", None) != mavutil.mavlink.MAV_TYPE_GCS:
                heartbeat_seen = True
                heartbeats_seen += 1
                if self.primary_sysid is None:
                    self.primary_sysid = sysid
                    self.primary_compid = compid
                self._ensure_vehicle(sysid, compid)
                handle_message(msg, self.vehicles[sysid])
                self.last_heartbeat_time = now
                if not stream_requested and sysid == self.primary_sysid:
                    self.request_data_streams()
                    stream_requested = True
                continue

            if heartbeat_seen and sysid == self.primary_sysid:
                if msg_type in self._expected_telemetry_types:
                    self._telemetry_seen_during_handshake.add(msg_type)
                if self.primary_sysid in self.vehicles:
                    handle_message(msg, self.vehicles[self.primary_sysid])

            if heartbeats_seen >= self.heartbeat_required_for_connect and len(self._telemetry_seen_during_handshake) >= 2:
                return True

            await asyncio.sleep(0.001)

        return False

    async def _reset_transport(self):
        self.running = False
        self.vehicles.clear()
        self.primary_sysid = None
        self.primary_compid = None
        self._streams_sent.clear()
        self.last_seq = -1
        if getattr(self, "adsb_store", None):
            self.adsb_store.clear()
        self.purge_socket()

    def request_data_streams_for(self, sysid: int, compid: int):
        if not self.conn:
            return
        streams = [
            (mavutil.mavlink.MAV_DATA_STREAM_ALL, 5),
            (mavutil.mavlink.MAV_DATA_STREAM_POSITION, 10),
            (mavutil.mavlink.MAV_DATA_STREAM_EXTRA1, 10),
            (mavutil.mavlink.MAV_DATA_STREAM_EXTRA2, 10),
            (mavutil.mavlink.MAV_DATA_STREAM_EXTRA3, 5),
            (mavutil.mavlink.MAV_DATA_STREAM_EXTENDED_STATUS, 2),
            (mavutil.mavlink.MAV_DATA_STREAM_RC_CHANNELS, 5),
        ]
        for stream_id, rate in streams:
            self.conn.mav.request_data_stream_send(sysid, compid, stream_id, rate, 1)
        # ArduPilot only sends HOME_POSITION and GPS_GLOBAL_ORIGIN on request — Mission Planner
        # does the same after the heartbeat handshake. We need both to anchor the map and to
        # detect HOME ≠ EKF_ORIGIN drift, which is a common source of "drone shows in the wrong
        # spot" symptoms.
        try:
            # MAV_CMD_GET_HOME_POSITION (410) — drone replies with HOME_POSITION
            self.conn.mav.command_long_send(sysid, compid, 410, 0, 0, 0, 0, 0, 0, 0, 0)
            # MAV_CMD_REQUEST_MESSAGE (512) for GPS_GLOBAL_ORIGIN (msg id 49)
            self.conn.mav.command_long_send(sysid, compid, 512, 0, 49, 0, 0, 0, 0, 0, 0)
        except Exception as e:
            logger.debug(f"HOME/ORIGIN request skipped: {e}")

    def request_data_streams(self):
        if not self.conn or not self.primary_sysid:
            return
        self.request_data_streams_for(self.primary_sysid, self.primary_compid)

    def select_primary(self, sysid: int) -> bool:
        if sysid not in self.vehicles:
            return False
        self.primary_sysid = sysid
        self.primary_compid = self.vehicles[sysid].compid
        hb = self.vehicles[sysid].last_heartbeat
        if hb:
            self.last_heartbeat_time = hb
        self._set_connection_state(self.connection_state)
        self.request_data_streams()
        return True

    def list_vehicles_payload(self) -> List[Dict[str, Any]]:
        now = time.time()
        out: List[Dict[str, Any]] = []
        for sysid in sorted(self.vehicles.keys()):
            v = self.vehicles[sysid]
            hb_age = None
            if v.last_heartbeat:
                hb_age = max(0.0, now - v.last_heartbeat)
            out.append(
                {
                    "sysid": sysid,
                    "compid": v.compid,
                    "mode": v.status.mode,
                    "armed": v.status.armed,
                    "last_heartbeat": v.last_heartbeat,
                    "heartbeat_age_s": hb_age,
                    "is_primary": sysid == self.primary_sysid,
                }
            )
        return out

    async def read_loop(self):
        try:
            while self.running and self.conn:
                msg = self.conn.recv_match(blocking=False)
                if msg:
                    mtype = msg.get_type()
                    self.message_counts[mtype] = self.message_counts.get(mtype, 0) + 1
                    # Forward packet to other clients if configured
                    for fwd_conn in self.forward_conns:
                        try:
                            fwd_conn.write(msg.get_msgbuf())
                        except Exception as e:
                            logger.debug(f"Failed to forward msg: {e}")

                    if msg.get_type() == "BAD_DATA":
                        continue

                    if mtype == "ADSB_VEHICLE":
                        if getattr(self, "adsb_store", None):
                            self.adsb_store.ingest(msg)
                        continue

                    if msg.get_type() == 'PARAM_VALUE' and hasattr(self, 'parameter_manager') and self.parameter_manager:
                        if msg.get_srcSystem() == self.primary_sysid:
                            self.parameter_manager.on_param_value(msg)
                    
                    # Route mission messages (primary vehicle only)
                    if hasattr(self, 'mission_manager') and self.mission_manager:
                        if msg.get_srcSystem() == self.primary_sysid and msg.get_type() in [
                            'MISSION_COUNT', 'MISSION_ITEM_INT', 'MISSION_ITEM',
                            'MISSION_REQUEST_INT', 'MISSION_REQUEST', 'MISSION_ACK'
                        ]:
                            self.mission_manager.handle_mission_message(msg)
                            
                    if msg.get_type() == 'COMMAND_ACK':
                        if hasattr(self, 'command_manager') and self.command_manager:
                            self.command_manager.on_command_ack(msg)
                        
                    sysid = msg.get_srcSystem()
                    compid = msg.get_srcComponent()

                    if mtype == "HEARTBEAT" and getattr(msg, "type", None) != mavutil.mavlink.MAV_TYPE_GCS:
                        self._ensure_vehicle(sysid, compid)
                        key = (sysid, compid)
                        if key not in self._streams_sent:
                            self.request_data_streams_for(sysid, compid)
                            self._streams_sent.add(key)

                    if sysid in self.vehicles:
                        state = self.vehicles[sysid]
                        if sysid == self.primary_sysid:
                            try:
                                seq = msg.get_seq()
                            except Exception:
                                seq = 0
                            if self.last_seq != -1:
                                diff = (seq - self.last_seq) % 256
                                if diff > 1:
                                    state.link_status.total_packets_lost += (diff - 1)
                            state.link_status.total_packets_received += 1
                            self._pps_window_packets += 1
                            self.last_seq = seq
                            if state.link_status.total_packets_received > 0:
                                total = state.link_status.total_packets_received + state.link_status.total_packets_lost
                                state.link_status.packet_loss_percent = (
                                    state.link_status.total_packets_lost / total
                                ) * 100.0
                            if self.last_heartbeat_time:
                                state.link_status.heartbeat_age_s = max(
                                    0.0, time.time() - self.last_heartbeat_time
                                )
                            now = time.time()
                            elapsed = now - self._pps_window_start
                            if elapsed >= 1.0:
                                state.link_status.packets_per_second = self._pps_window_packets / elapsed
                                self._pps_window_start = now
                                self._pps_window_packets = 0

                        handle_message(msg, state)

                        # MAG_CAL callback hook for calibration progress tracking
                        if mtype in ('MAG_CAL_PROGRESS', 'MAG_CAL_REPORT'):
                            if hasattr(self, '_mag_cal_cb') and callable(self._mag_cal_cb):
                                try:
                                    self._mag_cal_cb(mtype, msg)
                                except Exception:
                                    pass

                        # Accel cal position request: ArduPilot sends COMMAND_LONG(42429) to GCS
                        # indicating which physical position to hold for the next accel cal step.
                        if mtype == 'COMMAND_LONG':
                            accel_cmd = int(getattr(msg, 'command', 0))
                            if accel_cmd == 42429 and hasattr(self, '_accel_cal_pos_cb') and callable(self._accel_cal_pos_cb):
                                try:
                                    self._accel_cal_pos_cb(int(getattr(msg, 'param1', 0)))
                                except Exception:
                                    pass

                        if mtype == 'HEARTBEAT' and sysid == self.primary_sysid:
                            self.last_heartbeat_time = time.time()
                            if self.connection_state in (ConnectionState.HEARTBEAT_LOST, ConnectionState.RECONNECTING):
                                self._set_connection_state(ConnectionState.CONNECTED)
                                logger.info("Link restored. Re-requesting streams.")
                                self.request_data_streams()
                
                # Use small sleep to yield control
                await asyncio.sleep(0.001)
        except asyncio.CancelledError:
            logger.info("read_loop cancelled.")
        except Exception as e:
            logger.error(f"read_loop error: {e}")

    async def keep_alive_loop(self):
        try:
            while self.running and self.conn:
                # Send GCS heartbeat at 1Hz
                self.conn.mav.heartbeat_send(
                    mavutil.mavlink.MAV_TYPE_GCS,
                    mavutil.mavlink.MAV_AUTOPILOT_INVALID,
                    0, 0, 0
                )
                
                # Check link loss
                if self.last_heartbeat_time and (time.time() - self.last_heartbeat_time > self.heartbeat_timeout_s):
                    if self.connection_state != ConnectionState.HEARTBEAT_LOST:
                        logger.warning("Heartbeat lost. Transitioning to HEARTBEAT_LOST.")
                        self._set_connection_state(ConnectionState.HEARTBEAT_LOST)
                    await self._attempt_reconnect()
                            
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            logger.info("keep_alive_loop cancelled.")
        except Exception as e:
            logger.error(f"keep_alive_loop error: {e}")

    async def _attempt_reconnect(self):
        if self._connect_lock.locked():
            return
        # Honour exponential backoff window. _next_reconnect_eta is the absolute time the next
        # attempt is allowed; the keep-alive loop polls us at 1 Hz and bails until then.
        now = time.time()
        if self._next_reconnect_eta and now < self._next_reconnect_eta:
            return
        # Respect optional max-attempt cap. 0 == unlimited (the Mission Planner default behaviour).
        if self.reconnect_max_attempts and self._reconnect_attempts >= self.reconnect_max_attempts:
            if self.last_error_reason != "max_attempts_reached":
                logger.error(
                    "Reconnect gave up after %d attempts.", self._reconnect_attempts
                )
                self._set_connection_state(
                    ConnectionState.DISCONNECTED,
                    reason="max_attempts_reached",
                    detail=f"Stopped retrying after {self._reconnect_attempts} attempts.",
                )
            return

        self._reconnect_attempts += 1
        delay = self._next_backoff_delay()
        self._last_reconnect_attempt = now
        self._next_reconnect_eta = now + delay

        self._set_connection_state(ConnectionState.RECONNECTING)
        logger.info(
            "Attempting MAVLink reconnect (#%d, next backoff %.1fs)...",
            self._reconnect_attempts, delay,
        )

        if self.original_connection_string.lower() == "auto":
            detected = await auto_detect_connection()
            if not detected:
                logger.warning("Auto reconnect failed: no device detected.")
                self._set_connection_state(
                    ConnectionState.HEARTBEAT_LOST,
                    reason="auto_detect_failed",
                    detail="No device on baud sweep during reconnect.",
                )
                return
            parts = detected.split(":")
            self.connection_string = parts[0]
            self.baudrate = int(parts[1]) if len(parts) > 1 else self.baudrate

        try:
            self.purge_socket()
            await asyncio.sleep(0.5)
            self.conn = await self._open_transport_with_stabilization()
            self.running = True
            self._set_connection_state(ConnectionState.WAITING_FOR_HEARTBEAT)
            session_ok = await self._bootstrap_session()
            if not session_ok:
                self._set_connection_state(
                    ConnectionState.HEARTBEAT_LOST,
                    reason="no_heartbeat",
                    detail=f"No HEARTBEAT on retry #{self._reconnect_attempts}.",
                )
                return

            self._streams_sent.clear()
            self.request_data_streams()
            self._set_connection_state(ConnectionState.CONNECTED)
            logger.info("Reconnect successful. Streams renegotiated.")
        except Exception as e:
            logger.error(f"Reconnect failed: {e}")
            self._set_connection_state(
                ConnectionState.HEARTBEAT_LOST,
                reason="transport_error",
                detail=str(e),
            )

    async def send_command(
        self, sysid: int, compid: int, command: int, p1=0, p2=0, p3=0, p4=0, p5=0, p6=0, p7=0, retries=3
    ) -> Dict[str, Any]:
        return await self.command_manager.execute_command(
            sysid, compid, command, p1, p2, p3, p4, p5, p6, p7, is_int=False, retries=retries
        )

    def list_flight_modes(self) -> List[str]:
        if not self.conn:
            return []
        try:
            mm = self.conn.mode_mapping()
            return sorted(mm.keys()) if mm else []
        except Exception as e:
            logger.debug(f"mode_mapping failed: {e}")
            return []

    def set_mode(self, sysid: int, mode: str):
        if not self.conn:
            return False
        # Get mode ID from pymavlink mode mapping
        mode_id = self.conn.mode_mapping().get(mode)
        if mode_id is None:
            logger.error(f"Unknown mode: {mode}")
            return False
        try:
            self.conn.mav.set_mode_send(
                sysid,
                mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
                mode_id
            )
            return True
        except Exception as e:
            logger.error(f"Failed to set mode {mode}: {e}")
            return False

    async def fly_to_here(self, sysid: int, compid: int, lat: float, lng: float, alt: float):
        if not self.conn: return False
        
        # 1. Set mode to GUIDED
        self.set_mode(sysid, "GUIDED")
        await asyncio.sleep(0.5) # Give it a moment to switch mode
        
        # 2. Send SET_POSITION_TARGET_GLOBAL_INT
        # type_mask: Ignore velocity and acceleration (0b0000111111111000 = 4088)
        try:
            self.conn.mav.set_position_target_global_int_send(
                0, # time_boot_ms
                sysid, compid,
                mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
                0b0000111111111000, # type_mask
                int(lat * 1e7), int(lng * 1e7), alt,
                0, 0, 0, # vx, vy, vz
                0, 0, 0, # afx, afy, afz
                0, 0 # yaw, yaw_rate
            )
            return True
        except Exception as e:
            logger.error(f"Failed to send fly_to_here: {e}")
            return False

    async def set_home_location(self, sysid: int, compid: int, lat: float, lng: float, alt: float) -> Dict[str, Any]:
        """MAV_CMD_DO_SET_HOME: use explicit lat/lng/alt (param1=0)."""
        if not self.conn:
            return {
                "accepted": False,
                "mav_result": -1,
                "mav_result_text": "NO_CONNECTION",
                "reason": "no_connection",
                "command": 179,
            }
        return await self.command_manager.execute_command(
            sysid, compid,
            mavutil.mavlink.MAV_CMD_DO_SET_HOME,
            0, 0, 0, 0,
            float(lat), float(lng), float(alt),
        )

    async def set_roi_location(self, sysid: int, compid: int, lat: float, lng: float, alt: float) -> Dict[str, Any]:
        """MAV_CMD_DO_SET_ROI_LOCATION (195)."""
        if not self.conn:
            return {
                "accepted": False,
                "mav_result": -1,
                "mav_result_text": "NO_CONNECTION",
                "reason": "no_connection",
                "command": int(mavutil.mavlink.MAV_CMD_DO_SET_ROI_LOCATION),
            }
        return await self.command_manager.execute_command(
            sysid, compid,
            mavutil.mavlink.MAV_CMD_DO_SET_ROI_LOCATION,
            0, 0, 0, 0,
            float(lat), float(lng), float(alt),
        )

    async def clear_roi(self, sysid: int, compid: int) -> Dict[str, Any]:
        """MAV_CMD_DO_SET_ROI_NONE (197)."""
        if not self.conn:
            return {
                "accepted": False,
                "mav_result": -1,
                "mav_result_text": "NO_CONNECTION",
                "reason": "no_connection",
                "command": int(mavutil.mavlink.MAV_CMD_DO_SET_ROI_NONE),
            }
        return await self.command_manager.execute_command(
            sysid,
            compid,
            mavutil.mavlink.MAV_CMD_DO_SET_ROI_NONE,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        )

    def fetch_parameters(self, sysid: int, compid: int):
        if not self.conn: return False
        self.conn.mav.param_request_list_send(sysid, compid)
        return True

    def set_parameter(self, sysid: int, compid: int, param_id: str, param_value: float, param_type: int = mavutil.mavlink.MAV_PARAM_TYPE_REAL32):
        if not self.conn: return False
        self.conn.mav.param_set_send(
            sysid, compid,
            param_id.encode('utf-8'),
            param_value,
            param_type
        )
        return True

    def purge_socket(self):
        """Violently closes the underlying serial port to free it from the OS."""
        if self.conn:
            try:
                # Try explicit pyserial close if it's a serial port
                if hasattr(self.conn, 'port') and hasattr(self.conn.port, 'close'):
                    try:
                        if hasattr(self.conn.port, "reset_input_buffer"):
                            self.conn.port.reset_input_buffer()
                        if hasattr(self.conn.port, "reset_output_buffer"):
                            self.conn.port.reset_output_buffer()
                    except Exception:
                        pass
                    self.conn.port.close()
                    logger.info("Explicitly closed underlying OS serial port.")
            except Exception as e:
                logger.debug(f"Explicit serial port close failed: {e}")
                
            try:
                self.conn.close()
            except Exception as e:
                logger.debug(f"mavutil close failed: {e}")
        self.conn = None

    async def close(self):
        logger.info("LinkManager initiating shutdown...")
        self.running = False
        self._reconnect_attempts = 0
        self._next_reconnect_eta = 0.0
        self._set_connection_state(
            ConnectionState.DISCONNECTED,
            reason="user_disconnect",
            detail="Operator-initiated disconnect.",
        )
        
        # Cancel all running tasks
        for task in self._tasks:
            task.cancel()
            
        if self._tasks:
            # Wait for tasks to clean up
            await asyncio.gather(*self._tasks, return_exceptions=True)
            self._tasks.clear()

        self.vehicles.clear()
        self.primary_sysid = None
        self.primary_compid = None
        self._streams_sent.clear()
        self.last_seq = -1
        if getattr(self, "adsb_store", None):
            self.adsb_store.clear()
        self.purge_socket()
        self.last_heartbeat_time = 0.0
        self.last_message_time = 0.0
        self._telemetry_seen_during_handshake.clear()

        for fwd_conn in self.forward_conns:
            try:
                fwd_conn.close()
            except: pass
            
        logger.info("LinkManager shutdown complete.")
