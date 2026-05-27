# MASTER OPERATIONS AND DEBUGGING DOCUMENT
**Status**: Production. Last updated: 2026-05-27.
**Scope**: Running the system (setup, SITL, startup), operating the GCS, and debugging any failure mode. All settled root-cause analyses.
**Supersedes**: `GCS_DOCUMENTATION.md` (§1 setup, §5 testing), `try.md`, `FLIGHT_PLANNER_USER_GUIDE.md`, `LEVEL_CALIBRATION_AUDIT.md`, `docs/operations/mission_planner_operational_workflow.md`, `docs/operations/complete_frontend_developer_user_guide.md`, `docs/operations/frontend_testing_workflow_guide.md`, `docs/operations/phase7_system_stability.md`, `drone_gcs/SETUP.md`, `drone_gcs/TROUBLESHOOTING.md`, `drone_gcs/DIRECT_SERIAL.md`

---

## TABLE OF CONTENTS

1. [System Setup & Prerequisites](#1-system-setup--prerequisites)
2. [Starting the Stack](#2-starting-the-stack)
3. [SITL (Software-in-the-Loop)](#3-sitl-software-in-the-loop)
4. [Nominal Flight Workflow](#4-nominal-flight-workflow)
5. [Debugging Premature RTL](#5-debugging-premature-rtl)
6. [Debugging Mission Won't Start](#6-debugging-mission-wont-start)
7. [Debugging Upload / Transfer Failures](#7-debugging-upload--transfer-failures)
8. [Fence Troubleshooting](#8-fence-troubleshooting)
9. [Parameter Reference (Key Params)](#9-parameter-reference-key-params)
10. [Calibration Procedures](#10-calibration-procedures)
11. [Known Working State Verification](#11-known-working-state-verification)

---

## 1. SYSTEM SETUP & PREREQUISITES

### 1.1 Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 18+ | Frontend build & API gateway |
| Python | 3.11+ | MAVLink backend |
| npm | 9+ | Package management |

### 1.2 Installation

```bash
# Frontend dependencies
cd drone_gcs/frontend
npm install

# Python dependencies (create venv first)
cd drone_gcs/python_service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt   # pymavlink, fastapi, uvicorn, pydantic, pyzmq

# Node API dependencies
cd drone_gcs/node_api
npm install
```

---

## 2. STARTING THE STACK

Start all three services in separate terminals:

```bash
# Terminal 1 — Python MAVLink service (port 8000)
cd drone_gcs/python_service
source .venv/bin/activate
python main.py                    # starts FastAPI on :8000

# Terminal 2 — Node API gateway (port 8080)
cd drone_gcs/node_api
node server.js                    # or: node index.js

# Terminal 3 — Frontend dev server (port 5173)
cd drone_gcs/frontend
npm run dev
```

Open `http://localhost:5173` in the browser.

### 2.1 Port Map

| Service | Port | Description |
|---------|------|-------------|
| Frontend (dev) | 5173 | Vite dev server |
| Node gateway | 8080 | REST + WebSocket to browser |
| Python FastAPI | 8000 | MAVLink protocol engine |
| ZMQ PUB | 5556 | Python → Node telemetry |

### 2.2 Production Build

```bash
cd drone_gcs/frontend
npm run build    # outputs to dist/
```

The `dist/` folder is served statically by the Node gateway in production.

---

## 3. SITL (SOFTWARE-IN-THE-LOOP)

### 3.1 Starting SITL via GCS Simulation Page

1. Open **Simulation** page in the GCS.
2. Set Home coordinates: `17.456979, 78.372855, 50, 0` (Hyderabad — use your actual location).
3. Click **Reset Simulation** to kill any running SITL process.
4. Click **Start Simulation**.
5. Wait ~10 s for the EKF to settle (HUD shows mode other than UNKNOWN, GPS fix ≥ 3).

The Simulation page uses `sitl_orchestrator.py` which discovers `sim_vehicle.py` in common ArduPilot locations and auto-connects after a 3.5 s delay on `udp:127.0.0.1:14550`.

### 3.2 Starting SITL Manually

```bash
cd ardupilot
sim_vehicle.py -v Copter --console --map --out udp:127.0.0.1:14550
```

Then connect the GCS: Setup → Connection → `udp:127.0.0.1:14550` → Connect.

### 3.3 SITL Home vs GCS HOME

**Critical**: the SITL process starts with its own default HOME location (often Canberra `-35.36, 149.16`). If you draw a fence or set a mission using the GCS's "Set Home Here" before SITL has set its HOME, your polygon will be at the wrong location relative to where the vehicle actually is.

**Rule**: always wait for the **white H marker** to appear on the map (from `HOME_POSITION` telemetry) before drawing any fence or setting home. The H marker shows the autopilot's actual HOME.

---

## 4. NOMINAL FLIGHT WORKFLOW

This is the complete, tested workflow. Follow it exactly.

### 4.1 Pre-Flight

1. **Start SITL** (§3.1) and wait for EKF to settle.
2. **Verify**: HUD mode ≠ UNKNOWN, GPS fix ≥ 3, HOME marker (white H) visible on map.
3. **Clear stale fence** (§8.1) — do this before every test session.

### 4.2 Build the Mission

1. Open **Flight Planner**. Ensure dropdown shows **MISSION**.
2. Click **⚠ Insert TAKEOFF** (or right-click map → Insert TAKEOFF).
   - Row 0 should be `cmd=22, alt=10 m`.
   - The TAKEOFF marker appears on top of the HOME marker — this is correct; lat/lng of TAKEOFF is ignored by Copter.
3. Left-click the map to add 2-3 **NAV_WAYPOINTs** (cmd 16). Set alt = 50 m in WP table. Space them ≥ 10 m apart.
4. Right-click map → **Insert RTL**. Last row should be `cmd=20`.
5. Verify mission shape:

```
WP table:          Onboard (after _inject_home on Write):
0: TAKEOFF  cmd=22   seq 0: HOME      cmd=16 (auto-injected)
1: WP       cmd=16   seq 1: TAKEOFF   cmd=22
2: WP       cmd=16   seq 2: WP1       cmd=16
3: RTL      cmd=20   seq 3: WP2       cmd=16
                     seq 4: RTL       cmd=20
```

### 4.3 Write the Mission

1. Verify preflight chips: Connected ✓, GPS lock ✓, Home set ✓, TAKEOFF cmd ✓, Waypoints ✓.
2. Click **Write**. Watch toolbar: `XFER: upload SENDING_COUNT 0/N` → `UPLOADING_ITEMS i/N` → `DONE N/N`.
3. (Optional) Click **Read** to verify. Downloaded count = uploaded count + 1 (the extra is HOME at seq 0). Row 0 should be `cmd=16` (HOME).

### 4.4 ARM and Fly

1. **Flight Data** → click **ARM**.
   - If rejected: Actions tab → ARM (auto-retries via STABILIZE).
   - Never force-arm to bypass checks.
2. Back to **Flight Planner**. Verify: ✓ Armed chip.
3. Click **Set AUTO**. Wait ~1 s for mode chip to flip to AUTO.
   - **Expected**: WP counter reads `1/4`. The `⏸ HOLDING · mission not started` label appears. **This is correct** — see §5.2.
4. Click **Start Mission**.
   - Sends `MAV_CMD_MISSION_START (300)`.
   - Vehicle lifts off. Counter advances: `1/4 (TAKEOFF)` → `2/4 (WP1)` → ...
   - On final RTL row: AUTO → RTL. Green **"MISSION COMPLETE"** badge appears.
5. Vehicle returns, lands, disarms.

### 4.5 Post-Mission

- The mode flip AUTO → RTL at the end of the mission is **normal and expected**. `MissionExecutionPanel` shows green "MISSION COMPLETE" to confirm this.
- To fly again: STABILIZE → ARM → Set AUTO → Start Mission (or use a "Restart" button if implemented).

---

## 5. DEBUGGING PREMATURE RTL

Vehicle takes off but returns early, before reaching planned waypoints.

### 5.1 Step 1: Check the Messages Tab

**Flight Data → Messages tab** — look for:

| Message | Cause | Fix |
|---------|-------|-----|
| `Polygon fence breached` | Polygon fence triggered (most common) | §8.1 |
| `Fence Breach Circle` | FENCE_RADIUS exceeded from HOME | Increase FENCE_RADIUS or disable circle bit |
| `Fence Breach Alt Max` | Waypoint altitude > FENCE_ALT_MAX | Lower WP alts or raise FENCE_ALT_MAX |
| `EKF variance` | EKF failsafe | Recalibrate compass/accel; don't raise FS_EKF_ACTION blindly |
| `RC: Failsafe` | RC link lost | Stable RC link; or disable for SITL testing |
| `GCS Failsafe` | GCS link lost | Set `FS_GCS_ENABLE=0` for solo SITL bench tests |
| `RTL: Critical battery` | Battery failsafe | Check `BATT_LOW_VOLT` / `BATT_FS_LOW_ACT` |

**After the 2026-05-27 fix**: fence breach messages now also toast in red on the HUD in real time, and the **UNPLANNED RETURN banner** in the Mission Execution panel shows the exact autopilot reason. You should not need to hunt for messages manually.

### 5.2 The WP Counter Shows 1/4 on Set AUTO — Is That Normal?

**Yes, this is normal and correct.** See `MASTER_FLIGHT_PLANNER.md §9` for the full root cause document.

**Short answer**: When ArduCopter enters AUTO mode, it advances `MISSION_CURRENT` to the TAKEOFF command (seq 1) immediately. This is firmware behavior, not a GCS bug. Mission Planner does the same. The vehicle does NOT fly until you click "Start Mission".

The `⏸ HOLDING · mission not started` label in the Mission Execution panel confirms this state.

### 5.3 Step 2: Check Fence Status

```
Flight Planner → FENCE (dropdown)
→ Check fence diagnostics panel:
    Enabled = YES?  (danger)
    HOME inside inclusion = NO?  (danger)
    Breach (live) = YES?  (active breach)
```

If enabled and HOME is outside the inclusion polygon → this is the most common cause of premature RTL.

**Fix**: §8.1 (Clear the fence).

### 5.4 Step 3: Check Key Params

From `Setup → Parameters` (or the param_cache):

| Param | Dangerous value | Safe for SITL testing |
|-------|-----------------|-----------------------|
| `FENCE_ENABLE` | 1 | 0 |
| `FENCE_TYPE` | 7 (bit 1 = circle active) | 4 (polygon only) or 0 (disabled) |
| `FENCE_TOTAL` | > 0 (has stored polygon) | 0 (clear the fence) |
| `FENCE_RADIUS` | Very small (< mission span) | Large (> 1000 m) |
| `FS_GCS_ENABLE` | 2 (RTL on GCS loss) | 0 for SITL solo tests |

---

## 6. DEBUGGING MISSION WON'T START

### 6.1 Start Mission Button is Greyed Out

`canStartMission = !loading && waypoints.length > 0 && armed && inAutoMode && hasTakeoffCmd`

Check each condition with the preflight chip row in the mission toolbar:
- **Connected** ✗ → reconnect
- **GPS lock** ✗ → wait for satellite lock (SITL: wait for EKF to settle)
- **Home set** ✗ → wait for HOME_POSITION, or right-click map → "Set home here"
- **TAKEOFF cmd** ✗ → click "⚠ Insert TAKEOFF"
- **Waypoints** ✗ → add waypoints to the table
- **Armed** ✗ → ARM the vehicle
- **AUTO mode** ✗ → click "Set AUTO"

### 6.2 Write Rejected — Blocking Error

| Error | Cause | Fix |
|-------|-------|-----|
| "Mission is empty" | No waypoints | Add waypoints |
| "Mission has no TAKEOFF (cmd 22)" | First item ≠ TAKEOFF | Click "⚠ Insert TAKEOFF" |
| "First mission item must be TAKEOFF" | TAKEOFF at wrong position | Delete and re-add with Insert TAKEOFF |
| "HOME_POSITION not yet received" | Clicked Write before HOME arrived | Wait for white H marker, retry |

### 6.3 ARM Rejected

| Rejection message | Cause | Fix |
|-------------------|-------|-----|
| "Mode not armable" | Wrong mode for arming | ActionsTab ARM retries via STABILIZE auto |
| "Throttle not at minimum" | RC throttle too high | Lower throttle; in SITL use default idle |
| "EKF not OK" | EKF not settled | Wait longer after SITL start (10-15 s) |
| "Compass not calibrated" | Hardware issue | Calibrate compass (Setup → Calibration) |

### 6.4 Auto Mode Rejected

If `Set AUTO` fails or mode doesn't stick:
- Check STATUSTEXT for "Auto: Missing Takeoff Cmd" — means mission doesn't have TAKEOFF first
- Check STATUSTEXT for "Auto: No Mission" — means no mission on vehicle; click Write first
- Check `vehicle.parameters.MIS_TOTAL` > 0 if available

---

## 7. DEBUGGING UPLOAD / TRANSFER FAILURES

### 7.1 XFER Shows FAILED

| Error code | Meaning | Fix |
|-----------|---------|-----|
| `item_timeout` | Vehicle didn't respond to MISSION_REQUEST_INT (5 attempts × 2.5 s) | Check drone connected; retry |
| `ack_rejected` | Vehicle sent non-ACCEPTED MISSION_ACK | Check mission_type mismatch; check firmware version |
| `validation_failed` | Python-side validation failed (coordinate range, etc.) | Check WP lat/lng are valid |
| `no_connection` | No pymavlink connection | Reconnect; check serial/UDP/TCP |
| `final_ack_timeout_or_reject` | Final ACK not received in 1.0 s after last item | Usually transient; retry Write |

### 7.2 Download (Read) Shows Stale Items

After clicking **Read**, the downloaded count should be your uploaded count + 1 (for HOME). If the count is off:
- Upload was partial (check FAILED status)
- ArduPilot firmware sent stale MISSION_ITEM_INT (handled by 2.5 s drain window in `mission_manager.py`)

### 7.3 Fence Read Yields Zero Items Despite FENCE_TOTAL > 0

This is normal if using an older ArduPilot that still uses legacy `FENCE_POINT` protocol (pre-4.0). Our GCS uses the modern `MISSION_TYPE_FENCE` protocol. For Copter ≥ 4.0 this is not an issue.

---

## 8. FENCE TROUBLESHOOTING

### 8.1 Clearing the Onboard Fence (Most Important Step)

**The onboard fence persists in autopilot EEPROM across SITL restarts.** Clearing the drawn polygon in the GCS UI does NOT clear the autopilot's fence.

```
Flight Planner → FENCE (dropdown)
1. Click READ — reveals actual stored vertices (even if map shows nothing)
2. Click CLEAR — empties the waypoint table
3. Click WRITE — uploads zero vertices to vehicle
4. Wait for XFER DONE
5. Uncheck ENABLE in fence config row
6. Click "Apply Fence Config"
7. Verify: Fence diagnostics shows Enabled = NO
```

### 8.2 Setting Up a Fence Correctly

**Critical rule**: the SITL HOME and the polygon you draw must be at the **same location**.

1. **Simulation** → set Home `17.456979, 78.372855, 50, 0` → Reset → Start. Wait for EKF.
2. **Flight Planner** → FENCE.
3. Radio: select **Inclusion (5001)**.
4. Click 4+ map points enclosing your entire intended flight area (plus a margin).
5. Click **Write** → wait for `XFER DONE`.
6. In fence config: ✓ Enable, Action = RTL, **Radius** = value larger than your farthest WP from HOME, AltMax ≥ highest mission alt.
7. Click **Apply Fence Config**.
8. Verify diagnostics: Enabled = YES, HOME inside inclusion = YES, all mission WPs inside = YES.

### 8.3 Fence Config Field Guide

| Field | Recommended value | Notes |
|-------|------------------|-------|
| Enable | ✓ (when using fence) | Must explicitly apply |
| Action | RTL (1) | Or Land/Brake |
| Alt Max | 120 | Above mission max alt; below real ceiling |
| Alt Min | -10 | Leave at default unless needed |
| **Radius** | > mission farthest WP distance from HOME | **Set this large** — FENCE_TYPE=7 means circle is active |
| Margin | 2 | Must be < Radius |
| FENCE_TYPE | 4 (polygon only) | To disable circle fence, uncheck "Circle" bit |

### 8.4 FENCE_TYPE Bitmask

| Bit | Value | Meaning |
|-----|-------|---------|
| 0 | 1 | Alt Max fence |
| 1 | 2 | **Circle fence** (active by default! FENCE_RADIUS from HOME) |
| 2 | 4 | Polygon fence |
| 3 | 8 | Alt Min fence |

Default: 7 (AltMax + Circle + Polygon). The **circle fence** at FENCE_RADIUS is what most commonly causes premature RTL when forgotten. Set FENCE_TYPE = 4 to use polygon only.

---

## 9. PARAMETER REFERENCE (KEY PARAMS)

Current SITL param cache (`python_service/param_cache/1_1.json`):

| Param | Current | Safe for testing | Notes |
|-------|---------|-----------------|-------|
| `FENCE_ENABLE` | 1 | 0 | **Disable for testing** unless you explicitly want fence |
| `FENCE_ACTION` | 1 (RTL) | 1 or 0 | RTL on breach |
| `FENCE_TYPE` | 7 | 4 | AltMax+Circle+Polygon active; reduce to 4 for polygon only |
| `FENCE_TOTAL` | 11 | 0 | 11 polygon vertices stored — clear before testing |
| `FENCE_RADIUS` | 1000 | 1000+ | OK if > mission span |
| `FENCE_ALT_MAX` | 1000 | 1000 | OK |
| `FENCE_MARGIN` | 2 | 2 | Must be < RADIUS |
| `FS_GCS_ENABLE` | 2 (continue mission) | 0 | Set 0 for SITL solo bench tests |
| `FS_EKF_ACTION` | 3 (Land) | 3 | Keep; do not raise blindly |
| `RTL_ALT` | 50 m | 50 m | RTL climbs to 50 m before returning — make sure WPs are ≥ 50 m alt or expect climb |
| `BATT_LOW_VOLT` | 3.9 V/cell | n/a | Not causing RTL unless cells sag |
| `WPNAV_SPEED` | 500 cm/s | 500 | Default cruise speed |
| `WPNAV_RADIUS` | 200 cm | 200 | Waypoint acceptance radius |

To refresh params: Setup → Parameters → Refresh, or `POST /api/parameters/refresh`.

---

## 10. CALIBRATION PROCEDURES

### 10.1 Accelerometer Calibration

1. Open **Setup** → **Calibration** tab.
2. Click **Calibrate Accelerometer**.
3. Follow the on-screen prompts (place vehicle on each face).
4. For SITL: "Level Calibration" only is usually sufficient.

### 10.2 Compass Calibration

1. Setup → Calibration → **Calibrate Compass**.
2. Rotate vehicle through all orientations while calibrating.
3. For SITL: compass is simulated; calibration is usually not needed.

### 10.3 Level Calibration

Sets the gyro ground reference. Vehicle should be level and stationary.

1. Setup → Calibration → **Level Calibration**.
2. Wait for "Calibration successful" message.

For SITL, the `LEVEL_CALIBRATION_AUDIT.md` documented that this affects `AHRS_TRIM_*` parameters — see that doc if specific trim behavior is needed.

### 10.4 ESC Calibration

1. Setup → Calibration → **Calibrate ESCs**.
2. Follow the specific ESC calibration sequence for your hardware.
3. **Not applicable to SITL.**

---

## 11. KNOWN WORKING STATE VERIFICATION

Use this checklist after any code change to verify the system works end-to-end.

### 11.1 Pre-Test Checklist

- [ ] All three services started (Python :8000, Node :8080, Frontend :5173)
- [ ] Browser at `http://localhost:5173`
- [ ] SITL started and connected (HUD shows mode, GPS ≥ 3, HOME marker visible)
- [ ] **Fence cleared** (Flight Planner → FENCE → Read → Clear → Write → Disable → Apply)

### 11.2 Mission Upload Test

- [ ] Mission: TAKEOFF (10 m) → WP1 (50 m) → WP2 (50 m) → RTL
- [ ] Write → XFER shows `DONE 4/4`
- [ ] Read back → 5 items (HOME + 4 user items), row 0 = cmd 16 (HOME)
- [ ] WP table shows correct lat/lng for all items

### 11.3 Mission Execution Test

- [ ] ARM succeeds
- [ ] Set AUTO → mode chip shows AUTO, WP counter shows 1/N, `⏸ HOLDING` label visible
- [ ] Start Mission → vehicle lifts off, `▶ RUNNING` label visible
- [ ] WP counter advances: 1 (TAKEOFF) → 2 (WP1) → 3 (WP2) → 4 (RTL)
- [ ] End of mission: mode flips AUTO → RTL, **green "MISSION COMPLETE"** badge (NOT red "UNPLANNED RETURN")
- [ ] Vehicle lands at HOME, disarms

### 11.4 Fence Test

- [ ] Draw 4-point inclusion polygon enclosing HOME and all WPs
- [ ] Write fence → XFER DONE
- [ ] Apply Config: Enable ✓, Action = RTL, Radius ≥ 500, AltMax ≥ 100
- [ ] Diagnostics: Enabled = YES, HOME inside inclusion = YES
- [ ] Run mission → vehicle completes normally (no premature RTL)
- [ ] Fence cleared after test

### 11.5 Regression Checklist

- [ ] FlightPlanner page mounts without Vite parse error on fresh checkout
- [ ] Validation: TAKEOFF→WP→RTL mission shows no amber warning badge (only blue "Mission Info" if any)
- [ ] Validation: mission without TAKEOFF shows amber warning + blocked Write
- [ ] STATUSTEXT fence message toasts in red on HUD during breach
- [ ] UNPLANNED RETURN banner appears and shows breach reason
- [ ] MISSION COMPLETE banner appears (green) on planned AUTO→RTL transition

### 11.6 Transfer Status Display

The toolbar shows during any transfer:
```
XFER: upload UPLOADING_ITEMS | 4/7    ← in-progress
XFER: upload DONE | 7/7               ← success
XFER: download FAILED | 2/4 | item_timeout   ← failure
```

The frontend polls `/api/mission/transfer/status` every 900 ms while FlightPlanner is open.
