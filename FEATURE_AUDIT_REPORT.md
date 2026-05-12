# Feature Audit Report

**Product:** Drone GCS (`drone_gcs`: FastAPI Python service, Node gateway, React frontend)  
**Audit date:** 2026-05-10  
**Reference:** Compared qualitatively to [Mission Planner](https://github.com/ArduPilot/MissionPlanner) expectations (full MP parity is not claimed by this codebase).

**Legend:** Implemented = present in codebase; Partial = stubs, single path, or UI/API gap; No = absent.

---

## 1. CONNECTION & LINK MANAGEMENT

### Backend Status
- **Implemented:** Partial
- **APIs:** `/connection/start`, `/connection/stop`, `/connection/status` (FastAPI); proxied `/api/connection/*` (Node).
- **Services:** `LinkManager` (`mavlink_link.py`), `auto_detect_connection` (`connection_manager.py`), startup via `main.py` lifespan.
- **MAVLink Handling:** Single `mavutil.mavlink_connection`; GCS heartbeat; `REQUEST_DATA_STREAM` after vehicle heartbeat; optional UDP forwarding list (constructor; default often empty).
- **Issues Found:** Default connection string in `main.py` was machine-specific unless overridden by API start; no explicit MAVLink v1/v2 negotiation UI; auto-baud tries one detected port/baud from auto-detect only; multi-vehicle not supported (single `primary_sysid`); stream rates fixed in code, not user-tunable.

### Frontend Status
- **UI Available:** Yes (Flight Data ribbon)
- **Components:** `FlightData.jsx` — connect/disconnect, preset connection strings, baud select; `App.jsx` link indicator.
- **Real-time Integration:** WebSocket `CONNECTION_STATUS` from ZMQ fan-out; not all link stats exposed in UI.
- **Issues Found:** Presets only; custom port/string input added in audit follow-up; loss/latency partially shown.

### Integration Status
- **Partial**

### Required Fixes
- [x] Backend implementation — env-based default connection (see implementation)
- [x] Frontend integration — primary vehicle id + custom connection string
- [ ] WebSocket integration — optional: richer link-quality events
- [ ] MAVLink parser update — N/A for this slice
- [x] State management fix — primary vehicle key normalization
- [ ] UI implementation — full port discovery / saved profiles
- [ ] Error handling — surface Python connect errors to UI
- [ ] Performance optimization — N/A

---

## 2. TELEMETRY SYSTEM (ADVANCED)

### Backend Status
- **Implemented:** Partial
- **APIs:** Polled `/state`; live path is ZMQ → WebSocket (not REST).
- **Services:** `message_handlers.py` → `VehicleState`; `telemetry_pub.py` @ ~10 Hz.
- **MAVLink Handling:** HEARTBEAT, SYS_STATUS, GPS_RAW_INT, ATTITUDE, GLOBAL_POSITION_INT, VFR_HUD, EKF_STATUS_REPORT, VIBRATION, RC_CHANNELS, STATUSTEXT, TIMESYNC (latency hint), PARAM_VALUE.
- **Issues Found:** HDOP not parsed from GPS message; no `GLOBAL_POSITION_INT` velocity fields mapped; sensor health bitmask not dedicated; failsafe flags not a dedicated model.

### Frontend Status
- **UI Available:** Yes
- **Components:** `TelemetryGrid`, `AdvancedHUD`, connection ribbon stats.
- **Real-time Integration:** Yes via WebSocket JSON.
- **Issues Found:** Prior hardcoded `telemetry['1']` breaks non-default sysid (fixed in follow-up).

### Integration Status
- **Partial**

### Required Fixes
- [ ] Backend implementation — HDOP, GPS_RAW_INT eph/epv, SYS_STATUS sensors field
- [x] Frontend integration — primary vehicle selection
- [x] WebSocket integration — already used
- [ ] MAVLink parser update — optional SUBSYS messages
- [x] State management fix — vehicle id keying
- [ ] UI implementation — dedicated EKF / vibration panels
- [ ] Error handling
- [ ] Performance optimization — tune publish rate / delta encoding

---

## 3. FLIGHT DATA (MAIN SCREEN LOGIC)

### Backend Status
- **Implemented:** Partial (data); no separate “HUD server”
- **APIs:** Same as telemetry.
- **Services:** `VehicleState` attitude/position/velocity.
- **MAVLink Handling:** As in §2.
- **Issues Found:** No server-side trail buffer; home position not explicitly modeled (may appear only if in params or future HOME message).

### Frontend Status
- **UI Available:** Yes
- **Components:** `FlightData.jsx`, `AdvancedHUD`, `MapView`, `TelemetryGrid`.
- **Real-time Integration:** Yes.
- **Issues Found:** Altitude ladder / speed tape fidelity vs MP varies; map trail / home marker not verified as full MP equivalent; target tracking not implemented.

### Integration Status
- **Partial**

### Required Fixes
- [ ] Backend implementation — optional HOME_POSITION handling
- [ ] Frontend integration — path history, home icon
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation — MP-class HUD widgets
- [ ] Error handling
- [ ] Performance optimization

---

## 4. COMMAND & CONTROL

### Backend Status
- **Implemented:** Partial
- **APIs:** `POST /command` (COMMAND_LONG), `POST /mode`, `POST /flyto`.
- **Services:** `LinkManager.send_command`, `set_mode`, `fly_to_here` (GUIDED + SET_POSITION_TARGET_GLOBAL_INT).
- **MAVLink Handling:** COMMAND_ACK waited in `send_command`; mode via `SET_MODE`.
- **Issues Found:** No dedicated arm/disarm REST name in Python (routed via Node shortcuts); no RC override, servo/relay helpers; emergency stop / reboot not exposed as REST.

### Frontend Status
- **UI Available:** Partial
- **Components:** ARM/DISARM, RTL on `FlightData`; map context “Fly To Here” → `/api/flyto`.
- **Real-time Integration:** Commands are REST; state updates via telemetry.
- **Issues Found:** No mode dropdown; no LAND/Takeoff altitude UI; no generic COMMAND_LONG UI.

### Integration Status
- **Partial**

### Required Fixes
- [ ] Backend implementation — optional `/command/arm`, `/command/reboot` wrappers
- [x] Frontend integration — LAND shortcut (Node `COMMAND_MAP`)
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation — mode selector, takeoff alt
- [ ] Error handling — show COMMAND_ACK failures
- [ ] Performance optimization

---

## 5. MISSION PLANNING (ADVANCED)

### Backend Status
- **Implemented:** Partial
- **APIs:** `/mission`, `/mission/upload`, `/fence`, `/fence/upload`, `/fence/status`, `/fence/config`, `/rally`, `/rally/upload`.
- **Services:** `MissionManager` MISSION_ITEM_INT protocol.
- **MAVLink Handling:** Upload/download for MISSION, FENCE, RALLY types.
- **Issues Found:** No terrain database; polygon survey / grid / spline / complex DO commands not first-class in UI; mission simulation inside GCS not implemented.

### Frontend Status
- **UI Available:** Yes
- **Components:** `FlightPlanner`, `MapEditor`, `WaypointTable`; fence inclusion/exclusion (5001/5002).
- **Real-time Integration:** Read/write via REST; not live mission index streaming.
- **Issues Found:** ROI insert exists in map menu for MISSION; no full DO command palette; no grid/survey generator.

### Integration Status
- **Partial**

### Required Fixes
- [ ] Backend implementation — optional mission stats / current WP index stream
- [ ] Frontend integration — survey/grid tools
- [ ] WebSocket integration
- [ ] MAVLink parser update — MISSION_CURRENT optional
- [ ] State management fix
- [ ] UI implementation — DO command library
- [ ] Error handling — upload ACK details to UI
- [ ] Performance optimization

---

## 6. PARAMETER MANAGEMENT (FULL)

### Backend Status
- **Implemented:** Partial
- **APIs:** `/parameters/refresh`, `/parameters/set`, `/parameters/status`, `/parameters/cache/load`.
- **Services:** `ParameterSyncManager` — fetch list, verified set w/ rollback, disk cache, ZMQ `PARAM_SYNC_STATUS`.
- **MAVLink Handling:** PARAM_REQUEST_LIST, PARAM_VALUE, PARAM_SET.
- **Issues Found:** No ArduPilot metadata XML (min/max/units/enums); no compare/diff; no file import/export of param files on API.

### Frontend Status
- **UI Available:** Yes (`Params` / Setup route)
- **Components:** Search, categories, pagination, edit row, fetch all, cache load, sync status from store.
- **Real-time Integration:** Parameters merged into vehicle telemetry; sync status over WS.
- **Issues Found:** No metadata columns; no compare or .param file IO.

### Integration Status
- **Partial**

### Required Fixes
- [ ] Backend implementation — param file import/export
- [ ] Frontend integration — metadata & diff views
- [x] WebSocket integration — PARAM_SYNC_STATUS used
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation — reboot required flags
- [ ] Error handling — show rollback in UI
- [ ] Performance optimization

---

## 7. CALIBRATION & SETUP

### Backend Status
- **Implemented:** No
- **APIs:** None dedicated (could use raw COMMAND_LONG).
- **Services:** None.
- **MAVLink Handling:** Not implemented as wizards.
- **Issues Found:** Accel/compass/radio/ESC calibration flows absent.

### Frontend Status
- **UI Available:** No
- **Components:** N/A
- **Real-time Integration:** N/A
- **Issues Found:** Setup route is parameters only.

### Integration Status
- **Broken / Missing**

### Required Fixes
- [ ] Backend implementation
- [ ] Frontend integration
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation
- [ ] Error handling
- [ ] Performance optimization

---

## 8. LOGGING & ANALYSIS

### Backend Status
- **Implemented:** No (no .tlog / .bin pipeline in repo)
- **APIs:** None
- **Services:** SITL stdout/stderr log buffer only (`sitl_manager`).
- **MAVLink Handling:** N/A
- **Issues Found:** No log download, replay, or graphs.

### Frontend Status
- **UI Available:** Partial (simulation log viewer if exposed)
- **Components:** `Simulation.jsx` may show logs — verify locally.
- **Real-time Integration:** N/A for vehicle logs
- **Issues Found:** No analytics suite.

### Integration Status
- **Broken / Missing**

### Required Fixes
- [ ] Backend implementation
- [ ] Frontend integration
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation
- [ ] Error handling
- [ ] Performance optimization

---

## 9. TUNING & ANALYSIS TOOLS

### Backend Status
- **Implemented:** No
- **APIs:** Parameters only
- **Services:** None for PID autotune session or FFT
- **MAVLink Handling:** Could use commands; not wired
- **Issues Found:** No real-time tuning graphs like MP.

### Frontend Status
- **UI Available:** No dedicated tuning screen
- **Components:** N/A
- **Real-time Integration:** N/A
- **Issues Found:** User tunes via parameter list only.

### Integration Status
- **Broken / Missing**

### Required Fixes
- [ ] Backend implementation
- [ ] Frontend integration
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation
- [ ] Error handling
- [ ] Performance optimization

---

## 10. CAMERA & PAYLOAD CONTROL

### Backend Status
- **Implemented:** No
- **APIs:** None
- **Services:** None
- **MAVLink Handling:** No CAMERA_TRIGGER / gimbal helpers in `main.py`
- **Issues Found:** —

### Frontend Status
- **UI Available:** No
- **Components:** N/A
- **Real-time Integration:** N/A
- **Issues Found:** —

### Integration Status
- **Broken / Missing**

### Required Fixes
- [ ] Backend implementation
- [ ] Frontend integration
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation
- [ ] Error handling
- [ ] Performance optimization

---

## 11. MAP & GEO FEATURES

### Backend Status
- **Implemented:** No (map is frontend MapLibre)
- **APIs:** None for terrain/offline tiles
- **Services:** None
- **MAVLink Handling:** N/A
- **Issues Found:** Single online basemap URL; no terrain elevation service.

### Frontend Status
- **UI Available:** Yes
- **Components:** `MapView`, `MapEditor` (Carto dark matter)
- **Real-time Integration:** Vehicle position from telemetry
- **Issues Found:** No offline packs; distance measure tool not verified.

### Integration Status
- **Partial**

### Required Fixes
- [ ] Backend implementation — optional terrain API
- [ ] Frontend integration — layer switcher, measure
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation
- [ ] Error handling
- [ ] Performance optimization

---

## 12. MULTI-VEHICLE / SWARM

### Backend Status
- **Implemented:** No
- **APIs:** Single primary vehicle
- **Services:** `vehicles` dict exists but only primary processed in read loop filtering
- **MAVLink Handling:** Single target
- **Issues Found:** No vehicle switcher.

### Frontend Status
- **UI Available:** No
- **Components:** N/A
- **Real-time Integration:** N/A
- **Issues Found:** —

### Integration Status
- **Broken / Missing**

### Required Fixes
- [ ] Backend implementation
- [ ] Frontend integration
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation
- [ ] Error handling
- [ ] Performance optimization

---

## 13. SIMULATION (SITL)

### Backend Status
- **Implemented:** Partial
- **APIs:** `/simulation/start|stop|reset|status|logs`, `/simulation/profiles`
- **Services:** `SITLManager` — locates `sim_vehicle.py`, profiles JSON, logs
- **MAVLink Handling:** External ArduPilot SITL process
- **Issues Found:** Depends on local ArduPilot tree; not containerized in repo.

### Frontend Status
- **UI Available:** Yes (`Simulation.jsx`)
- **Components:** Start/stop, params, log tail
- **Real-time Integration:** Status polling
- **Issues Found:** End-to-end “virtual mission” is manual (planner + SITL).

### Integration Status
- **Partial**

### Required Fixes
- [ ] Backend implementation — health checks for ardupilot path
- [x] Frontend integration — already present
- [ ] WebSocket integration — optional live log stream
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation — preset missions
- [ ] Error handling
- [ ] Performance optimization

---

## 14. FIRMWARE & SYSTEM MANAGEMENT

### Backend Status
- **Implemented:** No
- **APIs:** None
- **Services:** None
- **MAVLink Handling:** No bootloader/flash
- **Issues Found:** —

### Frontend Status
- **UI Available:** No
- **Components:** N/A
- **Real-time Integration:** N/A
- **Issues Found:** —

### Integration Status
- **Broken / Missing**

### Required Fixes
- [ ] Backend implementation
- [ ] Frontend integration
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation
- [ ] Error handling
- [ ] Performance optimization

---

## 15. MAVLINK LOW-LEVEL TOOLS

### Backend Status
- **Implemented:** No
- **APIs:** No inspector
- **Services:** Logging in link manager only
- **MAVLink Handling:** Standard routing
- **Issues Found:** No raw packet peek API.

### Frontend Status
- **UI Available:** No
- **Components:** N/A
- **Real-time Integration:** N/A
- **Issues Found:** —

### Integration Status
- **Broken / Missing**

### Required Fixes
- [ ] Backend implementation
- [ ] Frontend integration
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation
- [ ] Error handling
- [ ] Performance optimization

---

## 16. COMMUNICATION TOOLS

### Backend Status
- **Implemented:** Partial
- **APIs:** Link fields in `/state` / telemetry payload (`link_status`)
- **Services:** Sequence-gap loss estimate, TIMESYNC latency, PPS
- **MAVLink Handling:** Derived from traffic
- **Issues Found:** No dedicated “radio config” screens; forwarding off unless configured.

### Frontend Status
- **UI Available:** Partial (loss % ribbon)
- **Components:** Flight Data ribbon
- **Real-time Integration:** Yes
- **Issues Found:** Bandwidth histogram not shown.

### Integration Status
- **Partial**

### Required Fixes
- [ ] Backend implementation — optional STATS_PORT
- [ ] Frontend integration — latency/BW panel
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation
- [ ] Error handling
- [ ] Performance optimization

---

## 17. UI / UX SYSTEM

### Backend Status
- **Implemented:** N/A
- **APIs:** —
- **Services:** —
- **MAVLink Handling:** —
- **Issues Found:** —

### Frontend Status
- **UI Available:** Yes
- **Components:** Sidebar routes: Flight Data, Planner, Setup (params), Simulation, OSD
- **Real-time Integration:** WS for telemetry/status
- **Issues Found:** Resizable panels not universal; Config/Tuning split is minimal vs MP tabs.

### Integration Status
- **Partial**

### Required Fixes
- [ ] Backend implementation
- [ ] Frontend integration
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation — layout presets
- [ ] Error handling
- [ ] Performance optimization

---

## 18. SAFETY & FAILSAFE SYSTEMS

### Backend Status
- **Implemented:** No dedicated aggregator
- **APIs:** Fence config; parameters indirectly
- **Services:** Telemetry fields only
- **MAVLink Handling:** STATUSTEXT, SYS_STATUS nibbles partially unused
- **Issues Found:** No pre-arm consolidated API; GPS/battery/EKF failsafe not summarized for UI.

### Frontend Status
- **UI Available:** Partial (telemetry + fence strip in planner)
- **Components:** — 
- **Real-time Integration:** Partial
- **Issues Found:** No pre-arm checklist page.

### Integration Status
- **Partial**

### Required Fixes
- [ ] Backend implementation — pre-arm bitmask helper
- [ ] Frontend integration — checklist UI
- [ ] WebSocket integration
- [ ] MAVLink parser update — SYS_STATUS / EKF flags interpretation
- [ ] State management fix
- [ ] UI implementation
- [ ] Error handling
- [ ] Performance optimization

---

## 19. ADVANCED FEATURES

### Backend Status
- **Implemented:** No / minimal
- **APIs:** None for ADS-B, follow-me, avoidance
- **Services:** None
- **MAVLink Handling:** Not present
- **Issues Found:** —

### Frontend Status
- **UI Available:** No
- **Components:** N/A
- **Real-time Integration:** N/A
- **Issues Found:** —

### Integration Status
- **Broken / Missing**

### Required Fixes
- [ ] Backend implementation
- [ ] Frontend integration
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation
- [ ] Error handling
- [ ] Performance optimization

---

## 20. EXTENSIBILITY

### Backend Status
- **Implemented:** Partial
- **APIs:** Open FastAPI routes can be extended; no plugin loader
- **Services:** Modular managers (`mission_manager`, `parameter_manager`, …)
- **MAVLink Handling:** Centralized in `LinkManager`
- **Issues Found:** No formal plugin ABI.

### Frontend Status
- **UI Available:** N/A
- **Components:** React routes easy to extend
- **Real-time Integration:** — 
- **Issues Found:** No third-party plugin menu.

### Integration Status
- **Partial**

### Required Fixes
- [ ] Backend implementation — plugin hooks (future)
- [ ] Frontend integration
- [ ] WebSocket integration
- [ ] MAVLink parser update
- [ ] State management fix
- [ ] UI implementation
- [ ] Error handling
- [ ] Performance optimization

---

## Summary

| Area                         | Approx. completeness vs Mission Planner |
|-----------------------------|-------------------------------------------|
| Connection + basic telemetry | Low–medium                               |
| Flight Data HUD + map       | Low–medium                               |
| Commands / guided           | Low                                      |
| Mission / fence / rally     | Medium (mission protocol path)           |
| Parameters                  | Medium (no metadata/files)               |
| SITL                        | Medium (host-dependent)                  |
| Calib / logs / tuning / flash | Minimal or none                        |

## Implemented in this audit pass (engineering)

1. **`FEATURE_AUDIT_REPORT.md`** — this document  
2. **Default connection** — `main.py` reads `DRONE_CONNECTION_STRING` / `DRONE_BAUDRATE` / `DRONE_UDP_FORWARD` with safe defaults (`auto`, `115200`, no forward)  
3. **Primary vehicle id** — telemetry keys normalized; `primarySysId` from backend; UI uses primary vehicle instead of hardcoded `1`  
4. **Flight Data** — “Custom…” connection string field; **LAND** command shortcut in Node gateway  

---

*End of report.*
