# PLAN SCREEN Audit

## 1. Feature Inventory

| Feature | Mission Planner | Backend | Frontend | End-to-end |
|---|---|---|---|---|
| Read/write mission via MAVLink mission protocol | ✅ Implemented | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| Add waypoint on map | ✅ Implemented | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| Drag waypoint on map | ✅ Implemented | ✅ Implemented | ✅ Implemented (added) | ✅ Implemented |
| Delete waypoint | ✅ Implemented | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| Reorder mission rows | ✅ Implemented | ✅ Implemented | ✅ Implemented (added) | ✅ Implemented |
| Rich waypoint table (frame/cmd/params) | ✅ Implemented | ✅ Implemented | ✅ Implemented (expanded) | ✅ Implemented |
| Right-click insert actions (WP/TAKEOFF/LAND/RTL/ROI) | ✅ Implemented | ✅ Implemented | ✅ Implemented (added subset) | ✅ Implemented |
| Spline/polygon/survey/corridor tools | ✅ Implemented | ❌ Missing | ❌ Missing | ❌ Missing |
| Fence mission type | ✅ Implemented | ❌ Missing | ❌ Missing | ❌ Missing |
| Rally mission type | ✅ Implemented | ❌ Missing | ❌ Missing | ❌ Missing |
| ACK/error-classified upload state machine | ✅ Implemented | ⚠ Partial | ⚠ Partial | ⚠ Partial |

## 2. Mission Planner Reference Behavior

- References:
  - `MissionPlanner/GCSViews/FlightPlanner.cs`
  - `MissionPlanner/GCSViews/FlightPlanner.Designer.cs`
  - `MissionPlanner/ExtLibs/ArduPilot/mav_mission.cs`
  - `MissionPlanner/ExtLibs/ArduPilot/Mavlink/MAVLinkInterface.cs`
- Hidden logic includes:
  - robust mission protocol retry and sequence handling,
  - context actions creating command-specific waypoint rows with parameter defaults,
  - mission-type-specific workflows (mission/fence/rally),
  - tool-generated missions (survey/circle/spline/polygon) with validation and derived params.

## 3. Backend Audit

- Current implementation:
  - `python_service/mission_manager.py`
  - `python_service/mission_models.py`
  - `python_service/main.py` mission endpoints
- Implemented during this pass:
  - protocol compatibility widened (`MISSION_REQUEST` + `MISSION_REQUEST_INT`; `MISSION_ITEM` + `MISSION_ITEM_INT` handling),
  - increased timeouts for upload/download robustness.
- Remaining gaps:
  - explicit mission transfer FSM with failure classes and progress model,
  - mission type support (`MAV_MISSION_TYPE_FENCE`, `RALLY`) APIs,
  - advanced ACK and partial upload support.

## 4. Frontend Audit

- Current implementation:
  - `frontend/src/pages/FlightPlanner.jsx`
  - `frontend/src/components/MapEditor.jsx`
  - `frontend/src/components/WaypointTable.jsx`
  - `frontend/src/store/useMissionStore.js`
- Implemented during this pass:
  - selection-aware waypoint model,
  - insert-at-index, move up/down, richer command/param editing,
  - draggable map markers with waypoint coordinate updates,
  - right-click context menu actions for common commands.
- Remaining gaps:
  - no dedicated spline/survey/polygon toolchain,
  - no fence/rally editor UI,
  - no mission validation assistant before upload.

## 5. Mission Planner UI Parity

- Current parity improved for core waypoint editing.
- Still missing MP-level planning workflows:
  - advanced context menu families,
  - mission type toggles and workflows,
  - generated mission tools (survey/circle/spline/terrain flows),
  - richer table validation and command presets.

## 6. Telemetry Binding Audit

| Planner UI element | MAVLink dependency | Required fields |
|---|---|---|
| Waypoint table rows | `MISSION_ITEM_INT` / `MISSION_ITEM` | seq, frame, command, params, lat/lng/alt |
| Read button | `MISSION_REQUEST_LIST`, `MISSION_COUNT`, `MISSION_REQUEST_INT`, `MISSION_ITEM_INT`, `MISSION_ACK` | full mission item sequence |
| Write button | `MISSION_COUNT`, `MISSION_REQUEST_INT`, `MISSION_ITEM_INT`, `MISSION_ACK` | upload request sequencing + final ACK |
| Context actions (TAKEOFF/LAND/RTL/ROI) | Mission command IDs (`22`, `21`, `20`, `201`) | command + params + coords |

## 7. Missing Feature Implementation Plan

- Backend:
  - implement mission transfer FSM with progress telemetry.
  - add fence/rally endpoints and mission type argument.
- Frontend:
  - add mission type selector (`MISSION/FENCE/RALLY`),
  - add table command presets and validations per command type,
  - add survey/circle/spline generation tools.
- MAVLink:
  - support fence/rally mission microservice transactions.
- Tests:
  - SITL upload/download with packet loss and retry behavior.

## 8. UI/UX Improvements

- Add Mission Planner-style context menu hierarchy and command templates.
- Add drag-drop row reordering and map-to-row highlighting.
- Add “mission diff” preview before upload.

## 11. PLAN SCREEN REQUIREMENTS Review

- Mission Editing: ⚠ Partial (now includes add/drag/delete/reorder/basic command editing).
- Right Click Context Menu: ⚠ Partial (subset implemented: insert WP, takeoff, land, RTL, ROI, delete selected).
- Waypoint Table: ⚠ Partial (expanded columns done; command-specific validation and frame presets missing).
- Mission Types: ❌ Missing (survey/corridor/orbit/fence/rally full flows).
- Fence Modes: ❌ Missing.
- Rally Points: ❌ Missing.
