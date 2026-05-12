# SITL Architecture

## Goals

- Mission Planner-style simulation lifecycle controls.
- Safe process orchestration with predictable cleanup.
- Backend-first design with frontend control surface.

## Components

- `python_service/sitl_manager.py`
  - start/stop/reset/status process orchestration
  - tracked state + last error + active config
- `python_service/main.py`
  - `/simulation/start|stop|reset|status`
- `node_api/server.js`
  - `/api/simulation/*` proxy endpoints
- `frontend/src/pages/Simulation.jsx`
  - lifecycle controls + status polling UI

## Lifecycle

1. Operator chooses vehicle/model/home/speedup/wipe.
2. Backend starts SITL process (`sim_vehicle.py` default command).
3. UI polls status for process health.
4. Stop/reset actions safely terminate or restart process.

## Safety

- Kill fallback if graceful stop times out.
- State and errors always exposed through status endpoint.

## Next Steps

- Multi-instance swarm manager (unique SYSIDs, ports).
- Per-instance telemetry route management.
- Simulation profile persistence and launch presets.
- Attach SITL stdout/stderr logs to operator UI.
