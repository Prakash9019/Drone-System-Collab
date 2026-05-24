# DATA TAB — IMPLEMENTATION AUDIT TABLE

Paired with [`DATA_TAB_CENTRALIZED.md`](./DATA_TAB_CENTRALIZED.md). Single, sortable matrix of every Data-Tab feature.

Column meanings:
- **E**xists — fully wired end-to-end (frontend → backend → MAVLink → UI)
- **P**artial — wired but incomplete (missing UI, missing edge case, etc.)
- **M**issing — not implemented
- **D**uplicate — same logic appears in ≥ 2 places (file refs in *Files*)
- **F**ragmented — one feature spread across more files than necessary (refs in *Files*)
- A feature may carry multiple marks (e.g. `E + D` if it works but is duplicated)
- **Files** — primary paths and line ranges; backend rows include the MAVLink message / command

---

## SECTION 1 — HUD

| # | Feature | E | P | M | D | F | Files |
| --- | --- | :-: | :-: | :-: | :-: | :-: | --- |
| H1 | Artificial horizon (roll/pitch graphics) | ✔ |   |   |   |   | `AdvancedHUD.jsx:129–162` |
| H2 | Compass / heading tape | ✔ |   |   |   |   | `AdvancedHUD.jsx:5–56` |
| H3 | Roll indicator (arc + pointer) | ✔ |   |   |   |   | `AdvancedHUD.jsx:59–126` |
| H4 | Pitch ladder | ✔ |   |   |   |   | `AdvancedHUD.jsx:129–162` |
| H5 | Yaw display | ✔ |   |   |   |   | `AdvancedHUD.jsx:263, 266` |
| H6 | Altitude tape (relative) | ✔ |   |   |   |   | `AdvancedHUD.jsx:203–254` |
| H7 | Altitude separate AMSL widget |   |   | ✔ |   |   | data in `position.alt_amsl`, no widget |
| H8 | Ground speed | ✔ |   |   |   |   | `AdvancedHUD.jsx:165–200` |
| H9 | Airspeed | ✔ |   |   |   |   | `AdvancedHUD.jsx:165–200` |
| H10 | Climb rate / VSI bar | ✔ |   |   |   |   | `AdvancedHUD.jsx:203–254` |
| H11 | EKF status indicator | ✔ |   |   |   |   | `AdvancedHUD.jsx:287–302`, `message_handlers.py:129–135` (EKF_STATUS_REPORT) |
| H12 | GPS fix status (No/2D/3D/RTK) | ✔ |   |   |   |   | `AdvancedHUD.jsx:325–336`, `message_handlers.py:81–85` (GPS_RAW_INT) |
| H13 | Vibration indicator | ✔ |   |   |   |   | `AdvancedHUD.jsx:304–305, 409`, `message_handlers.py:137–143` (VIBRATION) |
| H14 | Distance to home (HUD widget) |   |   | ✔ |   |   | data: `home.*` exists; no HUD render |
| H15 | Distance to next waypoint (HUD widget) |   | ✔ |   |   | ✔ | `StatusTab.jsx:57` only; data flows via `navigation.wp_dist` (`message_handlers.py:158–161` NAV_CONTROLLER_OUTPUT) |
| H16 | Mission progress / current WP (HUD widget) |   | ✔ |   |   | ✔ | `StatusTab.jsx:56` only; `mission.current_seq` (`message_handlers.py:119–120` MISSION_CURRENT) |
| H17 | Arm / disarm overlay | ✔ |   |   |   |   | `AdvancedHUD.jsx:363–366`, `message_handlers.py:37–51` (HEARTBEAT) |
| H18 | Flight warnings / pre-arm overlay |   | ✔ |   |   |   | failsafe banner only at `AdvancedHUD.jsx:382–385`; no sensor-health summary |
| H19 | Status text overlays on HUD |   |   | ✔ |   |   | STATUSTEXT in `MessagesTab` only (`message_handlers.py:163–168`) |
| H20 | Drone icon (centre aircraft reference) | ✔ |   |   |   |   | `AdvancedHUD.jsx:369–380` |
| H21 | HUD path-trail overlay |   |   | ✔ |   |   | trail exists on map (`MapView.jsx:201–220`), not on HUD |
| H22 | MAVLink ingest — HEARTBEAT | ✔ |   |   |   |   | `message_handlers.py:37–51` |
| H23 | MAVLink ingest — ATTITUDE | ✔ |   |   |   |   | `message_handlers.py:87–90` |
| H24 | MAVLink ingest — GLOBAL_POSITION_INT | ✔ |   |   |   |   | `message_handlers.py:92–105` |
| H25 | MAVLink ingest — VFR_HUD | ✔ |   |   |   |   | `message_handlers.py:122–127` |
| H26 | MAVLink ingest — SYS_STATUS | ✔ |   |   |   |   | `message_handlers.py:53–61` |
| H27 | MAVLink ingest — GPS_RAW_INT | ✔ |   |   |   |   | `message_handlers.py:81–85` |
| H28 | MAVLink ingest — EKF_STATUS_REPORT | ✔ |   |   |   |   | `message_handlers.py:129–135` |
| H29 | MAVLink ingest — VIBRATION | ✔ |   |   |   |   | `message_handlers.py:137–143` |
| H30 | MAVLink ingest — MISSION_CURRENT | ✔ |   |   |   |   | `message_handlers.py:119–120` |
| H31 | HUD uses centralised telemetry selectors |   | ✔ |   |   | ✔ | `HUD_MIGRATION_NOTES.md` claims yes; HUD inlines math — selectors effectively unused |

---

## SECTION 2 — TELEMETRY

| # | Feature | E | P | M | D | F | Files |
| --- | --- | :-: | :-: | :-: | :-: | :-: | --- |
| T1 | Live telemetry packet ingest (16+ msg types) | ✔ |   |   |   |   | `message_handlers.py:34–188` |
| T2 | Per-message handler dispatch | ✔ |   |   |   |   | `message_handlers.py:14–32` (decode_mode), `34–188` (handle_message) |
| T3 | Mode decode (two implementations) | ✔ |   |   | ✔ |   | `message_handlers.py:14–32` + `mavlink_link.py:474–478` |
| T4 | Configurable telemetry stream rates from UI |   |   | ✔ |   |   | backend supports `request_data_stream`; no UI |
| T5 | Status-text routing | ✔ |   |   |   |   | `message_handlers.py:163–168` → `vehicle_state.py:76–79` → `/state` / WS |
| T6 | Stale telemetry detection (per-field TTL) | ✔ |   |   |   |   | `node_api/telemetry/staleTelemetry.js` |
| T7 | Vehicle state SoT (single dataclass) | ✔ |   |   |   |   | `vehicle_state.py:122–242` |
| T8 | ZMQ PUB (Python → Node) | ✔ |   |   |   |   | `telemetry_pub.py` |
| T9 | Node telemetry engine (parse + envelope + sequence) | ✔ |   |   |   |   | `node_api/telemetry/telemetryEngine.js:84–172` |
| T10 | Event bus | ✔ |   |   |   |   | `node_api/telemetry/eventBus.js` |
| T11 | WebSocket bridge → React | ✔ |   |   |   |   | `frontend/.../telemetry/telemetryWebSocketBridge.js`, `useTelemetryStore.js:30–200` |
| T12 | Frontend selectors (telemetry / param / mission / preflight / command / map) | ✔ |   |   |   | ✔ | `telemetry/{telemetry,parameter,mission,preflight,command,map}Selectors.js` — six files (acceptable but spread) |
| T13 | Telemetry recording (backend) | ✔ |   |   |   |   | `replay_manager.py`, `/replay/record/*` in `main.py:201–215` |
| T14 | Telemetry playback (backend) | ✔ |   |   |   |   | `/replay/playback/*` in `main.py:222–257` |
| T15 | Replay UI (record / play / pause / seek) |   |   | ✔ |   |   | endpoints exist; no frontend page |
| T16 | Telemetry registry (Quick-tab key catalogue) | ✔ |   |   |   |   | `frontend/.../utils/TelemetryRegistry.js` |

---

## SECTION 2 — ACTIONS (commands)

End-to-end command translation happens in **`node_api/server.js:210–270`** (`COMMAND_SHORTCUTS` map + `/api/command/:cmd`). All shortcut actions are wired end-to-end despite being absent as named endpoints in `main.py`.

| # | Feature | E | P | M | D | F | Files |
| --- | --- | :-: | :-: | :-: | :-: | :-: | --- |
| A1 | ARM (MAV_CMD_COMPONENT_ARM_DISARM 400 p1=1) | ✔ |   |   |   |   | `ActionsTab.jsx:69` → `node_api/server.js:211, 236` → `main.py:527` |
| A2 | FORCE ARM (p1=1, p2=21196) | ✔ |   |   |   |   | `server.js:212` |
| A3 | DISARM (400 p1=0) | ✔ |   |   |   |   | `server.js:213` |
| A4 | TAKEOFF (22 p7=alt; UI altitude input) | ✔ |   |   |   |   | `ActionsTab.jsx:66` (`needsAlt`) → `server.js:216` |
| A5 | LAND (21) | ✔ |   |   |   |   | `server.js:215` |
| A6 | RTL (20) | ✔ |   |   |   |   | `server.js:214` |
| A7 | MISSION START (300) | ✔ |   |   |   |   | `server.js:217` |
| A8 | PAUSE (193 p1=0) | ✔ |   |   |   |   | `server.js:218` |
| A9 | CONTINUE / RESUME (193 p1=1) | ✔ |   |   |   |   | `server.js:219` |
| A10 | GUIDED — entered via set_mode | ✔ |   |   |   |   | `/api/mode` → `mavlink_link.py:480–497` |
| A11 | AUTO — entered via set_mode | ✔ |   |   |   |   | `/api/mode` |
| A12 | Generic mode switching (SET_MODE) | ✔ |   |   |   |   | `main.py:556–564`, `mavlink_link.py:480–497` |
| A13 | COMMAND_ACK handling + timeouts + retries | ✔ |   |   |   |   | `command_manager.py:46–192` (10 s ARM/DISARM, 3 s default, 3 retries) |
| A14 | Emergency stop / kill switch |   |   | ✔ |   |   | not implemented |
| A15 | Fly-to-here / DO_REPOSITION | ✔ |   |   |   |   | `MapView.jsx:769–778` → `/api/flyto` → `main.py:566` → `mavlink_link.py:499–522` (SET_POSITION_TARGET_GLOBAL_INT after GUIDED) |
| A16 | Set HOME (DO_SET_HOME) | ✔ |   |   |   |   | `/api/vehicle/set_home` → `main.py:583` |
| A17 | Set ROI / clear ROI | ✔ |   |   |   |   | `/api/vehicle/roi`, `/api/vehicle/roi/clear` → `main.py:597–619` |
| A18 | Raw MAVLink passthrough | ✔ |   |   |   |   | `ActionsTab.jsx:88` → `/api/mavlink/command` → `main.py:527` |
| A19 | Mission pause/resume from UI | ✔ |   |   |   |   | `server.js:218–219` |
| A20 | Command lifecycle visible across multiple stores |   |   |   |   | ✔ | `command_manager.py` + `commandSelectors.js` + `useTelemetryStore.js` |

---

## SECTION 2 — MODES

Mode list comes from `mavlink_link.list_flight_modes()` → pymavlink `mode_mapping()`. UI fallback list in `ActionsTab.jsx:16–21` duplicates the data.

| # | Mode | E | P | M | D | F | Files |
| --- | --- | :-: | :-: | :-: | :-: | :-: | --- |
| MD1 | STABILIZE | ✔ |   |   | ✔ |   | `ActionsTab.jsx:16–21` + pymavlink map |
| MD2 | ALT_HOLD | ✔ |   |   | ✔ |   | as above |
| MD3 | LOITER | ✔ |   |   | ✔ |   | as above |
| MD4 | AUTO | ✔ |   |   | ✔ |   | as above |
| MD5 | GUIDED | ✔ |   |   | ✔ |   | actively used by `/flyto` |
| MD6 | RTL | ✔ |   |   | ✔ |   | as above |
| MD7 | LAND | ✔ |   |   | ✔ |   | as above |
| MD8 | BRAKE | ✔ |   |   | ✔ |   | as above |
| MD9 | POSHOLD | ✔ |   |   | ✔ |   | as above |
| MD10 | ACRO | ✔ |   |   | ✔ |   | as above |
| MD11 | SPORT | ✔ |   |   | ✔ |   | as above |
| MD12 | DRIFT | ✔ |   |   | ✔ |   | as above |
| MD13 | THROW | ✔ |   |   | ✔ |   | as above |
| MD14 | AUTOTUNE | ✔ |   |   | ✔ |   | as above |
| MD15 | SMART_RTL | ✔ |   |   | ✔ |   | also referenced in `utils/operationalState.js:3` |
| MD16 | FLOWHOLD | ✔ |   |   | ✔ |   | as above |
| MD17 | FOLLOW | ✔ |   |   | ✔ |   | as above |
| MD18 | CIRCLE / FLIP / ZIGZAG / SYSTEMID / AUTOROTATE | ✔ |   |   | ✔ |   | as above |
| MD19 | Per-mode parameter validation (AUTO requires mission, GUIDED requires position, …) |   |   | ✔ |   |   | none |
| MD20 | Mode-specific UI (sub-options, defaults) |   |   | ✔ |   |   | none |

---

## SECTION 2 — PARAMETERS

| # | Feature | E | P | M | D | F | Files |
| --- | --- | :-: | :-: | :-: | :-: | :-: | --- |
| P1 | Quick parameters tab | ✔ |   |   |   |   | `components/tabs/QuickTab.jsx:1–150`, `utils/TelemetryRegistry.js` |
| P2 | Full parameter list browse / search / sort / paginate | ✔ |   |   |   |   | `pages/Params.jsx:20–200+` |
| P3 | Parameter read (PARAM_REQUEST_LIST + PARAM_VALUE) | ✔ |   |   |   |   | `parameter_manager.py:188–232`, `message_handlers.py:180–187` |
| P4 | Parameter write (PARAM_SET) with ACK + tolerance verify | ✔ |   |   |   |   | `parameter_manager.py:139–186` (3× retry, rollback on failure) |
| P5 | Parameter cache (per sysid/compid JSON, 1 h TTL) | ✔ |   |   |   |   | `param_cache/`, `parameter_manager.py:25–30` |
| P6 | Param ID null-byte cleanup |   |   |   | ✔ |   | `parameter_manager.py:102–105` + `message_handlers.py:181–185` |
| P7 | Import `.param` (Mission Planner format) | ✔ |   |   |   |   | `main.py:711–730`, `param_format.py:parse_param_text()` |
| P8 | Export `.param` | ✔ |   |   |   |   | `main.py:653–658, 698–710`, `param_format.py:format_param_text()` |
| P9 | Parameter diff (two files / vehicle vs file) | ✔ |   |   |   |   | `main.py:681–767`, `param_format.py:diff_param_dicts()` |
| P10 | Parameter metadata (units / range / description) loaded | ✔ |   |   |   |   | `parameter_metadata.py`, `/parameters/metadata` |
| P11 | Parameter metadata displayed in UI |   |   | ✔ |   |   | not rendered in `Params.jsx` |
| P12 | Sync progress + last error | ✔ |   |   |   |   | `parameter_manager.py:to_status()` |
| P13 | Dirty / unsaved-changes UI indicator |   |   | ✔ |   |   | none |
| P14 | Reset to default | ✔ |   |   |   |   | `/parameters/reset` (`main.py:767`) |
| P15 | Param re-sync on reconnect |   |   | ✔ |   |   | assumes unchanged |

---

## SECTION 3 — CONNECTION SYSTEM

| # | Feature | E | P | M | D | F | Files |
| --- | --- | :-: | :-: | :-: | :-: | :-: | --- |
| C1 | Bluetooth Serial | ✔ |   |   |   |   | `mavlink_link.py:104–128` (DTR/RTS stabilize), `connection_manager.py:31–61` |
| C2 | TCP client | ✔ |   |   |   |   | `mavlink_link.py:78, 112`, `main.py:104–115` |
| C3 | UDP client | ✔ |   |   |   |   | `mavlink_link.py:78` |
| C4 | UDP server / forwarding |   | ✔ |   |   |   | `DRONE_UDP_FORWARD` env var only — no UI |
| C5 | UART / direct serial | ✔ |   |   |   |   | `mavlink_link.py:78, 104–128`, `connection_manager.py:12–29` |
| C6 | Serial port enumeration | ✔ |   |   |   |   | `connection_manager.py:11–29`, `main.py:444–450` (`/connection/ports`) |
| C7 | Baud rate configuration / auto-detect (115200/57600/38400/9600) | ✔ |   |   |   |   | `connection_manager.py:9, 31–61`, `mavlink_link.py:15–18, 112`, `main.py:401–421` |
| C8 | MAVLink handshake (sysid election, ≥2 streams) | ✔ |   |   |   |   | `mavlink_link.py:157–213` |
| C9 | Heartbeat send 1 Hz (GCS → vehicle) | ✔ |   |   | ✔ |   | `mavlink_link.py:167–173` (bootstrap) + `406–410` (keep-alive) |
| C10 | Heartbeat receive | ✔ |   |   |   |   | `mavlink_link.py:331–336`, `vehicle_state.py:82–88` |
| C11 | Heartbeat timeout (3 s default) | ✔ |   |   |   |   | `mavlink_link.py:413–417` |
| C12 | Auto-reconnect | ✔ |   |   |   |   | `mavlink_link.py:425–462`, fixed 1.0 s delay |
| C13 | Exponential backoff |   |   | ✔ |   |   | fixed delay only |
| C14 | Max-reconnect-attempt cap |   |   | ✔ |   |   | infinite retry |
| C15 | Connect-failure reason codes |   | ✔ |   |   |   | logs only — no structured reason in `/connection/status` |
| C16 | Disconnect (clean teardown) | ✔ |   |   |   |   | `mavlink_link.py:620–651`, `main.py:423–429` |
| C17 | Connection state machine (DISCONNECTED → CONNECTING → WAITING_FOR_HEARTBEAT → CONNECTED → HEARTBEAT_LOST → RECONNECTING) | ✔ |   |   |   |   | `vehicle_state.py:6–13` (NB: `ACTIVE` defined but never set) |
| C18 | Connection state UI ribbon (color pill + HB age + packet loss + GPS + mode + ADSB) | ✔ |   |   |   |   | `FlightData.jsx:15–23, 229–252`, `StatusTab.jsx:7–13` |
| C19 | Multi-vehicle backend support | ✔ |   |   |   |   | `mavlink_link.py:23, 140–148, 257–267`, `main.py:453–473` |
| C20 | Multi-vehicle UI selection |   | ✔ |   |   |   | `useTelemetryStore.vehiclesRoster` exists; minimal UI |
| C21 | SITL auto-connect on simulator start | ✔ |   |   |   |   | `sitl_orchestrator.py:30` (`udp:127.0.0.1:14550`, 3.5 s delay) |
| C22 | Saved connection profiles |   |   | ✔ |   |   | hardcoded presets only |
| C23 | Link quality — packet loss % and pps | ✔ |   |   |   |   | `mavlink_link.py:347–366` |
| C24 | Link quality — RSSI / SNR for RF links |   |   | ✔ |   |   | not surfaced |
| C25 | Stream-request logic (split across 3 sites) | ✔ |   |   |   | ✔ | `mavlink_link.py:198, 334–336, 456` |
| C26 | Connection state mirroring (LinkManager + per-VehicleState) | ✔ |   |   |   | ✔ | `mavlink_link.py:135–138` + `vehicle_state.py:125` |
| C27 | Param re-sync on reconnect |   |   | ✔ |   |   | see P15 |

---

## SECTION 4 — MAP / FLIGHT DATA SCREEN

| # | Feature | E | P | M | D | F | Files |
| --- | --- | :-: | :-: | :-: | :-: | :-: | --- |
| MP1 | Vehicle marker | ✔ |   |   |   |   | `MapView.jsx:23–39, 179–192, 293–376` |
| MP2 | Real MAVLink GPS rendering (validates fix ≥ 2, ignores `(0,0)`) | ✔ |   |   |   |   | `MapView.jsx:293–376` + `message_handlers.py:81–105` (GPS_RAW_INT + GLOBAL_POSITION_INT) |
| MP3 | Heading rotation of vehicle icon | ✔ |   |   | ✔ |   | `MapView.jsx:14–21, 368–370` (also in `MapEditor.jsx:97–104`, `mapSelectors.js:27–36`) |
| MP4 | Flight path trail (1500 pts max, 1 e-6 decimation, reset on disconnect) | ✔ |   |   |   |   | `MapView.jsx:201–220, 336–347, 386–395` |
| MP5 | Home marker | ✔ |   |   | ✔ |   | `MapView.jsx:398–424`, `message_handlers.py:106–110`; duplicate render in `MapEditor.jsx:241–256` |
| MP6 | "Go to vehicle" button | ✔ |   |   |   |   | `MapView.jsx:661–677` |
| MP7 | Auto-follow vehicle (toggle, localStorage, cancel-on-user-interact) | ✔ |   |   |   |   | `MapView.jsx:105–108, 349–354, 693–700` |
| MP8 | Waypoint rendering during flight (seq labels, active-WP highlight) | ✔ |   |   | ✔ |   | `MapView.jsx:568–605`; mirrored in `MapEditor.jsx:279` |
| MP9 | Mission route polyline | ✔ |   |   | ✔ |   | `MapView.jsx:536–549` source `mv-mission-route`; mirrored in `MapEditor.jsx` source `route` |
| MP10 | Geofence overlay (inclusion green / exclusion red, dashed) | ✔ |   |   | ✔ |   | `MapView.jsx:505–534`; fence grouping also in `MapEditor.jsx:42–54` and `FlightPlanner.jsx:73–90` |
| MP11 | Rally point overlay | ✔ |   |   |   |   | `MapView.jsx:551–566` |
| MP12 | Map centering on first GPS fix (one-shot) | ✔ |   |   |   |   | `MapView.jsx:94–96, 312–323` |
| MP13 | Telemetry-to-map sync (60 fps rAF interpolation) | ✔ |   |   |   |   | `MapView.jsx:293–376` |
| MP14 | Drone icon rendering (custom SVG, rotation, scaling) | ✔ |   |   |   |   | `MapView.jsx:23–39, 179–192` |
| MP15 | Click-to-fly-to / DO_REPOSITION from map (context menu) | ✔ |   |   |   |   | `MapView.jsx:769–778` → `/api/flyto` |
| MP16 | Set HOME from map | ✔ |   |   |   |   | `MapView.jsx` ctx menu → `/api/vehicle/set_home` |
| MP17 | Set ROI from map | ✔ |   |   |   |   | `MapView.jsx` ctx menu → `/api/vehicle/roi` |
| MP18 | RTL from map context menu | ✔ |   |   |   |   | `MapView.jsx` ctx menu → `/api/command/rtl` |
| MP19 | Map provider / tile source switching |   |   | ✔ |   |   | hard-coded CartoDB at `MapView.jsx:160`, `MapEditor.jsx:130` |
| MP20 | Distance / bearing measurement tool |   |   | ✔ |   |   | not implemented |
| MP21 | Altitude profile along path |   |   | ✔ |   |   | not implemented |
| MP22 | ADS-B traffic overlay | ✔ |   |   |   |   | `MapView.jsx:462–503`, `python_service/adsb_store.py` |
| MP23 | Weather overlay |   |   | ✔ |   |   | not implemented |
| MP24 | Fence command constants (5001/5002) |   |   |   | ✔ |   | duplicated in `useMissionStore` + inline in MapView/MapEditor |
| MP25 | Mission-execution panel (transfer status, progress, retries, error) | ✔ |   |   |   |   | `MissionExecutionPanel.jsx:1–187`, `useTelemetryStore.missionSyncStatus` |

---

## STALE / CONTRADICTORY DOCS

| Doc | Claim | Reality |
| --- | --- | --- |
| `DATA_TAB_GAP_ANALYSIS.md:23` | Map waypoints/polyline missing | E — `MapView.jsx:536–605` |
| `DATA_TAB_IMPLEMENTATION_PLAN.md` | click-to-fly-to / DO_REPOSITION missing | E — `MapView.jsx:769–778` + `/api/flyto` |
| `docs/audit/data_screen_audit.md:11` | Home / trail / overlays missing | E — `MapView.jsx:410–423`, `:201–220`, `:505–605` |
| (earlier audit drafts) | ARM/DISARM/TAKEOFF/LAND/RTL endpoints missing | E — wired via `node_api/server.js:210–270` shortcut layer |
| `HUD_MIGRATION_NOTES.md` | HUD consumes `telemetrySelectors.js` | P/F — selectors imported but math inlined |
| `COMMAND_ENGINE.md:18` | 10 Hz ZMQ broadcast | Loop-rate driven, not 10 Hz |
| `COMMAND_ENGINE.md:26` | 15 s staleness constant | No such constant |
| `vehicle_state.py:11` | `ACTIVE` connection state | Never set anywhere |

---

## ROLL-UP COUNTS

| Section | E | P | M | D | F | Rows |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| HUD (H1–H31) | 24 | 4 | 5 | 0 | 3 | 31 |
| Telemetry (T1–T16) | 14 | 0 | 2 | 1 | 1 | 16 |
| Actions (A1–A20) | 19 | 0 | 1 | 0 | 1 | 20 |
| Modes (MD1–MD20) | 18 | 0 | 2 | 18 | 0 | 20 |
| Parameters (P1–P15) | 12 | 0 | 3 | 1 | 0 | 15 |
| Connection (C1–C27) | 19 | 3 | 5 | 1 | 2 | 27 |
| Map (MP1–MP25) | 19 | 0 | 5 | 5 | 0 | 25 |
| **Total** | **125** | **7** | **23** | **26** | **7** | **154** |

(*Note: D-count on Modes is inflated because every mode shares the same duplicate-list root cause — collapsing to a single "static fallback list duplicates pymavlink mode_mapping" issue brings the substantive D total to ~9.*)

Bottom-line parity vs Mission Planner across Data-Tab surface: **~83 %**.
