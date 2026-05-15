# Drone GCS — Complete System Documentation

> **Reference implementation:** Mission Planner (C#) located at `/MissionPlanner/`  
> **Our stack:** React + Zustand (frontend) · FastAPI (Python backend) · Express (Node API gateway)

---

## Table of Contents

1. [Project Setup](#1-project-setup)
2. [Architecture](#2-architecture)
3. [Flight Planner Features](#3-flight-planner-features)
4. [Internal Logic](#4-internal-logic)
5. [Testing Guide](#5-testing-guide)

---

## 1. Project Setup

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 18+ | Frontend build & API gateway |
| Python | 3.11+ | MAVLink backend |
| npm | 9+ | Package management |

### Installation

```bash
# 1. Clone and enter repo
git clone <repo> && cd Drone-System-Collab

# 2. Frontend dependencies
cd drone_gcs/frontend
npm install

# 3. Python dependencies
cd ../python_service
pip install -r requirements.txt      # pymavlink, fastapi, uvicorn, pydantic

# 4. Node API dependencies
cd ../node_api
npm install
```

### Running the System

Start all three services (separate terminals):

```bash
# Terminal 1 — Python MAVLink service (port 8000)
cd drone_gcs/python_service
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2 — Node API gateway (port 8080)
cd drone_gcs/node_api
node index.js

# Terminal 3 — Frontend dev server (port 5173)
cd drone_gcs/frontend
npm run dev
```

Open `http://localhost:5173` in the browser.

### Production Build

```bash
cd drone_gcs/frontend
npm run build         # outputs to dist/
```

The `dist/` folder is served statically by the Node gateway in production.

### Port Map

| Service | Port | Description |
|---------|------|-------------|
| Frontend (dev) | 5173 | Vite dev server |
| Node gateway | 8080 | Proxies `/api/*` to Python |
| Python FastAPI | 8000 | MAVLink protocol engine |

---

## 2. Architecture

### 2.1 System Overview

```
Browser (React)
  │
  ├── useMissionStore (Zustand)   — waypoints, missionType, fence mode
  ├── useTelemetryStore (Zustand) — vehicle state, ADSB, telemetry
  │
  └─── HTTP API calls ──► Node Express (port 8080)
                               │
                         proxy /api/* ──► FastAPI (port 8000)
                                              │
                                        pymavlink ──► Drone (UDP/TCP/Serial)
```

### 2.2 Mission Engine

**File:** `python_service/mission_manager.py`

The `MissionManager` class handles all MAVLink mission protocol operations:

| Method | Description |
|--------|-------------|
| `upload_mission(items, mission_type)` | Sends MISSION_COUNT → waits for MISSION_REQUEST_INT → sends each MISSION_ITEM_INT → waits for MISSION_ACK |
| `download_mission(mission_type)` | Sends MISSION_REQUEST_LIST → waits for MISSION_COUNT → requests each item → sends MISSION_ACK |
| `clear_mission(mission_type)` | Sends MISSION_CLEAR_ALL → waits for MISSION_ACK |

**mission_type values:**
- `"MISSION"` → MAV_MISSION_TYPE_MISSION (0)
- `"FENCE"` → MAV_MISSION_TYPE_FENCE (2)
- `"RALLY"` → MAV_MISSION_TYPE_RALLY (5)

**Stale message draining:** For each requested item, the engine drains messages within a 2.5-second window. Wrong-sequence responses (stale retransmissions from ArduPilot) are silently discarded without consuming retry attempts.

**HOME injection:** For `MISSION` type only, a HOME waypoint (seq=0, frame=0, cmd=16) is automatically prepended before upload. ArduPilot requires this. The user-drawn waypoints become seq=1, 2, 3…

**Transfer status:** Accessible at `GET /api/mission/transfer/status`. The frontend polls this every 900ms to show live progress.

### 2.3 Fence Engine

**Reference:** `MissionPlanner/ExtLibs/ArduPilot/Fence.cs`

Fences use the standard MAVLink mission protocol with `mission_type = MAV_MISSION_TYPE_FENCE (2)`.

**Fence item types:**

| MAVLink Command | Value | Description |
|----------------|-------|-------------|
| FENCE_POLYGON_VERTEX_INCLUSION | 5001 | Vertex of an inclusion polygon |
| FENCE_POLYGON_VERTEX_EXCLUSION | 5002 | Vertex of an exclusion polygon |
| FENCE_CIRCLE_INCLUSION | 5003 | Center of inclusion circle (param1=radius) |
| FENCE_CIRCLE_EXCLUSION | 5004 | Center of exclusion circle (param1=radius) |
| FENCE_RETURN_POINT | 5000 | Custom fence breach return location |

**Polygon grouping protocol (critical):**
Each vertex carries `param1 = total vertices in its polygon`. When `accumulated_points.count == item.param1`, the polygon is complete. This matches `Fence.LocationToFence()` in MP exactly.

```
Example upload for: Inclusion(4pts) + Exclusion(3pts)
Item 0: cmd=5001, param1=4, lat=..., lng=...   ← inclusion vertex 1/4
Item 1: cmd=5001, param1=4, lat=..., lng=...   ← inclusion vertex 2/4
Item 2: cmd=5001, param1=4, lat=..., lng=...   ← inclusion vertex 3/4
Item 3: cmd=5001, param1=4, lat=..., lng=...   ← inclusion vertex 4/4 → polygon complete
Item 4: cmd=5002, param1=3, lat=..., lng=...   ← exclusion vertex 1/3
Item 5: cmd=5002, param1=3, lat=..., lng=...   ← exclusion vertex 2/3
Item 6: cmd=5002, param1=3, lat=..., lng=...   ← exclusion vertex 3/3 → polygon complete
```

**Frame requirement:** All fence items must use `MAV_FRAME_GLOBAL (0)`. Relative altitude frames (3) are rejected by ArduPilot for fence items.

**Polygons are NOT closed:** The first vertex is NOT repeated as the last vertex. ArduPilot closes the polygon implicitly using param1.

### 2.4 Map Rendering Flow

**MapEditor** (Flight Planner tab) — `components/MapEditor.jsx`

Uses MapLibre GL JS with these GeoJSON sources:

| Source ID | Content | Layers |
|-----------|---------|--------|
| `route` | Mission waypoint path (LineString) | `route` (line) |
| `fence-area` | Fence polygon FeatureCollection | `fence-fill` (fill), `fence-outline` (line) |
| `vehicle-dot` | Vehicle position dot | `vehicle-dot` (circle) |

Fence rendering uses **data-driven paint**:
```js
'fill-color': ['match', ['get', 'fenceType'], 'exclusion', '#ef4444', '#22c55e']
```
This eliminates `setPaintProperty` calls — color is encoded per-feature in the GeoJSON properties.

**MapView** (Data tab) — `components/MapView.jsx`

Uses additional overlay sources:

| Source ID | Content | Layers |
|-----------|---------|--------|
| `flight-trail` | Historical position trail | `flight-trail` (line) |
| `mv-fence-fill` | Fence overlay from store | `mv-fence-fill`, `mv-fence-outline` |
| `mv-mission-route` | Mission route overlay | `mv-mission-route` (line) |

### 2.5 State Management

**useMissionStore** (Zustand) — `store/useMissionStore.js`

| State field | Type | Description |
|-------------|------|-------------|
| `waypoints` | `MissionItem[]` | Active waypoint buffer |
| `missionType` | `'MISSION'|'FENCE'|'RALLY'` | Active mission type selector |
| `fencePolygonMode` | `'INCLUSION'|'EXCLUSION'` | Default type for new fence clicks |
| `selectedSeq` | `number|null` | Currently selected waypoint |
| `_missionSaved` | `MissionItem[]` | Persisted MISSION buffer |
| `_fenceSaved` | `MissionItem[]` | Persisted FENCE buffer |
| `_rallySaved` | `MissionItem[]` | Persisted RALLY buffer |

**Per-type buffer switching:** When `setMissionType` is called, the current waypoints are saved to the appropriate slot, and the target slot is restored. A Zustand `subscribe` listener keeps the active slot in sync with all edits in real-time.

```
MISSION → _missionSaved   FENCE → _fenceSaved   RALLY → _rallySaved
```

**useTelemetryStore** (Zustand) — `store/useTelemetryStore.js`

Holds real-time MAVLink telemetry: vehicle position, attitude, battery, GPS, mode, arm state, home position, mission progress, ADSB tracks.

### 2.6 Synchronization Logic

**Plan↔Data tab sync:**
- `_fenceSaved` is always up-to-date (Zustand subscribe keeps it synced)
- MapView reads `_fenceSaved` when `missionType !== 'FENCE'`
- MapView reads active `waypoints` when `missionType === 'FENCE'`
- This means fence drawn in Plan tab appears immediately on Data tab

**Transfer status polling:**
- Frontend polls `GET /api/mission/transfer/status` every 900ms
- Python `MissionManager.transfer_status` dict is updated at each protocol step
- Shown in the toolbar as: `XFER: upload UPLOADING_ITEMS | 3/7`

---

## 3. Flight Planner Features

### 3.1 Toolbar Buttons

| Button | Action |
|--------|--------|
| **MISSION / FENCE / RALLY** dropdown | Switch active mission type. Saves/restores per-type waypoint buffer |
| **Read** | `GET /api/fence` or `/api/mission` — downloads from drone, loads into store |
| **Write** | `POST /api/fence/upload` or `/api/mission/upload` — uploads current waypoints |
| **Clear** | Clears all waypoints from the store (local only, does not clear drone) |
| **Survey grid** | Opens SurveyGridPanel to auto-generate lawnmower pattern waypoints |
| **Save File** | Exports waypoints as QGC WPL 110 `.waypoints` file |
| **Load File** | Imports `.waypoints` file into the store |
| **Zoom Fit** | Pans/zooms map to show all waypoints |
| **N Warnings** | Toggles the validation warnings panel |

### 3.2 Fence Mode Panel

When **FENCE** is selected:

**Polygon type radio:**
- **Inclusion** — vehicle must stay INSIDE this region
- **Exclusion** — vehicle must never ENTER this region

When you click the map, a vertex is added with the current mode's command (5001 or 5002). Switching the radio changes the command for subsequent clicks only — existing vertices retain their original type.

**Status display:**
```
Fence: ENABLED | Action: 1 | Incl(4pts) + Excl(3pts)
```
Warning icons (⚠) appear if any polygon has fewer than 3 points.

**Fence configuration row:**
- Enable checkbox → sets `FENCE_ENABLE` parameter
- Action dropdown → sets `FENCE_ACTION` (0=Report, 1=RTL, 2=Land, 3=Brake)
- Radius, Alt Max, Alt Min fields → fence geometry limits
- **Apply Fence Config** → `POST /api/fence/config`

### 3.3 Mission Workflow

Complete end-to-end flow:

```
1. Select MISSION type
2. Click map to add waypoints (or right-click for command menu)
3. Edit table for altitude, command, params
4. Click Write (uploads to drone via MAVLink)
5. ARM → TAKEOFF → switch to AUTO mode
6. Click Start Mission
```

**Mission control row** (visible when MISSION selected):
- **Set AUTO / Set GUIDED** — sends `MAV_CMD_DO_SET_MODE`
- **Start Mission** — enabled only when: Armed + AUTO mode + waypoints exist
- Live display: `WP: 3 / 7 | Mode: AUTO`

### 3.4 Fence Workflow

```
1. Select FENCE type
2. Choose Inclusion or Exclusion radio
3. Click map to draw polygon vertices (minimum 3 for a valid polygon)
4. Switch radio to draw additional exclusion/inclusion zones
5. Validate — check status bar for warnings
6. Click Write to upload fence
7. Configure fence parameters and click Apply Fence Config
8. Fence is active on the drone
```

**Multi-polygon workflow:**
Each contiguous run of same-type vertices forms one polygon. Example:
- Click 4 times in INCLUSION mode → one 4-point inclusion polygon
- Switch to EXCLUSION mode → click 3 times → one 3-point exclusion polygon
- Write → uploads 2 polygons with correct param1 per polygon

### 3.5 Upload/Download Flow

**Upload (Write):**
1. `buildMissionItemsForType` pre-processes waypoints (groups fence polygons, injects HOME for mission)
2. `POST /api/fence/upload` with `{ items: [...], mission_type: "FENCE" }`
3. Python: `MissionManager.upload_mission()` runs MAVLink protocol
4. Protocol: MISSION_COUNT → wait MISSION_REQUEST_INT → send each MISSION_ITEM_INT → wait MISSION_ACK

**Download (Read):**
1. `GET /api/fence` or `/api/mission`
2. Python: `MissionManager.download_mission()` runs MAVLink protocol
3. Protocol: MISSION_REQUEST_LIST → wait MISSION_COUNT → request each item → send MISSION_ACK
4. Returns flat list of `MissionItem` objects
5. Frontend loads items into store; existing command values preserved

**ArduPilot quirks handled:**
- Older ArduPilot sends `mission_type=0` on MISSION_ITEM_INT even for fence items → we accept `mtype==0` as unset
- Stale retransmissions accumulate in queue → drained within 2.5s window without consuming retry attempts

### 3.6 Polygon Editing Flow

**Adding vertices:**
- Left-click on map → adds vertex at click position
- Right-click → context menu with "Insert Fence Vertex" option

**Moving vertices:**
- Click a waypoint marker → selects it (highlighted ring)
- Drag marker to new position → updates lat/lng in store → live polygon re-renders

**Deleting vertices:**
- Select a waypoint (click marker)
- Right-click → "Delete Selected WP"
- Or use the Delete (🗑) button in the waypoint table

**Reordering vertices:**
- Use ↑/↓ arrows in the waypoint table
- Polygon re-renders immediately with new vertex order

### 3.7 Right-Click Context Menu

**FENCE mode:**
- Insert Fence Vertex — adds vertex at right-click position with current mode command

**MISSION mode:**
- Insert WP after selected
- Add waypoint at end
- Set home here
- Set guided target
- RTL (vehicle)
- Set ROI here / Clear ROI
- Survey grid…
- Insert TAKEOFF / LAND / RTL / LOITER / SPLINE / ROI / DO_JUMP / CHANGE SPEED / CAM_TRIGG_DIST

---

## 4. Internal Logic

### 4.1 Inclusion / Exclusion Fence Logic

**ArduPilot behavior:**
- **Inclusion polygon:** Vehicle must stay INSIDE the polygon. Breaching the boundary triggers the fence action.
- **Exclusion polygon:** Vehicle must stay OUTSIDE the polygon. Entering it triggers the fence action.
- **Multiple inclusions:** Vehicle must stay inside ALL inclusion zones simultaneously (intersection, not union).
- **Multiple exclusions:** Vehicle must avoid ALL exclusion zones.

**Protocol encoding (matching MP Fence.FenceToLocation):**

```python
# Each polygon is serialized as N items where:
# - command = 5001 (inclusion) or 5002 (exclusion)  
# - param1 = N (total vertices in THIS polygon)
# - frame = 0 (MAV_FRAME_GLOBAL)
# - lat/lng = vertex coordinates
# - alt = 0 (not used for fence)
```

**Polygon grouping on upload (`buildFencePolygonGroups`):**

```js
// Groups consecutive vertices with the same command into polygon objects
function buildFencePolygonGroups(waypoints) {
  const groups = [];
  let current = null;
  waypoints.forEach(wp => {
    const cmd = (wp.command === 5001 || wp.command === 5002) ? wp.command : 5001;
    if (!current || current.cmd !== cmd) {
      if (current) groups.push(current);
      current = { cmd, items: [] };
    }
    current.items.push(wp);
  });
  if (current) groups.push(current);
  return groups;
}
```

**Polygon reconstruction on download (matching MP Fence.LocationToFence):**

ArduPilot sends fence items sequentially. The frontend groups them by matching `accumulated_count == item.param1`. When a group is complete, it forms one polygon. The same logic runs in the Python backend and frontend rendering.

### 4.2 Fence Validation Logic

**Pre-upload checks:**
1. Each polygon group must have ≥ 3 vertices (triangle minimum)
2. A warning is shown (but upload is not blocked) if exclusion zones exist without any inclusion zone

**Runtime validation:**
ArduPilot checks:
- Polygon must be convex or simple (no self-intersecting edges)
- Minimum 3 vertices
- Coordinates within valid lat/lng range

### 4.3 Mission Serialization Flow

```
UI Waypoints (store)
  │
  ├── buildMissionItemsForType()   ← pre-processing
  │     FENCE: group by cmd, set param1 per polygon, frame=0
  │     MISSION: HOME injection at seq=0
  │     RALLY: force frame=3, command=5100
  │
  ├── POST /api/fence/upload → Python MissionTransferRequest (Pydantic)
  │
  └── MissionManager.upload_mission()
        MISSION_COUNT(N, mission_type=2)
        ← MISSION_REQUEST_INT(seq=0)
        MISSION_ITEM_INT(seq=0, cmd=5001, param1=4, lat*1e7, lng*1e7, ...)
        ← MISSION_REQUEST_INT(seq=1)
        ...
        MISSION_ITEM_INT(seq=N-1, ...)
        ← MISSION_ACK(type=0/ACCEPTED)
```

### 4.4 Event Synchronization Between Modules

**Waypoint edits → map re-render:**
- Any store mutation (`addWaypoint`, `updateWaypointField`, `removeWaypoint`) updates `waypoints`
- MapEditor useEffect on `[waypoints]` re-renders markers, route line, and fence polygons
- React batches multiple state updates, so only one re-render per interaction

**Store slot sync (per-type buffers):**
```js
useMissionStore.subscribe((state, prev) => {
  if (state.waypoints === prev.waypoints) return;
  const slotKey = slotMap[state.missionType];
  if (slotKey && state[slotKey] !== state.waypoints) {
    useMissionStore.setState({ [slotKey]: state.waypoints });
  }
});
```
This keeps `_fenceSaved` current with every fence waypoint edit, enabling the Data tab to always show the latest drawn fence even when Plan tab is not active.

**Type switch:**
`setMissionType` saves current waypoints to the outgoing slot and restores the target slot atomically in a single Zustand `set()` call. No re-render gap.

### 4.5 Map Interaction Lifecycle

```
User clicks map
  │
  ├── MapEditor 'click' handler fires
  │     addWaypoint(lat, lng, alt) → reads current missionType & fencePolygonMode from store
  │
  ├── Zustand state update (waypoints array)
  │
  ├── React re-render triggered
  │
  ├── markers useEffect fires (waypoints changed)
  │     - Old markers removed
  │     - New markers created (color by command type)
  │     - route/fence-area GeoJSON sources updated
  │
  └── MapLibre re-renders layers (fill, outline, line)
```

**Marker drag:**
```
User drags marker
  │
  ├── marker.on('dragend') fires
  │     updateWaypointField(seq, 'lat', newLat)
  │     updateWaypointField(seq, 'lng', newLng)
  │
  └── Zustand update → useEffect → re-render (marker stays at new position, polygon updates)
```

---

## 5. Testing Guide

### 5.1 Pre-Test Setup

1. Connect a drone (or SITL simulator) via MAVLink
2. Verify connection: Data tab shows vehicle position and telemetry
3. Open Flight Planner tab

### 5.2 SITL Setup (Software-in-the-Loop)

```bash
# Start ArduPilot SITL
cd ardupilot
sim_vehicle.py -v Copter --console --map

# Connect our GCS (UDP)
# Python service: configure MAVLink connection to udp:127.0.0.1:14550
```

### 5.3 Mission Workflow Testing

**Golden path:**
1. Select MISSION type
2. Click map 5 times to add waypoints
3. Right-click → Insert TAKEOFF (cmd=22) at position 1
4. Right-click → Insert LAND (cmd=21) at end
5. Verify: warning banner disappears (TAKEOFF + LAND present)
6. Click Write → expect `XFER: upload DONE`
7. Read → items re-load from drone
8. Verify count matches

**Edge cases:**
- Upload with 0 waypoints → Write button disabled
- Upload with only TAKEOFF → warning: no RTL/LAND
- Upload with 513 waypoints → warning: large mission
- HOME waypoint: first downloaded item is HOME (lat=home_lat, cmd=16, seq=0); verify it appears in table

### 5.4 Fence Workflow Testing

**Single inclusion polygon:**
1. Select FENCE type, radio = Inclusion
2. Click map 4 times forming a square
3. Status bar shows: `Incl(4pts)` — no warnings
4. Click Write → upload succeeds
5. Click Read → 4 items with cmd=5001, param1=4 load back

**Single exclusion polygon:**
1. FENCE type, radio = Exclusion
2. Click map 4 times
3. Status: `Excl(4pts)` + ⚠ warning "Exclusion without inclusion zone"
4. Write → upload succeeds
5. Read → 4 items with cmd=5002, param1=4

**Combined inclusion + exclusion (the critical test):**
1. FENCE type, radio = Inclusion
2. Click 5 times to form outer boundary
3. Switch radio to Exclusion
4. Click 3 times to mark restricted zone (inside the inclusion area)
5. Status: `Incl(5pts) + Excl(3pts)` — no warnings
6. Click Write
7. Verify upload: items 0-4 have cmd=5001, param1=5; items 5-7 have cmd=5002, param1=3
8. Click Read → items reconstruct correctly
9. **Map shows:** Green filled polygon (inclusion) + Red filled polygon (exclusion) as separate layers

**Multi-polygon color verification:**
- Inclusion vertices: Green (#22c55e) vertex markers, green fill, green outline
- Exclusion vertices: Red (#ef4444) vertex markers, red fill, red outline
- Both on screen simultaneously → two distinct colored polygons (NOT orange mixed color)

**Polygon validation:**
1. Add only 2 fence vertices in INCLUSION mode
2. Warning: "Polygon 1 (inclusion) has 2 point(s) — minimum 3 required"
3. Warning button appears in toolbar
4. Write still allowed (firmware rejects invalid polygon with its own error)

**Download reconstruction:**
1. Upload inclusion(4) + exclusion(3)
2. Click Read
3. Store receives 7 items: [5001×4, 5002×3]
4. Rendering groups them: first 4 form green inclusion polygon, next 3 form red exclusion polygon
5. Verify vertex markers match: 0-3 green, 4-6 red

### 5.5 Fence Breach Testing

With SITL running:
1. Enable fence via "Apply Fence Config" with FENCE_ENABLE=1
2. Arm vehicle and fly it toward the fence boundary
3. Verify SITL console shows fence breach message
4. Verify vehicle executes configured action (RTL/Land/Brake)

### 5.6 Fence Synchronization (Plan ↔ Data tabs)

1. In Flight Planner: Draw inclusion fence (5 points) and exclusion fence (3 points)
2. Switch to Data tab WITHOUT writing to drone
3. Data tab should show: green inclusion polygon + red exclusion polygon
4. Toggle checkboxes: "Fence overlay" → fence disappears/reappears
5. Go back to Plan tab, add one more exclusion vertex
6. Switch to Data tab → exclusion polygon now has 4 vertices (live sync)

### 5.7 Right-Click Context Menu Testing

**FENCE mode:**
- Right-click → "Insert Fence Vertex" → vertex added at cursor with current mode type

**MISSION mode:**
- Right-click → "Set home here" → `POST /api/vehicle/set_home` (verify in telemetry)
- Right-click → "Set guided target" → `POST /api/flyto` (vehicle moves to target in GUIDED mode)
- Right-click → "Survey grid…" → opens survey grid panel centered at cursor

### 5.8 Edge Cases and Validation Scenarios

| Scenario | Expected Behavior |
|----------|-------------------|
| Upload empty fence | Write button disabled (0 waypoints) |
| Fence with 1 vertex | Warning shown; upload allowed but firmware rejects |
| Fence with 2 vertices | Warning shown; renders as partial line preview |
| Interleaved INC/EXC vertices (inc, exc, inc) | Creates 3 separate polygons |
| Fence upload while disconnected | Error: "no_connection" shown in status |
| Mission download with stale queue | Stale messages drained in 2.5s window; correct items received |
| MISSION_INVALID_SEQUENCE from AP | Recovery: wait for AP's retransmitted REQUEST, resume from that seq |
| Switch MISSION→FENCE→MISSION | Each type's waypoints preserved; no data loss |
| 500+ waypoint mission | Warning shown; upload attempted |

### 5.9 Transfer Status Monitoring

During any upload/download, the toolbar shows:
```
XFER: upload UPLOADING_ITEMS | 4/7
XFER: upload DONE | 7/7          ← success
XFER: download FAILED | 2/4 | ERROR: item_timeout   ← failure
```

`item_timeout` means the drone did not respond to a MISSION_REQUEST_INT within 5 attempts × 2.5s = 12.5s. Check:
1. Is the drone connected? (Check telemetry heartbeat)
2. Is the mission_type correct? (Fence items use type=2)
3. Is ArduPilot version sending mission_type in MISSION_ITEM_INT? (Older AP sends type=0 — handled)

---

## Appendix: MAVLink Command Reference

| Command | Value | Description |
|---------|-------|-------------|
| MAV_CMD_NAV_WAYPOINT | 16 | Navigate to waypoint |
| MAV_CMD_NAV_TAKEOFF | 22 | Auto takeoff |
| MAV_CMD_NAV_LAND | 21 | Land in place |
| MAV_CMD_NAV_RETURN_TO_LAUNCH | 20 | Return to home |
| MAV_CMD_NAV_LOITER_UNLIM | 17 | Loiter indefinitely |
| MAV_CMD_NAV_LOITER_TURNS | 18 | Loiter N turns |
| MAV_CMD_NAV_LOITER_TIME | 19 | Loiter N seconds |
| MAV_CMD_NAV_SPLINE_WAYPOINT | 82 | Smooth spline waypoint |
| MAV_CMD_DO_SET_ROI | 201 | Set region of interest |
| MAV_CMD_DO_JUMP | 177 | Jump to waypoint seq |
| MAV_CMD_DO_CHANGE_SPEED | 178 | Change airspeed/groundspeed |
| MAV_CMD_DO_DIGICAM_CONTROL | 203 | Trigger camera |
| MAV_CMD_DO_SET_CAM_TRIGG_DIST | 206 | Camera trigger distance |
| MAV_CMD_FENCE_RETURN_POINT | 5000 | Fence breach return point |
| MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION | 5001 | Inclusion fence vertex |
| MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION | 5002 | Exclusion fence vertex |
| MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION | 5003 | Inclusion fence circle |
| MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION | 5004 | Exclusion fence circle |
| MAV_CMD_RALLY_POINT | 5100 | Rally point |

## Appendix: API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/mission` | Download MISSION items |
| POST | `/api/mission/upload` | Upload MISSION items |
| GET | `/api/fence` | Download FENCE items |
| POST | `/api/fence/upload` | Upload FENCE items |
| GET | `/api/fence/status` | Read FENCE_ENABLE, FENCE_ACTION, etc. |
| POST | `/api/fence/config` | Write fence parameters |
| GET | `/api/rally` | Download RALLY items |
| POST | `/api/rally/upload` | Upload RALLY items |
| GET | `/api/mission/transfer/status` | Live transfer progress |
| POST | `/api/command/:cmd` | Shortcut commands (arm, disarm, rtl, land, takeoff) |
| POST | `/api/mode` | Set flight mode |
| POST | `/api/flyto` | Set GUIDED mode target |
| POST | `/api/vehicle/set_home` | Set home position |
| POST | `/api/vehicle/roi` | Set region of interest |
| POST | `/api/mavlink/command` | Raw MAVLink command (MAV_CMD_*) |
| GET | `/api/telemetry` | Full vehicle telemetry state |
