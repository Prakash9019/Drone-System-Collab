# FLIGHT PLANNER AUDIT TABLE
**Scope**: Mission + Fence + Survey Grid + Map/AutoPan (Rally is best-effort)
**Date**: 2026-05-25 (regression audit)

Legend: ✓ exists / ◑ partial / ✗ missing / ⚠ broken / D duplicated / F fragmented

---

## 0. REGRESSION TABLE — 2026-05-25

| Feature | Exists | Partial | Broken | Root cause | Files |
|---------|:------:|:-------:|:------:|------------|-------|
| FlightPlanner page mount on fresh checkout | | | ⚠ R1 | Duplicate `import { UploadCloud … }` and `import { pointInPolygon … }` introduced by merge commit `429705f` — Vite/ESBuild parse error | `drone_gcs/frontend/src/pages/FlightPlanner.jsx:9-12` (HEAD) |
| Fence config form `fence_type` state | | ◑ R2 | | Duplicate `fence_type:` key inside `setFenceForm({...})` — same value, no behaviour change, but noisy | `drone_gcs/frontend/src/pages/FlightPlanner.jsx:~459,~493` |
| `VehicleState.fence_status` field | ✓ | D R3 | | Two `class FenceStatus` dataclasses in same module — last-wins | `drone_gcs/python_service/vehicle_state.py:113, 141` (HEAD) |
| `/fence/status` JSON shape | ✓ | D R4 | | Duplicate `"fence_status_msg": fs,` in return dict | `drone_gcs/python_service/main.py:325-326` |
| Validation "Last item is RTL" presented as warning | | ◑ F5 | | `validateMission()` pushed informational RTL/LAND messages onto the same `warnings[]` array as real warnings — amber warning button on a correctly configured mission | `drone_gcs/frontend/src/pages/FlightPlanner.jsx:140-141` |

All five issues are addressed; R1/R2/R3 were fixed in the user's working tree, R4/F5 were fixed during this audit. See `FLIGHT_PLANNER_CENTRALIZED.md` §11 for the commit checklist.

**Symptom-to-cause mapping**:
- "Mission worked before, now it doesn't" → R1 prevented the page from compiling after a `git pull`. The browser kept serving the previous HMR build, so partial functionality persisted across sessions in a confusing way.
- "Warning shows even though my mission is correct (TAKEOFF…WPs…RTL)" → F5: `validateMission` lumped the expected-end-of-mission note with real warnings.

---

## A. MISSION — full audit

| Feature                              | Status | Files |
|--------------------------------------|--------|-------|
| Mission create (map left-click)      | ✓      | `frontend/src/components/MapEditor.jsx` left-click handler → `useMissionStore.addWaypoint(lat,lng,alt=50)` |
| Map right-click context menu (TAKEOFF/LAND/RTL/LOITER/SPLINE/ROI/DO_*) | ✓ | `MapEditor.jsx:460-528` |
| Right-click "Insert RTL" appends cmd 20 at end | ✓ | `MapEditor.jsx:513` calling `addCommand(20)` → `insertWaypointAt(waypoints.length, {command:20, lat, lng, alt:50})` |
| WaypointTable inline edit            | ✓      | `frontend/src/components/WaypointTable.jsx` (391 lines) |
| Drag-reorder / move up/down rows     | ✓      | `useMissionStore.moveWaypoint(seq, ±1)` with `_reindex` |
| Undo / Bulk Alt                      | ✓      | `useMissionStore._undoStack` cap 20 |
| TAKEOFF-first hard block             | ✓      | `FlightPlanner.jsx:blockingErrors` — refuses Write when first item ≠ cmd 22 |
| Validation split warnings vs infos   | ✓ (post-fix) | `FlightPlanner.jsx:validateMission` returns `{warnings, infos}` |
| MISSION_TYPE_MISSION upload          | ✓      | `python_service/mission_manager.py:upload_mission` |
| HOME injection at seq=0              | ✓      | `mission_manager.py:_inject_home` — uses vehicle.home if `home.valid`, else (0,0,0) |
| Re-indexing after insert/remove/move | ✓      | `useMissionStore._reindex` |
| Save/Load `.waypoints` (QGC WPL 110) | ✓      | `FlightPlanner.jsx:parseWaypointsFile, buildWaypointsFile` |
| MISSION_REQUEST_INT INVALID_SEQUENCE drain | ✓ | `mission_manager.py:275-304` (drains spurious ACKs inline) |
| MISSION_ITEM_INT lat/lng × 1e7 scale | ✓      | `mission_manager.py:271` |
| Final MISSION_ACK timeout=1s         | ✓      | `mission_manager.py:317` |
| AUTO start (`mission_start` shortcut → cmd 300, p1=0, p2=0) | ✓ | `node_api/server.js:293`; `command_manager.py:execute_command` |
| Mode set GUIDED / AUTO               | ✓      | `mavlink_link.set_mode_send`; UI `FlightPlanner.jsx:setMode` |
| ARM with auto-retry on "mode not armable" | ✓ | `frontend/src/components/tabs/ActionsTab.jsx:75-100` (switch to STABILIZE, retry) |
| Pre-flight checklist (Connected, GPS, Home, TAKEOFF, WPs, Armed, AUTO, fence interaction) | ✓ | `FlightPlanner.jsx:preflightChecks` |
| canStartMission gate                 | ✓      | `FlightPlanner.jsx:617` (`!loading && waypoints>0 && armed && AUTO && hasTakeoffCmd`) |
| MISSION_CURRENT (seq) tracking       | ✓      | `message_handlers.py:119-120`; surfaced in MissionExecutionPanel |
| MISSION COMPLETE detection on AUTO→RTL/LAND | ✓ | `MissionExecutionPanel.jsx:77-101` (badge "MISSION COMPLETE" vs "failsafe") |
| Re-arm after mission complete (one-click) | ✗ | recommended F9 — see `FLIGHT_PLANNER_CENTRALIZED.md §11.2` |
| Write button gated on `home.valid`   | ✗ | recommended F6 |
| Confirm-before-write modal           | ✗ | recommended F10 |
| Right-click DO_DIGICAM_CONTROL (203) | ✗ | recommended F11 |
| Right-click CONDITION_DELAY (112), CONDITION_YAW (115) | ✗ | recommended F11 |

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
| Mission Planner parity comparison                            | `FLIGHT_PLANNER_CENTRALIZED.md` §10 |
| Production fix list (with commit message)                    | `FLIGHT_PLANNER_CENTRALIZED.md` §11 |
| Regression audit (2026-05-25)                                | Section 0 above + `FLIGHT_PLANNER_CENTRALIZED.md` §0, §2.4 |
| Fence diagnostics implementation                             | shipped — `FlightPlanner.jsx:fenceDiagnostics`, `vehicle_state.FenceStatus`, `message_handlers.FENCE_STATUS` |
| Survey Grid fixes                                            | not yet shipped — see `FLIGHT_PLANNER_CENTRALIZED.md` §4 |
| AutoPan implementation                                       | shipped — `MapEditor.jsx:autoPan` toggle |
| User instructions                                            | Section 9 of `FLIGHT_PLANNER_CENTRALIZED.md` |

---

## H. CHANGE LOG

- **2026-05-25** — Regression audit. Added Section 0 (regression table) mapping the user-reported "mission broken" symptom to merge-conflict duplicate-import artifacts in commit `429705f`. Rewrote Section A (Mission) from "reference only" to a full audit table now that mission is in scope. Updated Deliverables Summary.
- **2026-05-24** — Initial audit. Mission marked reference-only; focused on Fence + Survey + Map gaps.
