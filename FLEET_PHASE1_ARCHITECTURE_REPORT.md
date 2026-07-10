# FLEET PHASE 1 — Repository Analysis & Architecture Report

**Status:** Complete — verified against source code (not just docs)
**Date:** 2026-07-09
**Scope:** `drone_gcs/` only. `qgroundcontrol/` and `MissionPlanner/` are vendored upstream reference codebases and are OUT of refactoring scope.
**Purpose:** Ground-truth baseline for converting the single-drone GCS into an Enterprise Fleet Management Platform. Companion doc: `FLEET_PHASE2_ARCHITECTURE_DESIGN.md`.

---

## 1. Current Architecture (as-built)

Three manually-started local processes plus the browser:

```
Browser (React 18 + Vite + Zustand, dev :3000/:5173)
  │  HTTP REST + WebSocket (telemetry/commands)          ┌─ direct WS (video only)
  ▼                                                      ▼
Node Gateway  :8080  (node_api/server.js)          Python FastAPI :8000
  │  axios REST proxy ────────────────────────────►  main.py (~70 endpoints)
  │  ZMQ SUB tcp://127.0.0.1:5556 ◄───────────────  telemetry_pub.py (PUB, 10 Hz JSON)
  │                                                   │ pymavlink (LinkManager)
  ▼                                                   ▼
All browser WS clients (broadcast fan-out)         Drone (serial / UDP 14550 / TCP 5760 / BLE)
```

| Component | Location | Role |
|---|---|---|
| Python service | `drone_gcs/python_service/` | MAVLink engine: connection, telemetry, missions, commands, params, calibration, SITL, video (GStreamer), replay |
| Node gateway | `drone_gcs/node_api/` | Stateless REST proxy + ZMQ→WebSocket telemetry relay + telemetry enrichment engine |
| Frontend | `drone_gcs/frontend/` | React SPA: Flight Data, Planner, Setup, Params, Simulation, OSD, Video, Help |
| `drone_gcs/api_gateway/` | **EMPTY directory** — no code, not git-tracked | Placeholder only |
| `drone_gcs/web_ui/` | **EMPTY directory** | Placeholder only |

**Authoritative docs** (per `DOCUMENTATION_INDEX.md`): `MASTER_GCS_ARCHITECTURE.md`, `MASTER_FLIGHT_PLANNER.md`, `MASTER_DATA_TAB.md`, `MASTER_OPERATIONS_AND_DEBUGGING.md`, plus `drone_gcs/VIDEO_SUBSYSTEM_IMPLEMENTATION.md` (as-built video). `MODERN_GCS_ARCHITECTURE.md` and `GCS_DOCUMENTATION.md` are superseded.

---

## 2. Telemetry Flow

```
Vehicle ─MAVLink─► LinkManager.read_loop() (mavlink_link.py:359)
  → handle_message(msg, VehicleState)   (message_handlers.py:34 — HEARTBEAT, ATTITUDE,
     GLOBAL_POSITION_INT, VFR_HUD, GPS_RAW_INT, SYS_STATUS, EKF, VIBRATION, STATUSTEXT, …)
  → VehicleState dataclass (vehicle_state.py:156) — per-sysid in link_manager.vehicles dict
  → TelemetryPublisher.publish_loop() 10 Hz full-snapshot JSON (telemetry_pub.py:43)
     ZMQ PUB bound tcp://127.0.0.1:5556  — message types: TELEMETRY_UPDATE, CONNECTION_STATUS,
     PARAM_SYNC_STATUS, COMMAND_STATUS, MISSION_SYNC_STATUS, PREFLIGHT_STATUS, ADSB_UPDATE
  → Node telemetryEngine.processZmqFrameString() (telemetryEngine.js:84)
     — additive enrichment: schema_version "2026.1", stale detection (2500/4000 ms thresholds),
       rad→deg normalization, EKF health score, engine_envelope {kind, vehicle_id, is_replay}
  → server.js broadcast() (server.js:36) — EVERY message to EVERY open WS client, no filtering,
     no rate limiting, no backpressure
  → frontend telemetryWebSocketBridge.js → telemetrySyncReducer.js (pure reducer)
  → Zustand useTelemetryStore — telemetry keyed by vehicle_id
  → selectors (selectPrimaryVehicle) → AdvancedHUD, MapView, TelemetryGrid, tabs
```

Key properties: full-snapshot (not delta), 10 Hz, no buffering/compression/rate-limiting anywhere, no persistence (replay taps the ZMQ payload stream to `.jsonl` files in `recordings/`). Node's event bus (`eventBus.js`) exists but has zero registered subscribers — plugin infrastructure only.

## 3. Video Flow

Entirely separate transport from telemetry; browser bypasses Node and talks to Python :8000 directly.

```
Camera (RTSP / UDP-RTP H264/H265 :5600 / TCP-MPEGTS / UDP-MPEGTS)
  → GstVideoReceiver (gst_video_receiver.py) — ONE pipeline: source_bin → tee
      ├─ webrtc_sender.py  — per-peer webrtcbin, no transcode, STUN only (no TURN)
      │     signaling: WS /ws/video/signaling (main.py:1372)
      ├─ raw_ws_sender.py  — appsink → [u64 pts][NAL] frames → WS /ws/video/raw → browser WebCodecs
      └─ recorder.py       — valve (keyframe-gated) → mp4/mkv mux → recordings/ + .ass subtitle sidecar
VideoManager — PROCESS-WIDE SINGLETON (video_manager.py:203), one GstVideoReceiver at a time
camera_manager.py — MAVLink CAMERA_INFORMATION / VIDEO_STREAM_INFORMATION discovery → auto-config
Video control REST (/api/video/*, /api/cameras) — proxied through Node :8080
```

Frontend renders via WebRTC `<video>` (default) or WebCodecs `<canvas>` (fallback), toggled in `VideoView.jsx`. **One active stream, one camera, one vehicle** — no thermal/dual-camera concurrency despite QGC parentage supporting it.

## 4. Mission Flow

```
FlightPlanner.jsx (client-side waypoint editing, useMissionStore, QGC WPL 110 file I/O)
  → POST /api/mission/upload (Node proxy) → Python mission_manager.py
  → MAVLink mission microprotocol on link_manager.conn, addressed to primary_sysid ONLY
     (mission_manager.py:65-66): MISSION_COUNT → REQUEST_INT/ITEM_INT loop → MISSION_ACK
     — HOME auto-injected at seq 0; retries (count×3, item×10); INVALID_SEQUENCE drain
  → transfer_status published over ZMQ; frontend polls /api/mission/transfer/status every 900 ms
Fence (mission_type=2, polygon vertex counts in param1) and Rally (type=5) use the same protocol.
```

Command flow: `POST /api/command/:cmd` → Node `COMMAND_MAP` (arm/disarm/rtl/land/takeoff/…, server.js:286) → Python `/command` → `command_manager.execute_command()` — COMMAND_LONG + ACK-wait + retries, per-(sysid,compid) lock, **always primary_sysid**.

Parameter flow: `parameter_manager.py` — bulk fetch + gap recovery, verified set with rollback, disk cache `param_cache/{sysid}_{compid}.json`.

## 5. WebSocket Flow

| Socket | Endpoint | Direction | Content |
|---|---|---|---|
| Telemetry | `ws://localhost:8080` (Node) | server→client only (inbound msgs ignored) | All ZMQ types, enriched, broadcast to all |
| Video signaling | `ws://<host>:8000/ws/video/signaling` (Python, NOT proxied) | bidirectional | WebRTC SDP/ICE |
| Video raw | `ws://<host>:8000/ws/video/raw` (Python, NOT proxied) | server→client | H.264 Annex-B + timestamps |

## 6. Authentication

**None exists.** No JWT, no login, no users, no roles, no route guards, no Authorization headers, wide-open CORS (`cors()` with no options, server.js:16). The original plan (`drone_gcs/docs/plan.md`) deferred auth ("API-key later, JWT can be added later"). All three tiers assume trusted localhost/LAN.

## 7. Database

**None exists.** All persistence is files + localStorage:

| Data | Storage |
|---|---|
| Parameters cache | `python_service/param_cache/{sysid}_{compid}.json` |
| Video settings | `python_service/video_settings.json` |
| SITL profiles | `sitl_profiles.json`; OSD profiles `osd_profiles.json` |
| Recordings + telemetry replay | `python_service/recordings/*.mp4`, `*.jsonl`, `.ass` |
| Missions | client-side `.waypoints` files (QGC WPL 110) |
| UI prefs | browser localStorage |

Nothing persists: users, orgs, drones, flights, mission history, telemetry history, alerts, audit logs.

## 8. API Structure

- **Node :8080** exposes ~80 routes under `/api/*` — 1:1 axios proxies to Python except: `COMMAND_MAP` translation (server.js:286-342), `GET /api/telemetry/engine/snapshot` (local), multer log-upload forwarding.
- **Python :8000** exposes ~70 endpoints: connection lifecycle, state, mission/fence/rally, commands/mode/flyto/set_home/ROI, parameters (12+ routes), calibration/motor test, setup groups (flight modes/failsafe/battery/radio), simulation/SITL, OSD, video, cameras, replay, log analysis, ADS-B, `GET /vehicles` + `POST /vehicles/select`.
- No API versioning, no OpenAPI doc published to consumers, no request auth, no rate limiting, no vehicle scoping on command routes.

## 9. Backend Services (module inventory)

**Python (`python_service/`):** `main.py` (app + lifespan + ~70 routes), `mavlink_link.py` (LinkManager), `connection_manager.py` (port auto-detect), `telemetry_pub.py` (ZMQ PUB), `vehicle_state.py`, `message_handlers.py`, `mission_manager.py`, `command_manager.py`, `parameter_manager.py` (+ `parameter_metadata.py`, `param_format.py`), `camera_manager.py`, `preflight_manager.py`, `replay_manager.py`, `sitl_manager.py` + `sitl_orchestrator.py`, `osd_manager.py`, `adsb_store.py`, `log_analyzer.py`, `video_service/` (7 modules).

**Node (`node_api/`):** `server.js` (Express + WS + ZMQ SUB + proxies), `telemetry/` (`telemetryEngine.js`, `vehicleStateManager.js`, `staleTelemetry.js`, `schemas.js`, `eventBus.js`).

## 10. Frontend Modules

Stack: React 18.3, Zustand 5 (3 stores), MapLibre GL 5 (CartoCDN dark basemap), react-router-dom 7, axios, Vite 5. No TypeScript, no tests, no linter.

Pages: FlightData (HUD/map/quick actions/connection ribbon), FlightPlanner (mission/fence/rally/survey), Setup (calibrations, radio, flight modes, failsafe, battery, motor test), Params, Simulation, OSDEditor, Video, Help. Components: `AdvancedHUD`, `MapView` (renders secondary vehicles + ADS-B as passive markers), `MapEditor`, `TelemetryGrid` (registry of 45+ fields), 9 Mission-Planner-style Data tabs, video components.

Known defect: `.env.example` defines `VITE_API_BASE` but **no code reads it** — every REST/WS URL is a hardcoded `localhost:8080` / `:8000` literal.

---

## 11. Single-Drone Dependency Inventory (the refactor target list)

The system was designed "multi-vehicle from day 1, single-vehicle in practice" (`drone_gcs/docs/plan.md`). State storage IS vehicle-keyed; transport, command routing, and UX are single-link/single-primary. Every item below must change for fleet operation.

### Python service
| # | Assumption | Location |
|---|---|---|
| P1 | Module-level global singletons: `link_manager`, `mission_manager`, `telemetry_publisher`, `parameter_manager`, `sitl_manager`, `osd_manager`, `preflight_manager`, `camera_manager` | `main.py:49-56` |
| P2 | One `LinkManager.conn` — a single MAVLink transport per process | `mavlink_link.py:20` |
| P3 | First non-GCS heartbeat becomes `primary_sysid`; ALL commands/missions/params/calibration target primary only | `mavlink_link.py:260`, `mission_manager.py:65`, `main.py:573-656` |
| P4 | ZMQ PUB hardcoded `tcp://127.0.0.1:5556`; FastAPI hardcoded `:8000` | `telemetry_pub.py:13`, `main.py:1414` |
| P5 | `VideoManager` process-wide singleton; one GStreamer pipeline / one active stream | `video_manager.py:203-218` |
| P6 | Global calibration state (`_mag_cal_data`, `_accel_cal_pos`) | `main.py:67,92` |
| P7 | Single-instance config files (video_settings.json, param_cache, osd/sitl profiles, recordings/) | various |
| P8 | SITL manages one subprocess, auto-connect hardcoded `udp:127.0.0.1:14550` | `sitl_manager.py:79,130` |

### Node gateway
| # | Assumption | Location |
|---|---|---|
| N1 | One ZMQ SUB to one hardcoded Python backend (`127.0.0.1:8000`, `tcp://127.0.0.1:5556`, no env overrides) | `server.js:11-13` |
| N2 | Singleton telemetry engine/bus created at module load | `server.js:44-45` |
| N3 | Global connection state: DISCONNECTED/HEARTBEAT_LOST **wipes the entire vehicle map** — models one link, not per-vehicle links | `vehicleStateManager.js:52-54` |
| N4 | Broadcast fan-out: every WS client receives every message; no per-vehicle subscription, filtering, or backpressure | `server.js:36-42` |
| N5 | Command/mission/param proxy routes carry no vehicle selector | `server.js:311, 222, 382` |
| N6 | No auth, no DB, no persistence of any kind | grep-verified |

### Frontend
| # | Assumption | Location |
|---|---|---|
| F1 | One global WS to hardcoded `ws://localhost:8080`, opened once at app mount | `useTelemetryStore.js:117`, `App.jsx:23` |
| F2 | `selectPrimaryVehicle` drives HUD, grid, planner, setup, commands — secondary vehicles are passive map dots only | `telemetrySelectors.js:73-87` |
| F3 | No REST call carries a vehicle_id; switching targets requires `POST /api/vehicles/select` round-trip | all commands |
| F4 | Single global mission-editing buffer (not per-vehicle) | `useMissionStore.js` |
| F5 | One video stream, fixed endpoints, single `<video>`/`<canvas>` | `webrtcClient.js:4`, `VideoView.jsx` |
| F6 | Hardcoded hosts; `VITE_API_BASE` unwired | all API_URL constants |

### What is already fleet-ready (reuse as-is)
- `link_manager.vehicles: Dict[sysid, VehicleState]` + `/vehicles` endpoints (Python)
- `VehicleStateManager` Map keyed by vehicle_id + `known_vehicle_ids`/`primary_sysid` enrichment (Node)
- `telemetry[vehicle_id]` store shape, `vehiclesRoster`, fleet selectors, multi-vehicle map markers (frontend)
- The entire MAVLink protocol layer (mission microprotocol, command ACK machine, param sync) — correct and battle-tested; it needs *scoping*, not rewriting
- The telemetry enrichment engine, stale detection, schema versioning (Node)
- The whole video pipeline topology (tee → webrtc/raw/record) — needs *instantiation per stream*, not redesign

---

## 12. Gaps vs. Fleet Requirements (summary)

| Requirement | Today |
|---|---|
| Multiple drone connections | 1 transport/process |
| Drone identity/registration | none (sysid only, first-heartbeat-wins) |
| Auth / RBAC / orgs / users | none |
| Database / history / analytics | none (files only) |
| Multi-stream video | 1 stream singleton |
| Per-vehicle command routing | primary-only |
| Deployment (Docker/K8s/cloud) | 3 manual terminal processes |
| Networking (LTE/VPN/WireGuard) | localhost hardcoded |
| Alerts/notifications/audit | none |
| Health/monitoring (Prometheus) | none |
