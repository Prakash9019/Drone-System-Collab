# Phase 2 Implementation Notes

## Purpose

This document captures what is being implemented in **Phase 2**, why it is required, what has already been delivered, and what remains before full Mission Planner parity.

Phase 2 focuses on reliability-critical parity, not cosmetic UI:

- protocol correctness
- state synchronization
- retry/ACK handling
- reconnect-safe behavior
- backend/frontend wiring completeness

---

## Why Phase 2 Is Required

Mission Planner reliability comes from robust internal systems, not just screens.
Without these systems, common failure modes occur:

- parameters appear writable but fail silently
- mission/fence/rally operations mismatch vehicle state
- stale data is shown as live
- reconnect causes inconsistent state
- simulation controls look present but are operationally weak

Phase 2 closes those architectural gaps.

---

## Scope of Phase 2

### 1) Mission-Type Protocol Parity (MISSION/FENCE/RALLY)

#### Implemented
- Backend mission transfer now supports mission-type aware operations:
  - `MISSION`
  - `FENCE`
  - `RALLY`
- Message routing supports both legacy and INT variants:
  - `MISSION_REQUEST_INT` + `MISSION_REQUEST`
  - `MISSION_ITEM_INT` + `MISSION_ITEM`
- API now accepts and propagates mission type end-to-end.
- Frontend planner has mission-type selector and read/write switching.

#### Why required
- Mission Planner treats mission, fence, and rally as separate protocol domains.
- Hardcoding `MISSION` only leads to incomplete planner parity and unsafe operations.

#### Files touched
- `drone_gcs/python_service/mission_manager.py`
- `drone_gcs/python_service/main.py`
- `drone_gcs/python_service/mavlink_link.py`
- `drone_gcs/python_service/mission_models.py`
- `drone_gcs/node_api/server.js`
- `drone_gcs/frontend/src/store/useMissionStore.js`
- `drone_gcs/frontend/src/pages/FlightPlanner.jsx`

---

### 2) PARAM_SET Verified ACK + Rollback

#### Implemented
- Parameter writes now use verification flow:
  - send `PARAM_SET`
  - wait for matching `PARAM_VALUE` echo
  - validate value with tolerance
  - retry if needed
- If write verification fails, perform best-effort rollback to previous cached value.
- API returns rollback state on failure.

#### Why required
- Naive `PARAM_SET` calls can fail silently on real links.
- Verified write semantics are essential for safe tuning/config changes.
- Rollback reduces risk of partial/bad configuration state.

#### Files touched
- `drone_gcs/python_service/parameter_manager.py`
- `drone_gcs/python_service/main.py`

---

### 3) Parameter Cache + Staleness Policy

#### Implemented
- Persistent per-vehicle parameter cache on disk.
- Staleness-aware warm load (default max age: 1 hour).
- Auto-save during live sync and successful verified writes.
- Cache status exposed to frontend.
- Manual cache load endpoint + UI action.

#### Why required
- Full parameter downloads are expensive and fragile on weak links.
- Mission Planner-style warm cache improves startup usability and resilience.
- Staleness checks prevent presenting old cache as authoritative live state.

#### Files touched
- `drone_gcs/python_service/parameter_manager.py`
- `drone_gcs/python_service/main.py`
- `drone_gcs/node_api/server.js`
- `drone_gcs/frontend/src/store/useTelemetryStore.js`
- `drone_gcs/frontend/src/pages/Params.jsx`

---

### 4) Day-2 Baseline Systems Already Added (pre-Phase 2.1/2.2)

- Parameter sync manager with missing-index recovery (`PARAM_REQUEST_READ` batches).
- Parameter sync progress telemetry (`PARAM_SYNC_STATUS`).
- SITL process lifecycle manager (start/stop/reset/status).
- Simulation UI screen bound to backend.

These provide the foundation that Phase 2 hardens.

---

## Important Architectural Aspects

### A) State Machine Integrity
- Parameter sync states must be explicit (`IDLE`, `SYNCING`, `RECOVERING_MISSING`, `COMPLETE`, `PARTIAL`, `CACHE_WARM`).
- Connection and mission flows must remain deterministic during reconnects.

### B) Protocol Observability
- Every critical operation should produce inspectable status:
  - sync progress
  - missing counts
  - rollback flags
  - cache source/time

### C) End-to-End Wiring
- UI actions must map to backend APIs.
- Backend APIs must map to MAVLink behavior.
- MAVLink responses must flow back to UI state.

### D) Failure Handling
- Retries are required for unstable links.
- Timeouts must be explicit and user-visible.
- Rollback/partial states must not be hidden.

---

## Risks / Limitations (Current)

- Mission-type support is present, but advanced mission UX (survey/spline/fence editor depth) is still incomplete.
- Parameter metadata model (safe ranges, enum values, reboot-required flags) is not yet implemented.
- SITL multi-instance swarm and stream-routing parity is pending.
- OSD slot protocol/editor parity is pending.

---

## Next Steps After Current Phase 2 Slice

1. Friendly + Advanced tuning pages with metadata-backed validation.
2. Geofence editor + `FENCE_POINT` / `FENCE_FETCH_POINT` protocol pipeline.
3. OSD layout/profile system + slot mapping parity.
4. SITL swarm/multi-vehicle orchestration and routing manager.

---

## Validation Status

For current Phase 2 work:

- Python compile checks: passed
- Frontend build checks: passed
- Lint checks on changed files: passed

This confirms the implemented Phase 2 baseline is integrated and runnable.
