# MASTER FLIGHT PLANNER DOCUMENT
**Status**: Production. Last updated: 2026-05-27.
**Scope**: Everything about the Flight Planner tab — Mission, Fence, Survey Grid, Map/AutoPan, and mission execution debugging.
**Supersedes**: `FLIGHT_PLANNER_CENTRALIZED.md`, `FLIGHT_PLANNER_MISSION_CENTRALIZED.md`, `FLIGHT_PLANNER_AUDIT_TABLE.md`, `FLIGHT_PLANNER_MISSION_AUDIT_TABLE.md`, `MISSION_AUTO_START_ROOT_CAUSE.md`, `PREMATURE_RTL_ROOT_CAUSE.md`, `try.md`, `FLIGHT_PLANNER_USER_GUIDE.md`, `PLAN_TAB_IMP.md`, `MISSION_ENGINE.md`, `MISSION_MIGRATION_NOTES.md`, `mission-map-flow.md`, `mission-sync-flow.md`

---

## TABLE OF CONTENTS

1. [Architecture Overview](#1-architecture-overview)
2. [Mission — End-to-End Flow](#2-mission--end-to-end-flow)
3. [Mission — MAVLink Protocol](#3-mission--mavlink-protocol)
4. [Mission — Validation Rules](#4-mission--validation-rules)
5. [Fence — Protocol & Upload](#5-fence--protocol--upload)
6. [Fence — Diagnostics & Params](#6-fence--diagnostics--params)
7. [Survey Grid](#7-survey-grid)
8. [Map / AutoPan](#8-map--autopan)
9. [Root Cause: WP Counter Jumps 0→1 on Set AUTO](#9-root-cause-wp-counter-jumps-01-on-set-auto)
10. [Root Cause: Premature RTL](#10-root-cause-premature-rtl)
11. [Regression Audit (2026-05-25)](#11-regression-audit-2026-05-25)
12. [Mission Planner Parity Matrix](#12-mission-planner-parity-matrix)
13. [Open Issues & Follow-ups](#13-open-issues--follow-ups)
14. [User Operator Guide](#14-user-operator-guide)

---

## 1. ARCHITECTURE OVERVIEW

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Frontend (React)                                                        │
│  pages/FlightPlanner.jsx  — toolbar, mode select, fence/mission ctrl     │
│  components/MapEditor.jsx — map, click-to-add, right-click menu         │
│  components/SurveyGridPanel.jsx — survey config modal                   │
│  components/WaypointTable.jsx — table editor                            │
│  store/useMissionStore.js — waypoints[], missionType, fencePolygonMode  │
│  utils/surveyGrid.js — lawnmower generator                              │
│  utils/mapShared.js — heading, fence groups, home marker                │
└──────────────────┬───────────────────────────────────────────────────────┘
                   │ HTTP (axios) :8080
                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Node API (Express) — node_api/server.js                                  │
│  Thin proxy to Python: /api/fence/* /api/mission/*                       │
└──────────────────┬───────────────────────────────────────────────────────┘
                   │ HTTP :8000
                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Python service (FastAPI)                                                 │
│  main.py — REST endpoints                                                 │
│  mission_manager.py — MAVLink mission protocol (upload/download)          │
│  mavlink_link.py — pymavlink connection, message dispatch                 │
│  message_handlers.py — per-msg-type → vehicle_state mutations             │
│  vehicle_state.py — central state object                                  │
└──────────────────┬───────────────────────────────────────────────────────┘
                   │ MAVLink (UDP 14550)
                   ▼
                ArduPilot SITL / vehicle
```

Key invariants:
- Commands never reach pymavlink from the frontend directly — always Frontend → Node API → Python → pymavlink.
- `VehicleState` is the sole authoritative model in Python. `useMissionStore` is the sole mission state in React.

---

## 2. MISSION — END-TO-END FLOW

### 2.1 Frontend → Wire Sequence

```
User clicks map → useMissionStore.addWaypoint(lat, lng, alt=50)
User right-click → "Insert TAKEOFF / RTL / LAND / LOITER / SPLINE WP / DO_*"
  → insertWaypointAt(idx, { command, lat, lng, alt })
  → useMissionStore._reindex re-numbers seq from 0

User clicks WRITE
  → blockingErrors(waypoints, missionType) — hard stop if fails
  → POST /api/mission/upload { items: [...] }
  → mission_manager.upload_mission(items, "MISSION")
  → _inject_home() prepends seq=0 HOME (frame=0, cmd=16, lat/lng/alt from vehicle.home)
  → MAVLink protocol:
       MISSION_COUNT(N+1, MISSION_TYPE_MISSION)
        ↓ loop MISSION_REQUEST_INT(seq) → MISSION_ITEM_INT(seq, ...)
        ↓ MISSION_ACK(ACCEPTED, MISSION_TYPE_MISSION)
  → transfer_status: IDLE → SENDING_COUNT → UPLOADING_ITEMS → DONE

ARM → POST /api/command/arm → command_long(400, p1=1) → 10 s ACK timeout

Set AUTO → POST /api/mode { mode: "AUTO" } → set_mode_send (no ACK wait, mode confirmed via HEARTBEAT)

Start Mission → sendShortcutCommand("mission_start") → command_long(300, p1=0, p2=0)
  → ArduPilot: "start from seq 1, run to end"
  → MISSION_CURRENT advances as each NAV item completes
  → final RTL/LAND: ArduPilot autoswitches AUTO → RTL/LAND (normal end)
```

### 2.2 Hard Invariants (never break)

| # | Invariant | Enforced at | Why |
|---|-----------|-------------|-----|
| I1 | TAKEOFF (cmd 22) is the first user item | `FlightPlanner.jsx:blockingErrors` | ArduCopter AUTO init: "Auto: Missing Takeoff Cmd" |
| I2 | HOME at seq=0 is injected by Python, never sent by frontend | `mission_manager._inject_home` | MP convention; firmware expects seq 0 = HOME |
| I3 | `mission_type_value` sent on every MAVLink frame | `mission_manager.upload_mission` | 4.x disambiguates mission/fence/rally on same wire |
| I4 | HOME injection only for MISSION; never FENCE/RALLY | `mission_manager.upload_mission` (guarded by `if mission_type == "MISSION"`) | Fence has no HOME concept; injecting it corrupts the polygon list |
| I5 | Lat/lng sent as scaled int32 in MISSION_ITEM_INT (×1e7) | `mission_manager.upload_mission:271` | MAVLink2 spec |
| I6 | Validation messages split: `warnings` (amber) and `infos` (blue) | `FlightPlanner.jsx:validateMission` | "Last item is RTL" is expected, not a warning |
| I7 | `canStartMission` requires armed && AUTO && hasTakeoffCmd && wps>0 | `FlightPlanner.jsx:617` | Prevents premature mission_start |
| I8 | INVALID_SEQUENCE ACKs drained inline; only re-send on genuine timeout | `mission_manager.upload_mission:274-304` | ArduPilot often sends both ACK and REQUEST for same item |
| I9 | Mode set via `set_mode_send(custom_mode)`, not `command_long(176)` | `mavlink_link.set_mode` | Matches MP `MAVLinkInterface.setMode` |

### 2.3 Upload Payload Shape

```jsonc
POST /api/mission/upload
{
  "items": [
    { "seq": 0, "frame": 3, "command": 22,  "lat": 17.456979, "lng": 78.372855, "alt": 10 },  // TAKEOFF
    { "seq": 1, "frame": 3, "command": 16,  "lat": 17.4580,   "lng": 78.3740,   "alt": 50 },  // WP1
    { "seq": 2, "frame": 3, "command": 16,  "lat": 17.4590,   "lng": 78.3750,   "alt": 50 },  // WP2
    { "seq": 3, "frame": 3, "command": 20,  "lat": 17.456979, "lng": 78.372855, "alt": 50 }   // RTL
  ],
  "mission_type": "MISSION"
}
```

Python prepends HOME before upload:
```
[ { "seq": 0, "frame": 0, "command": 16, HOME_lat, HOME_lng, HOME_alt },   // injected
  { "seq": 1, "frame": 3, "command": 22, ... },  // TAKEOFF
  { "seq": 2, "frame": 3, "command": 16, ... },  // WP1
  { "seq": 3, "frame": 3, "command": 16, ... },  // WP2
  { "seq": 4, "frame": 3, "command": 20, ... }   // RTL
]
```

---

## 3. MISSION — MAVLINK PROTOCOL

### 3.1 Upload Sequence

| Step | Direction | Message | Key Fields |
|------|-----------|---------|------------|
| 1 | GCS → Vehicle | `MISSION_COUNT` | `count=N+1` (incl HOME), `mission_type=0` |
| 2 | Vehicle → GCS | `MISSION_REQUEST_INT` | `seq=0`, `mission_type` |
| 3 | GCS → Vehicle | `MISSION_ITEM_INT` | `seq=0`, `frame=0`, `cmd=16`, `lat×1e7`, `lng×1e7`, `alt` (HOME) |
| 4 | repeat | `MISSION_REQUEST_INT(k)` → `MISSION_ITEM_INT(k)` | — |
| 5 | Vehicle → GCS | `MISSION_ACK` | `type=MAV_MISSION_ACCEPTED(0)`, `mission_type` |

### 3.2 Transfer Status Phases

| Phase | Meaning |
|-------|---------|
| `IDLE` | No transfer in progress |
| `SENDING_COUNT` | Sent MISSION_COUNT, waiting for first REQUEST |
| `UPLOADING_ITEMS` | Mid-upload; `current/total` is live |
| `REQUESTING_LIST` | Sent MISSION_REQUEST_LIST (download) |
| `DOWNLOADING_ITEMS` | Mid-download |
| `DONE` | Last ACK was ACCEPTED |
| `FAILED` | `validation_failed` / `no_connection` / `item_timeout` / `ack_rejected` |

### 3.3 Mission Commands Accepted

| ID | Name | Notes |
|----|------|-------|
| 16 | NAV_WAYPOINT | Default for map left-click |
| 17 | LOITER_UNLIM | Right-click menu |
| 18 | LOITER_TURNS | p1 = turns |
| 19 | LOITER_TIME | p1 = seconds |
| 20 | RTL | Last item — triggers AUTO→RTL |
| 21 | LAND | Last item — triggers AUTO→LAND |
| 22 | TAKEOFF | **Must** be first user item |
| 82 | SPLINE_WP | Smooth turns |
| 93 | DELAY | Wait at WP |
| 115 | DO_CHANGE_SPEED | Survey use |
| 177 | DO_JUMP | Loops |
| 178 | DO_CHANGE_SPEED (alias) | Survey |
| 201 | DO_SET_ROI | Gimbal point-of-interest |
| 206 | CAM_TRIGG_DIST | Survey camera trigger |

---

## 4. MISSION — VALIDATION RULES

### 4.1 blockingErrors() — Hard Refuse (Write is blocked)

| Check | Trigger |
|-------|---------|
| Mission is empty | MISSION mode and `cmds.length === 0` |
| No TAKEOFF command | `!cmds.includes(22)` |
| First item not TAKEOFF | `cmds[0] !== 22` |
| HOME not valid | `missionType === 'MISSION' && !vehicle?.home?.valid` (M4 fix) |

### 4.2 validateMission() — Soft Checks

| → warnings (amber) | Trigger |
|--------------------|---------|
| No RTL/LAND at end | `!cmds.some(c => c===20 || c===21)` |
| Large mission | `> 500 waypoints` |
| Zero coordinates | Some WP has `!lat && !lng` |

| → infos (blue) | Trigger |
|----------------|---------|
| Last item is RTL | `cmds.at(-1) === 20` — this is **normal end-of-mission, not a warning** |
| Last item is LAND | `cmds.at(-1) === 21` |

### 4.3 preflightChecks (color chips in mission control row)

```js
[ 'Connected', 'GPS lock', 'Home set', 'TAKEOFF cmd', 'Waypoints', 'Armed', 'AUTO mode',
  'HOME in fence', 'WPs in fence', 'Alt < AltMax' ]
```

`canStartMission = !loading && waypoints>0 && armed && inAutoMode && hasTakeoffCmd`

---

## 5. FENCE — PROTOCOL & UPLOAD

### 5.1 End-to-End Flow

```
User selects FENCE → useMissionStore.setMissionType('FENCE')
  → swaps waypoints buffer to _fenceSaved slot
User picks Inclusion (5001) or Exclusion (5002) via radio
User clicks map / right-clicks → Insert Fence Vertex
  → addWaypoint(lat, lng, alt=0) — alt forced to 0 for fence
  → command = 5001 or 5002 based on fencePolygonMode
User clicks WRITE
  → buildMissionItemsForType():
    - group by polygon (cmd), param1 = #vertices in THAT group
    - frame = 0 (MAV_FRAME_GLOBAL), alt = 0
  → POST /api/fence/upload
  → mission_manager.upload_mission(items, "FENCE")
  → MISSION_TYPE_FENCE on every MAVLink frame
```

### 5.2 Polygon Encoding (MP Fence.cs parity)

```
Each polygon = N items where:
  command = 5001 (inclusion) or 5002 (exclusion)
  param1  = N  (total vertices in THIS polygon)
  frame   = 0  (MAV_FRAME_GLOBAL)
  alt     = 0  (ignored by autopilot)

Example: Inclusion(4pts) + Exclusion(3pts) = 7 items:
  Item 0: cmd=5001, param1=4, lat=..., lng=...   ← inclusion vertex 1/4
  Item 1: cmd=5001, param1=4, lat=..., lng=...   ← inclusion vertex 2/4
  Item 2: cmd=5001, param1=4, lat=..., lng=...   ← inclusion vertex 3/4
  Item 3: cmd=5001, param1=4, lat=..., lng=...   ← inclusion vertex 4/4 → polygon complete
  Item 4: cmd=5002, param1=3, lat=..., lng=...   ← exclusion vertex 1/3
  Item 5: cmd=5002, param1=3, lat=..., lng=...   ← exclusion vertex 2/3
  Item 6: cmd=5002, param1=3, lat=..., lng=...   ← exclusion vertex 3/3 → polygon complete
```

**Polygons are NOT closed** — first vertex is NOT repeated as last. ArduPilot closes using param1.

### 5.3 MAVLink Fence Commands

| MAV_CMD | ID | Used | Notes |
|---------|----|------|-------|
| FENCE_RETURN_POINT | 5000 | ✗ | Single return point |
| FENCE_POLYGON_VERTEX_INCLUSION | 5001 | ✓ | param1 = total vertices in this polygon |
| FENCE_POLYGON_VERTEX_EXCLUSION | 5002 | ✓ | same |
| FENCE_CIRCLE_INCLUSION | 5003 | ✗ | param1 = radius |
| FENCE_CIRCLE_EXCLUSION | 5004 | ✗ | param1 = radius |

### 5.4 ArduCopter Fence Parameters

| Param | Default | Meaning |
|-------|---------|---------|
| FENCE_ENABLE | 0 | 0=off, 1=on |
| FENCE_TYPE | 7 | bitmask: 1=altmax 2=circle 4=polygon 8=altmin |
| FENCE_ACTION | 1 | 0=Report 1=RTL 2=Land 3=Brake 4=SmartRTL |
| FENCE_ALT_MAX | 100 | metres |
| FENCE_ALT_MIN | -10 | metres |
| FENCE_RADIUS | 300 | metres (circle fence — **this bites even without a polygon**) |
| FENCE_MARGIN | 2 | metres; must be < RADIUS |

**Critical**: FENCE_TYPE defaults to 7 → the **circle fence** at FENCE_RADIUS is ALWAYS active unless bit 1 is cleared. If any waypoint is > FENCE_RADIUS metres from HOME, it will breach even if there is no polygon.

---

## 6. FENCE — DIAGNOSTICS & PARAMS

### 6.1 Param Write Order (prevents transient invalid state)

```
FENCE_ACTION → FENCE_ALT_MAX → FENCE_ALT_MIN → FENCE_RADIUS → FENCE_MARGIN → FENCE_TYPE → FENCE_ENABLE (last)
```

### 6.2 Clearing the Onboard Fence (CRITICAL)

The onboard fence **persists in autopilot EEPROM**. Clearing the drawn polygon on the map does NOT clear `FENCE_ENABLE`/`FENCE_TOTAL`.

To actually clear:
1. Flight Planner → mission-type dropdown → **FENCE**
2. Click **Read** (downloads onboard fence — reveals vertex count even if map shows nothing)
3. Click **Clear** → click **Write** (uploads zero vertices) → wait for `XFER DONE`
4. In fence config row: uncheck **Enable** → click **Apply Fence Config** (writes `FENCE_ENABLE=0`)
5. Confirm Fence diagnostics panel shows **Enabled = NO**

### 6.3 FENCE_STATUS MAVLink Message

ArduPilot streams `FENCE_STATUS { breach_status, breach_type, breach_count, breach_time }` when armed. Handled in `message_handlers.py` → `vehicle_state.fence_status`.

`breach_type` values: 0=none, 1=minalt, 2=maxalt, 3=boundary

### 6.4 STATUSTEXT Fence Messages

ArduPilot sends these at **NOTICE severity (5)**. The HUD toast previously filtered severity ≤4, silently dropping fence breaches. **This has been fixed** — `AdvancedHUD.jsx` now also surfaces any message containing `fence`, `breach`, or `failsafe` regardless of severity, painted red with a "FENCE" label.

Messages to watch for:
- `"Polygon fence breached"` — polygon breach
- `"Fence Breach Circle"` — FENCE_RADIUS exceeded
- `"Fence Breach Alt Max"` / `"Fence Breach Alt Min"` — altitude limits
- `"Fence breach cleared"` — breach resolved

---

## 7. SURVEY GRID

### 7.1 Current Implementation

`utils/surveyGrid.js:buildSurveyWaypoints`:
- Inputs: center lat/lng, width m, length m, heading deg, lineSpacingM, alongSpacingM, altitudeM, command (16 or 82)
- Algorithm: stripes across width every lineSpacingM, alternate direction per stripe (lawnmower)
- Hard cap: 450 WPs, decimates if exceeded

`SurveyGridPanel.jsx` options:
- Camera overlap mode: single overlap %, sensor width mm, focal length mm → swath/GSD readout
- Checkboxes: Spline (cmd 82), Prepend TAKEOFF (cmd 22), Append RTL (cmd 20)
- Buttons: Cancel / Append grid / Replace mission

### 7.2 Known Issues

| Issue | Impact | Fix Priority |
|-------|--------|-------------|
| TAKEOFF placed at first grid point, not HOME | Misleading WP table; benign on flight (Copter ignores TAKEOFF lat/lng) | Medium |
| No CAM_TRIGG_DIST (cmd 206) | Photos never auto-trigger | High |
| No DO_CHANGE_SPEED (cmd 178) | Survey runs at default WPNAV_SPEED, often too slow | Medium |
| No polygon-fill mode | Only rectangular grid | Low |
| Single overlap%, not fwd+sidelap | Less accurate grid spacing for photography | Low |
| No grid preview on map before commit | User can't see grid layout first | Low |

---

## 8. MAP / AUTOPAN

### 8.1 Current State

- `MapEditor.jsx` opens with last persisted center/zoom (`utils/mapPreferences.js`)
- One-shot geolocation request on mount
- Drone marker auto-follows the vehicle position but does NOT pan the map

### 8.2 AutoPan Implementation (shipped)

Rules:
```
RULE 1: if HOME valid → centre on HOME
RULE 2: else if vehicle position valid → centre on vehicle
RULE 3: AutoPan toggle button:
         ON  → centre follows HOME/vehicle as they change
         OFF → free pan, no auto recentre
RULE 4: When HOME changes, re-centre immediately (only when AutoPan ON)
RULE 5: When user drags the map manually → AutoPan auto-disables
```

Files: `MapEditor.jsx` (autoPan state, map drag listener), `utils/mapPreferences.js` (persist autoPan).

---

## 9. ROOT CAUSE: WP COUNTER JUMPS 0→1 ON SET AUTO

**Status**: SETTLED. Documented 2026-05-27.

### 9.1 The Report

```
Mission: 0=TAKEOFF  1=WP1  2=WP2  3=RTL (planner table)
Flow:    Write → ARM → Set AUTO
Symptom: the WP counter reads 1/4 without clicking Start Mission.
         The vehicle stays on the ground.
```

### 9.2 Root Cause: Autopilot Firmware Behavior, Not a GCS Bug

The `0→1` change is the **autopilot's own `MISSION_CURRENT`**, not anything the GCS sends.

When ArduCopter enters AUTO with a valid EKF origin, `ModeAuto` runs `mission.start_or_resume()`, which advances the mission cursor from seq 0 (HOME) to the **first NAV command (seq 1, TAKEOFF)** and emits `MISSION_CURRENT(seq=1)`.

The vehicle does NOT fly yet. Physical takeoff is gated by ArduCopter's `auto_armed` flag, which becomes true only when:
- RC throttle is raised (real vehicle), OR
- `MAV_CMD_MISSION_START` is received (our Start Mission button)

### 9.3 Verification (All Four Layers)

| Layer | File:line | What Set AUTO does |
|-------|-----------|--------------------|
| Frontend | `FlightPlanner.jsx:513 setMode()` | calls `setFlightMode(mode)` → `POST /api/mode` **only** |
| Frontend | `FlightPlanner.jsx:524 startMission()` | the **only** caller of `mission_start`; wired solely to the Start Mission button — no useEffect auto-fires it |
| Node | `server.js:344 /api/mode` | pure proxy to Python `/mode`; no command coupling |
| Python | `mavlink_link.py:584 set_mode()` | sends `set_mode_send(custom_mode)` **only** |

There is no code path in which entering AUTO sends `MAV_CMD_MISSION_START` (300).

### 9.4 Mission Planner Parity Confirmed

MP behaves **identically**:
- `CurrentState.cs:3403` → `wpno = wpcur.seq;` (maps MISSION_CURRENT straight to displayed WP, same as us)
- `CurrentState.cs:3405` → `if (mode.ToLower() == "auto" && wpno != 0) lastautowp = (int)wpno;` — MP's own code expects `wpno` to be non-zero in AUTO

Masking the seq to keep it at 0 would **diverge** from Mission Planner, not match it.

### 9.5 The Fix (Shipped)

UI-clarity only. We keep the real `MISSION_CURRENT` seq (MP parity) and add run-state labels:

```
armed=false                       → DISARMED
armed + AUTO + on ground (≤0.8m)  → HOLDING   ← the case the operator hit
armed + AUTO + airborne (>0.8m)   → RUNNING
armed + not AUTO                  → ARMED
```

| File | Change |
|------|--------|
| `FlightPlanner.jsx` | Added `missionRunState` from `armed`, `inAutoMode`, `airborne (alt_rel > 0.8m)`. Shows **"⏸ HOLDING · mission not started — click Start Mission"** when HOLDING, **"▶ RUNNING"** when airborne |
| `MissionExecutionPanel.jsx` | Added matching `holding` detection → "HOLDING · NOT STARTED" badge |

### 9.6 Canonical Execution Flow

```
WRITE                   HOME injected at seq 0 → onboard: 0=HOME 1=TAKEOFF 2=WP1 3=WP2 4=RTL
  │
ARM                     motors armed; MISSION_CURRENT = 0 → UI: WP 0/4
  │
Set AUTO                MISSION_CURRENT → 1 (TAKEOFF cursor) — UI: ⏸ HOLDING
  │                     vehicle stays on the ground (auto_armed not set yet)
  │
Start Mission           sends MAV_CMD_MISSION_START (300) → auto_armed set → UI: ▶ RUNNING
  │
TAKEOFF (seq 1)         climbs to TAKEOFF alt
  │
WP1 (seq 2) → WP2 (seq 3)  MISSION_CURRENT advances per WP reached
  │
RTL (seq 4)             AUTO→RTL; UI: "MISSION COMPLETE" (not a failsafe)
  │
land → disarm
```

---

## 10. ROOT CAUSE: PREMATURE RTL

**Status**: SETTLED. Documented 2026-05-27. Video + autopilot STATUSTEXT log confirmed.

### 10.1 The Symptom

Mission: `TAKEOFF → WP → WP → RTL` (4.16 km span). Vehicle arms, enters AUTO, climbs, flies a short distance, then switches to RTL **before reaching WP1**. WP progress never advances past seq 2.

### 10.2 Autopilot's Own Reason (Messages Tab, Confirmed)

```
[INFO]   Mission: 2 WP
[NOTICE] Polygon fence breached      ← THE TRIGGER
[INFO]   Manual recovery started
[NOTICE] Fence breach cleared
```

**`Polygon fence breached` is the cause.** A polygon fence was enabled on the vehicle; the mission flew outside it (~200 m from home), the breach fired, and the fence action (RTL) returned the vehicle.

### 10.3 Why This Was Repeatedly Mis-Diagnosed

Two GCS defects hid the autopilot's explanation:

1. **The breach message is severity NOTICE (5)**. The HUD STATUSTEXT toast only showed severity ≤ 4 (`AdvancedHUD.jsx STATUSTEXT_TOAST_SEVERITY = 4`), so `Polygon fence breached` was **filtered out and never toasted** during flight. It only existed in the Messages tab.

2. **The onboard fence persists in autopilot EEPROM**. Clearing the drawn polygon on the map does **not** clear `FENCE_TOTAL` / `FENCE_ENABLE`. The vehicle had `FENCE_ENABLE=1`, `FENCE_TOTAL=11` in its param cache — a leftover from a previous session.

### 10.4 What Was NOT the Problem (Verified)

- **Mission ordering / corruption** — upload correct. `XFER DONE 5/5`. `_inject_home` prepends HOME at seq 0 in correct order.
- **GCS-commanded RTL** — Command/ACK log shows only `arm`, `mode:AUTO`, `mission_start`. No `rtl`.
- **Battery / GPS / EKF failsafe** — at RTL moment: battery 74%, GPS RTK-Fixed 10 sats, EKF healthy.
- **WP-reached bug** — WP stayed at seq 2; it never falsely "reached" anything. RTL is external to the mission.

### 10.5 Fixes Shipped

| File | Change | Effect |
|------|--------|--------|
| `AdvancedHUD.jsx` | STATUSTEXT toast now surfaces any line containing `fence`/`breach`/`failsafe` regardless of severity, painted red with "FENCE" label | `Polygon fence breached` (NOTICE) now toasts in real time |
| `MissionExecutionPanel.jsx` | New persistent **UNPLANNED RETURN** banner: when mode is RTL/LAND/BRAKE and it's not the planned mission end, shows the autopilot's most recent fence/failsafe STATUSTEXT + the WP it happened at, with fence-clearing guidance | Operator instantly sees *why* it returned |
| `FlightData.jsx` | Passes `status_messages` + `fence_status.last_breach_text` into the panel | Feeds the banner |

### 10.6 HUD WP Numbering Inconsistency (Known, Deferred)

AdvancedHUD uses `missionSeq+1/total` (shows "3/5") while MissionExecutionPanel uses `missionSeq/total-1` (shows "2/4") for the same MISSION_CURRENT. Not the RTL cause; worth unifying in a follow-up.

---

## 11. REGRESSION AUDIT (2026-05-25)

Commit `429705f "Resolve stash conflicts after history cleanup"` (2026-05-24) introduced four merge-conflict artifacts:

| # | File | Artifact | Impact | Fixed |
|---|------|----------|--------|-------|
| R1 | `FlightPlanner.jsx:9-12` | Duplicate `import { UploadCloud, … }` + duplicate `import { pointInPolygon, … }` | **Vite parse error** — page fails to render on fresh checkout | ✅ |
| R2 | `FlightPlanner.jsx:~460,~493` | `fence_type:` repeated inside same `setFenceForm({...})` call | No behaviour change; code smell | ✅ |
| R3 | `vehicle_state.py:113 vs 141` | `class FenceStatus` defined twice | Python last-wins; no behaviour change | ✅ |
| R4 | `main.py:325-326` | `"fence_status_msg": fs,` repeated in return dict | Dict collapses to one key; cosmetic | ✅ |

Additional fix (F5): `validateMission()` now returns `{ warnings, infos }`. "Last item is RTL/LAND" moved to `infos` (blue) instead of `warnings` (amber) — no more false warning on a correctly-formed mission.

---

## 12. MISSION PLANNER PARITY MATRIX

### Mission Upload Protocol

| Concern | Mission Planner | Drone GCS | Verdict |
|---------|----------------|-----------|---------|
| HOME at seq=0 | Always present | `_inject_home()` uses `vehicle.home` if `valid`, else `(0,0,0)` | Parity when HOME arrived; M4 gates on `home.valid` now |
| `mission_type` on every frame | Yes (4.x) | Yes | ✓ Parity |
| Item format | `MISSION_ITEM_INT` preferred | `MISSION_ITEM_INT` only | ✓ Parity |
| Lat/lng scaling | ×1e7 | ×1e7 | ✓ Parity |
| INVALID_SEQUENCE drain | Inline | Inline | ✓ Parity |
| Final ACK timeout | 1.0 s | 1.0 s | ✓ Parity |
| `MAV_CMD_MISSION_START` params | `p1..p7=0` (`LayoutEditor.cs:552`) | `p1..p7=0` (`server.js:293`) | ✓ Parity |
| Mode set payload | `set_mode_send(custom_mode)` | `set_mode_send(custom_mode)` | ✓ Parity |
| `MISSION_CURRENT` on AUTO entry | Advances to seq 1 (TAKEOFF cursor) | Same — firmware behavior | ✓ Parity |
| Right-click "Insert TAKEOFF" | Inserts at index 0, HOME coords | Now inserts at index 0, HOME coords (M1 fix) | ✓ Parity |

### Fence Upload Protocol

| Concern | Mission Planner | Drone GCS | Verdict |
|---------|----------------|-----------|---------|
| Protocol | MISSION_TYPE_FENCE (4.x) | MISSION_TYPE_FENCE | ✓ Parity |
| `param1` semantics | Total vertices in THIS polygon (`Fence.cs:97-140`) | Per-group vertex count | ✓ Parity |
| Frame | MAV_FRAME_GLOBAL (0) for all fence items | `frame=0` | ✓ Parity |
| FENCE_TYPE configurable | Hidden; relies on default 7 | Exposed as checkboxes | ✓ Better than MP |
| Circle fence (5003/5004) | Supported | **Missing** | ✗ Gap |
| FENCE breach surface | Red HUD message + persistent pane | Red toast (fixed) + persistent UNPLANNED RETURN banner | ✓ Parity (was broken before fix) |

---

## 13. OPEN ISSUES & FOLLOW-UPS

### High Priority

| # | Issue | Where |
|---|-------|-------|
| M1 ✅ | Right-click "Insert TAKEOFF" → insert at index 0 with HOME coords | Fixed: `MapEditor.jsx:373-389` |
| M2 ✅ | TAKEOFF default altitude 10 m everywhere (was 50 m in right-click) | Fixed |
| M3 ✅ | Quick-action ARM in FlightData auto-retries on "mode not armable" | Fixed: extract retry from ActionsTab |
| M4 ✅ | Block WRITE if `home.valid === false` (mission only) | Fixed: `FlightPlanner.jsx:handleWrite` |
| M6 ✅ | `addWaypoint` calls `_reindex` after push | Fixed: `useMissionStore.js` |

### Medium Priority

| # | Issue | Where |
|---|-------|-------|
| M5 | Auto `parameter_manager.fetch_all()` after CONNECTED | `mavlink_link.py:_bootstrap_session` |
| M8 | "Restart mission" button when MISSION COMPLETE detected | `FlightPlanner.jsx` |
| F6 | Write button gated on `home.valid` for MISSION mode | `FlightPlanner.jsx:handleWrite` |
| F8 | Permanent "MISSION COMPLETE" banner on planner toolbar | `FlightPlanner.jsx` mission-control row |

### Low Priority

| # | Issue | Where |
|---|-------|-------|
| M7 | `MISSION_SET_CURRENT` (set current WP / resume) | `mavlink_link.py` + REST + WaypointTable |
| M9 | Set-AUTO confirmation gate (poll HEARTBEAT 2 s before enabling Start Mission) | `FlightPlanner.jsx:setMode` |
| F9 | Re-arm & restart mission button after mission complete | `FlightPlanner.jsx` |
| F11 | Right-click: add DO_DIGICAM_CONTROL (203), CONDITION_DELAY (112), CONDITION_YAW (115) | `MapEditor.jsx:511-522` |
| F12 | Fence: add circle-inclusion (5003) and circle-exclusion (5004) | `useMissionStore.js`, `MapEditor.jsx` |
| HUD | HUD WP numbering: unify `seq+1/total` (HUD) vs `seq/total-1` (panel) | `AdvancedHUD.jsx` + `MissionExecutionPanel.jsx` |

---

## 14. USER OPERATOR GUIDE

### 14.1 Step-by-Step: Fly a Mission (Nominal Path)

1. Open **Simulation** page. Set Home: `17.456979, 78.372855, 50, 0`. Click **Reset Simulation** → **Start Simulation**. Wait ~10 s for EKF to settle.
2. Verify: HUD shows a mode (not UNKNOWN), GPS fix ≥ 3, HOME marker visible on map.
3. **Before touching the mission — clear any stale fence** (see §14.3).
4. Open **Flight Planner**. Ensure dropdown shows **MISSION**.
5. Click **⚠ Insert TAKEOFF** button (or right-click map → Insert TAKEOFF). Row 0 should be `cmd=22, alt=10`.
6. Left-click map to add 2-3 NAV_WAYPOINTs, spacing ≥ 10 m apart. Set alt to 50 m in WP table.
7. Right-click map → **Insert RTL**. Last row should be `cmd=20`.
8. Click **Write**. Wait for `XFER: upload DONE`.
9. **Flight Data** → click **ARM**. If rejected: Actions tab → ARM (auto-retries via STABILIZE).
10. Back to **Flight Planner** → click **Set AUTO** → wait for mode chip to flip to AUTO.
11. Click **Start Mission**.
12. Watch Mission Execution panel: active WP advances. End of mission shows green **"MISSION COMPLETE"** badge.

### 14.2 User-Error Checklist

| # | Mistake | Symptom | Fix |
|---|---------|---------|-----|
| 1 | Fence enabled from prior session, polygon doesn't enclose HOME | takes off, moves slightly, RTLs | §14.3 — clear fence first |
| 2 | TAKEOFF inserted at end instead of index 0 | AUTO refuses: "Auto: Missing Takeoff Cmd" | Click **⚠ Insert TAKEOFF** button |
| 3 | RTL in middle of mission | flies some WPs, early RTL | Delete misplaced RTL; RTL must be last item |
| 4 | After Read, edited row 0 (HOME) by mistake | next Write moves autopilot HOME | Don't touch row 0 after Read |
| 5 | Forgot to click Write | autopilot has old mission | Click Write; watch `XFER DONE` |
| 6 | TAKEOFF alt = 0 | drone "takes off" to 0 m, never leaves ground | Set TAKEOFF alt to ≥ 10 m |
| 7 | WP altitude > FENCE_ALT_MAX | climb to WP1 triggers AltMax breach → RTL | Lower WP alts or raise FENCE_ALT_MAX |
| 8 | Set AUTO before ARM | ARM rejected in AUTO mode | ARM first, then switch to AUTO |
| 9 | "Set home here" used right before Write, telemetry hasn't updated yet | HOME in mission = stale coords | Wait ~2 s after Set Home until white H marker moves |

### 14.3 How to Clear the Fence (Do This Before Every Test)

1. Flight Planner → **FENCE** (dropdown).
2. Click **Read** — see how many vertices are stored.
3. Click **Clear** → click **Write** → wait for `XFER DONE`.
4. Uncheck **Enable** in fence config → click **Apply Fence Config**.
5. Confirm diagnostics panel shows **Enabled = NO**.

### 14.4 Debug Checklist (When Mission Misbehaves)

1. **Did upload succeed?** `XFER: upload DONE N/N` in toolbar? If not, click Read and check count.
2. **Is seq advancing?** Mission Execution panel shows live MISSION_CURRENT. If it jumps to RTL row, a failsafe fired.
3. **Is HOME correct?** White H marker on map at expected location?
4. **What did the autopilot say?** Flight Data → **Messages tab**. Look for:
   - `Polygon fence breached` — fence polygon breach
   - `Fence Breach Circle` — FENCE_RADIUS exceeded
   - `Fence Breach Alt Max / Min` — altitude limits
   - `RTL: Critical battery` — battery failsafe
   - `EKF variance` — EKF failsafe
   - `RC: Failsafe` / `GCS Failsafe` — link failsafes
5. **After fixes 2026-05-27**: any fence/breach/failsafe message now auto-toasts in red on the HUD, and an **UNPLANNED RETURN** banner appears in the Mission Execution panel with the exact autopilot reason.

### 14.5 Mission Planner Reference: HOME vs TAKEOFF

| Concept | What it is | Where it lives | How to change |
|---------|-----------|----------------|---------------|
| HOME | RTL anchor point. Mission seq 0. | Autopilot EEPROM, streamed as `HOME_POSITION` | Right-click map → "Set home here", or autopilot sets on arming |
| TAKEOFF | Mission command (cmd 22), tells Copter to climb | seq 1 in uploaded mission (seq 0 = HOME is injected by Python) | "Insert TAKEOFF" button / right-click → Insert TAKEOFF |
| EKF origin | Where EKF anchors its math | Autopilot internal | Set by autopilot |

**The WP table index 0 is your TAKEOFF.** HOME is inserted server-side as seq 0 by `_inject_home()` at upload time. You never type HOME into the WP table.
