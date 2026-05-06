import logging
from typing import Any

from pymavlink import mavutil
from vehicle_state import VehicleState

logger = logging.getLogger(__name__)

def update_state(state: VehicleState, message: Any) -> None:
    """Map a received MAVLink message to fields in the VehicleState dataclass."""
    msg_type = message.get_type()
    
    try:
        if msg_type == 'GLOBAL_POSITION_INT':
            state.lat = message.lat * 1e-7
            state.lng = message.lon * 1e-7
            state.alt = message.alt * 1e-3
            state.relative_alt = message.relative_alt * 1e-3
            state.vx = message.vx * 1e-2
            state.vy = message.vy * 1e-2
            state.vz = message.vz * 1e-2
            
        elif msg_type == 'ATTITUDE':
            state.roll = message.roll
            state.pitch = message.pitch
            state.yaw = message.yaw
            
        elif msg_type == 'VFR_HUD':
            state.airspeed = message.airspeed
            state.groundspeed = message.groundspeed
            state.throttle = message.throttle
            state.climb = message.climb
            
        elif msg_type == 'SYS_STATUS':
            state.battery_voltage = message.voltage_battery * 1e-3
            state.battery_current = message.current_battery * 1e-2
            state.battery_remaining = message.battery_remaining
            state.drop_rate_comm = message.drop_rate_comm
            state.errors_comm = message.errors_comm
            
        elif msg_type == 'GPS_RAW_INT':
            state.gps_fix_type = message.fix_type
            state.satcount = message.satellites_visible
            state.eph = message.eph
            state.epv = message.epv
            
        elif msg_type == 'PARAM_VALUE':
            state.params[message.param_id] = message.param_value
            state.param_count = message.param_count
            state.param_index = message.param_index

        elif msg_type == 'MISSION_COUNT':
            state.mission_items = []

        elif msg_type in ('MISSION_ITEM_INT', 'MISSION_ITEM'):
            item = {
                "seq": message.seq,
                "frame": message.frame,
                "command": message.command,
                "current": message.current,
                "autocontinue": message.autocontinue,
                "param1": message.param1,
                "param2": message.param2,
                "param3": message.param3,
                "param4": message.param4,
                "x": message.x * 1e-7 if msg_type == 'MISSION_ITEM_INT' else message.x,
                "y": message.y * 1e-7 if msg_type == 'MISSION_ITEM_INT' else message.y,
                "z": message.z,
            }
            state.mission_items.append(item)
            
        elif msg_type == 'HEARTBEAT':
            state.system_status = message.system_status
            state.armed = (message.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED) != 0
            state.mode = mavutil.mode_string_v10(message)
            
        elif msg_type == 'NAV_CONTROLLER_OUTPUT':
            state.nav_roll = message.nav_roll
            state.nav_pitch = message.nav_pitch
            state.nav_bearing = message.nav_bearing
            state.target_bearing = message.target_bearing
            state.wp_dist = message.wp_dist
            state.alt_error = message.alt_error
            state.aspd_error = message.aspd_error
            state.xtrack_error = message.xtrack_error
            
    except AttributeError as exc:
        logger.warning("Missing attribute while mapping %s: %s", msg_type, exc)
