# FLIGHT PLANNER — CENTRALIZED IMPLEMENTATION DOCUMENT
**Scope**: Fence, Survey Grid, Map/AutoPan only. Mission is reference-only (already working). Rally ignored.
**Companion**: `FLIGHT_PLANNER_AUDIT_TABLE.md`
**Last touched**: 2026-05-24

---

## TABLE OF CONTENTS

1. Architecture overview
2. Mission (reference only — do not modify)
3. Fence — current state, MP comparison, root cause, fix plan
4. Survey Grid — current state, MP comparison, fix plan
5. Map / AutoPan — current state, fix plan
6. MAVLink protocol reference (fence-relevant)
7. Implementation order (concrete diff plan)
8. Validation matrix
9. User instructions (Mission / Fence / Survey)

---

## 1. ARCHITECTURE OVERVIEW

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Frontend (React)                                                        │
│  pages/FlightPlanner.jsx ─ toolbar, mode select, fence/mission ctrl     │
│  components/MapEditor.jsx ─ map, click-to-add, right-click menu         │
│  components/SurveyGridPanel.jsx ─ survey config modal                   │
│  components/WaypointTable.jsx ─ table editor                            │
│  store/useMissionStore.js ─ waypoints[], missionType, fencePolygonMode  │
│  utils/surveyGrid.js ─ lawnmower generator                              │
│  utils/mapShared.js ─ heading, fence groups, home marker                │
│  utils/mapPreferences.js ─ persisted center/zoom                        │
└──────────────────┬───────────────────────────────────────────────────────┘
                   │ HTTP (axios) :8080
                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Node API (Express)                                                       │
│  node_api/server.js ─ thin proxy to Python; /api/fence/* /api/mission/*  │
└──────────────────┬───────────────────────────────────────────────────────┘
                   │ HTTP :8000
                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Python service (FastAPI)                                                 │
│  main.py ─ REST endpoints                                                 │
│  mission_manager.py ─ MAV mission protocol (upload/download)              │
│  mavlink_link.py ─ pymavlink connection, message dispatch                 │
│  message_handlers.py ─ per-msg-type → vehicle_state mutations             │
│  vehicle_state.py ─ central state object                                  │
│  parameter_manager.py ─ PARAM_VALUE / PARAM_SET                           │
└──────────────────┬───────────────────────────────────────────────────────┘
                   │ MAVLink (UDP 14550)
                   ▼
                ArduPilot SITL / vehicle
```

---

## 2. MISSION (reference only)

**Do not modify.** The flow below is the contract; deviations are bugs.

```
User clicks map
  → useMissionStore.addWaypoint(lat, lng, alt=50)
  → MapEditor renders marker + green dashed route
User edits in WaypointTable
  → updateWaypointField(seq, k, v)
User clicks WRITE
  → blockingErrors() — empty / no TAKEOFF / TAKEOFF not first
  → POST /api/mission/upload { items[] }
Node → Python (main.py)
  → mission_manager.upload_mission(items, "MISSION")
  → _inject_home() prepends a seq=0 HOME placeholder (frame=0, cmd=16)
  → MISSION_COUNT → MISSION_REQUEST(_INT) loop → MISSION_ITEM_INT each → MISSION_ACK
Vehicle stores → user clicks Set AUTO → Start Mission
  → COMMAND_LONG MAV_CMD_MISSION_START
```

Key invariants (don't break):
- ArduPilot Copter AUTO **requires** TAKEOFF (cmd=22) immediately after the auto-injected HOME.
- HOME inject only happens for `MISSION` type; **never** for FENCE or RALLY (`mission_manager.py:213-215`).
- `mission_type_value` passed on EVERY MAVLink frame so 4.x firmware doesn't get confused (`mission_manager.py:211, 237, 266-273`).

---

## 3. FENCE

### 3.1 Current end-to-end flow

```
User selects FENCE from mission-type dropdown
  → useMissionStore.setMissionType('FENCE')
  → store swaps waypoints buffer to _fenceSaved slot (per-type isolation)
User picks Inclusion (5001) or Exclusion (5002) via radio
  → fencePolygonMode = 'INCLUSION' | 'EXCLUSION'
User clicks map / right-clicks → Insert Fence Vertex
  → addWaypoint(lat, lng, alt=0) — alt forced to 0 for fence
  → command = 5001 or 5002 based on mode
User can switch radio mid-draw → consecutive vertices of new type form a new group
  → mapShared.buildFenceGroups() walks the list, breaks on cmd change
Render:
  - waypoints with cmd==5001 → green polygon fill+outline
  - cmd==5002 → red
  - <3 pts → dashed LineString preview (no fill yet)
User clicks WRITE
  → FlightPlanner.buildMissionItemsForType() rebuilds:
    - group by polygon (cmd id), assign param1 = #vertices in THAT group (matches MP)
    - frame = 0 (MAV_FRAME_GLOBAL)
    - alt = 0
  → POST /api/fence/upload
  → mission_manager.upload_mission(items, "FENCE")
  → MISSION_TYPE_FENCE in every MAVLink frame
User opens Fence Config row → Enable / Action / Alt Max / Alt Min / Radius / Margin
  → POST /api/fence/config
  → param_manager.set_parameter_verified() in fixed order:
    1. FENCE_ACTION   2. FENCE_ALT_MAX   3. FENCE_ALT_MIN
    4. FENCE_RADIUS   5. FENCE_MARGIN    6. FENCE_ENABLE last
  → /api/fence/status poll every 2.5s, fills form (only when not dirty)
```

### 3.2 What works

- ✅ Modern MISSION_TYPE_FENCE protocol (not the legacy FENCE_TOTAL+setFencePoint).
- ✅ Multi-polygon: inclusion + exclusion in the same upload, grouped correctly (`utils/mapShared.js:40-53`, mirrors MP `Fence.cs:24-88`).
- ✅ Per-polygon `param1` (vertex count of THAT polygon) — required by ArduPilot, matches `Fence.cs:114-124`.
- ✅ MARGIN < RADIUS guard both client and server side (`FlightPlanner.jsx:393`, `main.py:328`).
- ✅ Parameter write order avoids transient invalid state.

### 3.3 What's broken or missing

#### A. `FENCE_TYPE` is never written
- Bitmask: `1=alt-max  2=circle  4=polygon  8=alt-min`.
- We rely on the autopilot default (Copter = 7). If the user previously ran a Plane build or zeroed FENCE_TYPE in Setup → Parameters, polygons are uploaded but **not enforced**.
- And: with `FENCE_TYPE & 2 == 2`, the **circular** fence is ALSO active at `FENCE_RADIUS` (default 300 m on Copter, but often left at whatever the previous user set). A waypoint farther than `FENCE_RADIUS` from arm-HOME breaches even though the polygon doesn't.
- **Fix**: add FENCE_TYPE to Fence Config form (multi-checkbox or numeric bitmask), write it before FENCE_ENABLE.

#### B. `FENCE_STATUS` MAVLink message is not handled
- The autopilot streams `FENCE_STATUS { breach_status, breach_type, breach_count, breach_time, breach_mitigation }` at 1 Hz when armed.
- `python_service/message_handlers.py:163` only handles STATUSTEXT; FENCE_STATUS falls through to a no-op.
- **Fix**: add `FENCE_STATUS` handler → push into `vehicle_state.fence_status` dataclass → bubble via `to_dict()` → consume in FlightPlanner status panel.

#### C. STATUSTEXT fence breach lines are buried
- ArduPilot emits human strings: `"Fence Breach Polygon"`, `"Fence Breach Circle"`, `"Fence Breach Alt Max"`.
- They land in `state.status_messages` but the Fence tab never shows them.
- **Fix**: filter the last `status_messages` by `/fence|breach/i`, show the most recent in the Fence Config row.

#### D. No preflight validation against fence geometry
- We never check:
  - HOME position is inside the inclusion polygon
  - HOME position is outside every exclusion polygon
  - Each mission waypoint lies inside the union(inclusion) \ union(exclusion)
  - Mission altitudes ≤ FENCE_ALT_MAX, ≥ FENCE_ALT_MIN
  - Mission waypoints within FENCE_RADIUS of HOME (when circle bit set)
- **Fix**: implement ray-casting `pointInPolygon()` (frontend), surface as Fence preflight panel.

#### E. Diagnostics panel missing
- Required by the brief:
  - Fence Enabled (param)
  - Fence Active (FENCE_STATUS msg)
  - Inside Inclusion YES/NO (computed client-side from current GPS + polygon)
  - Inside Exclusion YES/NO (computed)
  - Fence Breach YES/NO (FENCE_STATUS.breach_status > 0)
  - Breach Reason (FENCE_STATUS.breach_type + last matching STATUSTEXT)
  - Triggered Action (FENCE_ACTION param value, label)
- **Fix**: new collapsible panel in FlightPlanner.jsx (`<FenceDiagnostics />`), visible when missionType=='FENCE'.

#### F. No fence-circle support
- MP supports `FENCE_CIRCLE_INCLUSION` (5003) and `FENCE_CIRCLE_EXCLUSION` (5004) — single point + radius.
- We only do polygons.
- **Lower priority**, but mention in the centralised doc.

### 3.4 Probable root cause: AUTO → RTL after takeoff

Ordered by likelihood:

1. **Circular fence breach** (HIGH). `FENCE_TYPE` defaults to 7 → circle is active at whatever `FENCE_RADIUS` happens to be (we never set it via Apply Config unless the user types a number, and the default Copter SITL value is 300 m, but a previously-flown SITL may have 30 m or 50 m stored). The first NAV_WAYPOINT after TAKEOFF is N metres from HOME; if N > FENCE_RADIUS, breach → FENCE_ACTION=1 → RTL.
   - **Test**: read `FENCE_RADIUS` after Apply Config; warn if any mission WP distance > FENCE_RADIUS.
2. **HOME-outside-polygon** (HIGH). The user "sets home" in the Simulation page (17.456979, 78.372855) before draw. If SITL was started before that home edit, the actual ArduPilot HOME is wherever sim_vehicle defaulted (Mission Planner default `-35.36, 149.16` — Canberra). User then draws the polygon over Hyderabad on the map, but the vehicle in SITL is in Canberra → instantly outside polygon → RTL.
   - **Test**: server-side, after Apply Config, compare `vehicle.home.lat/lng` against polygon bounding box; warn the UI.
3. **HOME-inside-exclusion** (MEDIUM). If the user drew an exclusion polygon over HOME (e.g., a "no-fly building" centered on home), the vehicle is instantly in breach.
4. **Stale fence from previous SITL session** (MEDIUM). MP has a "Clear" button that writes `FENCE_TOTAL=0` and `FENCE_ENABLE=0`. We don't expose "clear onboard fence".

### 3.5 Fix plan (concrete)

| Step | File | Change |
|------|------|--------|
| 1 | `python_service/vehicle_state.py` | Add `FenceStatus` dataclass + field in `VehicleState`; expose in `to_dict()`. |
| 2 | `python_service/message_handlers.py` | Add `elif msg_type == 'FENCE_STATUS':` handler. |
| 3 | `python_service/main.py` `/fence/config` | Accept optional `fence_type` int; write `FENCE_TYPE` between `FENCE_MARGIN` and `FENCE_ENABLE`. |
| 4 | `python_service/main.py` `/fence/status` | Include `fence_status` from vehicle_state; current GPS lat/lng; current home. |
| 5 | `frontend/src/utils/geometry.js` *(new)* | `pointInPolygon(lat, lng, polygon)` ray-casting. |
| 6 | `frontend/src/pages/FlightPlanner.jsx` | New `<FenceDiagnostics />` panel; preflight validation rendered when missionType=='FENCE'; FENCE_TYPE checkboxes in config form. |
| 7 | `frontend/src/components/MapEditor.jsx` | Highlight breached polygon in pulsing red; show diff between drawn-but-unwritten polygons. |
| 8 | `node_api/server.js` | No change (transparent proxy). |

---

## 4. SURVEY GRID

### 4.1 Current state

`utils/surveyGrid.js:buildSurveyWaypoints` makes a **rectangular** lawnmower:
- Inputs: center lat/lng, width m, length m, heading deg (from north, CW), `lineSpacingM`, `alongSpacingM`, `altitudeM`, `command` (16 or 82).
- Algorithm:
  - Stripes across width every `lineSpacingM`.
  - Along each stripe, sample at `alongSpacingM`.
  - Alternate direction per stripe (true lawnmower).
  - Reproject (east, north) metres → lat/lng with flat-earth approximation.
  - Hard cap at 450 WPs, decimates if exceeded.
- `SurveyGridPanel.jsx` UI:
  - Camera overlap mode: single overlap %, sensor width mm, focal length mm → swath, GSD readout.
  - Checkboxes: Spline (cmd 82), Prepend TAKEOFF (cmd 22), Append RTL (cmd 20).
  - Buttons: Cancel / Append grid / Replace mission.

### 4.2 What's wrong

1. **TAKEOFF position bug** — `SurveyGridPanel.jsx:88-92` places TAKEOFF at the first grid corner, not at HOME. Copter ignores lat/lng on TAKEOFF (climbs vertically), so this is harmless on the autopilot — but visually the WP table shows TAKEOFF off in the corner, which is misleading and breaks the `seq 0 == TAKEOFF at HOME` mental model.
2. **No CAM_TRIGG_DIST** — MP `GridUI.cs:1812` inserts `DO_SET_CAM_TRIGG_DIST` (cmd 206) at the start of the grid to trigger photos; we don't.
3. **No DO_CHANGE_SPEED** — survey usually wants a different cruise speed (`WPNAV_SPEED` is typically too cautious). MP exposes a speed field.
4. **No polygon-fill mode** — MP `Grid.cs:CreateGrid(polygon, ...)` fills any polygon; we only fill a rectangle.
5. **Single overlap %, not fwd+side** — MP uses `overlap` (forward, controls along-spacing) and `sidelap` (cross, controls line spacing).
6. **No lead-in / overshoot** — MP runs each line a few metres past the polygon edge so the camera has a stable shot at the boundary; we don't.
7. **No grid preview on the map** before commit.
8. **No estimated photo count / flight time**.

### 4.3 Why the user sees "wrong mission execution"

- Without CAM_TRIGG_DIST: photos never trigger → user assumes survey "didn't work".
- Without DO_CHANGE_SPEED: vehicle creeps at default speed → user assumes it's stuck.
- TAKEOFF at corner: WP table looks scrambled — but flight itself is correct.
- If a fence is active **and the grid extends past FENCE_RADIUS**: breach → RTL mid-survey.

### 4.4 Fix plan

| Step | File | Change |
|------|------|--------|
| 1 | `frontend/src/components/SurveyGridPanel.jsx` | TAKEOFF uses HOME lat/lng when available (fallback: vehicle current, fallback: first grid pt). |
| 2 | `frontend/src/components/SurveyGridPanel.jsx` | Add "Trigger camera every (m)" → emit `CAM_TRIGG_DIST` as first WP after TAKEOFF. |
| 3 | `frontend/src/components/SurveyGridPanel.jsx` | Add "Survey speed (m/s)" → emit `DO_CHANGE_SPEED`. |
| 4 | `frontend/src/utils/surveyGrid.js` | Add `buildPolygonSurveyWaypoints(polygon, opts)` — see PLAN_TAB_IMP.md §4.1 STEP 1. Uses MP-style "long-axis" heading auto-pick. |
| 5 | `frontend/src/components/SurveyGridPanel.jsx` | Split overlap into `forwardOverlap` and `sidelap`; recompute alongSpacing AND lineSpacing. |
| 6 | `frontend/src/components/SurveyGridPanel.jsx` | Compute "Estimated photos: N" + "Estimated time: M min" (length_total / speed). |

---

## 5. MAP / AUTOPAN

### 5.1 Current state

- `MapEditor.jsx` opens with last persisted center/zoom (`utils/mapPreferences.js`).
- One-shot geolocation request on mount, jumpTo if granted.
- Drone marker auto-follows the vehicle position (re-`setLngLat`) but **does not pan the map**.
- Home marker is added/removed when HOME changes, no pan.

### 5.2 What's missing (per brief)

```
RULE 1  if HOME valid → centre on HOME
RULE 2  else if vehicle position valid → centre on vehicle
RULE 3  AutoPan toggle button:
         ON  → centre follows HOME/vehicle as they change
         OFF → free pan, no auto recentre
RULE 4  When HOME changes, re-centre immediately (only when AutoPan ON)
Do not break: mission overlays, fence draw, grid gen, WP edit.
```

### 5.3 Fix plan

| Step | File | Change |
|------|------|--------|
| 1 | `frontend/src/components/MapEditor.jsx` | Add `autoPan` boolean state (persist in `mapPreferences`, default ON). |
| 2 | `MapEditor.jsx` | New effect: when `autoPan && (vehicleHome || vehicleMapState?.position)` changes, `map.easeTo({ center, duration: 350, essential: true })`. Track a `lastFollowSig` to avoid panning when only zoom changes. |
| 3 | `MapEditor.jsx` | Toggle button in the existing `NavigationControl` area (top-right) — `<button>` with a crosshair icon, active state highlighted. |
| 4 | `MapEditor.jsx` | When user drags the map manually (`map.on('dragstart')`), set `autoPan=false` automatically. (Pattern: MP keeps following until user pans, then stops; explicit toggle re-enables.) |
| 5 | `utils/mapPreferences.js` | Persist `autoPan`. |
| 6 | (optional) `MapView.jsx` (Data tab) | Same change for parity — extract `useAutoPan()` hook in `utils/mapShared.js` so both maps share the logic. |

---

## 6. MAVLINK PROTOCOL REFERENCE (fence-relevant)

### Commands

| MAV_CMD                                    | id   | Used? | Notes |
|--------------------------------------------|------|-------|-------|
| FENCE_RETURN_POINT                         | 5000 | ✗     | Single return point; MP `Fence.cs:79` |
| FENCE_POLYGON_VERTEX_INCLUSION             | 5001 | ✓     | param1 = total vertices in this polygon |
| FENCE_POLYGON_VERTEX_EXCLUSION             | 5002 | ✓     | same |
| FENCE_CIRCLE_INCLUSION                     | 5003 | ✗     | param1 = radius |
| FENCE_CIRCLE_EXCLUSION                     | 5004 | ✗     | param1 = radius |

### Params (ArduCopter)

| Param            | Default | Meaning |
|------------------|---------|---------|
| FENCE_ENABLE     | 0       | 0=off, 1=on |
| FENCE_TYPE       | 7       | bitmask: 1=altmax 2=circle 4=polygon 8=altmin |
| FENCE_ACTION     | 1       | 0=Report 1=RTL 2=Land 3=Brake 4=SmartRTL |
| FENCE_ALT_MAX    | 100     | metres |
| FENCE_ALT_MIN    | -10     | metres |
| FENCE_RADIUS     | 300     | metres (circle fence) |
| FENCE_MARGIN     | 2       | metres; must be < RADIUS |
| FENCE_TOTAL      | r/o     | autopilot computes from uploaded list (modern protocol) |
| FENCE_RET_RALLY  | 0       | 0=Home 1=Nearest rally on breach return |
| FENCE_RET_ALT    | 0       | breach return altitude |

### Messages

| MAVLink message | Fields | Currently handled? |
|-----------------|--------|--------------------|
| FENCE_STATUS    | breach_status, breach_type (0=none, 1=minalt, 2=maxalt, 3=boundary), breach_count, breach_time, breach_mitigation | ✗ |
| STATUSTEXT      | severity, text — fence msgs: "Fence Breach Polygon", "Fence Breach Circle", "Fence Breach Alt Max", "Fence Breach Alt Min", "Fence Disabled" | ✓ stored, ✗ not surfaced on fence tab |

---

## 7. IMPLEMENTATION ORDER

Smallest blast radius first, biggest user-visible win.

### Phase A — Diagnostics (3 small commits, mostly additive)
A1. `vehicle_state.py` + `message_handlers.py`: add FENCE_STATUS handler.
A2. `main.py /fence/status`: include `fence_status` + recent fence STATUSTEXT lines + computed inside/outside (server-side has GPS, fence is downloadable, can compute).
A3. `FlightPlanner.jsx`: render the diagnostics panel when missionType=='FENCE'.

### Phase B — Fence preflight + FENCE_TYPE
B1. `utils/geometry.js`: add `pointInPolygon`.
B2. `FlightPlanner.jsx`: HOME/WP-inside checks; FENCE_TYPE bitmask in config form.
B3. `main.py /fence/config`: write FENCE_TYPE.

### Phase C — Map AutoPan
C1. `mapShared.js`: extract `useAutoPan(map, { home, vehicle, enabled })` hook.
C2. `MapEditor.jsx`: consume hook, add toggle.
C3. (optional) `MapView.jsx`: consume hook (Data tab parity).

### Phase D — Survey Grid fixes
D1. `SurveyGridPanel.jsx`: TAKEOFF at HOME, add CAM_TRIGG_DIST + DO_CHANGE_SPEED.
D2. `surveyGrid.js`: polygon-fill mode.
D3. `SurveyGridPanel.jsx`: split overlap/sidelap.

---

## 8. VALIDATION MATRIX

After each phase, verify these test cases:

| Case                                                        | Expected |
|-------------------------------------------------------------|----------|
| Draw 4-point inclusion polygon over HOME, write fence       | Toolbar shows "Incl(4pts)", upload OK |
| Apply config Enable + RTL + AltMax 120, then read params    | Status shows ENABLED, Action 1, alt 120 |
| Mission with WP 50m from HOME inside fence, FENCE_RADIUS≥100 | Mission runs to completion |
| Mission with WP 500m from HOME, FENCE_RADIUS=300            | Diagnostics panel WARNS pre-arm; breach panel lights up post-arm |
| HOME outside inclusion polygon                              | Diagnostics WARNS "HOME outside inclusion" pre-arm |
| Exclusion polygon over HOME                                 | Diagnostics WARNS "HOME inside exclusion" pre-arm |
| Toggle AutoPan, then change HOME via right-click set-home   | Map recentres on new HOME |
| Drag the map manually                                       | AutoPan auto-disables; toggle button shows OFF |
| Run survey grid with CAM_TRIGG_DIST=5m                      | Mission contains cmd 206 with param1=5 after TAKEOFF |
| Survey with DO_CHANGE_SPEED=10                              | Mission contains cmd 178 with param2=10 |

---

## 9. USER INSTRUCTIONS

### 9.1 How to fly a MISSION (reference — already working)

1. Open **Simulation** page.
2. Set Home: `17.456979, 78.372855, 50, 0` (or your location).
3. Click **Reset Simulation** → **Start Simulation**. Wait for the EKF to settle (≈ 10 s).
4. Open **Flight Planner**.
5. Dropdown: ensure **MISSION** is selected.
6. Click on the map to add waypoints. First click should be where you want **TAKEOFF**.
7. In the WP table, change the cmd of the first row to **TAKEOFF (22)** and set its alt (e.g. 10 m). If you forget, the toolbar shows a red **⚠ Insert TAKEOFF** button — click it.
8. Add more **NAV_WAYPOINT (16)** rows (alt e.g. 50 m).
9. End with **RTL (20)** or **LAND (21)**.
10. Click **Write**.
11. Open **Flight Data → Actions** → **ARM** (or use Actions tab ARM).
12. Back in Flight Planner: **Set AUTO** → **Start Mission**.
13. Watch the green-highlighted active waypoint move through the table.

### 9.2 How to set up a FENCE — CORRECT ORDER

> **Critical**: the SITL home (Simulation page) and the polygon you draw on the map must be the **same location**. If you set home to Hyderabad but the SITL was started with the default Canberra home, your polygon will be on the wrong continent.

**Part A — start clean**
1. **Simulation** page → set Home `17.456979, 78.372855, 50, 0` → **Reset Simulation** → **Start Simulation**. Wait for EKF.
2. (Optional but recommended) **Setup → Parameters**: look up `FENCE_ENABLE`. If it's 1 from a previous run, set to 0 first. Look up `FENCE_RADIUS` — if it's a small leftover (< 200 m) AND your mission stretches farther, bump it now or expect a breach.

**Part B — draw the inclusion**
3. **Flight Planner** → mission-type dropdown → **FENCE**.
4. Polygon radio: select **Inclusion (5001)**.
5. Click on the map around your intended flight area. Minimum 3 points. The toolbar shows `Incl(Npts)`.
6. (Optional) Switch the radio to **Exclusion (5002)**, then draw a small no-fly polygon inside the inclusion. Toolbar will show `Incl(4pts) + Excl(3pts)`.

**Part C — upload the polygon list**
7. Click **Write**. Wait for `FENCE uploaded successfully!` and the XFER counter to show `DONE`.

**Part D — configure runtime behaviour** (the param row at the bottom of the toolbar)
8. ☑ **Enable**.
9. **Action** → **RTL**.
10. **Alt Max** → e.g. **120**.
11. **Alt Min** → leave at **0**.
12. **Radius** → set to a value larger than your mission's farthest WP from HOME. If unsure: 500.
13. **Margin** → leave at **2** (must be less than Radius).
14. Click **Apply Fence Config**. Wait for `Fence configuration applied.`.

**Part E — verify**
15. The toolbar status should read `Fence: ENABLED | Action: 1 | Incl(4pts)`.
16. (Once diagnostics panel ships) Check: HOME inside inclusion = YES, HOME outside exclusion = YES, all mission WPs inside = YES.

**Part F — fly the mission**
17. Switch mission-type to **MISSION**.
18. Draw your mission **inside** the inclusion polygon, **outside** any exclusion polygon, **below** Alt Max.
19. **Write**.
20. **Flight Data → ARM** → back to planner → **Set AUTO** → **Start Mission**.

**If AUTO → RTL happens immediately:**
- Read STATUSTEXT (Flight Data → Messages) for "Fence Breach …".
- "Fence Breach Polygon" → vehicle is outside inclusion (or inside exclusion). Likely the SITL home didn't match where you drew.
- "Fence Breach Circle" → mission WP farther than FENCE_RADIUS from HOME. Increase RADIUS.
- "Fence Breach Alt Max" → reduce mission altitudes below FENCE_ALT_MAX.

### 9.3 How to use SURVEY GRID

1. **Flight Planner** → mission-type **MISSION**.
2. Right-click the map at the **center of your survey area** → **Survey grid…** (or click the **Survey grid** button in the toolbar — it will default to home).
3. In the modal:
   - **Center lat / lng** — pre-filled from your right-click.
   - **Width / Length** — survey footprint in metres.
   - **Heading** — direction of the flight lines (0 = north).
   - **Altitude** — flight altitude (relative).
   - **Along spacing** — distance between consecutive WPs on a stripe (smaller = more accurate, more WPs).
   - **Line spacing** — distance between parallel stripes.
4. (Optional) ☑ **Camera overlap mode** → enter overlap %, sensor width mm, focal length mm. The line spacing is now auto-computed from camera FOV at altitude.
5. Options:
   - ☑ **Prepend TAKEOFF** (recommended).
   - ☑ **Append RTL** (recommended).
   - ☑ **Spline WPs** for smoother turns.
6. Click **Replace mission** to wipe the current mission and use the grid, or **Append grid** to add it after existing WPs.
7. Inspect the WP table — make sure WP 0 is TAKEOFF and the last is RTL.
8. **Write** → ARM → **Set AUTO** → **Start Mission**.

> **Currently missing (planned)**: Camera trigger (CAM_TRIGG_DIST), DO_CHANGE_SPEED, polygon-fill mode, separate forward overlap vs sidelap. Until these ship, take photos manually from the Video tab or set up CAM_TRIGG_DIST in Setup → Parameters.

---

## 10. CHANGE LOG OF THIS DOC

- 2026-05-24 — initial centralisation. Consolidates `PLAN_TAB_IMP.md`, `imp.md` runbook, `MISSION_ENGINE.md`, `mission-map-flow.md`, and Mission Planner reference (`MissionPlanner/ExtLibs/ArduPilot/Fence.cs`, `MissionPlanner/GCSViews/FlightPlanner.cs`, `MissionPlanner/Grid/GridUI.cs`).
