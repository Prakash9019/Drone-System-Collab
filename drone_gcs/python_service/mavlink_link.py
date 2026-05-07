import asyncio
import time
import logging
from pymavlink import mavutil
from typing import Dict, Optional, List, Set
from vehicle_state import VehicleState, ConnectionState
from message_handlers import handle_message
from connection_manager import auto_detect_connection

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
        self.pending_commands = {}
        self._tasks: List[asyncio.Task] = []
        self._connect_lock = asyncio.Lock()
        self._connect_task: Optional[asyncio.Task] = None
        self._expected_telemetry_types: Set[str] = {"SYS_STATUS", "GLOBAL_POSITION_INT", "ATTITUDE"}
        self._telemetry_seen_during_handshake: Set[str] = set()
        self.connect_timeout_s = 30.0
        self.heartbeat_timeout_s = 3.0
        
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
                    self._set_connection_state(ConnectionState.DISCONNECTED)
                    return False

            logger.info(f"Connecting to {self.connection_string} at baud {self.baudrate}")
            self._set_connection_state(ConnectionState.CONNECTING)

            try:
                self.purge_socket()
                self.conn = mavutil.mavlink_connection(self.connection_string, baud=self.baudrate)
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
                    self._set_connection_state(ConnectionState.DISCONNECTED)
                    return False

                self._set_connection_state(ConnectionState.CONNECTED)
                self._ensure_background_tasks()
                logger.info("MAVLink session validated and telemetry active.")
                return True
            except Exception as e:
                logger.error(f"Connection failed: {e}")
                await self._reset_transport()
                self._set_connection_state(ConnectionState.DISCONNECTED)
                return False

    def _set_connection_state(self, state: ConnectionState):
        self.connection_state = state
        if self.primary_sysid in self.vehicles:
            self.vehicles[self.primary_sysid].connection_state = state

    def _ensure_vehicle(self, sysid: int, compid: int):
        if sysid not in self.vehicles:
            self.vehicles[sysid] = VehicleState(
                sysid=sysid,
                compid=compid,
                connection_state=self.connection_state
            )

    def _ensure_background_tasks(self):
        self._tasks = [task for task in self._tasks if not task.done()]
        if not any(task.get_name() == "read_loop" for task in self._tasks):
            self._tasks.append(asyncio.create_task(self.read_loop(), name="read_loop"))
        if not any(task.get_name() == "keep_alive_loop" for task in self._tasks):
            self._tasks.append(asyncio.create_task(self.keep_alive_loop(), name="keep_alive_loop"))

    async def _bootstrap_session(self) -> bool:
        self._telemetry_seen_during_handshake.clear()
        heartbeat_seen = False
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
                self.last_heartbeat_time = now
                if self.primary_sysid is None:
                    self.primary_sysid = sysid
                    self.primary_compid = compid
                self._ensure_vehicle(self.primary_sysid, self.primary_compid)
                handle_message(msg, self.vehicles[self.primary_sysid])
                if not stream_requested:
                    self.request_data_streams()
                    stream_requested = True
                continue

            if heartbeat_seen and sysid == self.primary_sysid:
                if msg_type in self._expected_telemetry_types:
                    self._telemetry_seen_during_handshake.add(msg_type)
                if self.primary_sysid in self.vehicles:
                    handle_message(msg, self.vehicles[self.primary_sysid])

            if heartbeat_seen and len(self._telemetry_seen_during_handshake) >= 2:
                return True

            await asyncio.sleep(0.001)

        return False

    async def _reset_transport(self):
        self.running = False
        self.purge_socket()

    def request_data_streams(self):
        if not self.conn or not self.primary_sysid:
            return
            
        streams = [
            (mavutil.mavlink.MAV_DATA_STREAM_ALL, 5), # Ask for everything at 5Hz to avoid 0s
            (mavutil.mavlink.MAV_DATA_STREAM_POSITION, 10),
            (mavutil.mavlink.MAV_DATA_STREAM_EXTRA1, 10), # Attitude
            (mavutil.mavlink.MAV_DATA_STREAM_EXTRA2, 10),  # VFR_HUD
            (mavutil.mavlink.MAV_DATA_STREAM_EXTENDED_STATUS, 2), # SYS_STATUS
            (mavutil.mavlink.MAV_DATA_STREAM_RC_CHANNELS, 5)
        ]
        
        for stream_id, rate in streams:
            self.conn.mav.request_data_stream_send(
                self.primary_sysid,
                self.primary_compid,
                stream_id,
                rate,
                1 # start
            )

    async def read_loop(self):
        try:
            while self.running and self.conn:
                msg = self.conn.recv_match(blocking=False)
                if msg:
                    # Forward packet to other clients if configured
                    for fwd_conn in self.forward_conns:
                        try:
                            fwd_conn.write(msg.get_msgbuf())
                        except Exception as e:
                            logger.debug(f"Failed to forward msg: {e}")

                    if msg.get_type() == "BAD_DATA":
                        continue
                    
                    # Route mission messages
                    if hasattr(self, 'mission_manager') and self.mission_manager:
                        if msg.get_type() in ['MISSION_COUNT', 'MISSION_ITEM_INT', 'MISSION_REQUEST_INT', 'MISSION_ACK']:
                            self.mission_manager.handle_mission_message(msg)
                            
                    if msg.get_type() == 'COMMAND_ACK':
                        cmd = msg.command
                        if cmd in self.pending_commands:
                            self.pending_commands[cmd] = msg.result
                        
                    sysid = msg.get_srcSystem()
                    if sysid == self.primary_sysid and sysid in self.vehicles:
                        # Update packet loss stats
                        state = self.vehicles[sysid]
                        seq = msg.get_seq()
                        
                        if self.last_seq != -1:
                            diff = (seq - self.last_seq) % 256
                            if diff > 1:
                                state.link_status.total_packets_lost += (diff - 1)
                                
                        state.link_status.total_packets_received += 1
                        self.last_seq = seq
                        
                        if state.link_status.total_packets_received > 0:
                            total = state.link_status.total_packets_received + state.link_status.total_packets_lost
                            state.link_status.packet_loss_percent = (state.link_status.total_packets_lost / total) * 100.0

                        handle_message(msg, state)
                        
                        if msg.get_type() == 'HEARTBEAT':
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

        self._set_connection_state(ConnectionState.RECONNECTING)
        logger.info("Attempting MAVLink reconnect...")

        if self.original_connection_string.lower() == "auto":
            detected = await auto_detect_connection()
            if not detected:
                logger.warning("Auto reconnect failed: no device detected.")
                return
            parts = detected.split(":")
            self.connection_string = parts[0]
            self.baudrate = int(parts[1]) if len(parts) > 1 else self.baudrate

        try:
            self.purge_socket()
            await asyncio.sleep(0.5)
            self.conn = mavutil.mavlink_connection(self.connection_string, baud=self.baudrate)
            self.running = True
            self._set_connection_state(ConnectionState.WAITING_FOR_HEARTBEAT)
            session_ok = await self._bootstrap_session()
            if not session_ok:
                self._set_connection_state(ConnectionState.HEARTBEAT_LOST)
                return

            self.request_data_streams()
            self._set_connection_state(ConnectionState.CONNECTED)
            logger.info("Reconnect successful. Streams renegotiated.")
        except Exception as e:
            logger.error(f"Reconnect failed: {e}")
            self._set_connection_state(ConnectionState.HEARTBEAT_LOST)

    async def send_command(self, sysid: int, compid: int, command: int, p1=0, p2=0, p3=0, p4=0, p5=0, p6=0, p7=0, retries=3):
        if not self.conn:
            return False
            
        for attempt in range(retries):
            self.pending_commands[command] = None
            try:
                self.conn.mav.command_long_send(
                    sysid, compid,
                    command,
                    0, # confirmation
                    p1, p2, p3, p4, p5, p6, p7
                )
            except Exception as e:
                logger.error(f"Failed to send command {command}: {e}")
                
            # Wait for ACK
            timeout = time.time() + 2.0
            while time.time() < timeout:
                if self.pending_commands.get(command) is not None:
                    result = self.pending_commands[command]
                    if result == mavutil.mavlink.MAV_RESULT_ACCEPTED:
                        del self.pending_commands[command]
                        return True
                    else:
                        logger.warning(f"Command {command} rejected with result {result}")
                        del self.pending_commands[command]
                        return False # Rejected, no retry
                await asyncio.sleep(0.1)
                
            logger.warning(f"Command {command} timeout, retrying {attempt+1}/{retries}...")
            
        if command in self.pending_commands:
            del self.pending_commands[command]
        return False

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
        self._set_connection_state(ConnectionState.DISCONNECTED)
        
        # Cancel all running tasks
        for task in self._tasks:
            task.cancel()
            
        if self._tasks:
            # Wait for tasks to clean up
            await asyncio.gather(*self._tasks, return_exceptions=True)
            self._tasks.clear()
            
        self.purge_socket()
        self.last_heartbeat_time = 0.0
        self.last_message_time = 0.0
        self._telemetry_seen_during_handshake.clear()
            
        for fwd_conn in self.forward_conns:
            try:
                fwd_conn.close()
            except: pass
            
        logger.info("LinkManager shutdown complete.")
