# Preflight Engine Architecture

The Preflight Validation Engine provides a centralized, backend-driven mechanism for evaluating the safety and readiness of connected vehicles. Rather than duplicating MAVLink status checks across various frontend UI components, the Python service continuously synthesizes raw vehicle state into a normalized safety payload, assigning a **Readiness Confidence Score (0-100)**.

## Core Evaluation (`preflight_manager.py`)
The `PreflightManager` runs at 10Hz, maintaining persistent tracking of individual failures (including `first_seen` and `last_seen` timestamps) and calculating severity deductions against a base score of 100.

1. **Connection & Freshness**:
   - `ERROR (-100)`: Vehicle is disconnected or heartbeat is > 5.0s stale.
   - `WARN (-20)`: Heartbeat is delayed (> 2.0s).
2. **GPS Readiness**:
   - `ERROR (-100)`: GPS fix type is less than 3 (No 3D Fix).
   - `WARN (-20)`: GPS satellites are fewer than 6.
3. **EKF Health**:
   - `WARN (-20)`: EKF flags are uninitialized (0).
   - `ERROR (-100)`: Variances (Horizontal/Vertical Position, Velocity, Compass) exceed `1.0`.
4. **Battery Safety**:
   - `WARN (-10)`: Battery voltage is zero or unavailable.
   - `ERROR (-100)`: Remaining battery capacity falls below 20%.
5. **Vibration**:
   - `WARN (-20)`: Any axis (X, Y, Z) reports vibration exceeding 30.0 m/s/s.
6. **RC Calibration**:
   - `WARN (-10)`: No RC channel data is detected.
7. **Sensor Health**:
   - `ERROR (-50)`: Expected sensors are reporting unhealthy bitmasks.

## Aggregated Status Payload
The output of the evaluation is a `PREFLIGHT_STATUS` payload formatted as:
```json
{
  "sysid": 1,
  "ready_to_arm": false,
  "score": 60,
  "checks": [
    { 
      "id": "gps_fix",
      "category": "GPS",
      "status": "ERROR", 
      "message": "No 3D Fix (Fix type: 1)",
      "first_seen": 1684069000.123,
      "last_seen": 1684069300.123
    }
  ],
  "status_texts": [
    {
      "severity": 4,
      "status": "WARN",
      "text": "PreArm: Hardware Safety Switch",
      "timestamp": 1684069290.000
    }
  ],
  "timestamp": 1684069300.123
}
```

## History API
Every time the `ready_to_arm` boolean flips, a snapshot is saved to a ring buffer (`maxlen=50`). The engine explicitly logs the transition direction (e.g., `READY -> NOT_READY`) alongside the score and reasons. This history is exposed via `GET /preflight/history` and powers post-flight analytics and mission audit logging.
