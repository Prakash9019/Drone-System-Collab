# DATA TAB — CENTRALIZED IMPLEMENTATION REFERENCE

Single source of truth for the Drone GCS **Data Tab** (Flight Data screen). Replaces the fragmented set of partial docs listed in §0.

Scope: the live-flight surface — HUD, telemetry, actions, modes, parameters, connection, map. Mission *planning* is out of scope (lives in `PLAN_TAB_IMP.md`). Setup/calibration is out of scope (`SETUP_TAB_IMP.md`).

Status legend used throughout: **E** = exists / fully wired · **P** = partial · **M** = missing · **D** = duplicated · **F** = fragmented across files.

---

## 0. WHAT THIS DOCUMENT REPLACES

These docs are now superseded for Data-Tab work. They contain valid history but are stale on current code state — several make claims contradicted by the code (see §7). Keep for reference; do not treat as authoritative.

| Doc | Status | Notes |
| --- | --- | --- |
| `DATA_TAB_GAP_ANALYSIS.md` | Stale | Says map waypoints/polyline/home are missing — they exist (`MapView.jsx:410–605`). |
| `DATA_TAB_IMPLEMENTATION_PLAN.md` | Stale | Says click-to-fly-to / DO_REPOSITION missing — exists (`MapView.jsx:769–778` + `/api/flyto`). |
| `DATA_TAB_IMP.md` | Partial | High-level intent doc; superseded by this file. |
| `docs/audit/data_screen_audit.md` | Stale | Home marker / trail / overlays marked missing — all exist. |
| `drone_gcs/imp.md` | Partial | Working notes; not authoritative. |
| `hud-architecture.md` | Reference only | Describes Mission Planner C# HUD, not our React HUD — kept for parity reference. |
| `HUD_MIGRATION_NOTES.md` | Partial-true | Claims HUD uses `telemetrySelectors` — code inlines the math; selectors imported but underused. |
| `COMMAND_ENGINE.md` | Inaccurate | Claims 10 Hz ZMQ broadcast and 15 s staleness; neither is hard-coded — rate is loop-driven. |
| All `*_MIGRATION_NOTES.md`, `*_ENGINE.md`, `*-flow.md` | Reference | Useful background, not current state. |

---

## 1. SYSTEM ARCHITECTURE (DATA TAB ONLY)

```
┌──────────────────────────────────────────────────────────────────┐
│ FRONTEND (React + Zustand)                                       │
│   pages/FlightData.jsx ─────────────────────────── 470 LOC       │
│     ├─ components/AdvancedHUD.jsx ──────────────── 437 LOC       │
│     ├─ components/MapView.jsx ──────────────────── 877 LOC       │
│     ├─ components/MissionExecutionPanel.jsx ─────  187 LOC       │
│     ├─ components/TelemetryGrid.jsx ──────────────  59 LOC       │
│     └─ components/tabs/                                          │
│          {Actions,Quick,Status,Aux,Servo,Messages,               │
│           PreFlight,Gauges}Tab.jsx                               │
│   store/                                                         │
│     ├─ useTelemetryStore.js  ── primary telemetry SoT  321 LOC   │
│     └─ useMissionStore.js    ── mission/fence/rally    217 LOC   │
│   telemetry/                                                     │
│     ├─ telemetryWebSocketBridge.js ── inbound WS frames          │
│     ├─ telemetrySyncReducer.js     ── reducer                    │
│     ├─ {telemetry,parameter,mission,preflight,map,command}       │
│       Selectors.js                ── selectors                   │
│     └─ syncConstants.js                                          │
└───────────────────────▲──────────────────────────────────────────┘
                        │ WebSocket  +  HTTP /api/*  (Express on :3001)
┌───────────────────────┴──────────────────────────────────────────┐
│ NODE API (Express)        drone_gcs/node_api/                    │
│   server.js                                                      │
│     ├─ ZMQ SUB ────────► telemetry/telemetryEngine.js            │
│     │                    telemetry/vehicleStateManager.js        │
│     │                    telemetry/eventBus.js                   │
│     │                    telemetry/staleTelemetry.js             │
│     ├─ /api/state                  ── REST snapshot              │
│     ├─ /api/command/:cmd           ── SHORTCUT MAP (arm, disarm, │
│     │                                  rtl, land, takeoff,       │
│     │                                  mission_start, pause,…)   │
│     │                                  → forwards to Py /command │
│     ├─ /api/mode, /api/flyto, /api/vehicle/{set_home,roi,…}      │
│     ├─ /api/parameters/*  /api/mission /api/fence /api/rally     │
│     ├─ /api/connection/{start,stop,status,ports}                 │
│     └─ /api/vehicles, /api/adsb/traffic, /api/calibration/*, …   │
└───────────────────────▲──────────────────────────────────────────┘
                        │ HTTP  +  ZMQ PUB (vehicle state @ loop rate)
┌───────────────────────┴──────────────────────────────────────────┐
│ PYTHON SERVICE (FastAPI + pymavlink)   drone_gcs/python_service/ │
│   main.py (1295 LOC)             ── all REST endpoints           │
│   mavlink_link.py (652 LOC)      ── transport + heartbeat +      │
│                                     reconnect state machine      │
│   message_handlers.py (188 LOC)  ── per-MAVLink-msg handlers     │
│   vehicle_state.py (242 LOC)     ── VehicleState dataclass       │
│   command_manager.py             ── ACK + timeout + retry        │
│   parameter_manager.py           ── PARAM_REQUEST/SET + cache    │
│   mission_manager.py             ── upload/download/status       │
│   connection_manager.py          ── port enum + auto-detect      │
│   preflight_manager.py · adsb_store.py · replay_manager.py       │
│   sitl_manager.py · sitl_orchestrator.py · telemetry_pub.py      │
└─────────────────────────────────▲────────────────────────────────┘
                                  │ pymavlink (serial / UDP / TCP / BLE)
                              VEHICLE / SITL
```

Key invariants:
- `vehicle_state.VehicleState` is the **only** authoritative model in the Python layer.
- `useTelemetryStore` is the **only** authoritative store in the React layer; selectors derive everything else.
- Commands never reach pymavlink directly from the frontend — always Frontend → Node API → Python `/command` (or `/mode`, `/flyto`).

---

## 2. SECTION 1 — HUD

### 2.1 Component map

| Element | File | Lines | Status |
| --- | --- | --- | --- |
| Compass / heading tape | `AdvancedHUD.jsx` | 5–56 | E |
| Roll arc + pointer | `AdvancedHUD.jsx` | 59–126 | E |
| Pitch ladder + horizon clip | `AdvancedHUD.jsx` | 129–162 | E |
| Speed tape (airspeed + groundspeed) | `AdvancedHUD.jsx` | 165–200 | E |
| Altitude tape + VSI bar | `AdvancedHUD.jsx` | 203–254 | E |
| Status bar (mode, GPS, EKF, sats, HDOP) | `AdvancedHUD.jsx` | 261–336 | E |
| Armed/Disarmed overlay | `AdvancedHUD.jsx` | 363–366 | E |
| Aircraft reference (centre yellow gull-wing) | `AdvancedHUD.jsx` | 369–380 | E |
| Failsafe banner | `AdvancedHUD.jsx` | 382–385 | P (failsafe only — no pre-arm) |
| Vibration warning chip | `AdvancedHUD.jsx` | 304–305, 409 | E |
| Distance to home widget | — | — | **M** |
| Distance to next WP widget | — | — | **M** on HUD (rendered in `StatusTab.jsx:57`) |
| Mission progress widget (current/total) | — | — | **M** on HUD (rendered in `StatusTab.jsx:56`) |
| Pre-arm warnings overlay | — | — | **M** |
| STATUSTEXT overlay on HUD | — | — | **M** (text is captured to `MessagesTab` only) |
| Flight path trail rendered as MP-style overlay | `MapView.jsx` | 201–220 | E (on map, not HUD) |

### 2.2 MAVLink → HUD data path (verified end-to-end)

| MAVLink message | Python handler | VehicleState field | Frontend consumer |
| --- | --- | --- | --- |
| `HEARTBEAT` | `message_handlers.py:37–51` | `status.armed`, `status.mode`, `status.system_type` | HUD armed overlay, mode label |
| `ATTITUDE` | `message_handlers.py:87–90` | `attitude.{roll,pitch,yaw}` (rad) | HUD horizon, roll arc, pitch ladder |
| `GLOBAL_POSITION_INT` | `message_handlers.py:92–105` | `position.{lat,lng,alt_amsl,alt_rel}`, `velocity.heading` | HUD altitude tape, map marker |
| `VFR_HUD` | `message_handlers.py:122–127` | `velocity.{airspeed,groundspeed,climb,heading,throttle}` | HUD speed tape, VSI |
| `GPS_RAW_INT` | `message_handlers.py:81–85` | `status.{gps_fix,satellites,gps_hdop,gps_vdop}` | HUD status bar GPS pill |
| `SYS_STATUS` | `message_handlers.py:53–61` | `status.battery_*`, sensor bitmasks | Battery in StatusTab; sensors not surfaced |
| `EKF_STATUS_REPORT` | `message_handlers.py:129–135` | `status.ekf_*` | HUD EKF pill (variance aggregation in `AdvancedHUD.jsx:288–302`) |
| `VIBRATION` | `message_handlers.py:137–143` | `status.vibration_{x,y,z}` | HUD vibe chip (>30 m/s² threshold) |
| `MISSION_CURRENT` | `message_handlers.py:119–120` | `mission.current_seq` | StatusTab only — **not in HUD** |
| `NAV_CONTROLLER_OUTPUT` | `message_handlers.py:158–161` | `navigation.{wp_dist,nav_bearing,xtrack,…}` | StatusTab only — **not in HUD** |
| `HOME_POSITION` | `message_handlers.py:106–110` | `home.{lat,lng,alt_m,valid}` | Map home marker; **no HUD widget** |
| `STATUSTEXT` | `message_handlers.py:163–168` | `status_messages` (ring of 50) | `MessagesTab` only — **no HUD overlay** |

### 2.3 Known issues

1. HUD imports `telemetrySelectors.js` (per `HUD_MIGRATION_NOTES.md`) but inlines the math — selectors are effectively dead code in the HUD path. **(F)**
2. Mission progress, WP distance, distance-to-home, pre-arm summary all already flow into the store but are not rendered on the HUD. **(M on HUD, E in backend)**
3. STATUSTEXT does not appear over the HUD on incoming messages — only inside the Messages sub-tab.
4. No flight-path trail on the HUD itself (MP overlays the trail under the HUD on its primary view). The trail does exist on the map view.

---

## 3. SECTION 2 — TELEMETRY · ACTIONS · MODES · PARAMETERS

### 3.1 Telemetry subsystem

| Capability | File(s) | Status |
| --- | --- | --- |
| MAVLink ingest (16+ message types) | `python_service/message_handlers.py:34–188` | E |
| Vehicle state SoT | `vehicle_state.py:122–242` | E |
| ZMQ PUB → Node | `python_service/telemetry_pub.py` | E |
| Node telemetry engine | `node_api/telemetry/telemetryEngine.js:84–172` | E |
| Stale-field detection (TTL per field) | `node_api/telemetry/staleTelemetry.js` | E |
| Event bus | `node_api/telemetry/eventBus.js` | E |
| WS bridge → React | `frontend/.../telemetry/telemetryWebSocketBridge.js` | E |
| Frontend reducer + selectors (telemetry / params / mission / preflight / command / map) | `frontend/.../telemetry/*.js` | E (F — split across 6 files) |
| Configurable stream rates (UI) | — | M |
| Replay record/playback (backend) | `replay_manager.py`, `/replay/*` in `main.py:201–257` | P (UI missing) |
| Replay UI | — | M |
| Telemetry registry (Quick tab keys) | `frontend/.../utils/TelemetryRegistry.js` | E |

### 3.2 Actions (commands)

**Critical correction vs prior audit drafts:** ARM, DISARM, TAKEOFF, LAND, RTL et al. **are wired** — the shortcut routing lives in the **Node API**, not in Python `main.py`. Earlier doc drafts that searched only `main.py` falsely concluded they were missing.

Translation layer: `node_api/server.js:210–220` — `COMMAND_SHORTCUTS`:

```js
'arm':       { command: 400, p1: 1 },      // MAV_CMD_COMPONENT_ARM_DISARM
'force_arm': { command: 400, p1: 1, p2: 21196 },
'disarm':    { command: 400, p1: 0 },
'rtl':       { command: 20 },               // MAV_CMD_NAV_RETURN_TO_LAUNCH
'land':      { command: 21 },               // MAV_CMD_NAV_LAND
'takeoff':   { command: 22, p7: 10 },       // MAV_CMD_NAV_TAKEOFF (default 10m)
'mission_start': { command: 300 },
'pause':     { command: 193, p1: 0 },
'continue':  { command: 193, p1: 1 },
```

Verified end-to-end flow (one example — ARM):

```
ActionsTab.jsx:69       axios.post('/api/command/arm', {})
node_api/server.js:236  app.post('/api/command/:cmd')
                        → look up shortcut → { command:400, p1:1 }
                        → POST PYTHON_API_URL + '/command'
python main.py:527      send_command()
                        → link_manager.send_command(sysid, compid, 400, 1, 0,…)
command_manager.py:46-192  COMMAND_LONG send → wait COMMAND_ACK
                        → 10 s timeout (ARM/DISARM), 3 s others, 3 retries
mavlink_link.py:480     command_long_send (pymavlink)
                        → MAVLink to vehicle
```

| Action | Endpoint (frontend) | Shortcut row | MAV cmd | Status |
| --- | --- | --- | --- | --- |
| ARM | `/api/command/arm` | 211 | 400 p1=1 | E |
| FORCE ARM | `/api/command/force_arm` | 212 | 400 p1=1 p2=21196 | E |
| DISARM | `/api/command/disarm` | 213 | 400 p1=0 | E |
| TAKEOFF | `/api/command/takeoff` (needsAlt) | 216 | 22 p7=alt | E |
| LAND | `/api/command/land` | 215 | 21 | E |
| RTL | `/api/command/rtl` | 214 | 20 | E |
| MISSION START | `/api/command/mission_start` | 217 | 300 | E |
| PAUSE / CONTINUE | `/api/command/pause`, `/continue` | 218–219 | 193 p1=0/1 | E |
| GUIDED (set mode) | `/api/mode` { mode:'GUIDED' } | server.js:269 | SET_MODE | E |
| AUTO (set mode) | `/api/mode` { mode:'AUTO' } | server.js:269 | SET_MODE | E |
| Mode switching (any) | `/api/mode` { mode:'<name>' } | server.js:269 | SET_MODE via `link_manager.set_mode()` (`mavlink_link.py:480–497`) | E |
| Fly-To-Here / DO_REPOSITION | `/api/flyto` | server.js:534 → main.py:566 → `mavlink_link.py:499–522` | SET_POSITION_TARGET_GLOBAL_INT after GUIDED | E |
| Set HOME | `/api/vehicle/set_home` | server.js:544 → main.py:583 | MAV_CMD_DO_SET_HOME | E |
| ROI / ROI clear | `/api/vehicle/roi`, `/api/vehicle/roi/clear` | server.js:554–564 → main.py:597–619 | MAV_CMD_DO_SET_ROI_* | E |
| Raw MAVLink passthrough | `/api/mavlink/command` | server.js:574 → main.py:527 (generic `/command`) | any | E |
| Emergency stop / kill switch | — | — | — | **M** |
| COMMAND_ACK + timeout + retries | `command_manager.py:46–192` | — | — | E |

### 3.3 Flight modes

`main.py:547` `/vehicle/flight_modes` returns pymavlink's `mode_mapping()` for the connected autopilot. Frontend renders the list, but `ActionsTab.jsx:16–21` also keeps a static fallback list.

| Mode | Recognised by `set_mode()` | Static list in `ActionsTab.jsx:16–21` | Notes |
| --- | --- | --- | --- |
| STABILIZE, ALT_HOLD, LOITER, AUTO, GUIDED, RTL, LAND, BRAKE, POSHOLD, ACRO, SPORT, DRIFT, THROW, AUTOTUNE, SMART_RTL, FLOWHOLD, FOLLOW, CIRCLE, FLIP, ZIGZAG, SYSTEMID, AUTOROTATE | E (via pymavlink mode_mapping) | Hard-coded | All 22+ modes set successfully if autopilot supports them. |

Issues:
- Static list in `ActionsTab.jsx` duplicates pymavlink's mode map. **(D)**
- No per-mode parameter validation (e.g., AUTO requires mission, GUIDED requires position estimate). **(M)**
- No mode-specific UX (sub-options, defaults).

### 3.4 Parameters

| Capability | File(s) | Status |
| --- | --- | --- |
| Quick params widget | `frontend/.../components/tabs/QuickTab.jsx` (1–150) + `utils/TelemetryRegistry.js` | E |
| Full param browse / search / sort | `frontend/.../pages/Params.jsx` | E |
| `PARAM_REQUEST_LIST` + `PARAM_VALUE` ingest | `parameter_manager.py:188–232`, `message_handlers.py:180–187` | E |
| `PARAM_SET` + ACK tolerance verify + 3× retry | `parameter_manager.py:139–186` | E |
| Per-vehicle JSON cache (1 h TTL) | `param_cache/` + `parameter_manager.py:25–30` | E |
| Mission Planner `.param` import | `main.py:711–730`, `param_format.py:parse_param_text()` | E |
| Mission Planner `.param` export | `main.py:653–658, 698–710`, `param_format.py:format_param_text()` | E |
| Param diff (two files / vehicle vs file) | `main.py:681–767`, `param_format.py:diff_param_dicts()` | E |
| Param metadata (units, range, description) | `parameter_metadata.py`, `/parameters/metadata` | E (loaded, **not rendered in `Params.jsx`** — UI gap) |
| Sync progress + last error | `parameter_manager.py:to_status()` | E |
| Unsaved-changes / dirty indicator in UI | — | M |
| Reset to default | `/parameters/reset` (`main.py:767`) | E |

---

## 4. SECTION 3 — CONNECTION SYSTEM

### 4.1 Transports — verified end-to-end

| Transport | Frontend selector | Backend open | MAVLink flow | Status |
| --- | --- | --- | --- | --- |
| Serial (USB / FTDI) | Live `/api/connection/ports` poll (every 5 s when disconnected) | `mavlink_link.py:104–128` (DTR/RTS stabilize) | E | E |
| UDP client (e.g. SITL `udp:127.0.0.1:14550`) | Preset | `mavlink_link.py:78` | E | E |
| TCP client (e.g. `tcp:127.0.0.1:5760`) | Preset | `mavlink_link.py:78` | E | E |
| Bluetooth serial (`/dev/tty.SIYI-…` etc.) | Preset | DTR/RTS toggles in `mavlink_link.py:104–128` | E | E |
| UDP server / forwarding | — | `DRONE_UDP_FORWARD` env var only | E | **P** (no UI) |
| Saved profiles | — | — | — | **M** |

### 4.2 Connection state machine — `vehicle_state.py:6–13`

```
DISCONNECTED
   │ connect()
   ▼
CONNECTING
   │ transport opened
   ▼
WAITING_FOR_HEARTBEAT
   │ heartbeat received + ≥2 telemetry streams
   ▼
CONNECTED  ◄────────────────┐
   │ HB age > 3.0 s         │ heartbeat resumes
   ▼                        │
HEARTBEAT_LOST              │
   │ _attempt_reconnect()   │
   ▼                        │
RECONNECTING ───────────────┘
   │ retry fails
   ▼
HEARTBEAT_LOST (loop)

ACTIVE state declared but never set — vestigial (see §7).
```

### 4.3 Connection capabilities

| Capability | File · Lines | Status |
| --- | --- | --- |
| Port enumeration (`pyserial`) | `connection_manager.py:11–29`, `main.py:444–450` | E |
| Auto-detect (baud sweep 115200/57600/38400/9600) | `connection_manager.py:31–61` | E |
| MAVLink handshake (sysid election, ≥2 streams) | `mavlink_link.py:157–213` | E |
| Heartbeat send 1 Hz (GCS → vehicle) | `mavlink_link.py:167–173, 406–410` | E (D — sent in both bootstrap and keep-alive) |
| Heartbeat receive | `mavlink_link.py:331–336` | E |
| Heartbeat timeout 3 s | `mavlink_link.py:413–417` | E |
| Auto-reconnect | `mavlink_link.py:425–462` | E |
| Disconnect (clean teardown) | `mavlink_link.py:620–651`, `main.py:423–429` | E |
| Connection state UI ribbon (color pill + HB age + packet loss + GPS + mode + ADSB) | `FlightData.jsx:15–23, 229–252` | E |
| Multi-vehicle (backend roster) | `mavlink_link.py:23, 140–148, 257–267`, `main.py:453–473`; `useTelemetryStore.vehiclesRoster` | E (UI minimal) |
| SITL auto-connect on simulator start | `sitl_orchestrator.py:30` (`udp:127.0.0.1:14550`, 3.5 s delay) | E |
| Link quality (packet loss %, pps) | `mavlink_link.py:347–366` | P (no RSSI/SNR) |
| Exponential backoff on reconnect | — | M (fixed 1.0 s) |
| Max-reconnect-attempt cap | — | M (retries forever) |
| Detailed connect-failure reason codes | — | M |
| Param re-sync on reconnect | — | M (assumed unchanged) |

### 4.4 Known issues
- Stream-request logic split across three call sites — `_bootstrap_session`, `read_loop` on new vehicle, `_attempt_reconnect`. **(F)**
- `ACTIVE` enum value defined but never assigned. **(dead code)**
- No reason-coded errors on connect failure (timeout vs port-not-found vs handshake-fail).

---

## 5. SECTION 4 — MAP · FLIGHT DATA SCREEN

### 5.1 Feature inventory — `MapView.jsx`

| Feature | File · Lines | Status |
| --- | --- | --- |
| Vehicle marker (custom quadcopter SVG) | `MapView.jsx:23–39, 179–192, 293–376` | E |
| Real GPS rendering (validates `gps_fix ≥ 2`, excludes `(0,0)`) | `MapView.jsx:293–376` + `message_handlers.py:81–105` | E |
| Heading rotation (yaw → heading fallback) | `MapView.jsx:14–21, 368–370` | E |
| Path trail (rolling, 1500 pts max, 1 e-6 decimation, reset on disconnect) | `MapView.jsx:201–220, 336–347, 386–395` | E |
| Home marker | `MapView.jsx:398–424` + `message_handlers.py:106–110` | E |
| "Go to vehicle" button (easeTo) | `MapView.jsx:661–677` | E |
| Auto-follow with localStorage persist + cancel-on-user-interact | `MapView.jsx:105–108, 349–354, 693–700` | E |
| Mission overlay (route line + seq-numbered waypoints, active-WP highlight) | `MapView.jsx:536–605` | E |
| Geofence overlay (inclusion green / exclusion red, dashed outline) | `MapView.jsx:505–534` | E |
| Rally points | `MapView.jsx:551–566` | E |
| First-fix auto-centre (one-shot) | `MapView.jsx:94–96, 312–323` | E |
| ADS-B traffic overlay | `MapView.jsx:462–503` + `python_service/adsb_store.py` | E |
| Click-to-fly-to (context menu → `/api/flyto`) | `MapView.jsx:769–778` | E |
| Set HOME from map | `MapView.jsx` context menu → `/api/vehicle/set_home` | E |
| Set ROI from map | `MapView.jsx` context menu → `/api/vehicle/roi` | E |
| Tile-provider switcher | hard-coded CartoDB dark-matter at `MapView.jsx:160`, `MapEditor.jsx:130` | **M** |
| Distance / bearing measurement tool | — | M |
| Altitude profile along path | — | M |
| Weather overlay | — | M |

### 5.2 Map ↔ Mission tab overlap

| Concern | `MapView.jsx` (Data tab) | `MapEditor.jsx` (Plan tab) | Severity |
| --- | --- | --- | --- |
| Fence polygon grouping (`buildFenceGroups`) | 516–526 | 42–54; also `FlightPlanner.jsx:73–90` | **D × 3** |
| Waypoint sequence labelling | 597 | 279 | D × 2 |
| Mission route line source | source `mv-mission-route` | source `route` | D × 2 (different names, identical logic) |
| Home marker SVG / logic | 410–423 | 241–256 | D × 2 |
| Drone heading fallback (yaw→heading) | 14–21 | 97–104; also `mapSelectors.js:27–36` | **D × 3** |
| Tile style | hard-coded | hard-coded | D × 2 |
| Fence-type command constants (5001/5002) | inline | `useMissionStore` + inline | D |

These can be extracted into a shared `map/` module (constants + render helpers) without changing behaviour.

### 5.3 Telemetry → map data path

```
GLOBAL_POSITION_INT          → state.position.{lat,lng,alt_rel,alt_amsl}
GPS_RAW_INT                  → state.status.{gps_fix,satellites,gps_hdop,gps_vdop}
ATTITUDE / VFR_HUD           → state.attitude.yaw / state.velocity.heading
HOME_POSITION                → state.home.{lat,lng,alt_m,valid}
       │
       ▼
telemetry_pub.py (ZMQ)
       │
       ▼
node_api/telemetry/telemetryEngine.js
       │
       ▼
useTelemetryStore (Zustand)
       │
       ▼
selectPrimaryVehicle / mapSelectors
       │
       ▼
MapView effect (deps: lat, lng, heading) — line 293
       ├─ validate positionValid
       ├─ setLngLat + setRotation
       ├─ append trail (>1e-6 move)
       ├─ auto-follow easeTo
       └─ rAF 60-fps interpolation
```

---

## 6. CROSS-CUTTING ISSUES

### 6.1 Duplications

| # | What | Where | Fix |
| --- | --- | --- | --- |
| D1 | Fence polygon grouping logic | `MapView.jsx:516–526`, `MapEditor.jsx:42–54`, `FlightPlanner.jsx:73–90` | Extract to `utils/fenceGeometry.js` |
| D2 | Drone heading fallback | `MapView.jsx:14–21`, `MapEditor.jsx:97–104`, `mapSelectors.js:27–36` | Single helper |
| D3 | Home marker render | `MapView.jsx:410–423`, `MapEditor.jsx:241–256` | Shared component |
| D4 | Heartbeat send loop | `mavlink_link.py:167–173` (bootstrap) and `406–410` (keep-alive) | Keep only keep-alive once CONNECTED |
| D5 | Mode list (static fallback) | `ActionsTab.jsx:16–21` vs runtime `/vehicle/flight_modes` | Use runtime only |
| D6 | Battery priority (SYS_STATUS vs BATTERY_STATUS) | logic in `message_handlers.py:54–79`, no mirror in frontend selectors | Single backend authority is fine — drop attempts in frontend if any |
| D7 | Param ID null-byte cleanup | `parameter_manager.py:102–105` + `message_handlers.py:181–185` | One helper |
| D8 | Mode decode | `message_handlers.py:14–32` vs `mavlink_link.py:474–478` | Consolidate |

### 6.2 Fragmentations

| # | What | Where | Fix |
| --- | --- | --- | --- |
| F1 | HUD-bound telemetry split across HUD + StatusTab + nothing-on-HUD (mission progress, WP dist) | `AdvancedHUD.jsx` vs `StatusTab.jsx` | Surface in HUD via dedicated mini-widgets |
| F2 | Stream-request logic | `mavlink_link.py` bootstrap + read_loop + reconnect | Single helper `_request_all_streams(target)` |
| F3 | Telemetry selectors split into 6 files (telemetry, parameter, mission, preflight, command, map) | `frontend/.../telemetry/*.js` | Acceptable split; just keep index re-exports |
| F4 | Command lifecycle state | `command_manager.py` + `commandSelectors.js` + `useTelemetryStore.js` | Status struct is one shape — keep but document mapping |
| F5 | Connection state mirrored in `LinkManager.connection_state` and per-`VehicleState.connection_state` | `mavlink_link.py` + `vehicle_state.py` | Single writer (`_set_connection_state`) — keep, but ensure the per-vehicle copy is read-only outside that writer |

### 6.3 Missing / not yet implemented

| # | What | Section | Notes |
| --- | --- | --- | --- |
| M1 | Distance-to-home HUD widget | HUD | Compute from `position` and `home` |
| M2 | Distance-to-next-WP HUD widget | HUD | `navigation.wp_dist` already in store |
| M3 | Mission progress HUD widget (current/total) | HUD | `mission.current_seq` in store |
| M4 | Pre-arm warnings overlay (sensor health bitmask + arm-checks) | HUD | Backend has SYS_STATUS sensor bits |
| M5 | STATUSTEXT toast/overlay on HUD | HUD | Backend buffers; only MessagesTab consumes |
| M6 | Configurable telemetry stream rates from UI | Telemetry | Backend supports; UI missing |
| M7 | Replay UI (record/play/seek controls bound to `/replay/*`) | Telemetry | Endpoints exist (`main.py:201–257`) |
| M8 | Emergency stop / kill-switch action | Actions | No dedicated path |
| M9 | Per-mode validation + parameter prompts (e.g. AUTO needs mission, GUIDED needs position) | Modes | — |
| M10 | Param-page dirty/unsaved indicator + metadata display (units/range/desc) | Parameters | Metadata fetched but not rendered |
| M11 | Connection profiles (saved string + transport + baud) | Connection | Frontend uses hardcoded presets |
| M12 | Exponential backoff + retry cap + reason-coded errors on reconnect | Connection | Currently fixed 1 s, infinite |
| M13 | Param re-sync on reconnect | Connection | Assumes parameters unchanged |
| M14 | Tile-provider switcher | Map | Hard-coded CartoDB |
| M15 | Distance / bearing measurement tool | Map | — |
| M16 | Altitude profile along path | Map | — |
| M17 | UDP-server / forwarding UI | Connection | Env-var only today |

---

## 7. DOC ↔ CODE CONTRADICTIONS (to drive cleanup of stale docs)

| Doc | Claim | Reality | Action |
| --- | --- | --- | --- |
| `DATA_TAB_GAP_ANALYSIS.md:23` | Map waypoints/polyline missing | Implemented `MapView.jsx:536–605` | Mark stale |
| `DATA_TAB_IMPLEMENTATION_PLAN.md` | click-to-fly-to / DO_REPOSITION missing | Implemented `MapView.jsx:769–778` + `/api/flyto` | Mark stale |
| `docs/audit/data_screen_audit.md:11` | Home marker / trail / overlays missing | All implemented (`MapView.jsx:410–423`, `:201–220`, `:505–605`) | Mark stale |
| Earlier audit drafts | ARM/DISARM/TAKEOFF/LAND/RTL endpoints missing from backend | Wired via Node API shortcut layer (`node_api/server.js:210–270`) → Python `/command` | Correct in any consumer of the older audit |
| `HUD_MIGRATION_NOTES.md` | HUD uses `telemetrySelectors.js` for normalised attitude / stale detection | HUD imports selectors but inlines the math; selectors effectively unused on this path | Either migrate HUD onto selectors, or update note |
| `COMMAND_ENGINE.md:18` | "engine state… broadcast at 10 Hz via ZMQ" | Rate driven by Python main loop cadence, not 10 Hz | Update or codify the 10 Hz |
| `COMMAND_ENGINE.md:26` | "stale detection 15 s" | `commandSelectors.js` checks `last_update`; no 15 s constant | Update doc or constant |
| `hud-architecture.md` | Describes Mission Planner C# WinForms HUD | Our HUD is React + SVG | Keep as parity reference; do not treat as spec |
| `vehicle_state.py:11` ACTIVE state | Documented as valid state | Never set anywhere | Remove or implement |

---

## 8. PARITY SCORECARD vs MISSION PLANNER

| Area | Score | Headline |
| --- | --- | --- |
| HUD | 75 % | Core attitude + speed + alt + GPS + EKF + arm OK; missing mission/WP/home widgets + pre-arm overlay |
| Telemetry | 90 % | End-to-end MAVLink → store; replay backend exists, UI does not |
| Actions | 85 % | All MP shortcuts wired (incl. ARM/RTL/TAKEOFF/LAND/MISSION_START/PAUSE); no kill switch, no per-mode UX |
| Modes | 70 % | All ArduPilot modes settable through pymavlink map; no validation, no per-mode UX |
| Parameters | 90 % | Read/write/cache/.param import-export/diff/reset all wired; UI lacks metadata + dirty state |
| Connection | 80 % | Serial/UDP/TCP/BLE work; reconnect works; no profiles, no exponential backoff, no reason-codes |
| Map | 85 % | Vehicle/home/trail/mission/fence/rally/ADS-B/Go-to/Click-to-fly all working; no provider switch, no measure tool, no alt profile |

**Overall Data Tab: ~83 % Mission-Planner parity.** Solid foundation; the remaining gaps are listed in §6.3 and tracked individually in the audit table (`DATA_TAB_AUDIT_TABLE.md`).

---

## 9. FILE INDEX (authoritative paths)

**Frontend**
- `drone_gcs/frontend/src/pages/FlightData.jsx`
- `drone_gcs/frontend/src/components/AdvancedHUD.jsx`
- `drone_gcs/frontend/src/components/MapView.jsx`
- `drone_gcs/frontend/src/components/MapEditor.jsx`
- `drone_gcs/frontend/src/components/MissionExecutionPanel.jsx`
- `drone_gcs/frontend/src/components/TelemetryGrid.jsx`
- `drone_gcs/frontend/src/components/tabs/{Actions,Quick,Status,Aux,Servo,Messages,PreFlight,Gauges}Tab.jsx`
- `drone_gcs/frontend/src/pages/Params.jsx`
- `drone_gcs/frontend/src/store/useTelemetryStore.js`
- `drone_gcs/frontend/src/store/useMissionStore.js`
- `drone_gcs/frontend/src/telemetry/{telemetryWebSocketBridge,telemetrySyncReducer,telemetrySyncTypes,telemetrySelectors,parameterSelectors,missionSelectors,preflightSelectors,commandSelectors,mapSelectors,syncConstants,index}.js`
- `drone_gcs/frontend/src/utils/{TelemetryRegistry,mapPreferences,operationalState,surveyGrid}.js`

**Node API**
- `drone_gcs/node_api/server.js`
- `drone_gcs/node_api/telemetry/{telemetryEngine,vehicleStateManager,eventBus,staleTelemetry,schemas,index}.js`

**Python service**
- `drone_gcs/python_service/main.py`
- `drone_gcs/python_service/mavlink_link.py`
- `drone_gcs/python_service/message_handlers.py`
- `drone_gcs/python_service/vehicle_state.py`
- `drone_gcs/python_service/command_manager.py`
- `drone_gcs/python_service/parameter_manager.py`
- `drone_gcs/python_service/parameter_metadata.py`
- `drone_gcs/python_service/param_format.py`
- `drone_gcs/python_service/mission_manager.py`
- `drone_gcs/python_service/mission_file_io.py`
- `drone_gcs/python_service/mission_models.py`
- `drone_gcs/python_service/connection_manager.py`
- `drone_gcs/python_service/preflight_manager.py`
- `drone_gcs/python_service/replay_manager.py`
- `drone_gcs/python_service/sitl_manager.py`
- `drone_gcs/python_service/sitl_orchestrator.py`
- `drone_gcs/python_service/adsb_store.py`
- `drone_gcs/python_service/telemetry_pub.py`

**Paired audit table:** `DATA_TAB_AUDIT_TABLE.md` (deliverable 2).
