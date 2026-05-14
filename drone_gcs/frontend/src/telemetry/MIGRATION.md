# Frontend telemetry layer — migration notes

## What changed

- **`useTelemetryStore`** no longer parses WebSocket JSON inline. Inbound frames go through **`applyInboundTelemetryPayload`** → **`reduceTelemetryWebSocketMessage`** (pure reducer).
- New **`sync`** slice on the store: `wsTransport`, `lastInboundAt`, `inboundSeq`, `reconnectAttempts`, `lastEngineEnvelope` (from Node `engine_envelope` when present).
- **`telemetry`** remains the **authoritative raw** vehicle dict per id (same shape as before, now often including `schema_version` and `telemetry_engine` from the Node telemetry core).
- **Selectors** live under **`src/telemetry/`** and are re-exported from **`useTelemetryStore`** so existing `import { selectPrimaryVehicle } from '../store/useTelemetryStore'` continues to work.

## Backward compatibility

- **`selectPrimaryVehicle`** behavior unchanged: primary sysid vehicle, else first key in `telemetry`.
- HUD / map / tabs still receive the **raw** vehicle object; no visual redesign.
- WebSocket URL and message types unchanged.

## New capabilities (opt-in)

| Export | Use when |
|--------|----------|
| `selectPrimaryVehicleDerived` | Need `normalized`, `stale`, `schema_version` together |
| `selectStaleTelemetry(vehicle)` | Stale flags from `telemetry_engine.stale` |
| `selectAttitudeDisplay(vehicle)` | Prefer engine degrees, else rad→deg fallback |
| `selectFleetTelemetrySummary` | Multi-vehicle roster metadata |
| `selectSyncTransport` | WS reconnect / inbound cadence |

## Suggested follow-ups (not done here)

- Use `selectAttitudeDisplay` inside **AdvancedHUD** only when you intentionally switch HUD math (optional).
- Subscribe to `selectSyncTransport` in status UI for “WS reconnecting” (optional).

## Files added

- `src/telemetry/syncConstants.js`
- `src/telemetry/telemetrySelectors.js`
- `src/telemetry/telemetrySyncReducer.js`
- `src/telemetry/telemetrySyncTypes.js` (JSDoc typedefs)
- `src/telemetry/telemetryWebSocketBridge.js`
- `src/telemetry/index.js`

## Files modified

- `src/store/useTelemetryStore.js`
