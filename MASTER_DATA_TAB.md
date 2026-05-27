# MASTER DATA TAB DOCUMENT
**Status**: Production. Last updated: 2026-05-27.
**Scope**: The live-flight Data Tab (Flight Data screen) — HUD, map, actions, modes, parameters, telemetry tabs, and connection.
**Supersedes**: `DATA_TAB_CENTRALIZED.md`, `DATA_TAB_AUDIT_TABLE.md`, `DATA_TAB_AUDIT_PROGRESS.md`, `DATA_TAB_GAP_ANALYSIS.md`, `DATA_TAB_IMP.md`, `DATA_TAB_IMPLEMENTATION_PLAN.md`, `DATA_TAB_GPS_ALTITUDE_AUDIT.md`, `hud-architecture.md`, `HUD_MIGRATION_NOTES.md`, `FEATURE_AUDIT_REPORT.md`, `FINAL_FEATURE_VERIFICATION_REPORT.md`

---

## TABLE OF CONTENTS

1. [Component Map](#1-component-map)
2. [HUD — Complete Audit](#2-hud--complete-audit)
3. [Map (MapView) — Feature Inventory](#3-map-mapview--feature-inventory)
4. [Actions & Commands](#4-actions--commands)
5. [Flight Modes](#5-flight-modes)
6. [Parameters System](#6-parameters-system)
7. [Telemetry Tabs](#7-telemetry-tabs)
8. [MissionExecutionPanel](#8-missionexecutionpanel)
9. [Duplication Issues (Plan↔Data tab)](#9-duplication-issues-plandata-tab)
10. [Parity Scorecard vs Mission Planner](#10-parity-scorecard-vs-mission-planner)
11. [Missing Features](#11-missing-features)

---

## 1. COMPONENT MAP

```
pages/FlightData.jsx (470 LOC)
  ├── components/AdvancedHUD.jsx (437 LOC)
  │     — compass tape, roll arc, pitch ladder, speed tape, altitude tape + VSI,
  │       status bar (mode, GPS, EKF, sats, HDOP), armed/disarmed overlay,
  │       aircraft reference, failsafe banner, vibration chip,
  │       STATUSTEXT toasts (now includes fence/breach/failsafe keywords)
  │
  ├── components/MapView.jsx (877 LOC)
  │     — vehicle marker + rotation, path trail, home marker,
  │       mission overlay, fence overlay, rally points, ADS-B overlay,
  │       auto-follow, click-to-fly-to, set HOME, set ROI
  │
  ├── components/MissionExecutionPanel.jsx
  │     — WP progress, MISSION COMPLETE badge, UNPLANNED RETURN banner,
  │       HOLDING banner, Command/ACK log, Phase transitions table
  │
  ├── components/TelemetryGrid.jsx (59 LOC)
  │
  └── components/tabs/
        ActionsTab.jsx    — ARM/DISARM/TAKEOFF/LAND/RTL/GUIDED/AUTO/modes
        QuickTab.jsx      — configurable quick parameter view
        StatusTab.jsx     — extended telemetry values
        GaugesTab.jsx     — analog-style gauges
        MessagesTab.jsx   — STATUSTEXT stream by severity
        PreFlightTab.jsx  — live pre-arm checks
        ServoTab.jsx      — SERVO_OUTPUT_RAW live PWM
        AuxTab.jsx        — auxiliary functions
```

---

## 2. HUD — COMPLETE AUDIT

### 2.1 HUD Element Status

| Element | File | Lines | Status |
|---------|------|-------|--------|
| Compass / heading tape | `AdvancedHUD.jsx` | 5–56 | ✓ |
| Roll arc + pointer | `AdvancedHUD.jsx` | 59–126 | ✓ |
| Pitch ladder + horizon clip | `AdvancedHUD.jsx` | 129–162 | ✓ |
| Speed tape (airspeed + groundspeed) | `AdvancedHUD.jsx` | 165–200 | ✓ |
| Altitude tape + VSI bar | `AdvancedHUD.jsx` | 203–254 | ✓ |
| Status bar (mode, GPS, EKF, sats, HDOP) | `AdvancedHUD.jsx` | 261–336 | ✓ |
| Armed/Disarmed overlay | `AdvancedHUD.jsx` | 363–366 | ✓ |
| Aircraft reference (center gull-wing) | `AdvancedHUD.jsx` | 369–380 | ✓ |
| Failsafe banner | `AdvancedHUD.jsx` | 382–385 | Partial (failsafe only — no pre-arm) |
| Vibration warning chip | `AdvancedHUD.jsx` | 304–305, 409 | ✓ (>30 m/s² threshold) |
| STATUSTEXT fence/breach/failsafe toast | `AdvancedHUD.jsx` | (fixed 2026-05-27) | ✓ (red, "FENCE" label) |
| Distance to home widget | — | — | **Missing** |
| Distance to next WP widget | — | — | **Missing** on HUD (in StatusTab) |
| Mission progress widget (current/total) | — | — | **Missing** on HUD (in StatusTab) |
| Pre-arm warnings overlay | — | — | **Missing** |
| STATUSTEXT overlay / ticker on HUD | MessagesTab only | — | **Missing** on HUD |
| Flight path trail on HUD | — | — | **Missing** on HUD (exists on map) |

### 2.2 MAVLink → HUD Data Path

| MAVLink Message | Python Handler | VehicleState Field | HUD Consumption |
|-----------------|---------------|-------------------|-----------------|
| `HEARTBEAT` | `message_handlers.py:37-51` | `status.{armed, mode}` | Armed overlay, mode label |
| `ATTITUDE` | `:87-90` | `attitude.{roll, pitch, yaw}` (rad) | Horizon, roll arc, pitch ladder |
| `GLOBAL_POSITION_INT` | `:92-105` | `position.{alt_amsl, alt_rel}`, `velocity.heading` | Altitude tape, heading |
| `VFR_HUD` | `:122-127` | `velocity.{airspeed, groundspeed, climb, throttle}` | Speed tape, VSI |
| `GPS_RAW_INT` | `:81-85` | `status.{gps_fix, satellites, gps_hdop}` | GPS status pill |
| `EKF_STATUS_REPORT` | `:129-135` | `status.ekf_*` | EKF pill (variance aggregation at `:288-302`) |
| `VIBRATION` | `:137-143` | `status.vibration_{x,y,z}` | Vibe chip |
| `STATUSTEXT` | `:163-168` | `status_messages` | Toast (incl. fence keywords at any severity) |
| `MISSION_CURRENT` | `:119-120` | `mission.current_seq` | **Not in HUD** — StatusTab + MissionExecutionPanel |
| `NAV_CONTROLLER_OUTPUT` | `:158-161` | `navigation.{wp_dist, nav_bearing}` | **Not in HUD** — StatusTab |
| `HOME_POSITION` | `:106-110` | `home.{lat, lng, alt_m, valid}` | **Not in HUD** — map home marker |

### 2.3 STATUSTEXT Toast Filter (Post-Fix 2026-05-27)

```js
// AdvancedHUD.jsx
const STATUSTEXT_TOAST_SEVERITY = 4;

const isImportant = (m) => {
  if ((m?.severity ?? 7) <= STATUSTEXT_TOAST_SEVERITY) return true;
  const t = String(m?.text || '').toLowerCase();
  return t.includes('fence') || t.includes('breach') || t.includes('failsafe');
};

// For fence messages: color=#ef4444 (red), label="FENCE"
// ArduPilot sends "Polygon fence breached" at NOTICE (severity 5) — was silently filtered before this fix
```

---

## 3. MAP (MAPVIEW) — FEATURE INVENTORY

All features implemented in `components/MapView.jsx` unless noted.

| Feature | Lines | Status |
|---------|-------|--------|
| Vehicle marker (custom quadcopter SVG) | 23–39, 293–376 | ✓ |
| Real GPS rendering (validates gps_fix ≥ 2, excludes (0,0)) | 293–376 | ✓ |
| Heading rotation (yaw → heading fallback) | 14–21, 368–370 | ✓ |
| Path trail (rolling 1500 pts max, 1e-6 decimation, reset on disconnect) | 201–220, 336–347 | ✓ |
| Home marker | 398–424 | ✓ |
| "Go to vehicle" button (easeTo) | 661–677 | ✓ |
| Auto-follow with localStorage persist + cancel-on-user-interact | 105–108, 349–354, 693–700 | ✓ |
| Mission overlay (route line + seq-numbered WPs, active-WP highlight) | 536–605 | ✓ |
| Geofence overlay (inclusion green / exclusion red, dashed outline) | 505–534 | ✓ |
| Rally points | 551–566 | ✓ |
| First-fix auto-centre (one-shot) | 94–96, 312–323 | ✓ |
| ADS-B traffic overlay | 462–503 | ✓ |
| Click-to-fly-to (context menu → `/api/flyto`) | 769–778 | ✓ |
| Set HOME from map | context menu → `/api/vehicle/set_home` | ✓ |
| Set ROI from map | context menu → `/api/vehicle/roi` | ✓ |
| Tile-provider switcher | — | **Missing** (hard-coded CartoDB dark-matter) |
| Distance / bearing measurement tool | — | **Missing** |
| Altitude profile along path | — | **Missing** |
| Weather overlay | — | **Missing** |

### 3.1 Telemetry → Map Data Path

```
GLOBAL_POSITION_INT → position.{lat, lng, alt_rel}
ATTITUDE / VFR_HUD  → attitude.yaw / velocity.heading
HOME_POSITION       → home.{lat, lng, valid}
  │
  ▼
ZMQ → Node → WebSocket → useTelemetryStore
  │
  ▼
MapView effect (deps: lat, lng, heading, line 293)
  ├── validate positionValid (gps_fix ≥ 2, lat/lng ≠ 0,0)
  ├── setLngLat + setRotation (vehicle marker)
  ├── append trail (move > 1e-6 degrees)
  ├── auto-follow easeTo
  └── rAF 60-fps interpolation
```

---

## 4. ACTIONS & COMMANDS

All actions are fully wired through the Node API shortcut layer, not directly from Python. See `MASTER_GCS_ARCHITECTURE.md §6` for the full command pipeline.

| Action | Endpoint | MAV cmd | Status |
|--------|----------|---------|--------|
| ARM | `/api/command/arm` | 400 p1=1 | ✓ |
| FORCE ARM | `/api/command/force_arm` | 400 p1=1 p2=21196 | ✓ |
| DISARM | `/api/command/disarm` | 400 p1=0 | ✓ |
| TAKEOFF | `/api/command/takeoff` | 22 p7=alt | ✓ |
| LAND | `/api/command/land` | 21 | ✓ |
| RTL | `/api/command/rtl` | 20 | ✓ |
| MISSION START | `/api/command/mission_start` | 300 | ✓ |
| PAUSE / CONTINUE | `/api/command/pause`, `/continue` | 193 p1=0/1 | ✓ |
| SET MODE | `/api/mode { mode: '<name>' }` | SET_MODE | ✓ |
| FLY-TO-HERE | `/api/flyto` | SET_POSITION_TARGET_GLOBAL_INT | ✓ |
| SET HOME | `/api/vehicle/set_home` | MAV_CMD_DO_SET_HOME (179) | ✓ |
| ROI / ROI clear | `/api/vehicle/roi`, `/roi/clear` | MAV_CMD_DO_SET_ROI_* | ✓ |
| Emergency stop / kill switch | — | — | **Missing** |

### 4.1 ARM Auto-Retry (ActionsTab.jsx)

When ARM is rejected with "mode not armable":
1. `ActionsTab.jsx:71-99`: auto-switch to STABILIZE → wait 800ms → retry ARM

This is the **correct path**. The quick-action ARM in FlightData also has this retry (added in M3 fix).

---

## 5. FLIGHT MODES

`main.py:547` `/vehicle/flight_modes` returns pymavlink's `mode_mapping()` for the connected autopilot. Frontend renders the dynamic list.

All 22+ ArduPilot copter modes can be set via `POST /api/mode { mode: '<name>' }` → `mavlink_link.set_mode()`.

### 5.1 Static Fallback List (ActionsTab.jsx:16-21)

`ActionsTab.jsx` keeps a hardcoded fallback list for when the vehicle is not connected. This duplicates pymavlink's mode map — **a known duplication (D5)** — but acceptable for offline UX.

### 5.2 Gaps

- No per-mode parameter validation (e.g. AUTO requires mission, GUIDED requires position estimate)
- No mode-specific UX (sub-options, defaults)

---

## 6. PARAMETERS SYSTEM

| Capability | File | Status |
|-----------|------|--------|
| Quick params widget | `tabs/QuickTab.jsx` + `utils/TelemetryRegistry.js` | ✓ |
| Full param browse / search / sort | `pages/Params.jsx` | ✓ |
| `PARAM_REQUEST_LIST` + `PARAM_VALUE` ingest | `parameter_manager.py:188-232` | ✓ |
| `PARAM_SET` + ACK tolerance + 3× retry | `parameter_manager.py:139-186` | ✓ |
| Per-vehicle JSON cache (1 h TTL) | `param_cache/` + `parameter_manager.py:25-30` | ✓ |
| Mission Planner `.param` import | `main.py:711-730`, `param_format.py` | ✓ |
| Mission Planner `.param` export | `main.py:653-658, 698-710`, `param_format.py` | ✓ |
| Param diff (two files / vehicle vs file) | `main.py:681-767`, `param_format.py:diff_param_dicts()` | ✓ |
| Param metadata (units, range, description) | `parameter_metadata.py` | ✓ fetched, **not rendered in Params.jsx** |
| Sync progress + last error | `parameter_manager.py:to_status()` | ✓ |
| Unsaved-changes / dirty indicator | — | **Missing** |
| Reset to default | `/parameters/reset` | ✓ |
| Auto-fetch on connect | — | **Missing** (M5) — parameters stay `{}` until user visits Params tab |

### 6.1 Auto-Fetch Gap (M5)

`parameter_manager.fetch_all()` is only called when the user visits the Params tab. This means:
- Fence diagnostics panel reads `vehicle.parameters.FENCE_*` → sees 0 on first load
- `Alt < AltMax` preflight chip reads fence params → incorrect until Params tab visited

**Fix**: trigger `parameter_manager.fetch_all()` automatically after `_bootstrap_session` returns True, guarded by a `fetched_once` flag.

---

## 7. TELEMETRY TABS

| Tab | Purpose | Status |
|-----|---------|--------|
| **Quick** | Configurable telemetry quick-view, editable via TelemetryRegistry | ✓ |
| **Status** | Extended: alt, ground speed, WP distance, distance to home, battery, GPS, EKF | ✓ |
| **Gauges** | Analog-style visual gauges for key values | ✓ |
| **Actions** | All flight controls: ARM/DISARM, modes, TAKEOFF/LAND/RTL | ✓ |
| **Messages** | Live STATUSTEXT stream, filterable by severity | ✓ |
| **PreFlight** | Live pre-arm checks: GPS lock/HDOP/EKF/sensor health/battery/arming | ✓ |
| **Servo** | Live PWM from SERVO_OUTPUT_RAW | ✓ |
| **Aux** | Auxiliary functions | ✓ |

### 7.1 Messages Tab — Critical for Debugging

The **Messages tab** shows the autopilot's STATUSTEXT stream. This is the **first place to look** when the vehicle does something unexpected.

Key messages and what they mean:
- `Polygon fence breached` → fence polygon triggered RTL (NOTICE severity — was hidden before fix)
- `Fence Breach Circle` → vehicle exceeded FENCE_RADIUS from HOME
- `EKF variance` / `EKF primary changed` → EKF failsafe
- `RC: Failsafe` → RC link lost
- `GCS Failsafe` → GCS link lost (`FS_GCS_ENABLE`)
- `RTL: Critical battery` → battery failsafe
- `Auto: Missing Takeoff Cmd` → AUTO mode refused; no TAKEOFF in mission

---

## 8. MISSIONEXECUTIONPANEL

`components/MissionExecutionPanel.jsx` — rendered inside FlightData.jsx below the HUD.

### 8.1 Key Detections

**MISSION COMPLETE** (green badge):
- Condition: `(inRtl || inLand) && (activeSeq - 1 === lastUserIdx) && (lastUserCmd === 20 || 21)`
- Meaning: vehicle entered RTL/LAND because the planned last waypoint IS an RTL/LAND command. This is **normal end-of-mission**, not a failsafe.

**UNPLANNED RETURN** (red banner, added 2026-05-27):
- Condition: `vehicleArmed && (inRtl || inLand || inBrake) && !missionCompletedByPlan && !reachingMissionEnd`
- Shows the autopilot's most recent fence/failsafe STATUSTEXT
- Includes fence-clearing guidance if the reason contains `fence`/`breach`

**HOLDING · NOT STARTED** (amber badge):
- Condition: `vehicleArmed && modeUpper === 'AUTO' && !airborne && activeSeq >= 1`
- Means: vehicle is armed in AUTO, the counter shows the TAKEOFF cursor (ArduPilot advances MISSION_CURRENT to TAKEOFF on AUTO entry), but the vehicle is still on the ground. This is **expected** — click "Start Mission".

**ENDING (PLANNED)** (teal badge):
- Condition: `(inRtl || inLand) && (activeCmdNum === 20 || 21)` but not yet at last WP
- Softer state: mission is transitioning toward planned completion

### 8.2 Airborne Detection

`airborne = position.alt_rel > 0.8 m`

This threshold is used in both `MissionExecutionPanel.jsx` and `FlightPlanner.jsx` to distinguish HOLDING from RUNNING. It ensures the counter can't be misread as "mission started" when the vehicle is merely armed in AUTO.

### 8.3 Props Required (from FlightData.jsx)

```jsx
<MissionExecutionPanel
  operational={...}
  operationalHistory={...}
  commandStatus={...}
  commandHistory={...}
  missionSeq={vehicle?.mission?.current_seq}
  missionTotal={vehicle?.mission?.total}
  plannedWaypoints={missionStore.waypoints}
  vehicleAltRel={vehicle?.position?.alt_rel}
  vehicleGroundSpeed={vehicle?.velocity?.groundspeed}
  vehicleWpDist={vehicle?.navigation?.wp_dist}
  missionSyncStatus={vehicle?.mission_sync}
  vehicleMode={vehicle?.status?.mode}
  vehicleArmed={vehicle?.status?.armed}
  statusMessages={vehicle?.status_messages}          // for UNPLANNED RETURN banner
  fenceBreachText={vehicle?.fence_status?.last_breach_text}  // fallback
/>
```

---

## 9. DUPLICATION ISSUES (PLAN↔DATA TAB)

These duplications exist between `MapView.jsx` (Data tab) and `MapEditor.jsx` (Plan tab). They should be extracted into shared utils but are not currently a runtime problem.

| Duplication | MapView | MapEditor | Shared already? |
|-------------|---------|-----------|-----------------|
| Fence polygon grouping (`buildFenceGroups`) | `:516-526` | `:42-54` | Partially in `utils/mapShared.js` |
| Waypoint sequence labelling | `:597` | `:279` | No |
| Mission route line source | `mv-mission-route` | `route` | No (different names, same logic) |
| Home marker SVG + logic | `:410-423` | `:241-256` | No |
| Drone heading fallback (yaw→heading) | `:14-21` | `:97-104` | Also `mapSelectors.js:27-36` |
| Tile style (CartoDB dark-matter) | hard-coded | hard-coded | No |
| Fence command constants (5001/5002) | inline | inline | Should be in `mapShared.js` |

**Recommended fix**: extract these into `utils/fenceGeometry.js` + a shared `<HomeMarker>` component + `utils/mapShared.js` constants.

---

## 10. PARITY SCORECARD VS MISSION PLANNER

| Area | Score | Status |
|------|-------|--------|
| HUD | 75% | Core attitude/speed/alt/GPS/EKF/arm ✓; missing mission/WP/home widgets + pre-arm overlay |
| Telemetry | 90% | End-to-end MAVLink → store; replay backend exists, UI does not |
| Actions | 85% | All MP shortcuts wired (ARM/RTL/TAKEOFF/LAND/MISSION_START/PAUSE); no kill switch |
| Modes | 70% | All ArduPilot modes settable via pymavlink; no per-mode validation or UX |
| Parameters | 90% | Read/write/cache/.param import-export/diff/reset; metadata fetched but not rendered |
| Connection | 80% | Serial/UDP/TCP/BLE work; reconnect works; no profiles, no exponential backoff |
| Map | 85% | Vehicle/home/trail/mission/fence/rally/ADS-B/Go-to/Click-to-fly ✓; no provider switch, no measure tool |
| **Overall** | **~83%** | Solid foundation; remaining gaps tracked below |

**Previously-hidden bug fixed**: STATUSTEXT fence breach messages (NOTICE severity) were silently filtered. Now toasted in real time and shown in UNPLANNED RETURN banner. This was the root cause of multiple sessions of "premature RTL" mis-diagnosis.

---

## 11. MISSING FEATURES

| # | Feature | Area | Notes |
|---|---------|------|-------|
| M1 | Distance-to-home HUD widget | HUD | Compute from `position` + `home` |
| M2 | Distance-to-next-WP HUD widget | HUD | `navigation.wp_dist` already in store |
| M3 | Mission progress HUD widget | HUD | `mission.current_seq` in store |
| M4 | Pre-arm warnings overlay (sensor health bitmask) | HUD | Backend has SYS_STATUS sensor bits |
| M5 | Auto-fetch parameters after connect | Parameters | `parameter_manager.fetch_all()` after `_bootstrap_session` |
| M6 | Configurable telemetry stream rates from UI | Telemetry | Backend supports; UI missing |
| M7 | Replay UI (record/play/seek) | Telemetry | Endpoints exist at `main.py:201-257` |
| M8 | Emergency stop / kill-switch | Actions | No dedicated path |
| M9 | Per-mode validation + parameter prompts | Modes | AUTO needs mission; GUIDED needs position |
| M10 | Param metadata display (units/range/desc) | Parameters | Metadata fetched (`parameter_metadata.py`) but not shown in Params.jsx |
| M11 | Unsaved-changes dirty indicator in Params | Parameters | — |
| M12 | Connection profiles (saved string + transport + baud) | Connection | Frontend uses hardcoded presets |
| M13 | Exponential backoff + retry cap + reason-coded errors | Connection | Fixed 1 s, infinite retries currently |
| M14 | Tile-provider switcher | Map | Hard-coded CartoDB |
| M15 | Distance / bearing measurement tool | Map | — |
| M16 | Altitude profile along path | Map | — |
| M17 | UDP-server / forwarding UI | Connection | Env-var only |
