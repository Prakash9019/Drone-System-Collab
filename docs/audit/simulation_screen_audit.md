# Simulation Screen Audit

## 1. Feature Inventory

| Feature | Mission Planner | Backend | Frontend | E2E |
|---|---|---|---|---|
| Start/stop/reset SITL lifecycle | ✅ | ✅ | ✅ | ✅ |
| Vehicle/model/home/wipe options | ✅ | ⚠ | ✅ | ⚠ |
| Process state + PID visibility | ✅ | ✅ | ✅ | ✅ |
| Multi-vehicle/swarm launch modes | ✅ | ❌ | ❌ | ❌ |
| SITL RC UDP bridge behavior | ✅ | ❌ | ❌ | ❌ |
| SITL defaults/param override pipeline | ✅ | ⚠ | ⚠ | ⚠ |

## 2. Mission Planner Reference Behavior

- `GCSViews/SITL.cs` performs launch argument construction, home/model/default overrides.
- Lifecycle is kill-before-start and cleanup-on-exit.
- Supports chain/multilink swarm starts, then connects per stream.
- SITL-specific runtime hooks in `MainV2.cs` and `Program.cs`.

## 3. Backend Audit

- Added `python_service/sitl_manager.py`:
  - async process start/stop/reset/status.
  - stores active config and exposes state.
- Added endpoints in `python_service/main.py`:
  - `/simulation/start`, `/simulation/stop`, `/simulation/reset`, `/simulation/status`.
- Remaining:
  - swarm/multi-instance support.
  - telemetry routing and RC passthrough parity.
  - model-specific default param file pipeline.

## 4. Frontend Audit

- Added `frontend/src/pages/Simulation.jsx`:
  - vehicle/model/home/speedup/wipe controls.
  - lifecycle buttons and periodic status polling.
- Added route/navigation in `frontend/src/App.jsx`.
- Remaining:
  - multi-vehicle dashboard and stream switching.
  - simulation logs and advanced options panel.

## 5. Mission Planner UI Parity

- Core parity baseline implemented for single-instance SITL lifecycle.
- Missing parity:
  - swarm controls,
  - chain/multilink topology options,
  - per-instance connection management.

## 6. Telemetry Binding Audit

- Simulation page currently binds process-state telemetry only (not sim-flight telemetry overlays).
- Flight telemetry still flows through existing MAVLink connection path after SITL link connect.

## 7. Missing Feature Implementation Plan

- Add N-instance launcher with unique SYSIDs and UDP/TCP allocation strategy.
- Add simulation profiles per vehicle/model.
- Add log stream tailing and health watchdog.
- Add reset/wipe + parameter preset selection in one start transaction.

## 8. UI/UX Improvements

- Add saved simulation profiles and one-click launch cards.
- Add map-based home selector linked to launch args.
- Add per-sim instance cards for state, SYSID, and active stream quality.
