import asyncio
import logging
import time
from collections import defaultdict
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple

from pymavlink import mavutil

try:
    from vehicle_state import VehicleState
except ImportError:
    # Placeholder until vehicle_state.py is implemented.
    from dataclasses import dataclass

    @dataclass
    class VehicleState:
        sysid: int
        compid: int

        def __post_init__(self):
            self.last_message_type: Optional[str] = None
            self.last_update: float = time.monotonic()

try:
    from message_mapper import update_state
except ImportError:
    update_state = None


ALLOWED_MESSAGE_TYPES = {
    "GLOBAL_POSITION_INT",
    "ATTITUDE",
    "VFR_HUD",
    "SYS_STATUS",
    "GPS_RAW_INT",
    "HEARTBEAT",
    "NAV_CONTROLLER_OUTPUT",
    "PARAM_VALUE",
    "MISSION_ITEM_INT",
    "MISSION_ITEM",
    "MISSION_COUNT",
    "MISSION_REQUEST_INT",
    "MISSION_REQUEST",
    "MISSION_ACK",
    "MISSION_CURRENT",
    "STATUSTEXT",
}


class ConnectionState(str, Enum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    LOST = "lost"


class MAVLinkLink:
    """Core MAVLink communication link.

    Responsibilities:
    - Open a serial/UDP/TCP/Bluetooth link.
    - Wait for 2 heartbeats before confirming a connection.
    - Maintain `vehicles` state keyed by sysid.
    - Start an async read loop and heartbeat sender.
    - Request telemetry streams and parameter list.
    - Dispatch messages to the state mapper.
    """

    def __init__(self, gcs_system_id: int = 255, gcs_component_id: int = 190):
        self.logger = logging.getLogger(__name__)
        self.gcs_system_id = gcs_system_id
        self.gcs_component_id = gcs_component_id

        self.connection: Optional[mavutil.mavlink_connection] = None
        self.vehicles: Dict[int, VehicleState] = {}
        self.component_ids: Dict[int, int] = {}
        self._heartbeat_counts: Dict[int, int] = defaultdict(int)
        self._last_heartbeat: Dict[int, float] = {}
        self._target_system: Optional[int] = None
        self._target_component: Optional[int] = None
        self.state = ConnectionState.DISCONNECTED
        self._connection_string: Optional[str] = None

        self._connect_lock = asyncio.Lock()
        self._read_task: Optional[asyncio.Task[Any]] = None
        self._heartbeat_task: Optional[asyncio.Task[Any]] = None
        self._monitor_task: Optional[asyncio.Task[Any]] = None
        self._shutdown_event = asyncio.Event()
        self._waiters: List[Tuple[Callable[[Any], bool], asyncio.Future[Any]]] = []

        self.heartbeat_timeout = 3.0
        self.required_heartbeats = 2

    async def connect(self, connection_string: str, baud: int = 57600, timeout: float = 15.0) -> None:
        """Open the MAVLink transport and perform initial handshake."""
        async with self._connect_lock:
            if self.state != ConnectionState.DISCONNECTED:
                raise RuntimeError("MAVLinkLink is already connected or connecting")

            self.state = ConnectionState.CONNECTING
            self.logger.info("Opening MAVLink connection: %s", connection_string)
            self._connection_string = connection_string

            self.connection = await asyncio.to_thread(self._open_connection, connection_string, baud)
            if self.connection is None:
                self.state = ConnectionState.DISCONNECTED
                raise RuntimeError("Failed to create MAVLink connection")

            # Ensure the connection object has a timeout on receive.
            self.connection.timeout = 1.0

            await self._wait_for_initial_heartbeats(timeout)
            if self.state != ConnectionState.CONNECTED:
                await self.disconnect()
                raise RuntimeError("Failed to confirm MAVLink connection")

            self._start_background_tasks()
            self.logger.info("MAVLink connection established: sysid=%s compid=%s", self._target_system, self._target_component)

    async def disconnect(self) -> None:
        """Shut down the read loop and close the connection."""
        self.logger.info("Disconnecting MAVLink link")
        self.state = ConnectionState.DISCONNECTED
        self._shutdown_event.set()

        tasks = [task for task in (self._read_task, self._heartbeat_task, self._monitor_task) if task is not None]
        for task in tasks:
            task.cancel()

        await asyncio.sleep(0)

        if self.connection is not None:
            try:
                self.connection.close()
            except Exception as exc:
                self.logger.warning("Error closing MAVLink connection: %s", exc)
            self.connection = None

        self._connection_string = None
        self._shutdown_event.clear()
        self._read_task = None
        self._heartbeat_task = None
        self._monitor_task = None
        self.logger.info("MAVLink disconnected")

    def _open_connection(self, connection_string: str, baud: int) -> mavutil.mavlink_connection:
        if connection_string.startswith("serial:"):
            port = connection_string[len("serial:"):]
            self.logger.info("Opening serial/Bluetooth MAVLink transport: %s @ %s", port, baud)
            return mavutil.mavlink_connection(port, baud=baud, source_system=self.gcs_system_id, source_component=self.gcs_component_id)

        if connection_string.startswith("udp:") or connection_string.startswith("tcp:") or connection_string.startswith("udpin:") or connection_string.startswith("udpout:"):
            self.logger.info("Opening network MAVLink transport: %s", connection_string)
            return mavutil.mavlink_connection(connection_string, source_system=self.gcs_system_id, source_component=self.gcs_component_id)

        self.logger.info("Opening default serial MAVLink transport: %s @ %s", connection_string, baud)
        return mavutil.mavlink_connection(connection_string, baud=baud, source_system=self.gcs_system_id, source_component=self.gcs_component_id)

    async def _wait_for_initial_heartbeats(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        self.logger.info("Waiting for %d heartbeat messages", self.required_heartbeats)

        while time.monotonic() < deadline:
            msg = await self._recv_message(timeout=1.0)
            if msg is None:
                continue

            if msg.get_type() != "HEARTBEAT":
                self._dispatch_message(msg)
                continue

            self._on_heartbeat(msg)
            sysid = msg.get_srcSystem()
            if self._heartbeat_counts[sysid] >= self.required_heartbeats:
                self._target_system = sysid
                self._target_component = msg.get_srcComponent()
                self.state = ConnectionState.CONNECTED
                self.logger.info("Confirmed heartbeat from vehicle %s:%s", self._target_system, self._target_component)
                self.request_telemetry_streams()
                self.request_param_list()
                return

        self.logger.error("Did not receive required heartbeats within %.1f seconds", timeout)
        self.state = ConnectionState.DISCONNECTED
        connection_hint = self._get_connection_string()
        if connection_hint.startswith('/dev/') or connection_hint.startswith('COM') or connection_hint.startswith('serial:'):
            raise RuntimeError(
                f"Heartbeat timeout after {timeout}s: no MAVLink heartbeat received on {connection_hint}. "
                "If you use direct serial/Bluetooth, stop MAVProxy or any other program using this port before connecting."
            )
        raise RuntimeError(
            f"Heartbeat timeout after {timeout}s: no MAVLink heartbeat received. "
            f"Is MAVProxy/the autopilot actually forwarding to {connection_hint}?"
        )

    def _get_connection_string(self) -> str:
        if self._connection_string is not None:
            return self._connection_string

        if self.connection is None:
            return "unknown"

        if hasattr(self.connection, 'device'):
            device = self.connection.device
            if isinstance(device, str):
                return device

        if hasattr(self.connection, 'port'):
            port = self.connection.port
            if isinstance(port, str):
                return port
            if hasattr(port, 'port'):
                return str(port.port)
            if hasattr(port, 'name'):
                return str(port.name)

        if hasattr(self.connection, 'target_ip'):
            target_ip = self.connection.target_ip
            target_port = getattr(self.connection, 'target_port', None)
            if target_ip is None:
                return "udp"
            return f"{target_ip}:{target_port if target_port is not None else 'unknown'}"

        return "unknown"

    def _start_background_tasks(self) -> None:
        loop = asyncio.get_running_loop()
        self._read_task = loop.create_task(self._read_loop())
        self._heartbeat_task = loop.create_task(self._heartbeat_sender_loop())
        self._monitor_task = loop.create_task(self._heartbeat_monitor_loop())

    async def _recv_message(self, timeout: float = 1.0) -> Optional[Any]:
        if self.connection is None:
            return None
        return await asyncio.to_thread(self.connection.recv_match, type=None, blocking=True, timeout=timeout)

    async def _wait_for_message(self, msg_types, predicate: Optional[Callable[[Any], bool]] = None, timeout: float = 5.0) -> Any:
        if isinstance(msg_types, str):
            msg_types = [msg_types]

        def matcher(message: Any) -> bool:
            if message.get_type() not in msg_types:
                return False
            if predicate is None:
                return True
            return predicate(message)

        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self._waiters.append((matcher, future))

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            if not future.done():
                self._waiters = [(m, f) for (m, f) in self._waiters if f is not future]

    async def _read_loop(self) -> None:
        self.logger.info("Starting MAVLink read loop")
        while not self._shutdown_event.is_set():
            msg = await self._recv_message(timeout=1.0)
            if msg is None:
                continue
            self._dispatch_message(msg)

        self.logger.info("MAVLink read loop stopped")

    def _dispatch_message(self, message: Any) -> None:
        msg_type = message.get_type()
        if msg_type not in ALLOWED_MESSAGE_TYPES:
            return

        sysid = message.get_srcSystem()
        compid = message.get_srcComponent()
        state = self._get_or_create_vehicle_state(sysid, compid)
        state.last_message_type = msg_type
        state.last_update = time.monotonic()

        if msg_type == "HEARTBEAT":
            self._on_heartbeat(message)

        if update_state is not None:
            try:
                update_state(state, message)
            except Exception as exc:
                self.logger.exception("Error updating state from message %s: %s", msg_type, exc)

        for matcher, future in list(self._waiters):
            if not future.done() and matcher(message):
                future.set_result(message)
                self._waiters.remove((matcher, future))

    def _get_or_create_vehicle_state(self, sysid: int, compid: int) -> VehicleState:
        if sysid not in self.vehicles:
            self.vehicles[sysid] = VehicleState(sysid=sysid, compid=compid)
            self.component_ids[sysid] = compid
            self.logger.info("Created vehicle state for sysid=%s compid=%s", sysid, compid)
        return self.vehicles[sysid]

    def _on_heartbeat(self, message: Any) -> None:
        sysid = message.get_srcSystem()
        compid = message.get_srcComponent()
        self._heartbeat_counts[sysid] += 1
        self._last_heartbeat[sysid] = time.monotonic()
        self.component_ids[sysid] = compid

        if self._target_system is None:
            self._target_system = sysid
            self._target_component = compid

        self.logger.debug("Heartbeat received from %s:%s (%d/%d)", sysid, compid, self._heartbeat_counts[sysid], self.required_heartbeats)

    async def _heartbeat_sender_loop(self) -> None:
        self.logger.info("Starting GCS heartbeat sender")
        while not self._shutdown_event.is_set() and self.connection is not None:
            try:
                self.connection.mav.heartbeat_send(
                    mavutil.mavlink.MAV_TYPE_GCS,
                    mavutil.mavlink.MAV_AUTOPILOT_INVALID,
                    0,
                    0,
                    0,
                )
                self.logger.debug("Sent GCS heartbeat")
            except Exception as exc:
                self.logger.warning("Failed to send heartbeat: %s", exc)
            await asyncio.sleep(1.0)

        self.logger.info("GCS heartbeat sender stopped")

    async def _heartbeat_monitor_loop(self) -> None:
        self.logger.info("Starting heartbeat monitor")
        while not self._shutdown_event.is_set():
            now = time.monotonic()
            lost_any = False
            for sysid, last in list(self._last_heartbeat.items()):
                if now - last > self.heartbeat_timeout:
                    self.logger.warning("Heartbeat lost for vehicle %s", sysid)
                    lost_any = True
            if lost_any and self.state == ConnectionState.CONNECTED:
                self.state = ConnectionState.LOST
                self.logger.error("Connection state transitioned to LOST due to heartbeat timeout")
            await asyncio.sleep(0.5)
        self.logger.info("Heartbeat monitor stopped")

    def request_telemetry_streams(self, rate_hz: int = 4) -> None:
        if self.connection is None or self._target_system is None or self._target_component is None:
            self.logger.warning("Cannot request telemetry streams before connection target is known")
            return

        self.logger.info("Requesting telemetry streams at %d Hz", rate_hz)
        try:
            self.connection.mav.request_data_stream_send(
                self._target_system,
                self._target_component,
                mavutil.mavlink.MAV_DATA_STREAM_ALL,
                rate_hz,
                1,
            )
        except Exception as exc:
            self.logger.exception("Failed to request telemetry streams: %s", exc)

    def request_param_list(self) -> None:
        if self.connection is None or self._target_system is None or self._target_component is None:
            self.logger.warning("Cannot request param list before connection target is known")
            return

        self.logger.info("Requesting parameter list from vehicle %s:%s", self._target_system, self._target_component)
        try:
            self.connection.mav.param_request_list_send(self._target_system, self._target_component)
        except Exception as exc:
            self.logger.exception("Failed to request parameter list: %s", exc)

    async def upload_mission(self, mission_items: list[dict], timeout: float = 15.0) -> None:
        if self.connection is None or self._target_system is None or self._target_component is None:
            raise RuntimeError("Cannot upload mission before MAVLink connection is established")

        self.logger.info("Uploading %d mission items to vehicle %s:%s", len(mission_items), self._target_system, self._target_component)
        self.connection.mav.mission_count_send(self._target_system, self._target_component, len(mission_items))

        while True:
            message = await self._wait_for_message(["MISSION_REQUEST_INT", "MISSION_REQUEST", "MISSION_ACK"], timeout=timeout)
            msg_type = message.get_type()

            if msg_type == "MISSION_ACK":
                if message.type == mavutil.mavlink.MAV_MISSION_ACCEPTED:
                    self.logger.info("Mission upload completed and accepted by vehicle")
                    return
                raise RuntimeError(f"Mission upload rejected: {message.type}")

            seq = getattr(message, "seq", None)
            if seq is None or seq >= len(mission_items):
                raise RuntimeError(f"Vehicle requested invalid mission sequence {seq}")

            self._send_mission_item(seq, mission_items[seq])

    async def download_mission(self, timeout: float = 15.0) -> list[dict]:
        if self.connection is None or self._target_system is None or self._target_component is None:
            raise RuntimeError("Cannot download mission before MAVLink connection is established")

        self.logger.info("Requesting mission list from vehicle %s:%s", self._target_system, self._target_component)
        self.connection.mav.mission_request_list_send(self._target_system, self._target_component)

        count_message = await self._wait_for_message("MISSION_COUNT", timeout=timeout)
        total = int(count_message.count)
        self.logger.info("Vehicle reports %d mission items", total)

        mission_items: list[dict] = []
        for seq in range(total):
            self.logger.debug("Requesting mission item %d", seq)
            self.connection.mav.mission_request_int_send(self._target_system, self._target_component, seq)
            item_message = await self._wait_for_message(["MISSION_ITEM_INT", "MISSION_ITEM"], predicate=lambda msg, seq=seq: getattr(msg, "seq", -1) == seq, timeout=timeout)
            mission_items.append(self._message_to_mission_item(item_message))

        ack = await self._wait_for_message("MISSION_ACK", timeout=timeout)
        if ack.type != mavutil.mavlink.MAV_MISSION_ACCEPTED:
            raise RuntimeError(f"Mission download did not complete successfully: {ack.type}")

        self.logger.info("Mission download completed successfully")
        return mission_items

    def _send_mission_item(self, seq: int, item: Optional[dict]) -> None:
        if self.connection is None or self._target_system is None or self._target_component is None:
            raise RuntimeError("Cannot send mission item before MAVLink connection is established")

        if item is None:
            raise RuntimeError("Mission item data is required to send mission item")

        self.connection.mav.mission_item_int_send(
            self._target_system,
            self._target_component,
            seq,
            int(item.get("frame", mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT)),
            int(item.get("command", 16)),
            int(item.get("current", 0)),
            int(item.get("autocontinue", 1)),
            float(item.get("param1", 0.0)),
            float(item.get("param2", 0.0)),
            float(item.get("param3", 0.0)),
            float(item.get("param4", 0.0)),
            int(item.get("x", 0.0) * 1e7),
            int(item.get("y", 0.0) * 1e7),
            float(item.get("z", 0.0)),
        )

    def _message_to_mission_item(self, message: Any) -> dict:
        if message.get_type() == "MISSION_ITEM_INT":
            return {
                "seq": message.seq,
                "current": message.current,
                "frame": message.frame,
                "command": message.command,
                "param1": message.param1,
                "param2": message.param2,
                "param3": message.param3,
                "param4": message.param4,
                "x": message.x * 1e-7,
                "y": message.y * 1e-7,
                "z": message.z,
                "autocontinue": message.autocontinue,
            }

        if message.get_type() == "MISSION_ITEM":
            return {
                "seq": message.seq,
                "current": message.current,
                "frame": message.frame,
                "command": message.command,
                "param1": message.param1,
                "param2": message.param2,
                "param3": message.param3,
                "param4": message.param4,
                "x": message.x,
                "y": message.y,
                "z": message.z,
                "autocontinue": message.autocontinue,
            }

        raise ValueError(f"Unsupported mission message type: {message.get_type()}")

    def send_command_long(self, command: int, param1: float = 0.0, param2: float = 0.0, param3: float = 0.0, param4: float = 0.0, param5: float = 0.0, param6: float = 0.0, param7: float = 0.0) -> None:
        if self.connection is None or self._target_system is None or self._target_component is None:
            raise RuntimeError("Cannot send command before MAVLink connection is established")

        self.logger.debug("Sending COMMAND_LONG %s to %s:%s", command, self._target_system, self._target_component)
        self.connection.mav.command_long_send(
            self._target_system,
            self._target_component,
            command,
            0,
            param1,
            param2,
            param3,
            param4,
            param5,
            param6,
            param7,
        )
