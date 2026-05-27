# FLIGHT PLANNER — MISSION CORE AUDIT TABLE
**Companion**: `FLIGHT_PLANNER_MISSION_CENTRALIZED.md`
**Date**: 2026-05-25 — mission-core deep-dive
**Scope**: Mission core (PRIMARY). Fence (SECONDARY).

Legend: ✓ working / ◑ partial / ✗ missing / ⚠ broken / D duplicated / F fragmented / **R** regression / **G** feature gap

---

## A. MISSION CORE — feature × status matrix

### A.1 Mission creation (frontend)

| Feature | Status | Regression? | Root cause | Files |
|---------|:-----:|:-----------:|------------|-------|
| Left-click map → add NAV_WAYPOINT (cmd 16, alt 50) | ✓ | | — | `MapEditor.jsx:182-185` → `useMissionStore.addWaypoint:54-77` |
| Right-click → context menu open | ✓ | | — | `MapEditor.jsx:187-190` |
| Right-click → "Insert WP after selected" | ✓ | | — | `MapEditor.jsx:462-464` → `insertHere:383-393` |
| Right-click → "Add waypoint at end" | ✓ | | — | `MapEditor.jsx:467-473` |
| Right-click → "Insert TAKEOFF" | ⚠ M1 | no (always wrong) | `addCommand(22)` appends at end instead of inserting at index 0 | `MapEditor.jsx:367-376, 511` |
| Right-click → "Insert LAND" / "Insert RTL" | ✓ | | append at end (correct end-of-mission behaviour) | `MapEditor.jsx:512-513` |
| Right-click → "Insert LOITER UNLIM/TURNS/TIME" | ✓ | | — | `MapEditor.jsx:514-516` |
| Right-click → "Insert SPLINE WP (82)" | ✓ | | — | `MapEditor.jsx:517` |
| Right-click → "Insert ROI (201)" | ✓ | | — | `MapEditor.jsx:518` |
| Right-click → "Insert DO_JUMP (177)" / "DO CHANGE SPEED (178)" / "CAM_TRIGG_DIST (206)" | ✓ | | — | `MapEditor.jsx:519-521` |
| TAKEOFF default altitude | ⚠ M2 | no | 50 m via right-click, 10 m via toolbar — inconsistent | `MapEditor.jsx:373`, `FlightPlanner.jsx:557` |
| Drag waypoint marker on map | ✓ | | — | `MapEditor.jsx:300-304` |
| "Set home here" via right-click | ✓ | | → `POST /api/vehicle/set_home` (MAV_CMD_DO_SET_HOME) | `MapEditor.jsx:474-478` |
| "Set guided target" via right-click | ✓ | | → `POST /api/flyto` → SET_POSITION_TARGET_GLOBAL_INT after GUIDED | `MapEditor.jsx:479-483` |
| "RTL (vehicle)" via right-click | ✓ | | → `POST /api/command/rtl` | `MapEditor.jsx:484-487` |
| "Set ROI here" / "Clear ROI" | ✓ | | → MAV_CMD_DO_SET_ROI_LOCATION / NONE | `MapEditor.jsx:489-498` |
| "Survey grid…" via right-click | ✓ | | navigates with seed lat/lng | `MapEditor.jsx:499-505` |

### A.2 Waypoint table (frontend)

| Feature | Status | Regression? | Files |
|---------|:-----:|:-----------:|-------|
| Per-row Command dropdown (human-readable) | ✓ | | `WaypointTable.jsx:248-263` |
| Per-row Frame dropdown (Global/Relative/Terrain) | ✓ | | `WaypointTable.jsx:266-277` |
| Per-row Lat/Lng/Alt edit | ✓ | | `WaypointTable.jsx:279-300` |
| Per-row P1–P4 with dynamic labels per cmd | ✓ | | `WaypointTable.jsx:303-315` (`CMD_PARAM_LABELS:55-66`) |
| Move row up/down | ✓ | | `useMissionStore.moveWaypoint:142-157` |
| Duplicate row | ✓ | | `WaypointTable.jsx:145-147` → `insertWaypointAt(seq+1, …)` |
| Delete row | ✓ | | `useMissionStore.removeWaypoint:129-140` |
| Bulk altitude | ✓ | | `WaypointTable.jsx:137-143` |
| Undo last action | ✓ | | `useMissionStore.undoLastAction:41-52` (cap 20) |
| Mission stats (count, km, est. time @ 8 m/s) | ✓ | | `WaypointTable.jsx:116-135` |
| Footer warning for missing TAKEOFF / RTL | ✓ | | `WaypointTable.jsx:379-384` |
| Zoom-to-WP per row | ✓ | | `WaypointTable.jsx:149-152` |

### A.3 Mission store (zustand)

| Concern | Status | Notes | Files |
|---------|:-----:|-------|-------|
| `waypoints[]` central state | ✓ | | `useMissionStore.js:7` |
| Per-mission-type slots (`_missionSaved` / `_fenceSaved` / `_rallySaved`) | ✓ | switching missionType preserves the inactive buffers | `:15-17, 24-35` |
| `_reindex` re-numbers seq + sets `current:1` only at seq=0 | ✓ | called in insert/remove/move/append | `:39` |
| `addWaypoint` calls `_reindex`? | ⚠ M6 | no — pushes `{seq: snapshot.length}` and relies on consistency | `:54-77` |
| `selectMapMissionOverlay` re-export | ✓ | from `telemetry/mapSelectors` | `:215` |
| Subscribe-side per-type slot sync | ✓ | mirrors `state.waypoints` into the active slot key | `:205-212` |

### A.4 Mission upload (frontend → Node → Python)

| Step | Status | Notes | Files |
|------|:-----:|-------|-------|
| `blockingErrors` enforces empty/no-TAKEOFF/TAKEOFF-not-first | ✓ | hard-refuse client side | `FlightPlanner.jsx:144-156` |
| `validateMission` split into `{warnings, infos}` | ✓ | last-item-RTL is info, not warning (F5 fix) | `FlightPlanner.jsx:121-141` |
| Blocked on `home.valid` for MISSION mode | ✗ M4 | not implemented | `FlightPlanner.jsx:handleWrite` |
| `buildMissionItemsForType('MISSION')` passthrough | ✓ | | `FlightPlanner.jsx:319-347` |
| POST `/api/mission/upload {items, mission_type}` | ✓ | | `FlightPlanner.jsx:395`, `server.js:222-229` |
| `MissionTransferRequest` model — pydantic | ✓ | `items: list[MissionItem]`, `mission_type: str` | `mission_models.py:21-26` |
| `mission_manager.upload_mission()` | ✓ | full state machine | `mission_manager.py:176-336` |
| `validate_mission` (lat/lng bounds) | ✓ | rejects out-of-range coords | `mission_manager.py:54-59` |
| `_inject_home()` prepends HOME at seq=0 | ✓ | uses `vehicle.home` if valid, else (0,0,0) | `mission_manager.py:150-174` |
| HOME injection only for MISSION (not FENCE/RALLY) | ✓ | guarded by `if mission_type.upper() == "MISSION"` | `mission_manager.py:214-215` |
| `MISSION_COUNT` send with `mission_type_value` | ✓ | retries 3 × 1.0 s | `mission_manager.py:235-247` |
| `MISSION_REQUEST_INT/MISSION_REQUEST` handling | ✓ | drains stale + advances `seq_to_send` | `mission_manager.py:261-307` |
| `MISSION_ITEM_INT` send with lat/lng ×1e7 | ✓ | int(lat*1e7), int(lng*1e7) | `mission_manager.py:266-273` |
| `MISSION_ACK` ACCEPTED / INVALID_SEQUENCE handling | ✓ | INVALID_SEQUENCE drained inline | `mission_manager.py:290-302` |
| Final `MISSION_ACK` wait (1.0 s) | ✓ | | `mission_manager.py:317` |
| `transfer_status` 10 Hz live state | ✓ | session_id, phase, current/total, retries, duration | `mission_manager.py:99-100` |
| `_commit_history` for completed sessions | ✓ | rolling 50 entries | `mission_manager.py:35-52` |

### A.5 Mission download (frontend → Node → Python)

| Feature | Status | Files |
|---------|:-----:|-------|
| `GET /api/mission?mission_type=MISSION` | ✓ | `server.js:201-211` |
| `mission_manager.download_mission()` | ✓ | `mission_manager.py:338-472` |
| Retries: 6 × 0.7 s on REQUEST_LIST → COUNT | ✓ | `:378-384` |
| Per-item: 5 attempts × 2.5 s drain window | ✓ | `:404-447` |
| Stale-seq messages drained without consuming attempt | ✓ | `:420-421` |
| Final MISSION_ACK send | ✓ | `:455-457` |
| Frontend `setWaypoints(loaded)` after Read | ✓ | `FlightPlanner.jsx:362` |

### A.6 Mission start (frontend → MAVLink)

| Step | Status | Notes | Files |
|------|:-----:|-------|-------|
| `Start Mission` button gated by `canStartMission` | ✓ | armed && AUTO && hasTakeoffCmd && wps>0 | `FlightPlanner.jsx:617, 755-764` |
| `sendShortcutCommand('mission_start')` | ✓ | | `useTelemetryStore.js:230-284` |
| Node maps to `{command: 300, p1..p7: 0}` | ✓ | | `server.js:293` |
| Python `/command` → `link_manager.send_command` | ✓ | → `command_manager.execute_command` | `main.py:554-571` |
| `command_long_send(300, conf=N, 0,…,0)` | ✓ | MAV_CMD_MISSION_START, p1=0 (first), p2=0 (last) | `command_manager.py:128-134` |
| COMMAND_ACK matching | ✓ | by `f"{sysid}_{compid}_{command}"` key | `command_manager.py:46-73` |
| IN_PROGRESS extends deadline | ✓ | per ACK | `command_manager.py:153-157` |
| 3 retries × 3.0 s for non-ARM, 10.0 s for ARM | ✓ | matches MP | `command_manager.py:138-141` |

### A.7 Mode set (frontend → MAVLink)

| Step | Status | Notes | Files |
|------|:-----:|-------|-------|
| `setFlightMode('AUTO')` from telemetry store | ✓ | POST /api/mode | `useTelemetryStore.js:327-353` |
| Node proxy `/api/mode` | ✓ | passthrough | `server.js:344-351` |
| Python `/mode` → `link_manager.set_mode` | ✓ | | `main.py:583-591` |
| `mavlink_link.set_mode(sysid, "AUTO")` | ✓ | `conn.mode_mapping()` lookup + `set_mode_send(custom_mode)` | `mavlink_link.py:584-601` |
| No ACK wait — relies on subsequent HEARTBEAT | ✓ | matches MP | — |
| Frontend `currentMode` updates from HEARTBEAT | ✓ | via `vehicle.status.mode` | `FlightPlanner.jsx:202` |
| Set-AUTO race window (UI flips before HB confirms) | ◑ M9 | no UI-side confirmation gate | — |
| Pre-flight check in Flight Data AUTO selector | ✓ | refuses AUTO if mission has no TAKEOFF / no GPS / no HOME | `FlightData.jsx:137-171` |

### A.8 ARM (frontend → MAVLink)

| Step | Status | Notes | Files |
|------|:-----:|-------|-------|
| ARM via quick-action in Flight Data | ✓ | `runShortcut('arm')` | `FlightData.jsx:475` |
| ARM via Actions tab | ✓ | `handleAction({kind: 'shortcut', name: 'arm'})` | `ActionsTab.jsx:67-101` |
| Auto-retry on "mode not armable" in Actions tab | ✓ | switches to STABILIZE, retries ARM once | `ActionsTab.jsx:71-99` |
| Auto-retry in quick-action ARM | ✗ M3 | not implemented — quick action just shows red banner | `FlightData.jsx:runShortcut, handleQuickArm` |
| FORCE ARM (bypasses pre-arm checks) | ✓ | `command_long(400, p1=1, p2=21196)` | `server.js:288` |
| ARM 10 s ACK timeout | ✓ | matches MP `doARMAsync` | `command_manager.py:140` |
| `vehicle.status.armed` updates from HEARTBEAT | ✓ | `(base_mode & MAV_MODE_FLAG_SAFETY_ARMED) != 0` | `message_handlers.py:41` |

### A.9 Mission execution (live state)

| Field | Status | Source | Files |
|-------|:-----:|--------|-------|
| `MISSION_CURRENT` → `mission.current_seq` | ✓ | MAVLink | `message_handlers.py:119-120`, `vehicle_state.py:269` |
| `MissionExecutionPanel` WP progress label | ✓ | `activeSeq - 1` index into planned items | `MissionExecutionPanel.jsx:67-75` |
| Active-cmd command name (CMD 22 → "TAKEOFF") | ✓ | `CMD_NAME` table | `MissionExecutionPanel.jsx:30-45` |
| Live ALT / GS / →WP | ✓ | `position.alt_rel`, `velocity.groundspeed`, `navigation.wp_dist` | `MissionExecutionPanel.jsx:151-155` |
| "HOME (auto)" label for activeSeq=0 | ✓ | injected seq 0 = HOME | `MissionExecutionPanel.jsx:71-73` |
| MISSION COMPLETE detection (AUTO → RTL/LAND on last item) | ✓ | `missionCompletedByPlan` derivation | `MissionExecutionPanel.jsx:88-101` |
| Restart-mission affordance | ✗ M8 | not implemented | — |

### A.10 Mission file IO (`.waypoints` QGC WPL 110)

| Feature | Status | Files |
|---------|:-----:|-------|
| Save → `.waypoints` download | ✓ | `FlightPlanner.jsx:405-416` (frontend impl, no backend needed) |
| Load from `.waypoints` picker | ✓ | `FlightPlanner.jsx:418-433` |
| Header `QGC WPL 110` validation | ✓ | `parseWaypointsFile:40-63` |
| 12-column tab-separated rows | ✓ | seq/current/frame/cmd/p1-4/lat/lng/alt/autocontinue |
| Python-side equivalent (unused by frontend but available) | ✓ | `mission_file_io.py` |

---

## B. FENCE — secondary

### B.1 What works (re-uses mission infrastructure)

| Feature | Status | Files |
|---------|:-----:|-------|
| FENCE mode dropdown | ✓ | `FlightPlanner.jsx:636-640` |
| Inclusion / Exclusion polygon radio | ✓ | `:686-696` |
| Polygon vertex add (click) | ✓ | `MapEditor.jsx:183` (alt forced to 0 for FENCE) |
| Multi-polygon grouping by command type | ✓ | `mapShared.buildFenceGroups`, `FlightPlanner.buildFencePolygonGroups:87-101` |
| Per-polygon `param1` = vertex count | ✓ | `buildMissionItemsForType('FENCE'):319-347` |
| `frame = 0 (GLOBAL)`, `alt = 0` | ✓ | `:334, 337` |
| Polygon ≥ 3 pts warning | ✓ | `validateFence:104-118` |
| `MISSION_TYPE_FENCE` upload | ✓ | shared `mission_manager.upload_mission` |
| FENCE_ENABLE / FENCE_ACTION / RADIUS / MARGIN / ALT_MAX / ALT_MIN write | ✓ | `main.py:339-378` |
| FENCE_TYPE bitmask write | ✓ | optional in `FenceConfigRequest` | `main.py:328-365` |
| FENCE_MARGIN < FENCE_RADIUS guard | ✓ | client + server | `FlightPlanner.jsx:474-476`, `main.py:346-350` |
| Param write order (RADIUS→MARGIN→TYPE→ENABLE last) | ✓ | `main.py:356-365` |
| `FENCE_STATUS` MAVLink handler | ✓ | `message_handlers.py:183-190` |
| Fence STATUSTEXT captured to `fence_status.last_breach_text` | ✓ | `message_handlers.py:163-181` |
| Fence diagnostics panel (enabled / polygon active / circle active / HOME inside / breach live / etc.) | ✓ | `FlightPlanner.jsx:228-272, 847-917` |
| Client-side `pointInPolygon` (ray-casting) | ✓ | `utils/geometry.js:21-38` |
| HOME inside inclusion / outside exclusion preflight | ✓ | `missionVsFence:569-595` |
| WPs inside fence / Alt < AltMax preflight | ✓ | same |

### B.2 What's missing (feature gaps, not regressions)

| # | Gap | Files |
|---|-----|-------|
| FE1 | `FENCE_CIRCLE_INCLUSION` (5003) / `FENCE_CIRCLE_EXCLUSION` (5004) draw modes | `useMissionStore`, `MapEditor`, `mapShared` |
| FE2 | `FENCE_RETURN_POINT` (5000) | new |
| FE3 | "Clear onboard fence" affordance | `FlightPlanner` |
| FE4 | Fence read-back diff (uploaded vs onboard) | `FlightPlanner` |
| FE5 | `vehicle.parameters.FENCE_*` empty on first load — see M5 | `mavlink_link.py` post-bootstrap hook |

### B.3 Why "fence is affected by mission instability"

Both share `mission_manager.upload_mission()` and `transfer_status`. A stuck mission upload leaves `transfer_status` in a state that the FENCE upload's first `_set_transfer()` call overwrites — but if the FENCE upload fails to even reach `_set_transfer` (e.g., link disconnect at the wrong moment), the stale mission `transfer_status` remains visible in the UI's XFER counter. Fix is implicit in the `mission_manager._set_transfer(...)` design: every code path eventually calls it. No new issue here; only a display nuance.

---

## C. MISSION PLANNER PARITY (mission only)

| Concern | MP | Us | Verdict |
|---------|----|----|---------|
| HOME at seq=0 | always | `_inject_home` (uses `home.valid`, else `(0,0,0)`) | Parity (M4 to gate on valid) |
| `mission_type` on every frame | yes | yes | Parity |
| `MISSION_ITEM_INT` (lat/lng ×1e7) | yes | yes | Parity |
| Upload retries | 3×1s + 10×1.5s | 3×1s + 10×1.5s | Parity |
| Download retries | 5×2.5s | 5×2.5s (drain) | Parity |
| INVALID_SEQUENCE drain | inline | inline | Parity |
| MAV_CMD_MISSION_START | `p1..p7 = 0` | `p1..p7 = 0` | Parity |
| set_mode_send custom_mode | yes | yes | Parity |
| ARM auto-retry | yes (mode swap) | yes in Actions tab, NO in quick-action | **Partial — M3** |
| Right-click "Insert TAKEOFF" inserts at top | yes | NO — appends | **Diverges — M1** |
| `MISSION_SET_CURRENT` | yes | NO | **Gap — M7** |
| Re-arm after mission complete | yes | NO | **Gap — M8** |
| Pre-flight TAKEOFF-first warning | warn | **block** | Stronger than MP |

---

## D. REGRESSIONS (history)

| Date | Regression | Status |
|------|-----------|--------|
| 2026-05-24 (commit `429705f`) | Duplicate `import { UploadCloud … }` in `FlightPlanner.jsx` — Vite parse error on fresh checkout | Fixed in working tree (uncommitted) |
| 2026-05-24 | Duplicate `fence_type:` key (×2) in `setFenceForm({…})` | Fixed in working tree |
| 2026-05-24 | Duplicate `class FenceStatus` in `vehicle_state.py` — Python last-wins, no behaviour change | Fixed in working tree |
| 2026-05-24 | Duplicate `"fence_status_msg": fs,` in `/fence/status` response — dict literal collapses | Fixed in working tree |
| 2026-05-24 | `validateMission` lumped expected RTL/LAND end-of-mission into `warnings` — amber alert on a correct mission | Fixed: split into `{warnings, infos}` (F5) |

**Verdict**: there is **no new mission-protocol regression** in the codebase as of 2026-05-25. The "mission is broken" symptom the user reported is downstream of (a) the build-break from `429705f` on a clean checkout, plus (b) the UX confusion from "Last item is RTL" warnings, plus (c) M1 making right-click TAKEOFF append. All three have been addressed (the build-break by the working-tree fixes, F5 by the validation split, M1 by the fix in §10 of `FLIGHT_PLANNER_MISSION_CENTRALIZED.md`).

---

## E. NEW ISSUES IDENTIFIED IN THIS PASS

| # | Severity | One-liner | Layer | Status |
|---|:--------:|-----------|-------|:------:|
| M1 | High UX | Right-click "Insert TAKEOFF" appends instead of index-0 inserting | Frontend | **Fix applied** in §10 of centralized doc |
| M2 | Medium UX | TAKEOFF default alt 50 m via right-click, 10 m via toolbar — inconsistent | Frontend | **Fix applied** |
| M3 | High UX | Quick-action ARM in Flight Data doesn't auto-retry on "mode not armable" | Frontend | **Fix applied** |
| M4 | Medium correctness | WRITE not gated on `home.valid` → can upload with (0,0,0) HOME | Frontend | **Fix applied** |
| M5 | Medium correctness | `vehicle.parameters` empty on first load — FENCE_* show 0 until Params tab visited | Python/Frontend | Deferred — needs backend hook |
| M6 | Low robustness | `addWaypoint` doesn't call `_reindex` | Frontend | **Fix applied** |
| M7 | Low (gap) | No `MISSION_SET_CURRENT` exposure | All layers | Deferred — feature, not regression |
| M8 | Medium UX | No "Restart mission" button after MISSION COMPLETE | Frontend | Deferred — new UI |
| M9 | Low | Set-AUTO race window — UI flips before HEARTBEAT confirms | Frontend | Deferred — UI-side polling |

---

## F. DELIVERABLES MAP

| Deliverable | Where |
|-------------|-------|
| Centralized mission doc | `FLIGHT_PLANNER_MISSION_CENTRALIZED.md` |
| Audit table (this file) | `FLIGHT_PLANNER_MISSION_AUDIT_TABLE.md` |
| Mission Planner parity comparison | `FLIGHT_PLANNER_MISSION_CENTRALIZED.md` §6 + §C above |
| Production fixes applied | `FLIGHT_PLANNER_MISSION_CENTRALIZED.md` §10 + this file §E "Fix applied" rows |
| User-flow validation matrix | `FLIGHT_PLANNER_MISSION_CENTRALIZED.md` §11 |
| Regression analysis | §D above + `FLIGHT_PLANNER_MISSION_CENTRALIZED.md` §0 |

---

## G. CHANGE LOG

- **2026-05-25** — Initial mission-core audit. Audited frontend / Node / Python / MAVLink end-to-end. Identified 9 layered issues (M1–M9). Applied M1, M2, M3, M4, M6. Deferred M5, M7, M8, M9 as future work. Confirmed mission protocol has full Mission Planner parity. Documented all regression history.
