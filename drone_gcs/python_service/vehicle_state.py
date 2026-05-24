import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Any, List

class ConnectionState(Enum):
    DISCONNECTED = "DISCONNECTED"
    CONNECTING = "CONNECTING"
    WAITING_FOR_HEARTBEAT = "WAITING_FOR_HEARTBEAT"
    CONNECTED = "CONNECTED"
    ACTIVE = "ACTIVE"
    HEARTBEAT_LOST = "HEARTBEAT_LOST"
    RECONNECTING = "RECONNECTING"

@dataclass
class Position:
    lat: float = 0.0
    lng: float = 0.0
    alt_amsl: float = 0.0
    alt_rel: float = 0.0

@dataclass
class Attitude:
    roll: float = 0.0
    pitch: float = 0.0
    yaw: float = 0.0

@dataclass
class Velocity:
    airspeed: float = 0.0
    groundspeed: float = 0.0
    climb: float = 0.0
    heading: int = 0
    throttle: int = 0

@dataclass
class Battery:
    voltage: float = 0.0
    current: float = 0.0
    remaining: int = 0

@dataclass
class EKFStatus:
    flags: int = 0
    velocity_variance: float = 0.0
    pos_horiz_variance: float = 0.0
    pos_vert_variance: float = 0.0
    compass_variance: float = 0.0
    terrain_alt_variance: float = 0.0

@dataclass
class Vibration:
    vibration_x: float = 0.0
    vibration_y: float = 0.0
    vibration_z: float = 0.0
    clipping_0: int = 0
    clipping_1: int = 0
    clipping_2: int = 0

@dataclass
class RCChannels:
    channels: Dict[int, int] = field(default_factory=dict)
    rssi: int = 0

@dataclass
class ServoOutput:
    channels: Dict[int, int] = field(default_factory=dict)

@dataclass
class Navigation:
    wp_dist: float = -1.0
    target_bearing: float = 0.0
    nav_bearing: float = 0.0

@dataclass
class StatusText:
    severity: int = 0
    text: str = ""
    timestamp: float = field(default_factory=time.time)

@dataclass
class LinkStatus:
    packet_loss_percent: float = 0.0
    latency_ms: float = 0.0
    total_packets_received: int = 0
    total_packets_lost: int = 0
    packets_per_second: float = 0.0
    heartbeat_age_s: float = 0.0

@dataclass
class Status:
    mode: str = "UNKNOWN"
    armed: bool = False
    system_type: int = 0
    gps_fix: int = 0
    satellites: int = 0
    # From GPS_RAW_INT eph/epv (HDOP/VDOP * 100); 0 = unknown
    gps_hdop: float = 0.0
    gps_vdop: float = 0.0
    sensors_present: int = 0
    sensors_enabled: int = 0
    sensors_health: int = 0


@dataclass
class HomePosition:
    lat: float = 0.0
    lng: float = 0.0
    alt_m: float = 0.0
    valid: bool = False

@dataclass
class EKFOrigin:
    """EKF origin from MAVLink GPS_GLOBAL_ORIGIN. Mission Planner anchors mission math here.
    Diverging from HOME_POSITION is a known cause of "drone appears at wrong place" symptoms."""
    lat: float = 0.0
    lng: float = 0.0
    alt_m: float = 0.0
    valid: bool = False

@dataclass
class VehicleState:
    sysid: int
    compid: int
    connection_state: ConnectionState = ConnectionState.DISCONNECTED
    last_heartbeat: float = 0.0
    position: Position = field(default_factory=Position)
    attitude: Attitude = field(default_factory=Attitude)
    velocity: Velocity = field(default_factory=Velocity)
    battery: Battery = field(default_factory=Battery)
    status: Status = field(default_factory=Status)
    ekf_status: EKFStatus = field(default_factory=EKFStatus)
    vibration: Vibration = field(default_factory=Vibration)
    rc_channels: RCChannels = field(default_factory=RCChannels)
    servo_output: ServoOutput = field(default_factory=ServoOutput)
    navigation: Navigation = field(default_factory=Navigation)
    status_messages: List[StatusText] = field(default_factory=list)
    link_status: LinkStatus = field(default_factory=LinkStatus)
    parameters: Dict[str, Any] = field(default_factory=dict)
    home: HomePosition = field(default_factory=HomePosition)
    ekf_origin: EKFOrigin = field(default_factory=EKFOrigin)
    mission_current_seq: int = -1

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sysid": self.sysid,
            "compid": self.compid,
            "connection_state": self.connection_state.value,
            "last_heartbeat": self.last_heartbeat,
            "position": {
                "lat": self.position.lat,
                "lng": self.position.lng,
                "alt_amsl": self.position.alt_amsl,
                "alt_rel": self.position.alt_rel,
            },
            "attitude": {
                "roll": self.attitude.roll,
                "pitch": self.attitude.pitch,
                "yaw": self.attitude.yaw,
            },
            "velocity": {
                "airspeed": self.velocity.airspeed,
                "groundspeed": self.velocity.groundspeed,
                "climb": self.velocity.climb,
                "heading": self.velocity.heading,
                "throttle": self.velocity.throttle,
            },
            "battery": {
                "voltage": self.battery.voltage,
                "current": self.battery.current,
                "remaining": self.battery.remaining,
            },
            "status": {
                "mode": self.status.mode,
                "armed": self.status.armed,
                "system_type": self.status.system_type,
                "gps_fix": self.status.gps_fix,
                "satellites": self.status.satellites,
                "gps_hdop": self.status.gps_hdop,
                "gps_vdop": self.status.gps_vdop,
                "sensors_present": self.status.sensors_present,
                "sensors_enabled": self.status.sensors_enabled,
                "sensors_health": self.status.sensors_health,
            },
            "ekf_status": {
                "flags": self.ekf_status.flags,
                "velocity_variance": self.ekf_status.velocity_variance,
                "pos_horiz_variance": self.ekf_status.pos_horiz_variance,
                "pos_vert_variance": self.ekf_status.pos_vert_variance,
                "compass_variance": self.ekf_status.compass_variance,
                "terrain_alt_variance": self.ekf_status.terrain_alt_variance,
            },
            "vibration": {
                "vibration_x": self.vibration.vibration_x,
                "vibration_y": self.vibration.vibration_y,
                "vibration_z": self.vibration.vibration_z,
                "clipping_0": self.vibration.clipping_0,
                "clipping_1": self.vibration.clipping_1,
                "clipping_2": self.vibration.clipping_2,
            },
            "rc_channels": {
                "channels": self.rc_channels.channels,
                "rssi": self.rc_channels.rssi,
            },
            "servo_output": {
                "channels": self.servo_output.channels,
            },
            "navigation": {
                "wp_dist": self.navigation.wp_dist,
                "target_bearing": self.navigation.target_bearing,
                "nav_bearing": self.navigation.nav_bearing,
            },
            "status_messages": [
                {"severity": msg.severity, "text": msg.text, "timestamp": msg.timestamp}
                for msg in self.status_messages
            ],
            "link_status": {
                "packet_loss_percent": self.link_status.packet_loss_percent,
                "latency_ms": self.link_status.latency_ms,
                "total_packets_received": self.link_status.total_packets_received,
                "total_packets_lost": self.link_status.total_packets_lost,
                "packets_per_second": self.link_status.packets_per_second,
                "heartbeat_age_s": self.link_status.heartbeat_age_s,
            },
            "parameters": self.parameters,
            "home": {
                "lat": self.home.lat,
                "lng": self.home.lng,
                "alt_m": self.home.alt_m,
                "valid": self.home.valid,
            },
            "ekf_origin": {
                "lat": self.ekf_origin.lat,
                "lng": self.ekf_origin.lng,
                "alt_m": self.ekf_origin.alt_m,
                "valid": self.ekf_origin.valid,
            },
            "mission": {
                "current_seq": self.mission_current_seq,
            },
        }
