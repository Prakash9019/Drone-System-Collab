# Mission Planner Parity Board Report

Date: 2026-05-11  
Scope: `drone_gcs` parity review against Mission Planner modules provided by product team.

## Executive Summary

- `drone_gcs` has a functioning MAVLink core (connect, telemetry stream, commands, mission upload/download, parameters, SITL orchestration).
- It is **not yet full Mission Planner parity**.
- Highest maturity: Connect/Data/Plan/Params/SITL core loop.
- Biggest gaps: firmware flashing, deep log analyzer/FFT, full swarm/multi-link UI, advanced map providers, ADS-B transponder tab depth.

## Module-by-Module Status

### 1) Connect Module

**Backend**
- Implemented: serial/tcp/udp connection start/stop/status.
- Handshake: heartbeat + expected telemetry check before marking connected.
- Reconnect: heartbeat timeout -> reconnect attempts.
- Link quality: packet loss, pps, heartbeat age, latency estimate.

**Frontend**
- Implemented: protocol via free-form connection string + presets, baud, connect/disconnect.
- Visible status: stream vs MAVLink connection state.

**Gap vs Mission Planner**
- No multi-link manager UI, no explicit MAVLink version negotiation control, no port auto-picker UI list.
- **Phase C (started):** multi-vehicle on one MAVLink stream (map + primary selector); ADS-B ingest and map overlay; multi-SITL hints on Simulation page.

---

### 2) Data Module (Flight Data)

**Implemented**
- HUD: artificial horizon, compass ribbon, speed/alt tapes, armed/mode badges.
- Map: vehicle marker, home marker (from HOME_POSITION), guided fly-to context command.
- Tabs: Quick, Actions, Messages, PreFlight, Gauges, Status, Servo.
- Messages: STATUSTEXT stream rendered by severity.

**Telemetry bindings now wired**
- `ATTITUDE`, `VFR_HUD`, `SYS_STATUS`, `GPS_RAW_INT`, `GLOBAL_POSITION_INT`, `EKF_STATUS_REPORT`, `VIBRATION`, `RC_CHANNELS`, `HOME_POSITION`, `MISSION_CURRENT`, `NAV_CONTROLLER_OUTPUT`, `SERVO_OUTPUT_RAW`.

**New in this parity pass**
- Added `PreFlight` tab with live checks (GPS lock/HDOP/EKF/sensor health/battery/arming state).
- Added `Servo` tab with live PWM (`SERVO_OUTPUT_RAW`).
- Added navigation fields (`wp_dist`, bearings) and surfaced in Quick/Status tabs.
- Added MAVLink stream request for `MAV_DATA_STREAM_EXTRA3` to improve nav telemetry availability.

**Gap vs Mission Planner**
- No transponder/ADS-B tab.
- No full analog gauge pack equivalent.
- Flight trail now rendered; still lacks MP-level layered map telemetry/track controls.
- **Phase C (started):** ADS-B targets on map + Help table (MAVLink `ADSB_VEHICLE`); secondary vehicle markers on map when multiple sysids are present.

---

### 3) Plan Module

**Implemented**
- Waypoint CRUD, mission read/write, MISSION/FENCE/RALLY switching.
- Fence inclusion/exclusion commands (5001/5002) + planner mode toggle.
- Fence config write/read (`FENCE_ENABLE/ACTION/RADIUS/ALT_*`).
- Survey/lawnmower grid generator (center/size/heading/spacings, append/replace) with map handoff.
- Mission execution controls: `Set AUTO`, `Set GUIDED`, `Start Mission`, mission transfer status/progress strip.
- Current waypoint highlighting in table/map from `MISSION_CURRENT`; Mission Execution panel includes command/ACK and phase transitions.
- Rally nearest-point estimation (live distance to closest rally point when position available).

**Gap vs Mission Planner**
- Right-click library expanded (Loiter variants, DO_JUMP, ROI, Takeoff/Land/RTL/Spline/Speed/CAM trigger + survey handoff), but still missing corridor/structure scan generators.
- Missing terrain analysis/elevation tools and mission toolchain depth.

---

### 4) Setup Module

**Current**
- Dedicated Setup page with Calibration + Parameters tabs.
- Calibration actions exposed: accelerometer, compass, level, ESC, reboot autopilot.

**Gap vs Mission Planner**
- Missing interactive wizard flows (orientation walk-through, radio calibration graph, optional hardware setup pages).

---

### 5) Configuration Module

**Implemented**
- Parameter fetch/edit/search/categories.
- Verified param set with rollback handling server-side.
- Sync progress + cache load status.

**Gap vs Mission Planner**
- No metadata (units/min/max/enums/reboot flags).
- Parameter file export/import/compare now available (JSON workflow); MP `.param` native and metadata-linked workflows still missing.
- No dedicated planner preferences subtab parity.
- **Phase C (started):** lightweight metadata JSON + optional `PARAM_METADATA_JSON` merge; full MP metadata parity still open.

---

### 6) Simulation Module

**Implemented**
- SITL start/stop/reset, logs, profiles, sim_vehicle probe.
- MP-style orchestration improvements:
  - robust sim_vehicle discovery (`ARDUPILOT_HOME`, `SITL_CMD`, common locations)
  - process group handling and watchdog
  - optional auto `--out udp:127.0.0.1:14550`
  - optional auto-connect after start
  - capabilities endpoint + UI controls (extra args, auto-connect delay, target URL)

**Gap vs Mission Planner**
- No binary download manager for native Linux/mac binaries in-app.
- No swarm simulation manager UI.

---

### 7) Help Module

**Current**
- Dedicated Help/Diagnostics page added.
- Includes live MAVLink inspector (message count/frequency table) and documentation links.

**Gap vs Mission Planner**
- No deep packet field inspector tree, no DataFlash log analyzer/FFT UI yet.
- **Phase C (started):** basic `.tlog` / `.bin` message histogram in Help; FFT / graph tooling still open.

---

## Internal Architecture Parity

### Telemetry Pipeline
- Implemented flow: Vehicle -> LinkManager -> message parser -> `VehicleState` -> ZMQ -> WebSocket gateway -> Zustand store -> UI widgets.

### State Management
- Implemented: connection state, vehicle telemetry state, mission state, parameter sync status.
- Partial: multi-vehicle state exists conceptually but primary vehicle model dominates UI/processing.
- **Phase C (started):** all vehicles receive telemetry in the store; map shows non-primary aircraft; primary selector in Flight Data; ADS-B tracks in store + map.

### Dynamic Widget Logic
- Implemented: tabs and widgets bind live telemetry.
- Gap: no per-airframe adaptive widget packs at Mission Planner depth.

## Critical Remaining Gaps (Board Priority)

1. Firmware flashing and setup wizard depth.
2. DataFlash log analyzer + FFT + graph tooling.
3. Multi-vehicle switching and swarm controls. **Status: Phase C started** (fleet map markers, primary `sysid` select, simulation hints); swarm orchestration and multi-link UI still open.
4. Advanced plan tools (survey/grid/spline/terrain). **Status: partially implemented** (survey/grid + spline command + mission execution instrumentation); corridor/structure scan + terrain still open.
5. Parameter metadata (units/min/max/enums/reboot). **Status: Phase C started** (built-in JSON + API); full MP parity still open.
6. ADS-B/transponder and advanced map providers. **Status: Phase C started** (ADS-B MAVLink ingest, REST, map + Help); transponder tab and map providers still open.

## Immediate Recommendation

Adopt a staged parity roadmap (updated execution status):

- **Phase A (Ops parity)**: calibration page exposure, pre-arm diagnostics, richer Data map trail, mission command palette. **Status: Implemented (initial functional cut).**
- **Phase B (Engineering parity)**: MAVLink inspector, log analyzer, parameter metadata/files. **Status: Implemented (initial functional cut)** — inspector, parameter import/export/compare, log histogram upload, lightweight metadata JSON + Params columns.
- **Phase C (Advanced parity)**: multi-vehicle/swarm, ADS-B, advanced simulation orchestration. **Status: In progress** — multi-vehicle telemetry + map + primary select, ADS-B store/API/ZMQ/map/Help, mission execution panel/ACK history/phase transitions, multi-SITL documentation block on Simulation; remaining: FFT/graph log tools, full metadata parity, multi-link UI, map provider layers, in-app swarm/SITL manager.

