# CONNECT MODULE Audit

## 1. Feature Inventory

| Feature | Mission Planner | Backend (`drone_gcs`) | Frontend (`drone_gcs`) | End-to-end |
|---|---|---|---|---|
| Transport open + connect trigger | ✅ Implemented | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| Heartbeat-gated connect state | ✅ Implemented | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| `CONNECTING` + `WAITING_FOR_HEARTBEAT` phases | ✅ Implemented | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| Heartbeat watchdog -> lost -> reconnect | ✅ Implemented | ✅ Implemented | ⚠ Partial | ⚠ Partial |
| Stream negotiation after connect/reconnect | ✅ Implemented | ⚠ Partial | ❌ Missing | ⚠ Partial |
| Packet-rate/link-quality analytics | ✅ Implemented | ⚠ Partial | ⚠ Partial | ⚠ Partial |
| COM/TCP/UDP/Serial/Bluetooth selector | ✅ Implemented | ⚠ Partial | ⚠ Partial | ⚠ Partial |
| Parameter auto-sync lifecycle | ✅ Implemented | ⚠ Partial | ⚠ Partial | ⚠ Partial |
| Multi-vehicle target selection | ✅ Implemented | ⚠ Partial | ❌ Missing | ❌ Missing |
| Duplicate connect suppression | ✅ Implemented | ✅ Implemented | ✅ Implemented | ✅ Implemented |

## 2. Mission Planner Reference Behavior

- Connect path is driven by `MainV2.doConnect(...)` + `MAVLinkInterface.OpenBg(...)`.
- Internal hidden logic includes:
  - active heartbeat probing before session acceptance (`getHeartBeatAsync`-style flow),
  - repeated/validated stream requests (`requestDatastream`, periodic re-request on stale),
  - packet cadence/quality accounting in read loop (`packetspersecond`, `packetslost`, last-valid-packet timing),
  - serial-specific fallback behaviors (timeout handling, recovery quirks),
  - parameter sync with retries/fallback path (MAVFTP preferred, classic param protocol fallback).
- GCS heartbeat transmit cadence is 1Hz; UI and state update loops run on different timers.
- Synchronization is state-machine-like even if distributed across files.

## 3. Backend Audit

- Current implementation:
  - `python_service/mavlink_link.py` (`connect`, `_bootstrap_session`, `keep_alive_loop`, `_attempt_reconnect`, `request_data_streams`)
  - `python_service/main.py` (`/connection/start`, `/connection/stop`, `/connection/status`)
  - `python_service/connection_manager.py` (`auto_detect_connection`)
  - `python_service/message_handlers.py`, `vehicle_state.py`, `telemetry_pub.py`
- Implemented during this pass:
  - heartbeat-driven connect acceptance and reconnect transitions,
  - strict single-connect lock,
  - connection status publishing,
  - connection config override via `/connection/start` request payload (`connection_string`, `baudrate`),
  - link metrics expansion (`packets_per_second`, `heartbeat_age_s`).
- Remaining parity gaps:
  - adaptive stream manager with per-stream measured-rate feedback,
  - robust parameter sync finite-state flow with retries/missing-repair,
  - richer reconnect diagnostics/reason codes for UI.

## 4. Frontend Audit

- Current implementation:
  - `frontend/src/store/useTelemetryStore.js`
  - `frontend/src/pages/FlightData.jsx`
- Implemented during this pass:
  - frontend connect de-bounce lock and in-flight request collapse,
  - state-driven connection indicator (MAVLink health, not socket-open),
  - transport/baud selector (`auto`, UDP, TCP, serial path presets),
  - request body wiring into backend start endpoint.
- Remaining gaps:
  - no serial port discovery list from backend,
  - no advanced reconnect diagnostics panel/history,
  - no multi-vehicle connection targeting UI.

## 5. Mission Planner UI Parity

- Mission Planner shows detailed link and transport internals that are still only partial:
  - packet rate/quality trends,
  - deeper reconnect status and warnings,
  - richer transport options and serial selection workflow,
  - stronger parameter sync visibility.
- Current parity level: core connect lifecycle is now close; advanced diagnostics remain behind.

## 6. Telemetry Binding Audit

| UI Widget | MAVLink Messages | Fields | Rate | Backend pipeline | Frontend binding |
|---|---|---|---|---|---|
| Connection state pill | HEARTBEAT + internal FSM | connection_state | event-driven | `mavlink_link.py` -> `telemetry_pub.py` (`CONNECTION_STATUS`) | `useTelemetryStore.connectionState` |
| Heartbeat age | HEARTBEAT | last heartbeat timestamp | ~10Hz publish | `mavlink_link.py` -> `vehicle_state.link_status.heartbeat_age_s` | `FlightData` ribbon |
| Packet loss | all packet seq + HEARTBEAT | loss %, rx/lost counters | ~10Hz publish | `read_loop` seq accounting | `FlightData` and `StatusTab` |
| Packet rate | all packet seq stream | packets/sec | ~1Hz computed | `mavlink_link.py` pps window | available in state (needs richer UI charting) |
| GPS/Mode/Battery in ribbon | HEARTBEAT, GPS_RAW_INT, SYS_STATUS, VFR_HUD | mode, fix, sats, voltage, percent | stream-driven | `message_handlers.py` -> `vehicle_state.py` | `FlightData` |

## 7. Missing Feature Implementation Plan

- Backend:
  - add adaptive stream controller with target rates and stale re-request policy.
  - add parameter sync job FSM with progress + retries + missing-index repair.
- Frontend:
  - add connection diagnostics panel (reconnect attempt count, last reason, stream health).
  - add serial-port query UI and manual endpoint builder.
- Telemetry/MAVLink:
  - publish per-stream effective rates and parse latency quality metrics.
  - expose command ack classification for user-visible error reasons.
- Testing:
  - link drop simulation tests,
  - SITL startup race tests,
  - repeated connect spam test,
  - reconnect stream renegotiation test.

## 8. UI/UX Improvements

- Add Mission Planner-like compact status strip with explicit packet-rate + heartbeat-age + stream health.
- Add connection profiles (USB, radio telemetry, UDP SITL, TCP SITL, Bluetooth) with persistence.
- Add warning banner for heartbeat loss and auto-reconnect stages.

## 9. CONNECT MODULE REQUIREMENTS Review

- Connection Controls: ⚠ Partial (transport and baud present; COM port discovery and profile persistence missing).
- Supported Links: ⚠ Partial (serial/tcp/udp/bluetooth endpoint support exists; discovery/validation UX incomplete).
- Internal Logic: ⚠ Partial (heartbeat/session/reconnect implemented; firmware detection and advanced param sync incomplete).
- Telemetry Features: ⚠ Partial (basic packet/loss/heartbeat added; adaptive stream control and full timeout diagnostics incomplete).
