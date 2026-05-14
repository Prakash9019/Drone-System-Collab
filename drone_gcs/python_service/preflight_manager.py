import collections
import time
import logging
from typing import Dict, Any, List
from vehicle_state import VehicleState, ConnectionState

logger = logging.getLogger(__name__)

class PreflightManager:
    """
    Evaluates the current vehicle state to determine if it is safe to arm.
    Generates a list of discrete checks (GPS, EKF, Battery, Vibration) with INFO/WARN/ERROR severities.
    Maintains a score from 0-100, active failure tracking (first_seen, last_seen), and preserves STATUSTEXTs.
    """
    def __init__(self):
        self.history = collections.deque(maxlen=50)
        self.last_status: Dict[int, Any] = {}
        # Tracks persistent issues: { sysid: { check_id: { ...state } } }
        self.active_issues: Dict[int, Dict[str, Any]] = collections.defaultdict(dict)

    def _update_issue(self, sysid: int, check_id: str, category: str, status: str, message: str, now: float) -> Dict[str, Any]:
        issues = self.active_issues[sysid]
        if check_id not in issues or issues[check_id]["status"] != status:
            # New issue or status changed
            issues[check_id] = {
                "id": check_id,
                "category": category,
                "status": status,
                "message": message,
                "first_seen": now,
                "last_seen": now
            }
        else:
            issues[check_id]["last_seen"] = now
            issues[check_id]["message"] = message # Message might update dynamically
            
        return issues[check_id]

    def _resolve_issue(self, sysid: int, check_id: str):
        if check_id in self.active_issues[sysid]:
            del self.active_issues[sysid][check_id]

    def evaluate(self, vehicle: VehicleState) -> Dict[str, Any]:
        now = time.time()
        sysid = vehicle.sysid
        
        checks = []
        ready = True
        score = 100

        # Helper to log checks
        def add_check(check_id: str, category: str, status: str, message: str, penalty: int = 0):
            nonlocal ready, score
            if status == "ERROR":
                ready = False
            
            if status in ("WARN", "ERROR"):
                score -= penalty
                checks.append(self._update_issue(sysid, check_id, category, status, message, now))
            else:
                self._resolve_issue(sysid, check_id)

        # 1. Connection & Freshness
        if vehicle.connection_state not in (ConnectionState.CONNECTED, ConnectionState.ACTIVE):
            add_check("conn", "Connection", "ERROR", "Vehicle disconnected", penalty=100)
        else:
            self._resolve_issue(sysid, "conn")
            
            # Telemetry Freshness
            hb_age = now - vehicle.last_heartbeat if vehicle.last_heartbeat else 999
            if hb_age > 5.0:
                add_check("telemetry_fresh", "Telemetry", "ERROR", f"Stale Heartbeat ({hb_age:.1f}s)", penalty=100)
            elif hb_age > 2.0:
                add_check("telemetry_fresh", "Telemetry", "WARN", f"Delayed Heartbeat ({hb_age:.1f}s)", penalty=20)
            else:
                self._resolve_issue(sysid, "telemetry_fresh")

            # 2. GPS
            if vehicle.status.gps_fix < 3:
                add_check("gps_fix", "GPS", "ERROR", f"No 3D Fix (Fix type: {vehicle.status.gps_fix})", penalty=100)
            elif vehicle.status.satellites < 6:
                add_check("gps_fix", "GPS", "WARN", f"Low Satellites: {vehicle.status.satellites}", penalty=20)
            else:
                self._resolve_issue(sysid, "gps_fix")

            # 3. EKF
            if vehicle.ekf_status.flags == 0:
                add_check("ekf_init", "EKF", "WARN", "EKF Not Initialized", penalty=20)
            elif (vehicle.ekf_status.pos_horiz_variance >= 1.0 or 
                  vehicle.ekf_status.pos_vert_variance >= 1.0 or 
                  vehicle.ekf_status.velocity_variance >= 1.0 or 
                  vehicle.ekf_status.compass_variance >= 1.0):
                add_check("ekf_variance", "EKF", "ERROR", "High EKF Variance", penalty=100)
            else:
                self._resolve_issue(sysid, "ekf_init")
                self._resolve_issue(sysid, "ekf_variance")

            # 4. Battery
            if vehicle.battery.voltage <= 0:
                add_check("battery_data", "Battery", "WARN", "No Data", penalty=10)
            elif vehicle.battery.remaining < 20:
                add_check("battery_low", "Battery", "ERROR", f"Low Battery: {vehicle.battery.remaining}%", penalty=100)
            else:
                self._resolve_issue(sysid, "battery_data")
                self._resolve_issue(sysid, "battery_low")

            # 5. Vibration
            vibes = [vehicle.vibration.vibration_x, vehicle.vibration.vibration_y, vehicle.vibration.vibration_z]
            max_vibe = max(vibes) if any(v > 0 for v in vibes) else 0.0
            if max_vibe > 30.0:
                add_check("vibration", "Vibration", "WARN", f"High Vibration ({max_vibe:.1f})", penalty=20)
            else:
                self._resolve_issue(sysid, "vibration")
                
            # 6. RC Channels
            if not vehicle.rc_channels.channels:
                add_check("rc", "RC", "WARN", "No RC detected", penalty=10)
            else:
                self._resolve_issue(sysid, "rc")
                
            # 7. Sensor Health
            if vehicle.status.sensors_health > 0 and vehicle.status.sensors_enabled > 0:
                # Basic check: if anything enabled is not healthy
                if (vehicle.status.sensors_enabled & vehicle.status.sensors_health) != vehicle.status.sensors_enabled:
                    add_check("sensors", "Sensors", "ERROR", "Sensor Health Failure", penalty=50)
                else:
                    self._resolve_issue(sysid, "sensors")

        score = max(0, score)

        # Collect STATUSTEXT
        status_texts = []
        # Prune very old messages, e.g. > 60s
        valid_msgs = [m for m in vehicle.status_messages if now - m.timestamp < 60.0]
        vehicle.status_messages = valid_msgs
        
        for msg in valid_msgs:
            # severity mappings from MAV_SEVERITY
            status = "INFO"
            if msg.severity <= 3: # 0=EMERGENCY, 1=ALERT, 2=CRITICAL, 3=ERROR
                status = "ERROR"
            elif msg.severity == 4: # 4=WARNING
                status = "WARN"
                
            status_texts.append({
                "severity": msg.severity,
                "status": status,
                "text": msg.text,
                "timestamp": msg.timestamp
            })

        result = {
            "sysid": sysid,
            "ready_to_arm": ready,
            "score": score,
            "checks": list(self.active_issues[sysid].values()),
            "status_texts": status_texts,
            "timestamp": now
        }

        # Track history if readiness state toggles
        if sysid not in self.last_status or self.last_status[sysid]["ready_to_arm"] != ready:
            from_state = "NOT_READY" if sysid in self.last_status and not self.last_status[sysid]["ready_to_arm"] else ("READY" if sysid in self.last_status else "UNKNOWN")
            to_state = "READY" if ready else "NOT_READY"
            
            history_entry = {
                "sysid": sysid,
                "transition": f"{from_state} -> {to_state}",
                "ready_to_arm": ready,
                "score": score,
                "timestamp": now,
                "reasons": [c["message"] for c in result["checks"]]
            }
            self.history.append(history_entry)
            
        self.last_status[sysid] = result
        return result
