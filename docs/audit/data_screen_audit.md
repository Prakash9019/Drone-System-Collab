# DATA SCREEN Audit

## 1. Feature Inventory

| Feature | Mission Planner | Backend | Frontend | End-to-end |
|---|---|---|---|---|
| HUD (attitude, heading, AS/GS/ALT, mode/arm) | ✅ Implemented | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| GPS/EKF/Battery/Vibration telemetry surface | ✅ Implemented | ✅ Implemented | ⚠ Partial | ⚠ Partial |
| Warning synthesis (prearm/failsafe/high severity) | ✅ Implemented | ⚠ Partial | ❌ Missing | ❌ Missing |
| Map vehicle marker + heading | ✅ Implemented | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| Home marker / track history / overlays | ✅ Implemented | ❌ Missing | ❌ Missing | ❌ Missing |
| Guided map context actions | ✅ Implemented | ⚠ Partial | ⚠ Partial | ⚠ Partial |
| Tabs (Quick/Actions/Messages/Gauges/Status) | ✅ Implemented | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| Tabs (PreFlight/Servo/Transponder full behavior) | ✅ Implemented | ❌ Missing | ❌ Missing | ❌ Missing |
| Link telemetry health display | ✅ Implemented | ⚠ Partial | ⚠ Partial | ⚠ Partial |

## 2. Mission Planner Reference Behavior

- Primary references:
  - `MissionPlanner/GCSViews/FlightData.cs`
  - `MissionPlanner/ExtLibs/ArduPilot/CurrentState.cs`
  - `MissionPlanner/ExtLibs/Utilities/Warnings/WarningEngine.cs`
- Hidden behavior:
  - warning engine cadence and severity synthesis beyond raw `STATUSTEXT`,
  - map update throttling and conditional recenter behavior,
  - tab-specific update loops (messages and heavy UI update only when active),
  - richer telemetry derivation and health scoring before UI rendering.
- UI behavior is tightly coupled to telemetry validity, not only raw packet presence.

## 3. Backend Audit

- Implemented files:
  - `python_service/message_handlers.py`
  - `python_service/vehicle_state.py`
  - `python_service/mavlink_link.py`
  - `python_service/telemetry_pub.py`
- Gaps:
  - no synthesized warning model (prearm/failsafe aggregation),
  - no home position/track/fence/rally telemetry publication,
  - no transponder/servo telemetry and control pipeline.

## 4. Frontend Audit

- Implemented files:
  - `frontend/src/pages/FlightData.jsx`
  - `frontend/src/components/AdvancedHUD.jsx`
  - `frontend/src/components/MapView.jsx`
  - `frontend/src/components/TelemetryGrid.jsx`
  - `frontend/src/components/tabs/*`
- Detected partial/dead areas:
  - some tabs are present but have reduced behavior vs MP (no PreFlight/Servo/Transponder flows),
  - map overlays are minimal (no home/fence/rally layers),
  - warning system does not highlight critical aggregated state.

## 5. Mission Planner UI Parity

- Must-match MP UI items currently missing/partial:
  - packet rate panel and richer telemetry health indicators,
  - active warning rail (prearm, EKF, failsafe severity),
  - map overlays (home, fence, rally, flight path history),
  - advanced tab ecosystem (servo, transponder, preflight workflows).

## 6. Telemetry Binding Audit

| Widget | MAVLink messages | Fields | Update | Backend | Frontend |
|---|---|---|---|---|---|
| Artificial Horizon | `ATTITUDE` | roll, pitch, yaw | 10-50Hz typical | `handle_message(ATTITUDE)` | `AdvancedHUD` |
| Heading/Speed | `VFR_HUD` | heading, airspeed, groundspeed, climb | 5-10Hz | `handle_message(VFR_HUD)` | `AdvancedHUD`, `QuickTab` |
| Arm/Mode | `HEARTBEAT` | base_mode, custom_mode, type | 1Hz+ | `handle_message(HEARTBEAT)` | `AdvancedHUD`, ribbon |
| Battery | `SYS_STATUS` (and optionally `BATTERY_STATUS`) | voltage/current/remaining | 1-5Hz | `handle_message(SYS_STATUS)` | HUD + tabs |
| GPS | `GPS_RAW_INT`, `GLOBAL_POSITION_INT` | fix/sats/lat/lng/alt | 5-10Hz | `handle_message(...)` | ribbon/map/status |
| EKF | `EKF_STATUS_REPORT` | flags + variances | 1-5Hz | `handle_message(EKF_STATUS_REPORT)` | Status/Quick |
| Vibration | `VIBRATION` | vib/clipping | 1-10Hz | `handle_message(VIBRATION)` | Status/Quick |
| Link health | all packets + `HEARTBEAT` | loss, pps, hb age | computed | `mavlink_link.read_loop` | ribbon/status |

## 7. Missing Feature Implementation Plan

- Backend tasks:
  - add synthesized warning stream (critical/warn/info buckets),
  - add `HOME_POSITION` parser + publish home marker,
  - add route/track accumulator and reset semantics.
- Frontend tasks:
  - render home marker, track line, and warning banner,
  - add PreFlight/Servo/Transponder functional tabs with backend endpoints.
- MAVLink tasks:
  - parse `BATTERY_STATUS`, `HOME_POSITION`, `EXTENDED_SYS_STATE`, `NAV_CONTROLLER_OUTPUT` for richer widgets.
- Testing:
  - SITL scenario tests for warning and map overlay correctness.

## 8. UI/UX Improvements

- Add dynamic tab visibility settings and persistence (Mission Planner pattern).
- Add active warning panel and toast for state transitions.
- Add telemetry overlay toggles (home path, track, heading vector, mission layer).

## 10. DATA SCREEN REQUIREMENTS Review

- HUD: ⚠ Partial (core HUD works; richer MP warning/sensor overlays missing).
- Map Panel: ⚠ Partial (vehicle and basic guided action present; home/fence/track overlays missing).
- Tabs: ⚠ Partial (Quick/Actions/Messages/Gauges/Status exist; PreFlight/Servo/Transponder missing functional parity).
