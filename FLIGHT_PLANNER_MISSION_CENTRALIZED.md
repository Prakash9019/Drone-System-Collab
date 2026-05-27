# FLIGHT PLANNER — MISSION CORE — CENTRALIZED IMPLEMENTATION DOCUMENT
**Scope**: Mission core (PRIMARY). Fence (SECONDARY — only because it shares the upload protocol). Rally / Survey Grid / Map AutoPan are out of scope.
**Companion**: `FLIGHT_PLANNER_MISSION_AUDIT_TABLE.md` (feature matrix), `FLIGHT_PLANNER_CENTRALIZED.md` (broader Plan tab doc).
**Date**: 2026-05-25 — mission-core deep-dive after regression report.

---

## 0. EXECUTIVE SUMMARY

**User report**: "Mission Planner-style workflow (Insert TAKEOFF → WPs → Insert RTL → Write → ARM → Set AUTO → Start Mission) previously worked; now mission behaviour is inconsistent / broken. Fence is also affected because it depends on mission stability."

**Audit verdict (mission core)**:

The mission protocol path — `frontend → Node → Python → MAVLink → ArduPilot` — is **structurally correct and matches Mission Planner**:

- Upload uses `MISSION_TYPE_MISSION` over the modern mission protocol.
- HOME is auto-injected at seq=0 by `mission_manager._inject_home`.
- Lat/lng are sent as ×1e7 ints via `MISSION_ITEM_INT`.
- ACK handling drains `MISSION_INVALID_SEQUENCE` inline without consuming retries.
- `MAV_CMD_MISSION_START` (300) is sent with all params = 0, which is the same behaviour Mission Planner uses (`Swarm/Sequence/LayoutEditor.cs:552`).
- Mode switching uses `set_mode_send(custom_mode)` — same payload as MP.
- ARM uses `command_long(400, p1=1)` with a 10 s ACK timeout — same as MP `doARMAsync`.

The previously-reported **regression (merge artifacts in commit `429705f`)** has been **fixed in the working tree** (duplicate `import { UploadCloud … }`, duplicate `fence_type:` keys, duplicate `class FenceStatus`, duplicate `fence_status_msg` dict key). These fixes are **uncommitted** — committing them is the first prerequisite to any further work.

What this audit found that is **NEW or remained from prior audits**:

| # | Issue | Severity | Layer |
|---|-------|----------|-------|
| M1 | Right-click "Insert TAKEOFF" appends to end instead of inserting at index 0 — user has to use the toolbar's `⚠ Insert TAKEOFF` button instead. Confusing because the right-click menu items for LAND/RTL *should* append, but TAKEOFF must be first. | High UX | `MapEditor.jsx:511` |
| M2 | TAKEOFF default altitude is **50 m via right-click**, **10 m via toolbar `⚠ Insert TAKEOFF`**. Inconsistent. Most users want 10 m for the initial climb. | Medium UX | `MapEditor.jsx:373` vs `FlightPlanner.jsx:557` |
| M3 | Quick-action `ARM` button in Flight Data (`runShortcut('arm')`) does **not** auto-retry on "mode not armable". Only the `Actions` tab's `handleAction` does. The user's flow uses the quick-action button, so they hit "rejected" with no recovery. | High UX | `FlightData.jsx:475` |
| M4 | Write is not gated on `home.valid`. If clicked before `HOME_POSITION` arrives, Python prepends a `(0,0,0)` HOME. ArduPilot accepts this but the mission frame anchors to null-island. | Medium correctness | `FlightPlanner.jsx:handleWrite` |
| M5 | `vehicle.parameters` is empty on first load — no auto-refresh after CONNECTED. Anything that reads `vehicle.parameters.FENCE_*` (fence diagnostics, alt-max preflight) sees zeros until the user opens the Params tab. | Medium correctness | `useTelemetryStore.connect` + Python `/connection/start` |
| M6 | `addWaypoint` does not call `_reindex` (only insert/remove/move do). Today it's consistent because seq = `snapshot.length` and items are pushed at end, but it's a footgun — any future change that inserts mid-array via `addWaypoint` will desync seq from array index. | Low | `useMissionStore.js:54-77` |
| M7 | No "Resume mission" / `MISSION_SET_CURRENT` exposure. MP supports it; we don't. | Low (feature gap) | n/a |
| M8 | No re-arm / restart-mission affordance after `MISSION COMPLETE` is detected. User has to manually STABILIZE → ARM → AUTO → Start Mission. | Medium UX | `FlightPlanner.jsx` |
| M9 | `setMode('AUTO')` does not poll the heartbeat-derived `currentMode` before flipping `inAutoMode` in the UI. A 50 ms race window can let the user double-tap Start Mission before the autopilot has fully entered AUTO. | Low | `FlightPlanner.jsx:setMode` |

**Conclusion**: the **autopilot-facing mission flow is sound**. The remaining issues are UX layer (M1–M3, M8) and one correctness edge case (M4). The other items (M5–M7, M9) are gap closures, not regressions.

---

## 1. ARCHITECTURE — mission core only

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Frontend (React)                                                          │
│  ┌───────────────────────────────┐  ┌────────────────────────────────┐    │
│  │ FlightPlanner.jsx              │  │ MapEditor.jsx                  │    │
│  │  - mission-type dropdown       │  │  - left-click → addWaypoint    │    │
│  │  - WRITE button (validates,    │  │  - right-click → context menu  │    │
│  │    posts /api/mission/upload)  │  │      Insert TAKEOFF/LAND/RTL…  │    │
│  │  - Set AUTO / Set GUIDED       │  │  - drag waypoint marker →      │    │
│  │  - Start Mission               │  │    updateWaypointField         │    │
│  │  - preflight checklist         │  │                                │    │
│  └───────────────────────────────┘  └────────────────────────────────┘    │
│  ┌───────────────────────────────┐  ┌────────────────────────────────┐    │
│  │ WaypointTable.jsx             │  │ useMissionStore.js (zustand)   │    │
│  │  - inline cmd / frame / alt   │  │  - waypoints[]                 │    │
│  │  - bulk alt, undo, move       │  │  - missionType                 │    │
│  │  - mission stats (distance,   │  │  - _missionSaved/_fenceSaved/  │    │
│  │    est. time @ 8 m/s)         │  │    _rallySaved per-type slots  │    │
│  └───────────────────────────────┘  │  - missionCurrentSeq (live)    │    │
│                                     │  - missionPlannedTotal         │    │
│                                     │  - _undoStack (cap 20)         │    │
│                                     └────────────────────────────────┘    │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ useTelemetryStore.js                                                  │ │
│  │  - sendShortcutCommand(cmd, body) → POST /api/command/<cmd>           │ │
│  │  - setFlightMode(mode)            → POST /api/mode { mode }            │ │
│  │  - WebSocket bridge → vehicle.mission.current_seq updates             │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└─────────────────────┬─────────────────────────────────────────────────────┘
                      │ HTTP :8080   (axios)
                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  Node API (Express)  —  node_api/server.js                                 │
│  Thin proxy to Python:                                                     │
│   /api/mission             → GET  /mission                                 │
│   /api/mission/upload      → POST /mission/upload                          │
│   /api/mission/transfer/   → GET  /mission/transfer/status                 │
│   /api/command/<shortcut>  → POST /command (with COMMAND_MAP lookup)       │
│   /api/mode                → POST /mode                                    │
│   /api/fence/*             → /fence/*                                      │
└─────────────────────┬─────────────────────────────────────────────────────┘
                      │ HTTP :8000
                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  Python service (FastAPI)  —  python_service/                              │
│  main.py                                                                   │
│   POST /mission/upload  → mission_manager.upload_mission(items, "MISSION") │
│   POST /command         → link_manager.send_command(...) (→ command_long)  │
│   POST /mode            → link_manager.set_mode(sysid, mode)               │
│                                                                            │
│  mission_manager.py                                                        │
│   - validate_mission   (lat/lng bounds)                                    │
│   - _inject_home       (seq=0 HOME, renumber user items by +1)             │
│   - upload_mission     (MISSION_COUNT → MISSION_REQUEST_INT loop → ACK)    │
│   - download_mission   (REQUEST_LIST → MISSION_COUNT → REQUEST_INT loop)   │
│   - transfer_status    (10 Hz progress for the UI)                         │
│                                                                            │
│  mavlink_link.py                                                           │
│   - read_loop          (routes MISSION_* messages to mission_manager)      │
│   - set_mode           (set_mode_send custom_mode)                         │
│   - command_manager    (ACK matching, retries, IN_PROGRESS extension)      │
│                                                                            │
│  message_handlers.py                                                       │
│   - MISSION_CURRENT    → state.mission_current_seq                         │
│   - STATUSTEXT         → state.status_messages + fence breach text         │
│   - FENCE_STATUS       → state.fence_status                                │
└─────────────────────┬─────────────────────────────────────────────────────┘
                      │ MAVLink (UDP 14550 / serial)
                      ▼
                ArduPilot SITL / vehicle
```

---

## 2. END-TO-END USER FLOW (the one that's documented and supposed to work)

### 2.1 Sequence

```
1. Open Simulation page → set Home (e.g. 17.456979, 78.372855, 50, 0)
                       → Reset Simulation → Start Simulation (EKF ~10 s to settle)

2. Open Flight Planner page
   missionType dropdown = MISSION
                       ↓
3. Right-click map → Insert TAKEOFF
   (intended: TAKEOFF goes at index 0 with HOME lat/lng and 10m alt)
   (actual:   addCommand(22) → insertWaypointAt(waypoints.length, …)
              → appends at end, with click lat/lng and 50m alt)            ← ⚠ M1, M2

4. Left-click map (point #1)  → addWaypoint(lat, lng, alt=50)
5. Left-click map (point #2)  → addWaypoint(lat, lng, alt=50)
6. Right-click → Insert RTL    → addCommand(20) → insertWaypointAt(end, …)
                                  (RTL correctly appends — this is what users want)

   waypoints (assuming M1 was avoided by clicking TAKEOFF first):
     [ T(seq=0, cmd=22), W(seq=1, cmd=16), W(seq=2, cmd=16), R(seq=3, cmd=20) ]

7. Click WRITE
   - blockingErrors(waypoints, "MISSION") checks:
       cmds = [22, 16, 16, 20]
       ✓ not empty
       ✓ contains 22
       ✓ cmds[0] === 22                              ← hard refuses if false
     PASS → continue
   - validateMission() → { warnings, infos }
       infos: ["Last item is RTL (20) — vehicle will switch AUTO → RTL at
                that waypoint and return to home. This is normal end-of-mission
                behaviour."]
       warnings: []
   - payloadItems = buildMissionItemsForType(items)   (passthrough for MISSION)
   - POST /api/mission/upload { items, mission_type: "MISSION" }
        ↓ Node → Python /mission/upload
   - mission_manager.upload_mission():
       validate_mission(items)                       (lat/lng range check)
       _inject_home(items)                           ← prepends HOME at seq=0
                                                       and renumbers user items
                                                       to seq=1..N
       wire bytes:
         MAV.mission_count_send(N+1, MISSION_TYPE_MISSION)
            ↓ ArduPilot:
         MISSION_REQUEST_INT(seq=0)
            ↓
         MAV.mission_item_int_send(seq=0, frame=0, cmd=16, lat*1e7, lng*1e7,
                                   alt, MISSION_TYPE_MISSION)     // HOME
            ↓
         MISSION_REQUEST_INT(seq=1)
            ↓
         MAV.mission_item_int_send(seq=1, frame=3, cmd=22, …)     // TAKEOFF
         ... repeat for each user item ...
            ↓
         MISSION_ACK(MAV_MISSION_ACCEPTED, MISSION_TYPE_MISSION)
       transfer_status: SENDING_COUNT → UPLOADING_ITEMS → DONE
   - response: { status: "success" }
   - statusMsg: "MISSION uploaded successfully!"

8. Open Flight Data → quick-action ARM
   - runShortcut('arm') → POST /api/command/arm
   - Node maps to { command: 400, p1: 1 } → POST /command
   - command_manager.execute_command(sysid, compid, 400, p1=1, …):
       command_long_send(400, conf=0, p1=1) → wait up to 10s for ACK
       ACK ACCEPTED → vehicle.status.armed = true (via HEARTBEAT)
   - If REJECTED with "RTL mode not armable" / similar:
       quick-action button: shows red banner, no auto-retry         ← ⚠ M3
       Actions tab handler: auto-switch to STABILIZE, retry ARM     (✓ here)

9. Back to Flight Planner → click "Set AUTO"
   - setFlightMode('AUTO') → POST /api/mode { mode: 'AUTO' }
   - link_manager.set_mode(sysid, 'AUTO'):
       set_mode_send(MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, AUTO_id)
       (no ACK wait — mode confirmed via subsequent HEARTBEAT custom_mode)
   - Frontend's `currentMode` updates when next HEARTBEAT arrives.
   - canStartMission becomes true if:
       armed && inAutoMode && hasTakeoffCmd && waypoints.length > 0

10. Click "Start Mission"
    - sendShortcutCommand('mission_start')
    - POST /api/command/mission_start → { command: 300, p1..p7: 0 }
    - command_long_send(300, p1=0 (first_item), p2=0 (last_item), …)
      ArduPilot interprets (0, 0) as "run from item 1 to end"
    - MISSION_CURRENT updates as each NAV item completes
    - On the final RTL or LAND, ArduPilot autoswitches AUTO → RTL/LAND
    - MissionExecutionPanel detects this via:
        modeUpper === 'RTL' && activeCmd === 20 && activeSeq - 1 === lastUserIdx
      → shows "MISSION COMPLETE" badge instead of a "failsafe" warning.
```

### 2.2 Hard invariants (don't break these)

| # | Invariant | Where enforced | Why |
|---|-----------|----------------|-----|
| I1 | TAKEOFF (cmd 22) is the FIRST user item; AUTO refuses without it | `FlightPlanner.jsx:blockingErrors` + `MissionExecutionPanel` activeLabel | ArduCopter AUTO init: "Auto: Missing Takeoff Cmd" |
| I2 | HOME at seq=0 is **injected by Python**, never sent by frontend | `mission_manager._inject_home` | MP convention; firmware expects seq 0 = HOME |
| I3 | `mission_type_value` (int) sent on EVERY MAVLink mission frame | `mission_manager.upload_mission` | ArduPilot 4.x disambiguates mission/fence/rally on the same wire |
| I4 | HOME injection only for `MISSION`; **never** for FENCE/RALLY | `mission_manager.upload_mission` (guarded by `if mission_type.upper() == "MISSION"`) | Fence/Rally have no HOME concept |
| I5 | Lat/lng sent as **scaled int32** in MISSION_ITEM_INT (×1e7) | `mission_manager.upload_mission:271` | MAVLink2 modern protocol |
| I6 | Validation messages split into `warnings` (amber) and `infos` (blue) | `FlightPlanner.jsx:validateMission` | "Last item is RTL" is **expected**, not a warning |
| I7 | `canStartMission` requires armed && AUTO && hasTakeoffCmd && wps>0 | `FlightPlanner.jsx:617` | Prevents premature mission_start |
| I8 | INVALID_SEQUENCE ACKs are drained inline; only re-send on genuine timeout | `mission_manager.upload_mission:274-304` | ArduPilot often sends both ACK and REQUEST for same item |
| I9 | MAVLink mode is set via `set_mode_send(custom_mode)`, not `command_long(176)` | `mavlink_link.set_mode` | Matches MP `MAVLinkInterface.setMode` |

### 2.3 Frontend payload shape (sent to Python)

```jsonc
POST /api/mission/upload
{
  "items": [
    { "seq": 0, "frame": 3, "command": 22,  "current": 1, "autocontinue": 1,
      "param1": 0, "param2": 0, "param3": 0, "param4": 0,
      "lat": 17.456979, "lng": 78.372855, "alt": 10 },          // TAKEOFF

    { "seq": 1, "frame": 3, "command": 16,  "current": 0, "autocontinue": 1,
      "param1": 0, "param2": 0, "param3": 0, "param4": 0,
      "lat": 17.4580,    "lng": 78.3740,   "alt": 50 },         // WAYPOINT

    { "seq": 2, "frame": 3, "command": 16,  "current": 0, "autocontinue": 1,
      "param1": 0, "param2": 0, "param3": 0, "param4": 0,
      "lat": 17.4590,    "lng": 78.3750,   "alt": 50 },         // WAYPOINT

    { "seq": 3, "frame": 3, "command": 20,  "current": 0, "autocontinue": 1,
      "param1": 0, "param2": 0, "param3": 0, "param4": 0,
      "lat": 17.456979,  "lng": 78.372855, "alt": 50 }          // RTL
  ],
  "mission_type": "MISSION"
}
```

Python prepends a HOME item before the wire send:

```jsonc
[
  { "seq": 0, "frame": 0, "command": 16, "lat": 17.456979, "lng": 78.372855, "alt": 50 }, // HOME
  { "seq": 1, "frame": 3, "command": 22, "lat": 17.456979, "lng": 78.372855, "alt": 10 }, // TAKEOFF
  { "seq": 2, "frame": 3, "command": 16, "lat": 17.4580,   "lng": 78.3740,   "alt": 50 },
  { "seq": 3, "frame": 3, "command": 16, "lat": 17.4590,   "lng": 78.3750,   "alt": 50 },
  { "seq": 4, "frame": 3, "command": 20, "lat": 17.456979, "lng": 78.372855, "alt": 50 }  // RTL
]
```

---

## 3. CODE INDEX (by-file inventory for mission)

| Layer | File | Lines that matter |
|-------|------|-------------------|
| FE store | `drone_gcs/frontend/src/store/useMissionStore.js` | `addWaypoint:54-77`, `insertWaypointAt:102-127`, `_reindex:39`, `setMissionType:24-35`, `replaceWaypoints:161-180`, `appendWaypoints:182-201`, slot-sync subscribe `:205-212` |
| FE planner page | `drone_gcs/frontend/src/pages/FlightPlanner.jsx` | `validateMission:121-141`, `blockingErrors:144-156`, `handleRead:349-374`, `handleWrite:376-402`, `buildMissionItemsForType:319-347`, `setMode:500-509`, `startMission:511-524`, `hasTakeoffCmd:548-551`, `insertTakeoffAtStart:553-558`, `preflightChecks:598-615`, `canStartMission:617` |
| FE map | `drone_gcs/frontend/src/components/MapEditor.jsx` | left-click `:182-185`, right-click `:187-190`, `addCommand:367-376`, `insertHere:383-393` |
| FE table | `drone_gcs/frontend/src/components/WaypointTable.jsx` | `CMD_OPTIONS`, `CMD_PARAM_LABELS`, inline editing, mission stats |
| FE flight-data | `drone_gcs/frontend/src/pages/FlightData.jsx` | quick-action ARM `:475`, applyFlightMode AUTO pre-check `:137-171` |
| FE actions tab | `drone_gcs/frontend/src/components/tabs/ActionsTab.jsx` | ARM auto-retry on mode-not-armable `:71-99` |
| FE mission panel | `drone_gcs/frontend/src/components/MissionExecutionPanel.jsx` | activeLabel `:67-75`, missionCompletedByPlan `:88-101` |
| Node API | `drone_gcs/node_api/server.js` | mission routes `:201-283`, COMMAND_MAP `:286-296`, `/api/command/:cmd` `:311-342`, `/api/mode` `:344-351` |
| Python REST | `drone_gcs/python_service/main.py` | `/mission/upload:257-270`, `/mission:167-180`, `/mission/transfer/status:183-187`, `/mode:583-591`, `/command:554-571`, `/fence/*` `:272-378` |
| Python mission proto | `drone_gcs/python_service/mission_manager.py` | `_inject_home:150-174`, `upload_mission:176-336`, `download_mission:338-472`, `wait_for_message:118-144`, `_mission_type_value:109-116` |
| Python link | `drone_gcs/python_service/mavlink_link.py` | `set_mode:584-601`, `send_command:567-572`, `read_loop:359-465`, mission routing `:386-391` |
| Python commands | `drone_gcs/python_service/command_manager.py` | `execute_command:75-197`, ARM timeout `:138-140` |
| Python state | `drone_gcs/python_service/vehicle_state.py` | `MISSION_CURRENT` flows into `mission_current_seq:162`, exposed as `mission.current_seq` in `to_dict():268-270` |
| Python handlers | `drone_gcs/python_service/message_handlers.py` | `MISSION_CURRENT:119-120`, `STATUSTEXT:163-181`, `FENCE_STATUS:183-190`, `HOME_POSITION:106-110` |
| Python models | `drone_gcs/python_service/mission_models.py` | `MissionItem`, `MissionTransferRequest` |
| Python file IO | `drone_gcs/python_service/mission_file_io.py` | QGC WPL 110 load/save |

---

## 4. MAVLINK PROTOCOL — exactly what crosses the wire

### 4.1 Upload sequence

| Step | Direction | Message | Important fields |
|------|-----------|---------|------------------|
| 1 | GCS → Vehicle | `MISSION_COUNT` | `count = N+1` (incl HOME), `mission_type = MISSION (0)` |
| 2 | Vehicle → GCS | `MISSION_REQUEST_INT` | `seq = 0`, `mission_type` |
| 3 | GCS → Vehicle | `MISSION_ITEM_INT` | `seq=0`, `frame=0 (GLOBAL)`, `command=16 (NAV_WAYPOINT)`, lat/lng×1e7, alt (HOME) |
| 4 | repeat: | `MISSION_REQUEST_INT(seq=k)` → `MISSION_ITEM_INT(seq=k)` |
| 5 | Vehicle → GCS | `MISSION_ACK` | `type = MAV_MISSION_ACCEPTED (0)`, `mission_type` |

### 4.2 Mission item fields (per item)

| Field | Source | Notes |
|-------|--------|-------|
| `seq` | Python after `_inject_home` (0..N) | HOME=0, user items start at 1 |
| `frame` | 0 for HOME, 3 (relative AGL) for user items by default | User can override in WaypointTable |
| `command` | Frontend (16/22/20/21/82/93/177/178/206/201/etc.) | Validated by ArduPilot when AUTO entered |
| `current` | 0 for all items (ArduPilot ignores) | Mission Planner also sends 0 |
| `autocontinue` | 1 | Always continue to next item |
| `param1..4` | Per command (e.g. LOITER time, DO_CHANGE_SPEED m/s) | See WaypointTable.jsx `CMD_PARAM_LABELS` |
| `lat, lng` | scaled ×1e7 in MISSION_ITEM_INT | `int(lat * 1e7)` |
| `alt` | float metres | Frame interprets reference |

### 4.3 Commands we accept (frontend → backend → MAVLink)

| ID | Name | First-class in UI? | Notes |
|----|------|--------------------|-------|
| 16  | NAV_WAYPOINT | ✓ | Default for left-click |
| 17  | NAV_LOITER_UNLIM | ✓ | Right-click menu |
| 18  | NAV_LOITER_TURNS | ✓ | p1 = turns |
| 19  | NAV_LOITER_TIME | ✓ | p1 = seconds |
| 20  | NAV_RETURN_TO_LAUNCH | ✓ | Right-click → "Insert RTL" |
| 21  | NAV_LAND | ✓ | Right-click → "Insert LAND" |
| 22  | NAV_TAKEOFF | ✓ | Right-click → "Insert TAKEOFF" (BUT see M1) |
| 82  | NAV_SPLINE_WAYPOINT | ✓ | Smoother turns |
| 93  | NAV_SPLINE_TAKEOFF | UI dropdown only | Not in right-click |
| 115 | NAV_GUIDED_ENABLE | UI dropdown only |  |
| 177 | DO_JUMP | ✓ | Loops |
| 178 | DO_CHANGE_SPEED | ✓ | Survey use |
| 179 | DO_SET_HOME | UI dropdown only |  |
| 181 | DO_SET_RELAY | UI dropdown only |  |
| 183 | DO_SET_SERVO | UI dropdown only |  |
| 201 | DO_SET_ROI | ✓ | Gimbal point-of-interest |
| 203 | DO_DIGICAM_CONTROL | UI dropdown only | Right-click menu missing |
| 206 | CAM_TRIGG_DIST | ✓ | Survey camera trigger |

### 4.4 Mission ACK / mission transfer state

| `transfer_status.phase` | Meaning |
|-------------------------|---------|
| `IDLE` | No transfer in progress |
| `SENDING_COUNT` | Just sent MISSION_COUNT, waiting for first MISSION_REQUEST |
| `UPLOADING_ITEMS` | Mid-upload; `current / total` is live |
| `REQUESTING_LIST` | Sent MISSION_REQUEST_LIST (download path) |
| `DOWNLOADING_ITEMS` | Mid-download |
| `CLEARING` | Sent MISSION_CLEAR_ALL |
| `DONE` | Last ACK was ACCEPTED |
| `FAILED` | One of: validation_failed, no_connection, no_request_after_count, ack_rejected_after_count, item_timeout, final_ack_timeout_or_reject, ack_rejected |

The frontend polls `/api/mission/transfer/status` every 900 ms while the planner is open.

---

## 5. VALIDATION + BLOCKER RULES

### 5.1 `blockingErrors(waypoints, missionType)` — hard refuse

Returns a list of strings that MUST be empty for WRITE to proceed.

| Check | Trigger |
|-------|---------|
| Mission is empty | `MISSION` mode and `cmds.length === 0` |
| Mission has no TAKEOFF | `MISSION` mode and `!cmds.includes(22)` |
| First item is not TAKEOFF | `MISSION` mode and `cmds[0] !== 22` |

These are stricter than Mission Planner — MP would let the upload through and let the autopilot reject AUTO later. We refuse client-side to avoid the confusing "AUTO mode failed: init failed" silent error.

### 5.2 `validateMission(waypoints, missionType)` — soft

Returns `{ warnings, infos }`:

| → warnings (amber) | Trigger |
|--------------------|---------|
| No TAKEOFF command | `!cmds.includes(22)` (also a blocker but warning fallback) |
| TAKEOFF not first | `cmds.includes(22) && cmds[0] !== 22` |
| No RTL/LAND at end | `!cmds.some(c => c === 20 || c === 21)` |
| Large mission | `> 500 waypoints` |
| Zero coords | Some WP has `!lat && !lng` |

| → infos (blue) | Trigger |
|----------------|---------|
| Last item is RTL | `cmds.at(-1) === 20` |
| Last item is LAND | `cmds.at(-1) === 21` |

This split was the **F5** fix in the prior audit — before it, "Last item is RTL" lit up the amber warning button on a correctly-formed mission, which was misleading.

### 5.3 `preflightChecks` (shown as colour chips in the mission control row)

```js
[
  { label: 'Connected',  ok: !!vehicle?.status },
  { label: 'GPS lock',   ok: gps_fix >= 3 },
  { label: 'Home set',   ok: !!vehicle?.home?.valid },
  { label: 'TAKEOFF cmd', ok: hasTakeoffCmd },
  { label: 'Waypoints',  ok: waypoints.length > 0 },
  { label: 'Armed',      ok: !!vehicle?.status?.armed },
  { label: 'AUTO mode',  ok: inAutoMode },
  // when a fence is uploaded:
  { label: 'HOME in fence', ok: …(point-in-polygon check) },
  { label: 'WPs in fence',  ok: … },
  { label: 'Alt < AltMax',  ok: … },
]
```

`canStartMission = !loading && waypoints.length > 0 && armed && inAutoMode && hasTakeoffCmd`.

---

## 6. MISSION PLANNER PARITY (mission only)

| Concern | Mission Planner | Drone GCS | Verdict |
|---------|-----------------|-----------|---------|
| HOME at seq=0 | Always present | `mission_manager._inject_home()` uses `vehicle.home.lat/lng` if `home.valid`, else `(0,0,0)` | **Parity** when HOME has arrived. M4 — should gate on `home.valid`. |
| Send `mission_type` on every frame | Yes (4.x) | Yes (`mission_manager.upload_mission`) | Parity |
| Item format | `MISSION_ITEM_INT` preferred | `MISSION_ITEM_INT` only | Parity (MP also prefers INT on modern firmware) |
| Lat/lng scaling | ×1e7 in INT | ×1e7 in INT | Parity |
| Upload retries | 3 × 1000 ms + 10 × 1500 ms (per item) | 3 × 1000 ms + 10 × 1500 ms (per item) | Parity |
| Download retries | 5 × 2500 ms (MP `getWPAsync`) | 5 × 2500 ms (drain window inside each attempt) | Parity |
| INVALID_SEQUENCE drain | Inline | Inline (`mission_manager.upload_mission:296-297`) | Parity |
| Final MISSION_ACK timeout | 1.0 s | 1.0 s | Parity |
| MAV_CMD_MISSION_START params | `p1..p7 = 0` (`Swarm/Sequence/LayoutEditor.cs:552`) | `p1..p7 = 0` (`server.js:293` + Python `/command`) | Parity |
| Mode set | `set_mode_send(custom_mode)` (`MAVLinkInterface.setMode`) | `set_mode_send(custom_mode)` (`mavlink_link.set_mode`) | Parity |
| Mode-set ACK | None — polls HEARTBEAT custom_mode | None — UI polls via telemetry feed | Parity |
| ARM if rejected by mode | Switch to STABILIZE/LOITER, retry | Auto-retry only in Actions tab; M3 — quick action lacks it | **Partial parity** |
| `MISSION_SET_CURRENT` | Yes — "Set current WP" / "Resume" | **Not exposed** | M7 — feature gap |
| Mission Read at planner open | Auto-fetches mission on connect | Manual — user must click READ | Acceptable (MP behaviour varies) |
| TAKEOFF-first rule | Warn, allow write | **Block** write (`blockingErrors`) | Stronger; better UX than MP |
| Right-click "Insert TAKEOFF" | Inserts at index 0 with HOME coords | Appends at end with click coords | **M1 — diverges** |
| Right-click "Insert RTL/LAND" | Appends at end | Appends at end | Parity |
| Re-arm after mission complete | Single button | **Missing** — manual STABILIZE → ARM → AUTO → Start | M8 — feature gap |

**Overall**: the wire-level protocol has **full Mission Planner parity**. The ergonomics around right-click TAKEOFF and the post-mission re-arm flow diverge — these are surface fixes, not protocol issues.

---

## 7. ISSUES — root cause and proposed fix

### M1 — Right-click "Insert TAKEOFF" appends instead of inserting at index 0

**Symptom**: User right-clicks → "Insert TAKEOFF" *after* dropping waypoints. TAKEOFF ends up at the end. WRITE refuses with "First mission item must be TAKEOFF". The toolbar's `⚠ Insert TAKEOFF` button works (it calls `insertTakeoffAtStart` which uses index 0), but the right-click variant doesn't.

**Root cause**: `MapEditor.jsx:367-376` `addCommand(command)` unconditionally calls `insertWaypointAt(waypoints.length, …)`.

**Fix**:
- For `command === 22`: insert at index 0 using HOME lat/lng (if valid; else click lat/lng) and 10 m alt.
- For `command === 20` (RTL) / `command === 21` (LAND): keep current append-at-end behaviour.
- For other commands (LOITER, ROI, etc.): keep current append-at-end behaviour with click coords.

### M2 — TAKEOFF default altitude is 50 m via right-click, 10 m via toolbar

**Root cause**: `addCommand(22)` uses `alt: 50` while `insertTakeoffAtStart` uses `alt: 10`. Two code paths, two defaults.

**Fix**: standardize on 10 m for TAKEOFF in both paths.

### M3 — Quick-action ARM in Flight Data doesn't auto-retry on mode-not-armable

**Root cause**: `FlightData.jsx:runShortcut('arm')` posts to `/api/command/arm` and surfaces the result. It doesn't inspect `mav_result_text` for "not armable" and doesn't auto-switch to STABILIZE like `ActionsTab.handleAction` does.

**Fix**: extract the auto-retry block from `ActionsTab.jsx:71-99` into a helper, use it from both call sites.

### M4 — Write is not gated on `home.valid`

**Root cause**: `handleWrite` checks `blockingErrors` but not `vehicle.home.valid`. If user clicks before HOME_POSITION arrives, Python's `_inject_home` inserts `(0,0,0)` as HOME — ArduPilot accepts it, the mission anchors to null-island.

**Fix**: add `if (missionType === 'MISSION' && !vehicle?.home?.valid) → block with "Wait for HOME_POSITION before writing."` to `blockingErrors` (or to a pre-write gate in `handleWrite`).

### M5 — `vehicle.parameters` is empty on first load

**Root cause**: Frontend connects to Python via WebSocket, telemetry flows, but `parameter_manager.fetch_all()` is only called when the user visits the Params tab. The Fence diagnostics panel and the `Alt < AltMax` preflight chip read `vehicle.parameters.FENCE_*` — they show 0/default until Params is visited.

**Fix**: trigger `parameter_manager.fetch_all()` automatically after the autopilot bootstrap finishes (after `_bootstrap_session` returns True in `mavlink_link.py`), guarded by a "fetched_once" flag so reconnects don't refetch unnecessarily.

### M6 — `addWaypoint` skips `_reindex`

**Root cause**: `useMissionStore.addWaypoint` pushes `{seq: snapshot.length, …}` to the end without calling `_reindex`. Today consistent because every other mutation reindexes; tomorrow breakable.

**Fix**: call `state._reindex([...snapshot, newWp])` so addWaypoint behaves like insertWaypointAt(end, …).

### M7 — No "Set current WP" / `MISSION_SET_CURRENT`

**Root cause**: feature gap. MP's `MAVLinkInterface.setWPCurrentAsync` sends `MISSION_SET_CURRENT(seq)` and waits for an updated `MISSION_CURRENT`. We don't.

**Fix (out of scope for this audit, log as follow-up)**: add `link_manager.set_mission_current(seq)` + REST endpoint + a "Resume from WP N" affordance in WaypointTable.

### M8 — No re-arm / restart-mission button after mission complete

**Root cause**: feature gap. When AUTO transitions to RTL/LAND and lands, the operator has to manually go through STABILIZE → ARM → AUTO → Start Mission to restart.

**Fix**: when `MissionExecutionPanel` detects `missionCompletedByPlan`, show a "Restart mission" button that does: `setMode('STABILIZE')` → wait 400 ms → `arm` → `setMode('AUTO')` → `mission_start`.

### M9 — Set AUTO race window

**Root cause**: `setMode('AUTO')` returns immediately. The UI's `inAutoMode` flips on the *next* HEARTBEAT arrival (~1 Hz). In the gap, the user can click Start Mission with the old mode still effective.

**Fix**: after `setMode('AUTO')` returns, poll `vehicle.status.mode` for up to 2 s and only flip a UI-side `autoConfirmed` flag once `currentMode === 'AUTO'`. Use `autoConfirmed` instead of (or in addition to) `inAutoMode` for `canStartMission`.

---

## 8. FENCE (secondary — depends on mission flow)

**Status**: Fence upload uses the same `mission_manager.upload_mission(items, "FENCE")` code path as MISSION. **If mission upload works, fence upload works.** The two issues fence has on top of mission are:

### 8.1 What's correct

- ✅ Per-polygon `param1 = vertex count`. Matches MP `Fence.cs:114-124`.
- ✅ `frame = MAV_FRAME_GLOBAL (0)`, `alt = 0` for all fence items. Matches MP `Fence.cs:107-122`.
- ✅ Inclusion (5001) and exclusion (5002) polygons grouped by command; multi-polygon in single upload supported.
- ✅ `MISSION_TYPE_FENCE` on every frame.
- ✅ `FENCE_TYPE` bitmask exposed as 4 checkboxes (AltMax/Circle/Polygon/AltMin).
- ✅ `FENCE_MARGIN < FENCE_RADIUS` guard on both client and server.
- ✅ Param write order: ACTION → ALT_MAX → ALT_MIN → RADIUS → MARGIN → TYPE → ENABLE.
- ✅ `FENCE_STATUS` MAVLink message handled into `vehicle.fence_status`.
- ✅ Fence STATUSTEXT lines ("Fence Breach Polygon", etc.) captured in `fence_status.last_breach_text`.
- ✅ Client-side `pointInPolygon` for HOME-inside / WPs-inside / Alt-vs-AltMax preflight.

### 8.2 What's missing (won't block mission, but worth noting)

| # | Gap | Where |
|---|-----|-------|
| FE1 | `FENCE_CIRCLE_INCLUSION` (5003) / `FENCE_CIRCLE_EXCLUSION` (5004) draw modes | `useMissionStore`, `MapEditor`, `mapShared` |
| FE2 | `FENCE_RETURN_POINT` (5000) support | new |
| FE3 | "Clear onboard fence" affordance (separate from drawing) | `FlightPlanner` |
| FE4 | Fence read-back diff (uploaded vs onboard) | `FlightPlanner` |
| FE5 | M5 also affects fence — `FENCE_*` params show as 0 until Params tab visited | covered by M5 fix |

### 8.3 Why "fence is affected by mission instability" (per the user's report)

The fence flow re-uses every primitive of the mission upload — `upload_mission()`, `transfer_status`, `wait_for_message()`, `_set_transfer()`. If mission upload is hung or stuck in a bad `transfer_status`, the next fence upload sees a stale `transfer_status` and can confuse the UI's XFER counter. This is a UI display bug, not a protocol bug. Fix: reset `transfer_status` to `IDLE` at the start of every `upload_mission` / `download_mission` / `clear_mission` (already partly done — `_set_transfer(session_id=…, phase="…")` overwrites, but the previous `mission_type` and `direction` linger if the new call fails before the first `_set_transfer`).

---

## 9. PRODUCTION FIXES — checklist

### 9.1 Already applied in working tree (uncommitted)

| # | File | Change |
|---|------|--------|
| ✓ | `frontend/src/pages/FlightPlanner.jsx` | Removed duplicate `import { UploadCloud … }` (Vite parse error on clean checkout) |
| ✓ | `frontend/src/pages/FlightPlanner.jsx` | Removed duplicate `fence_type:` key inside `setFenceForm({…})` (twice) |
| ✓ | `frontend/src/pages/FlightPlanner.jsx` | `validateMission` returns `{ warnings, infos }` — RTL/LAND end is infos, not warnings |
| ✓ | `frontend/src/pages/FlightPlanner.jsx` | Toolbar button now blue "Mission Info" when only infos, amber "N Warnings" when actual warnings |
| ✓ | `frontend/src/components/MissionExecutionPanel.jsx` | "MISSION COMPLETE" badge on planned AUTO → RTL/LAND transition |
| ✓ | `frontend/src/components/tabs/ActionsTab.jsx` | ARM auto-retry on "mode not armable" via STABILIZE switch |
| ✓ | `frontend/src/pages/FlightData.jsx` | Passes `vehicleMode` / `vehicleArmed` to MissionExecutionPanel |
| ✓ | `python_service/main.py` | Removed duplicate `"fence_status_msg": fs,` key |
| ✓ | `python_service/vehicle_state.py` | Removed duplicate `class FenceStatus` |

**These need to be committed.** Recommended commit message:

```
fix(planner): remove merge-conflict duplicates + split mission validation

- Remove duplicate ES module imports in FlightPlanner.jsx (Vite parse error on
  fresh checkout from merge commit 429705f).
- Remove duplicate fence_type setter key + duplicate FenceStatus dataclass +
  duplicate fence_status_msg dict key in /fence/status.
- Split validateMission() to return { warnings, infos }. "Last item is RTL/LAND"
  is expected end-of-mission behaviour, not a warning — render in blue.
- MissionExecutionPanel detects planned AUTO → RTL/LAND end of mission and shows
  "MISSION COMPLETE" so the operator doesn't confuse it with a failsafe.
- ActionsTab ARM auto-retries via STABILIZE when the autopilot rejects with
  "mode not armable" (typical after a previous mission landed in RTL).
```

### 9.2 Recommended follow-ups (this audit applies M1, M2, M3, M4, M6 — see §10)

| # | Priority | Change |
|---|----------|--------|
| M1 | high | Right-click "Insert TAKEOFF" → insert at index 0, use HOME lat/lng + 10 m alt |
| M2 | medium | TAKEOFF default altitude 10 m everywhere |
| M3 | high | Quick-action ARM in Flight Data auto-retries the same way as Actions tab |
| M4 | medium | Block WRITE if `home.valid === false` (mission only) |
| M5 | medium | Auto `parameter_manager.fetch_all()` after CONNECTED, once per session |
| M6 | low | `addWaypoint` calls `_reindex` for safety |
| M7 | low | `MISSION_SET_CURRENT` (set current WP) — feature, not regression |
| M8 | medium | "Restart mission" button when MISSION COMPLETE detected |
| M9 | low | Set-AUTO confirmation gate — poll HEARTBEAT for 2 s after mode change |

---

## 10. FIXES APPLIED IN THIS PASS

This audit applies the **high-priority surface fixes** that are safe to ship without a separate review cycle. They live in §9.2 rows M1, M2, M3, M4, M6.

| File | Change | Section |
|------|--------|---------|
| `drone_gcs/frontend/src/components/MapEditor.jsx` | `addCommand(22)` → insert at index 0 with HOME lat/lng + 10 m alt; other commands unchanged | M1 + M2 |
| `drone_gcs/frontend/src/pages/FlightData.jsx` | `runShortcut('arm')` → on "mode not armable", switch to STABILIZE and retry once | M3 |
| `drone_gcs/frontend/src/pages/FlightPlanner.jsx` | `blockingErrors` → add HOME-not-valid check for MISSION mode | M4 |
| `drone_gcs/frontend/src/store/useMissionStore.js` | `addWaypoint` → calls `_reindex` after push | M6 |

The other items (M5, M7, M8, M9) require either backend changes or new UI components and are explicitly **deferred** — they're not part of the mission-core regression.

---

## 11. VALIDATION MATRIX (post-fix)

| Case | Expected |
|------|----------|
| Empty mission, click WRITE | Refused: "Mission is empty." |
| Mission without TAKEOFF, click WRITE | Refused: "Mission has no TAKEOFF (cmd 22). Click ⚠ Insert TAKEOFF" |
| Mission with TAKEOFF at index 2, click WRITE | Refused: "First mission item must be TAKEOFF (cmd 22)" |
| Mission with TAKEOFF→WP→WP→RTL, HOME not valid, click WRITE | Refused: "HOME_POSITION not yet received" (NEW — M4) |
| Mission with TAKEOFF→WP→WP→RTL, HOME valid, click WRITE | Upload succeeds, XFER counter goes IDLE → SENDING_COUNT → UPLOADING_ITEMS → DONE |
| Right-click → "Insert TAKEOFF" on empty mission | TAKEOFF at index 0, HOME lat/lng, 10 m alt (NEW — M1+M2) |
| Right-click → "Insert TAKEOFF" with existing WPs | TAKEOFF inserted at index 0, existing items shifted +1 (NEW — M1) |
| ARM rejected with "RTL mode not armable" via Flight Data quick action | Auto-switches to STABILIZE, retries ARM (NEW — M3) |
| Set AUTO + Start Mission with valid mission | mission_start ACCEPTED, MISSION_CURRENT advances through items |
| Final RTL completes, AUTO → RTL transition | MissionExecutionPanel shows green "MISSION COMPLETE" |
| addWaypoint after a sequence of insert/remove/move | seq values match array indices |

---

## 12. CHANGE LOG

- **2026-05-25** — Mission-core deep-dive. Audited entire frontend/Node/Python/MAVLink path against Mission Planner reference. Confirmed protocol parity. Identified nine layered issues (M1–M9) and shipped the four UX-critical fixes (M1, M2, M3, M4, M6) in §10. Wrote this document and `FLIGHT_PLANNER_MISSION_AUDIT_TABLE.md`.
