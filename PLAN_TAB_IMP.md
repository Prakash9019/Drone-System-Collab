# PLAN TAB IMPLEMENTATION PLAN
## Mission Planner Feature Parity — Complete Analysis & Implementation Roadmap

---

## 1. CURRENT STATE GAP ANALYSIS

### 1.1 Component-by-Component Assessment

| Component | File | Current % | Critical Gaps |
|-----------|------|-----------|---------------|
| FlightPlanner.jsx | `pages/FlightPlanner.jsx` | 65% | No file save/load, no validation, no bulk alt |
| MapEditor.jsx | `components/MapEditor.jsx` | 60% | No home marker, wrong RTL path, no dist labels |
| WaypointTable.jsx | `components/WaypointTable.jsx` | 50% | Raw cmd numbers, no cmd names, no mission stats |
| SurveyGridPanel.jsx | `components/SurveyGridPanel.jsx` | 70% | No camera overlap, no auto TAKEOFF/RTL bookends |
| surveyGrid.js | `utils/surveyGrid.js` | 75% | No polygon fill mode |
| useMissionStore.js | `store/useMissionStore.js` | 80% | Needs undo stack |

### 1.2 Missing vs. Mission Planner

**Mission Planner Plan tab has:**
- Human-readable command name dropdowns in WP table ✗ (we have raw numbers)
- Per-command parameter labels (P1=Hold time for LOITER etc.) ✗ missing
- Mission file save/load (.waypoints format) ✗ missing
- Mission statistics (total distance, estimated time) ✗ missing
- Home position marker on map ✗ missing
- WP distance labels on route segments ✗ missing
- Altitude type dropdown (relative/absolute/terrain) per WP ✗ missing
- Bulk altitude change ✗ missing
- Mission validation before upload ✗ missing
- Camera overlap % for survey ✗ missing
- Auto-add TAKEOFF/RTL to survey ✗ missing
- Polygon-based survey ✗ missing
- Insert mode vs append mode toggle ✗ missing
- Undo last action ✗ missing
- Zoom to fit mission ✗ missing
- Route segment distance labels ✗ missing

---

## 2. MAVLink Command Reference

```
16   NAV_WAYPOINT          — Navigate to waypoint
17   NAV_LOITER_UNLIM      — Loiter indefinitely
18   NAV_LOITER_TURNS      — Loiter N turns (P1=turns)
19   NAV_LOITER_TIME       — Loiter N seconds (P1=seconds)
20   NAV_RETURN_TO_LAUNCH  — RTL
21   NAV_LAND              — Land at location
22   NAV_TAKEOFF           — Takeoff to altitude (P7=alt)
82   NAV_SPLINE_WAYPOINT   — Spline WP (smooth trajectory)
93   NAV_SPLINE_TAKEOFF    — Spline takeoff
115  NAV_GUIDED_ENABLE     — Enable guided mode
177  DO_JUMP               — Jump to WP seq (P1=seq, P2=repeat)
178  DO_CHANGE_SPEED       — Change speed (P1=type, P2=speed m/s)
179  DO_SET_HOME           — Set home (P1=1=use current position)
181  DO_SET_RELAY          — Set relay (P1=relay, P2=state)
183  DO_SET_SERVO          — Set servo (P1=channel, P2=PWM)
201  DO_SET_ROI            — Set region of interest
203  DO_DIGICAM_CONTROL    — Trigger camera
206  CAM_TRIGG_DIST        — Camera trigger by distance (P1=meters)
5001 FENCE_POLYGON_INC    — Inclusion fence vertex
5002 FENCE_POLYGON_EXC    — Exclusion fence vertex
5100 RALLY_POINT          — Rally / emergency landing point
```

### Frame Types
```
0  MAV_FRAME_GLOBAL           — Absolute altitude (MSL)
3  MAV_FRAME_GLOBAL_RELATIVE_ALT — Relative alt (AGL above home)
5  MAV_FRAME_GLOBAL_TERRAIN_ALT  — Altitude above terrain
```

---

## 3. .WAYPOINTS FILE FORMAT (Mission Planner)

```
QGC WPL 110
<index>\t<current>\t<frame>\t<command>\t<p1>\t<p2>\t<p3>\t<p4>\t<lat>\t<lng>\t<alt>\t<autocontinue>
```

- `index`: sequential integer starting at 0
- `current`: 1 for first WP, 0 for rest
- Row 0 is always the home position (command=16, current=1)

---

## 4. IMPLEMENTATION PLAN — STEP BY STEP

### STEP 1: surveyGrid.js — Polygon fill survey
Add `buildPolygonSurveyWaypoints(polygon, opts)` that fills an arbitrary polygon.

### STEP 2: WaypointTable.jsx — Full Mission Planner parity
- Command name dropdown (human-readable, not raw number)
- Frame type dropdown (Relative/Absolute/Terrain)
- Per-command parameter labels in column headers
- Mission stats footer (total dist, estimated time @ 8 m/s)
- Bulk altitude editor row
- "Insert before / after" buttons
- Copy selected waypoint
- "Zoom to WP" button per row
- Color-coded rows by command type

### STEP 3: MapEditor.jsx — Map interaction parity
- Home marker (house icon, fixed position)
- Distance labels between consecutive waypoints
- Command-type color coding on markers
- "Insert mode" toggle (new clicks insert after selected, not always append)
- Distance rings (100m/500m/1km circles around home)
- Fix RTL context menu command path
- Bearing arrows on route segments (optional)
- Waypoint tooltip on hover (command name + alt)

### STEP 4: SurveyGridPanel.jsx — Camera overlap + polygon mode
- Camera overlap % → automatically compute line spacing
- Camera config panel (sensor width, focal length → GSD)
- Auto-prepend TAKEOFF WP
- Auto-append RTL WP  
- Polygon survey mode (draw polygon first, fill with grid)

### STEP 5: FlightPlanner.jsx — File IO + validation + mission ops
- Save to .waypoints file (browser download)
- Load from .waypoints file (file picker)
- Mission validation panel (warn: no TAKEOFF, no RTL, >500 WPs)
- Bulk altitude change (set all WPs to same alt)
- "Zoom to fit mission" button
- Mission summary stats bar (# WPs, total dist, est. time)
- Loiter / Guided waypoint at selected location
- Home WP auto-insert (WP0 = home position) on first write

### STEP 6: useMissionStore.js — Undo stack
Add `undoLastAction()` and `undo stack` (last 20 states).

### STEP 7: CSS — All new UI elements

---

## 5. USER DOCUMENTATION

See bottom of this file → Section 7.

---

## 6. IMPLEMENTATION STATUS TRACKER

| Step | Feature | Status |
|------|---------|--------|
| 1 | surveyGrid polygon fill | PLANNED |
| 2 | WaypointTable cmd dropdown | PLANNED |
| 2 | WaypointTable mission stats | PLANNED |
| 2 | WaypointTable bulk altitude | PLANNED |
| 3 | MapEditor home marker | PLANNED |
| 3 | MapEditor distance labels | PLANNED |
| 3 | MapEditor insert mode | PLANNED |
| 3 | MapEditor fix RTL path | PLANNED |
| 4 | Survey camera overlap | PLANNED |
| 4 | Survey auto bookends | PLANNED |
| 5 | FlightPlanner save/load file | PLANNED |
| 5 | FlightPlanner validation | PLANNED |
| 5 | FlightPlanner bulk alt | PLANNED |
| 5 | FlightPlanner zoom to fit | PLANNED |
| 6 | Mission store undo | PLANNED |

---

## 7. USER DOCUMENTATION — PLAN TAB GUIDE

### 7.1 What is the Plan Tab?
The Plan tab is where you design, visualize, and upload missions for your drone.
A **mission** is a sequence of waypoints and commands that the drone will execute automatically.

---

### 7.2 Mission Types

**MISSION** — A flight plan the drone follows in AUTO mode.
Waypoints define where the drone flies, at what altitude, and with what behaviour at each point.

**FENCE** — A geofence boundary on the map.
- **Inclusion fence** — the drone is only allowed to fly *inside* this polygon.
- **Exclusion fence** — the drone is not allowed to enter this polygon.

**RALLY** — Emergency landing points.
When RTL (Return to Launch) is triggered, the drone will fly to the nearest rally point instead of the original home location.

---

### 7.3 Creating a Mission

**Step-by-step:**
1. Select **MISSION** in the type dropdown.
2. Click on the map to place waypoints. Each click adds a numbered waypoint.
3. The route line connects all waypoints in sequence.
4. Right-click on the map for more options:
   - Add specific commands (TAKEOFF, LAND, RTL, LOITER)
   - Set home position
   - Set guided target
   - Generate a survey grid
5. Edit waypoint details in the table on the left:
   - **CMD** — the action at this waypoint (WAYPOINT, TAKEOFF, LAND, RTL, etc.)
   - **Frame** — altitude reference (Relative = AGL, Absolute = MSL, Terrain = above ground)
   - **Alt** — target altitude in metres
   - **P1–P4** — command-specific parameters (e.g., hold time for LOITER)
6. Click **Write** to upload the mission to the drone.

---

### 7.4 Mission Command Types

| Command | What it does |
|---------|-------------|
| NAV_WAYPOINT (16) | Fly to this location at the set altitude |
| NAV_TAKEOFF (22) | Take off to the set altitude before starting mission |
| NAV_LAND (21) | Land at this location |
| NAV_RTL (20) | Return to home (launch) location |
| NAV_LOITER_UNLIM (17) | Hold position indefinitely |
| NAV_LOITER_TURNS (18) | Circle the point N times (P1 = turns) |
| NAV_LOITER_TIME (19) | Hold position for N seconds (P1 = seconds) |
| NAV_SPLINE_WAYPOINT (82) | Fly a smooth curved path through this point |
| DO_CHANGE_SPEED (178) | Change cruise speed (P1=type, P2=m/s) |
| DO_JUMP (177) | Jump back to another waypoint N times |
| CAM_TRIGG_DIST (206) | Trigger camera every N metres (P1=metres) |

---

### 7.5 Read and Write

**READ** — Downloads the current mission stored on the drone into the map/table.
Use this to inspect what the drone is currently programmed with.

**WRITE** — Uploads your edited mission from the map/table to the drone.
The drone stores this in its flight controller memory.

> **Important:** Always READ first if you are not sure what is on the drone.
> WRITE overwrites whatever the drone had before.

---

### 7.6 AUTO Mode and Mission Execution

1. Place and upload your mission (WRITE).
2. ARM the drone (use Actions tab or ARM button).
3. TAKEOFF manually or include a TAKEOFF waypoint as the first command.
4. Click **Set AUTO** to switch to AUTO flight mode.
5. Click **Start Mission** to begin executing the mission from waypoint 0.
6. Monitor progress: the current waypoint is highlighted green on the map and table.
7. The drone will execute all commands sequentially.
8. Mission ends when the drone reaches the last waypoint (usually RTL or LAND).

---

### 7.7 GUIDED Mode

In GUIDED mode, you can:
- Right-click the map → "Set guided target" to fly the drone to that exact point.
- Use the Fly To coordinates from the Actions tab.

GUIDED does not use a pre-planned mission — it responds to individual position commands.

---

### 7.8 Survey Grid

The Survey Grid tool generates a lawnmower/grid pattern for aerial surveys and mapping.

**How to use:**
1. Select **MISSION** type.
2. Click **Survey Grid** in the toolbar (or right-click → "Survey grid").
3. Set the survey area center (lat/lng) or select location from right-click on map.
4. Configure:
   - **Width / Length** — size of the survey area in metres
   - **Heading** — direction flight lines run (0° = North, 90° = East)
   - **Line spacing** — distance between parallel passes
   - **Overlap** — camera overlap % (auto-computes line spacing based on altitude + camera FOV)
   - **Altitude** — flight altitude during survey
5. Click **Replace mission** to set the survey as your entire mission.
   Or **Append grid** to add survey waypoints to an existing mission.

**For best results:**
- Set TAKEOFF as WP0 before the survey waypoints.
- Set RTL or LAND as the last waypoint.
- Use camera trigger command (CAM_TRIGG_DIST) to take photos automatically.

---

### 7.9 Fence System

**What fences do:**
Geofences protect the drone from flying outside (inclusion) or inside (exclusion) a defined area.
If the drone breaches the fence, the configured **Fence Action** is triggered.

**Fence Actions:**
| Action | What happens |
|--------|-------------|
| Report | Log breach, no flight control action |
| RTL | Return to home immediately |
| Land | Land immediately at current position |
| Brake | Stop and hover in place |

**How to create a fence:**
1. Select **FENCE** in the type dropdown.
2. Choose **Inclusion** or **Exclusion** polygon mode.
3. Click on the map to place fence vertices.
4. The polygon closes and fills when you have 3+ vertices.
   - Green fill = Inclusion fence (fly only inside)
   - Red fill = Exclusion fence (do not enter)
5. Click **Write** to upload the fence to the drone.
6. In the fence configuration bar, set:
   - **Enable** checkbox to activate the fence
   - **Action** to select what happens on breach
   - **Radius** for cylindrical radius fence
   - **Alt Max/Min** for altitude limits
7. Click **Apply Fence Config** to write the configuration parameters.

---

### 7.10 Rally Points

Rally points are emergency landing locations.

**How to use:**
1. Select **RALLY** in the type dropdown.
2. Click on the map to place rally points (e.g., landing pads, open fields).
3. Click **Write** to upload rally points to the drone.
4. When RTL is triggered, the drone flies to the nearest rally point.

---

### 7.11 Saving and Loading Mission Files

**Save to file:**
Click **Save File** → downloads a `.waypoints` file (QGC format, compatible with Mission Planner).

**Load from file:**
Click **Load File** → opens your saved `.waypoints` file and restores the mission.

---

### 7.12 Common Operator Workflow

```
1. Open Plan tab
2. Select MISSION type
3. READ to see what's on the drone (if anything)
4. Clear if needed
5. Click map to place waypoints  
   OR use Survey Grid for mapping missions
6. Edit waypoint details in table (altitude, commands, parameters)
7. Validate mission (check for TAKEOFF at start, RTL at end)
8. WRITE to upload to drone
9. Go to Flight Data tab
10. ARM drone
11. Set AUTO mode
12. Start Mission
13. Monitor progress on map
```
