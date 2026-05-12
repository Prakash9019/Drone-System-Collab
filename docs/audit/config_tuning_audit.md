# Config / Tuning Audit

## 1. Feature Inventory

| Feature | Mission Planner | Backend | Frontend | E2E |
|---|---|---|---|---|
| Full parameter pull with retries/missing recovery | ✅ | ⚠ | ⚠ | ⚠ |
| Incremental sync progress telemetry | ✅ | ✅ | ✅ | ✅ |
| Parameter categories + search + large list handling | ✅ | ⚠ | ⚠ | ⚠ |
| Dirty tracking + modified highlighting | ✅ | ⚠ | ✅ | ⚠ |
| Param write ACK/validation semantics | ✅ | ⚠ | ⚠ | ⚠ |
| Friendly tuning groups/basic tuning UX | ✅ | ❌ | ❌ | ❌ |
| Extended ATC/Loiter/Nav tuning pages | ✅ | ❌ | ❌ | ❌ |
| Geofence/OSD config pages | ✅ | ❌ | ❌ | ❌ |

## 2. Mission Planner Reference Behavior

- Parameter control implemented in `MAVLinkInterface.cs` with robust LIST/READ/SET loops.
- Missing params recovered in batched index reads.
- Cache persistence and warm-start in `MAVState.cs` + `MainV2.cs`.
- Friendly/advanced config UIs in `ConfigRawParams.cs`, `ConfigFriendlyParams.cs`, `ConfigSimplePids.cs`.
- OSD/fence flows in `ConfigOSD.cs`, `ConfigAC_Fence.cs`.

## 3. Backend Audit

- Added `python_service/parameter_manager.py`:
  - tracks `reported`, `received`, `missing`, progress state.
  - does full `PARAM_REQUEST_LIST` sync and missing index recovery with `PARAM_REQUEST_READ`.
- Integrated via:
  - `python_service/main.py` (`/parameters/refresh`, `/parameters/status`)
  - `python_service/mavlink_link.py` (`PARAM_VALUE` feed into manager)
  - `python_service/telemetry_pub.py` (`PARAM_SYNC_STATUS` publishes).
- Remaining:
  - stronger `PARAM_SET` ACK verification and rollback semantics.
  - cache persistence and stale detection.

## 4. Frontend Audit

- Updated `frontend/src/pages/Params.jsx`:
  - category filters, search, sort, page-window virtualization-like slicing, dirty highlighting.
  - sync status banner (`SYNCING`, `RECOVERING_MISSING`, etc.).
- Updated `frontend/src/store/useTelemetryStore.js` for `PARAM_SYNC_STATUS`.
- Remaining:
  - full diff/import/export preset workflow.
  - grouped tuning pages and safe-range validation.

## 5. Mission Planner UI Parity

- Achieved: core full-parameter workflow with progress tracking and category/search usability.
- Missing parity:
  - friendly tuning wizard pages,
  - metadata-driven value constraints,
  - reboot-required and dependency awareness.

## 6. Telemetry Binding Audit

- `PARAM_VALUE` -> backend cache + sync accounting.
- `PARAM_REQUEST_LIST` / `PARAM_REQUEST_READ` used for sync/recovery.
- `PARAM_SET` used for writes (ACK handling partial).
- `PARAM_SYNC_STATUS` streamed to UI for progress.

## 7. Missing Feature Implementation Plan

- Add persistent param cache and stale freshness policy.
- Add write verification by expected echoed value tolerance.
- Add parameter metadata schema for range, enum, user-level and reboot-required.
- Build Basic/Extended tuning pages bound to named parameter groups.

## 8. UI/UX Improvements

- Add side category tree with counts.
- Add param diff panel (vehicle vs file preset).
- Add one-click profile import/export.
