# Telemetry core engine — implementation summary

## What was added

Node.js modular telemetry layer under **`drone_gcs/node_api/telemetry/`**, wired into the existing **ZeroMQ subscriber → WebSocket broadcast** path in **`server.js`**.

| File | Role |
|------|------|
| **`schemas.js`** | `TELEMETRY_SCHEMA_VERSION`, JSON parse guard, known ZMQ types, attitude rad→deg, EKF aggregate score / health (Mission Planner–style max variance). |
| **`eventBus.js`** | In-process `TelemetryEventBus` (`EventEmitter`) — `zmq:frame`, `zmq:parsed`, `telemetry:outbound`, `connection:transition`. |
| **`staleTelemetry.js`** | `StaleTelemetryDetector` — snapshot age vs link live, per-group staleness from last field-change timestamps. |
| **`vehicleStateManager.js`** | `VehicleStateManager` — per-vehicle `lastData`, snapshot timestamps, group activity; clears vehicles on **DISCONNECTED** / **HEARTBEAT_LOST**; tracks primary sysid from `CONNECTION_STATUS`. |
| **`telemetryEngine.js`** | `TelemetryCoreEngine` — ingestion (parse), dispatch by `type`, enrichment, WS output; optional `engine_envelope` sibling on messages. |
| **`index.js`** | Re-exports `telemetryEngine` module surface. |

## Wire-up

- **`server.js`** instantiates `TelemetryEventBus` + `TelemetryCoreEngine({ broadcast, bus })`.
- **`runZmqSubscriber`** calls `telemetryEngine.processZmqFrameString(payload)` instead of raw `broadcast(payload)`.
- **`GET /api/telemetry/engine/snapshot`** — debug JSON: schema version, connection state, primary sysid, known vehicle ids.

## Backward compatibility (frontend / Zustand)

- Preserved top-level WebSocket JSON: **`type`**, **`vehicle_id`** (telemetry), **`data`**.
- **Additive** fields only:
  - `data.schema_version` (`"2026.1"`)
  - `data.telemetry_engine` — `{ stale, normalized, fleet }` for `TELEMETRY_UPDATE` and connection metadata for `CONNECTION_STATUS`
  - Top-level **`engine_envelope`** — `{ v, ts, monotonic_ms, kind, name, vehicle_id, schema_version }`
- Unknown ZMQ JSON objects (no `type` / unknown `type`) are **passed through unchanged** (same as before).

## Dependencies

- **Runtime:** existing `ws`, `zeromq`, `express` — **no new npm packages**.
- **Internal:** Node `events`, `JSON` clone for immutable enrichment.

## Migration notes

1. **Frontend (optional later):** read `data.telemetry_engine.stale` for HUD/banners; use `normalized.attitude_deg` to avoid rad/deg bugs; subscribe to `telemetryBus` only from new Node-side plugins (not browser).
2. **Python:** unchanged; still publishes the same strings at 10 Hz.
3. **Electron:** unchanged; still talks to the same Node gateway.
4. **Further work (not done here):** split ingest to worker thread, protobuf/MessagePack, per-message ZMQ topics, auth on WS.

## Mission Planner alignment (conceptual)

| MP concept | This implementation |
|------------|---------------------|
| `readPacketAsync` → dispatch | ZMQ string → parse → branch on `type` |
| `MAVlist` / per-vehicle | `VehicleStateManager` map by `vehicle_id` |
| `UpdateCurrentSettings` link / stale hints | `StaleTelemetryDetector` + connection-driven fleet clear |
| `CurrentState` EKF scalar | `ekfAggregateFromVehicleData` + `health` |
| `OnPacketReceived` fan-out | `TelemetryEventBus` for in-process subscribers |

---

*Generated with the telemetry subsystem implementation.*
