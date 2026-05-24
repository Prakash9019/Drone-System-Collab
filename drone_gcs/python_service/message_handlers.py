from pymavlink import mavutil
from vehicle_state import VehicleState
import time

_GPS_INVALID_UINT16 = 65535


def _ratio_from_eps_raw(raw_eps: int) -> float:
    """GPS_RAW_INT eph/epv are HDOP/VDOP scaled by 100; unknown = UINT16_MAX."""
    if raw_eps is None or raw_eps <= 0 or raw_eps >= _GPS_INVALID_UINT16:
        return 0.0
    return raw_eps / 100.0

def decode_mode(custom_mode: int, system_type: int) -> str:
    # A mapping function to get mode name string based on system type (e.g. Copter, Plane)
    # This is a simplified version, it should ideally use mavutil.mode_mapping()
    if system_type == mavutil.mavlink.MAV_TYPE_QUADROTOR or system_type == mavutil.mavlink.MAV_TYPE_HEXAROTOR:
        mode_mapping = mavutil.mode_mapping_bynumber(mavutil.mavlink.MAV_TYPE_QUADROTOR)
    elif system_type == mavutil.mavlink.MAV_TYPE_FIXED_WING:
        mode_mapping = mavutil.mode_mapping_bynumber(mavutil.mavlink.MAV_TYPE_FIXED_WING)
    elif system_type == mavutil.mavlink.MAV_TYPE_GROUND_ROVER:
        mode_mapping = mavutil.mode_mapping_bynumber(mavutil.mavlink.MAV_TYPE_GROUND_ROVER)
    elif system_type == mavutil.mavlink.MAV_TYPE_SUBMARINE:
        mode_mapping = mavutil.mode_mapping_bynumber(mavutil.mavlink.MAV_TYPE_SUBMARINE)
    else:
        mode_mapping = mavutil.mode_mapping_bynumber(mavutil.mavlink.MAV_TYPE_QUADROTOR) # Default Copter

    if mode_mapping:
        for mode_name, mode_num in mode_mapping.items():
            if mode_num == custom_mode:
                return mode_name
    return f"UNKNOWN({custom_mode})"

def handle_message(msg: any, state: VehicleState):
    msg_type = msg.get_type()
    
    if msg_type == 'HEARTBEAT':
        # Update connection logic in link manager, but state here
        state.last_heartbeat = time.time()
        state.status.system_type = msg.type
        state.status.armed = (msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED) != 0
        # Prefer pymavlink's mode decoder when available; fallback to local mapping.
        try:
            mode_text = mavutil.mode_string_v10(msg)
        except Exception:
            mode_text = ""
        mode_text = (mode_text or "").strip()
        if mode_text and mode_text != "Mode(0x00000000)":
            state.status.mode = mode_text
        else:
            state.status.mode = decode_mode(msg.custom_mode, msg.type)
        
    elif msg_type == 'SYS_STATUS':
        # Only use SYS_STATUS voltage as fallback; BATTERY_STATUS takes priority when available.
        if not getattr(state.battery, '_has_battery_status', False):
            state.battery.voltage = msg.voltage_battery / 1000.0  # mV to V
            state.battery.current = msg.current_battery / 100.0   # cA to A
            state.battery.remaining = msg.battery_remaining       # %
        state.status.sensors_present = int(msg.onboard_control_sensors_present)
        state.status.sensors_enabled = int(msg.onboard_control_sensors_enabled)
        state.status.sensors_health = int(msg.onboard_control_sensors_health)

    elif msg_type == 'BATTERY_STATUS':
        # Primary battery (id==0). Supports >65.5V via cell array summing.
        if int(getattr(msg, 'id', 0)) == 0:
            voltages = getattr(msg, 'voltages', [])
            valid_cells = [v for v in voltages if v != 65535]
            if valid_cells:
                state.battery.voltage = sum(v / 1000.0 for v in valid_cells)
            curr = getattr(msg, 'current_battery', -1)
            if curr >= 0:
                state.battery.current = curr / 100.0  # cA to A
            rem = getattr(msg, 'battery_remaining', -1)
            if rem >= 0:
                state.battery.remaining = rem
            used = getattr(msg, 'current_consumed', -1)
            if used >= 0:
                state.battery.used_mah = float(used)
            state.battery._has_battery_status = True
        
    elif msg_type == 'GPS_RAW_INT':
        state.status.gps_fix = msg.fix_type
        state.status.satellites = msg.satellites_visible
        state.status.gps_hdop = _ratio_from_eps_raw(int(msg.eph))
        state.status.gps_vdop = _ratio_from_eps_raw(int(msg.epv))
        
    elif msg_type == 'ATTITUDE':
        state.attitude.roll = msg.roll
        state.attitude.pitch = msg.pitch
        state.attitude.yaw = msg.yaw
        
    elif msg_type == 'GLOBAL_POSITION_INT':
        state.position.lat = msg.lat / 1e7
        state.position.lng = msg.lon / 1e7
        state.position.alt_amsl = msg.alt / 1000.0
        state.position.alt_rel = msg.relative_alt / 1000.0
        # MAVLink field is usually `hdg` (centi-deg, UINT16_MAX when unknown).
        hdg = getattr(msg, "hdg", None)
        if hdg is None:
            hdg = getattr(msg, "heading", None)
        if hdg is not None and hdg != 65535 and hdg != 65536:
            try:
                state.velocity.heading = float(hdg) / 100.0
            except (TypeError, ValueError):
                pass
    elif msg_type == 'HOME_POSITION':
        state.home.lat = msg.latitude / 1e7
        state.home.lng = msg.longitude / 1e7
        state.home.alt_m = msg.altitude / 1000.0
        state.home.valid = True

    elif msg_type == 'GPS_GLOBAL_ORIGIN':
        # EKF origin in 1e7-scaled lat/lng + mm altitude.
        state.ekf_origin.lat = msg.latitude / 1e7
        state.ekf_origin.lng = msg.longitude / 1e7
        state.ekf_origin.alt_m = msg.altitude / 1000.0
        state.ekf_origin.valid = True
        
    elif msg_type == 'MISSION_CURRENT':
        state.mission_current_seq = int(msg.seq)
        
    elif msg_type == 'VFR_HUD':
        state.velocity.airspeed = msg.airspeed
        state.velocity.groundspeed = msg.groundspeed
        state.velocity.climb = msg.climb
        state.velocity.heading = msg.heading
        state.velocity.throttle = msg.throttle
        
    elif msg_type == 'EKF_STATUS_REPORT':
        state.ekf_status.flags = msg.flags
        state.ekf_status.velocity_variance = msg.velocity_variance
        state.ekf_status.pos_horiz_variance = msg.pos_horiz_variance
        state.ekf_status.pos_vert_variance = msg.pos_vert_variance
        state.ekf_status.compass_variance = msg.compass_variance
        state.ekf_status.terrain_alt_variance = msg.terrain_alt_variance
        
    elif msg_type == 'VIBRATION':
        state.vibration.vibration_x = msg.vibration_x
        state.vibration.vibration_y = msg.vibration_y
        state.vibration.vibration_z = msg.vibration_z
        state.vibration.clipping_0 = msg.clipping_0
        state.vibration.clipping_1 = msg.clipping_1
        state.vibration.clipping_2 = msg.clipping_2
        
    elif msg_type == 'RC_CHANNELS':
        state.rc_channels.rssi = msg.rssi
        for i in range(1, 19):
            attr_name = f'chan{i}_raw'
            if hasattr(msg, attr_name):
                state.rc_channels.channels[i] = getattr(msg, attr_name)

    elif msg_type == 'SERVO_OUTPUT_RAW':
        for i in range(1, 17):
            attr_name = f'servo{i}_raw'
            if hasattr(msg, attr_name):
                state.servo_output.channels[i] = getattr(msg, attr_name)

    elif msg_type == 'NAV_CONTROLLER_OUTPUT':
        state.navigation.wp_dist = float(getattr(msg, 'wp_dist', -1.0))
        state.navigation.target_bearing = float(getattr(msg, 'target_bearing', 0.0))
        state.navigation.nav_bearing = float(getattr(msg, 'nav_bearing', 0.0))
                
    elif msg_type == 'STATUSTEXT':
        from vehicle_state import StatusText
        new_msg = StatusText(severity=msg.severity, text=msg.text)
        state.status_messages.append(new_msg)
        if len(state.status_messages) > 50:
            state.status_messages.pop(0)
        
    elif msg_type == 'TIMESYNC':
        # Simple latency estimation: Current time - ts1
        # If tc1 is 0, it's a request from drone. If we sent it, ts1 is our timestamp
        if msg.tc1 != 0 and msg.ts1 != 0:
            # We assume ts1 was our time in nanoseconds
            now_ns = time.time() * 1e9
            latency_ns = now_ns - msg.ts1
            if latency_ns > 0:
                state.link_status.latency_ms = latency_ns / 1e6
                
    elif msg_type == 'PARAM_VALUE':
        param_id = msg.param_id
        if isinstance(param_id, bytes):
            param_id = param_id.decode('utf-8').rstrip('\x00')
        elif isinstance(param_id, str):
            param_id = param_id.rstrip('\x00')
            
        state.parameters[param_id] = msg.param_value
