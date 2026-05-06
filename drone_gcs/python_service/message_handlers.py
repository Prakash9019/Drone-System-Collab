from pymavlink import mavutil
from vehicle_state import VehicleState
import time

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
        state.status.mode = decode_mode(msg.custom_mode, msg.type)
        
    elif msg_type == 'SYS_STATUS':
        state.battery.voltage = msg.voltage_battery / 1000.0  # mV to V
        state.battery.current = msg.current_battery / 100.0   # cA to A
        state.battery.remaining = msg.battery_remaining       # %
        
    elif msg_type == 'GPS_RAW_INT':
        state.status.gps_fix = msg.fix_type
        state.status.satellites = msg.satellites_visible
        
    elif msg_type == 'ATTITUDE':
        state.attitude.roll = msg.roll
        state.attitude.pitch = msg.pitch
        state.attitude.yaw = msg.yaw
        
    elif msg_type == 'GLOBAL_POSITION_INT':
        state.position.lat = msg.lat / 1e7
        state.position.lng = msg.lon / 1e7
        state.position.alt_amsl = msg.alt / 1000.0
        state.position.alt_rel = msg.relative_alt / 1000.0
        # Wait, vx, vy, vz mapping missing in plan but standard
        
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
                
    elif msg_type == 'STATUSTEXT':
        state.status_text.severity = msg.severity
        state.status_text.text = msg.text
        
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
