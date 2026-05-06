import time
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class VehicleState:
    sysid: int
    compid: int
    
    # GLOBAL_POSITION_INT
    lat: float = 0.0
    lng: float = 0.0
    alt: float = 0.0
    relative_alt: float = 0.0
    vx: float = 0.0
    vy: float = 0.0
    vz: float = 0.0
    
    # ATTITUDE
    roll: float = 0.0
    pitch: float = 0.0
    yaw: float = 0.0
    
    # VFR_HUD
    airspeed: float = 0.0
    groundspeed: float = 0.0
    throttle: float = 0.0
    climb: float = 0.0
    
    # SYS_STATUS
    battery_voltage: float = 0.0
    battery_current: float = 0.0
    battery_remaining: float = 0.0
    drop_rate_comm: float = 0.0
    errors_comm: int = 0
    
    # GPS_RAW_INT
    gps_fix_type: int = 0
    satcount: int = 0
    eph: float = 0.0
    epv: float = 0.0
    
    # HEARTBEAT
    mode: str = "UNKNOWN"
    armed: bool = False
    system_status: int = 0
    
    # NAV_CONTROLLER_OUTPUT
    nav_roll: float = 0.0
    nav_pitch: float = 0.0
    nav_bearing: int = 0
    target_bearing: int = 0
    wp_dist: int = 0
    alt_error: float = 0.0
    aspd_error: float = 0.0
    xtrack_error: float = 0.0
    
    # Mission and Params
    mission_items: list[dict] = field(default_factory=list)
    params: dict[str, float] = field(default_factory=dict)
    param_count: int = 0
    param_index: int = 0
    
    # System Internal
    last_message_type: Optional[str] = None
    last_update: float = field(default_factory=time.monotonic)
