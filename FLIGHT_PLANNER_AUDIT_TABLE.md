# FLIGHT PLANNER AUDIT TABLE
**Scope**: Fence + Survey Grid + Map/AutoPan (Mission left untouched, Rally ignored)
**Date**: 2026-05-24

Legend: ✓ exists / ◑ partial / ✗ missing / D duplicated / F fragmented

---

## A. MISSION (reference only — DO NOT MODIFY)

| Feature                              | Status | Files |
|--------------------------------------|--------|-------|
| Mission create (map clicks)          | ✓      | `frontend/src/components/MapEditor.jsx:165-168` |
| Right-click commands (TAKEOFF/LAND/RTL/LOITER/etc.) | ✓ | `MapEditor.jsx:382-449` |
| Waypoint table edit                  | ✓      | `frontend/src/components/WaypointTable.jsx` |
| TAKEOFF preflight check + insert     | ✓      | `pages/FlightPlanner.jsx:466-476, 603-612` |
| MISSION_TYPE_MISSION upload protocol | ✓      | `python_service/mission_manager.py:176-336` |
| HOME inject at seq=0 (Copter req)    | ✓      | `mission_manager.py:150-174` |
| AUTO start (mission_start cmd)       | ✓      | `FlightPlanner.jsx:429-442` |
| Pre-flight checklist UI              | ✓      | `FlightPlanner.jsx:478-491, 625-638` |

---

## B. FENCE — MAIN FOCUS

### B.1 Existing pieces

| Feature                                          | Status | Files |
|--------------------------------------------------|--------|-------|
| FENCE mode dropdown in toolbar                   | ✓      | `FlightPlanner.jsx:510-514` |
| Inclusion/Exclusion polygon radio toggle         | ✓      | `FlightPlanner.jsx:551-575` |
| Polygon vertex add (map click)                   | ✓      | `MapEditor.jsx:165-168`, `store/useMissionStore.js:54-77` |
| Multi-polygon grouping by cmd id (5001/5002)     | ✓      | `utils/mapShared.js:40-53`, `FlightPlanner.jsx:73-87` |
| Polygon vertex `param1` = count per polygon      | ✓      | `FlightPlanner.jsx:249-260` (matches MP `Fence.cs:97-140`) |
| `frame=MAV_FRAME_GLOBAL` (0) for fence items     | ✓      | `FlightPlanner.jsx:254` (matches MP) |
| Fill+outline rendering, color by type            | ✓      | `MapEditor.jsx:135-160, 297-316` |
| FENCE upload via MISSION_TYPE_FENCE (modern)     | ✓      | `mission_manager.py:113, 211` |
| Per-polygon validation (≥3 pts warning)          | ✓      | `FlightPlanner.jsx:90-105` |
| Fence config form (Enable/Action/Radius/Alt/Margin) | ✓   | `FlightPlanner.jsx:643-674` |
| FENCE_ENABLE / FENCE_ACTION param writes         | ✓      | `python_service/main.py:321-357` |
| FENCE_MARGIN ≥ FENCE_RADIUS guard                | ✓      | `FlightPlanner.jsx:393-396`, `main.py:328-332` |
| Param write order (RADIUS → MARGIN → ENABLE last)| ✓      | `main.py:337-344` |
| FENCE_STATUS polling (2.5s)                      | ◑      | `FlightPlanner.jsx:366-390` — reads params only, no real FENCE_STATUS msg |
| Status bar `Fence: ENABLED \| Action: 1 \| Incl(4pts)` | ✓ | `FlightPlanner.jsx:551-575` |

### B.2 Missing / partial (vs Mission Planner)

| Feature                                              | Status | Where it should go |
|------------------------------------------------------|--------|--------------------|
| **`FENCE_TYPE` bitmask write** (1=altmax 2=circle 4=poly 8=altmin) | ✗ | `main.py:fence_config`, UI form |
| **MAVLink `FENCE_STATUS` message handler** (breach_status, breach_type, breach_count) | ✗ | `python_service/message_handlers.py`, `vehicle_state.py` |
| **Surface STATUSTEXT fence-breach lines to fence UI** | ✗ | `FlightPlanner.jsx`, `mavlink_link.py` |
| Fence runtime diagnostics panel (Enabled/Active/Inside Incl/Inside Excl/Breach/Reason/Triggered Action) | ✗ | `FlightPlanner.jsx` (new component) |
| **Point-in-polygon check: HOME inside inclusion**    | ✗ | preflight section in `FlightPlanner.jsx` |
| **Point-in-polygon check: HOME outside exclusion**   | ✗ | same |
| **Mission waypoints inside fence** preflight check   | ✗ | same |
| **Mission alt vs FENCE_ALT_MAX** preflight           | ✗ | same |
| **`FENCE_CIRCLE_INCLUSION` (5003) / `FENCE_CIRCLE_EXCLUSION` (5004)** support | ✗ | `useMissionStore.js`, `MapEditor.jsx` |
| **`FENCE_RETURN_POINT` (5000)** support              | ✗ | new |
| Visual indication of breach polygon                  | ✗ | `MapEditor.jsx` |
| Fence read-back diff (uploaded vs onboard)           | ✗ | `FlightPlanner.jsx` |

### B.3 Probable root causes — vehicle changes AUTO → RTL

| Hypothesis                                           | Likelihood | Diagnostic gap |
|------------------------------------------------------|-----------|----------------|
| `FENCE_TYPE` includes bit 1 (circle) and `FENCE_RADIUS` (default 300m or 100m) is breached when WP > radius from HOME | **HIGH** | We never expose FENCE_TYPE, never check radius vs WP distance |
| HOME at arm time differs from polygon center (SITL launched with wrong --home) | **HIGH** | No HOME-inside-polygon preflight check |
| Exclusion polygon, if drawn, contains HOME or mission path | **MEDIUM** | No HOME-outside-exclusion check |
| TAKEOFF altitude > `FENCE_ALT_MAX` (not the case at 10m vs 120m) | LOW | — |
| `FENCE_MARGIN` band pushes safe area inward → vehicle in margin band on arm | LOW–MED | No margin visualisation |
| Fence still active from previous SITL session (state not wiped) | MEDIUM | No "clear fence on drone" affordance separate from drawing |
| Polygon vertices wound in wrong order (rare on AC_Fence, but MP warns) | LOW | No winding-order check |

**Smoking gun**: the user has **no way to see** which fence type breached (polygon vs circle vs alt). The autopilot sends `STATUSTEXT` like "Fence Breach Polygon" or "Fence Breach Circle" and we silently swallow it (the message handler stores it in `status_messages` but nothing surfaces it on the fence tab).

---

## C. SURVEY GRID

### C.1 Existing pieces

| Feature                                                  | Status | Files |
|----------------------------------------------------------|--------|-------|
| Rectangle-based lawnmower around a center point          | ✓      | `frontend/src/utils/surveyGrid.js:29-127` |
| Heading (rotation), line spacing, along-spacing          | ✓      | `surveyGrid.js:51-65` |
| Spline waypoints (cmd 82) option                         | ✓      | `SurveyGridPanel.jsx:29, 70-71, 84` |
| Auto-prepend TAKEOFF (cmd 22)                            | ◑      | `SurveyGridPanel.jsx:87-93` — TAKEOFF at first grid pt, **not at HOME** |
| Auto-append RTL (cmd 20)                                 | ✓      | `SurveyGridPanel.jsx:95-101` |
| Camera overlap → line-spacing helper                     | ◑      | `SurveyGridPanel.jsx:10-18` — single overlap %, MP uses fwd+side |
| GSD readout, swath readout                               | ✓      | `SurveyGridPanel.jsx:52-63` |
| MAX 450 WPs cap                                          | ✓      | `surveyGrid.js:115-120` |
| Replace / Append entry into mission                      | ✓      | `SurveyGridPanel.jsx:103-104` |
| Seed from right-click map context                        | ✓      | `MapEditor.jsx:421-427`, `FlightPlanner.jsx:194-217` |

### C.2 Missing / wrong vs Mission Planner

| Feature                                                  | Status | Notes |
|----------------------------------------------------------|--------|-------|
| **Polygon-fill mode** (user draws arbitrary polygon, fill with grid) | ✗ | MP `ExtLibs/Utilities/Grid.cs:CreateGrid` |
| **Separate `overlap` (forward) and `sidelap` (cross)**   | ✗      | MP `Grid/GridUI.cs:222-223` |
| **`CAM_TRIGG_DIST` (cmd 206) auto-insert**               | ✗      | MP inserts at entry / clears at exit |
| **`DO_CHANGE_SPEED` (cmd 178) auto-insert**              | ✗      | MP option for survey cruise speed |
| **TAKEOFF placed at HOME, not first grid point**         | ✗ (wrong) | `SurveyGridPanel.jsx:88-92` uses `first.lat/lng` |
| **Lead-in / overshoot** per pass                         | ✗      | MP `Grid.cs:354` `overshoot1/overshoot2/leadin1/leadin2` |
| `CONDITION_YAW` (cmd 115) for survey heading hold        | ✗      | MP `GridUI.cs:891` |
| Camera config persistence (sensor / focal / image px)    | ◑      | Local UI state only, no save |
| **Heading auto-aligned with polygon long axis**          | ✗      | MP computes from polygon, ours is manual deg |
| Grid preview on map before commit                        | ✗      | MP draws grid + camera footprints |
| Estimated photo count                                    | ✗      | MP shows it |
| Estimated flight time                                    | ✗      | MP shows it |
| Mission validator that catches survey-specific issues    | ✗      | "TAKEOFF not at HOME" not flagged |

### C.3 Why "mission execution behaves wrong"

- **TAKEOFF location is the first grid point**, not HOME. ArduPilot ignores lat/lng on TAKEOFF (climbs straight up from current pos), so this is benign — but the **first NAV_WAYPOINT after TAKEOFF jumps to the corner**, which is what looks like erratic behaviour.
- **No `DO_CHANGE_SPEED`** → survey runs at `WPNAV_SPEED` (default 5 m/s), often too slow.
- **No `CAM_TRIGG_DIST`** → user expects photos, gets none.
- **No fence-vs-grid validation** → if user combined fence + survey, grid corner can be outside polygon.

---

## D. MAP / AUTOPAN

| Feature                                              | Status | Files |
|------------------------------------------------------|--------|-------|
| Map persists last center/zoom in localStorage         | ✓      | `MapEditor.jsx:85-91, 117-120`, `utils/mapPreferences.js` |
| One-shot geolocate on map open                       | ✓      | `MapEditor.jsx:103-115` |
| Drone live marker (rotates with heading)             | ✓      | `MapEditor.jsx:178-204` |
| Home marker                                          | ✓      | `MapEditor.jsx:206-213`, `mapShared.js:102-112` |
| **Auto-center on HOME when present**                 | ✗      | — |
| **Auto-center on vehicle when HOME absent**          | ✗      | — |
| **AutoPan toggle in UI**                             | ✗      | — |
| **Re-center on HOME change**                         | ✗      | — |
| Zoom-to-fit-mission button                           | ✓      | `FlightPlanner.jsx:356-364` |
| Don't break overlays during pan                      | n/a    | — |

---

## E. DUPLICATION / FRAGMENTATION

| Area                                                 | Status | Notes |
|------------------------------------------------------|--------|-------|
| Two maps (Data tab `MapView.jsx` + Plan tab `MapEditor.jsx`) | D | Shared helpers extracted to `utils/mapShared.js`, but home/drone-marker code is duplicated; AutoPan should land in `mapShared.js` so both maps benefit. |
| Fence config form lives in `FlightPlanner.jsx` (UI) + `main.py` (parameter writes) | F | Acceptable — UI/backend split |
| Multiple Mission Planner reference docs (`PLAN_TAB_IMP.md`, `MASTER_GCS_REQUIREMENTS.md`, `mission-map-flow.md`, `MISSION_ENGINE.md`, `imp.md`) | F+D | Centralise into `FLIGHT_PLANNER_CENTRALIZED.md` |
| Fence-poly grouping logic exists in three places — `mapShared.buildFenceGroups`, `FlightPlanner.buildFencePolygonGroups`, `FlightPlanner.buildMissionItemsForType` | D | Consolidate into one helper in `mapShared.js`. |
| Validation rules split between `FlightPlanner.validateFence` and `validateMission` | acceptable | each is small enough |

---

## F. STALE / SUPERSEDED DOCS

| Doc                                | Stale? | Note |
|------------------------------------|--------|------|
| `PLAN_TAB_IMP.md`                  | partly | Implementation tracker — most items now done; remove "PLANNED" markers |
| `imp.md`                           | OK     | User runbook — keep, but supersede with the new "USER GUIDE" section in centralised doc |
| `MISSION_PLANNER_PARITY_BOARD_REPORT.md` | stale | Pre-fence work |
| `MISSION_ENGINE.md` / `MISSION_MIGRATION_NOTES.md` | OK | Mission-only, reference |
| `mission-map-flow.md`              | OK     | Reference |
| `DATA_TAB_*` family                | OK     | Out of scope (different tab) |

---

## G. DELIVERABLES SUMMARY

| Deliverable                                                  | Path |
|--------------------------------------------------------------|------|
| Centralized doc                                              | `FLIGHT_PLANNER_CENTRALIZED.md` |
| Audit table                                                  | `FLIGHT_PLANNER_AUDIT_TABLE.md` (this file) |
| Fence diagnostics implementation                             | next iteration — code changes in `python_service/` + `frontend/` |
| Survey Grid fixes                                            | next iteration |
| AutoPan implementation                                       | next iteration |
| User instructions                                            | Section 9 of `FLIGHT_PLANNER_CENTRALIZED.md` |
