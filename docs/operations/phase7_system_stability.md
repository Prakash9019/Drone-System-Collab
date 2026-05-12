# PHASE 7 — SYSTEM STABILITY

Date: 2026-05-12  
Scope: `drone_gcs` end-to-end stability and MVP operational flow validation

---

## 16) End-to-End Validation

This section validates the full loop:

`UI -> frontend -> backend(Node) -> python_service -> MAVLink -> SITL -> telemetry -> UI`

### A. Pre-Validation Setup

- Ensure SITL is running (or start from Simulation page).
- Ensure Python service is running on `:8000`.
- Ensure Node API gateway is running on `:8080`.
- Open `Flight Data` page and confirm WebSocket stream establishes.
- Confirm `connectionState` transitions are visible (not stuck at `DISCONNECTED`).

### B. Validation Matrix

#### 1. UI / Button Integrity (Dead Buttons)

Verify all primary interaction points trigger intended actions:

- `Flight Data`
  - Connect / Disconnect
  - ARM / DISARM
  - TAKEOFF (altitude input respected)
  - RTL / LAND
  - Mode selector
  - Primary vehicle selector
  - Map controls (`My location`, `Go to vehicle`, `Auto-follow`)
- `Flight Planner`
  - Read / Write / Clear
  - Survey grid (open + generate + append/replace)
  - Mission execution controls (`Set AUTO`, `Set GUIDED`, `Start Mission`)
  - Fence config controls
  - Rally interactions
- `Help`
  - MAVLink inspector updates
  - Log analyze upload + CSV download

Acceptance:

- No button is visually active but functionally inert.
- Every click yields either successful state change or explicit error message.
- No silent failures.

---

#### 2. API Route Integrity (Broken Routes / 404 / 400)

Critical routes to verify from UI path:

- Connection:
  - `POST /api/connection/start`
  - `POST /api/connection/stop`
  - `GET /api/connection/status`
  - `GET /api/connection/ports`
- Telemetry/vehicle:
  - `POST /api/command/:cmd`
  - `POST /api/mode`
  - `POST /api/flyto`
  - `POST /api/vehicle/set_home`
  - `POST /api/vehicle/roi`
  - `POST /api/vehicle/roi/clear`
- Mission/fence/rally:
  - `GET /api/mission`, `POST /api/mission/upload`
  - `GET /api/fence`, `POST /api/fence/upload`, `POST /api/fence/config`
  - `GET /api/rally`, `POST /api/rally/upload`
  - `GET /api/mission/transfer/status`
- Diagnostics:
  - `GET /api/mavlink/inspector`
  - `POST /api/logs/analyze`

Acceptance:

- No `404` for wired UI actions.
- `400/500` responses are surfaced clearly in UI banners.
- Failure payloads include actionable details.

---

#### 3. Telemetry Health (Missing Telemetry / Stale State)

Check live updates for:

- Position (`GLOBAL_POSITION_INT`)
- Heading (`GLOBAL_POSITION_INT` and/or `VFR_HUD`)
- Attitude (`ATTITUDE`)
- Battery (`SYS_STATUS`)
- GPS fix/satellites (`GPS_RAW_INT`)
- Mission current seq (`MISSION_CURRENT`)
- Home (`HOME_POSITION`)

Also verify:

- Flight trail updates continuously.
- Home marker appears when available.
- Current mission waypoint highlight updates in table/map.
- ADS-B markers update (if traffic available).

Acceptance:

- No frozen telemetry values while link remains `CONNECTED/ACTIVE`.
- `MISSION_CURRENT` changes are reflected in UI in near real-time.

---

#### 4. Workflow Connectivity (Disconnected Flows)

Validate transitions across screens:

- Map context menu mission actions affect planner state.
- Survey menu from map opens planner with seeded center.
- Planner Read populates map + table.
- Planner Write reaches vehicle and updates transfer status.
- Mode/command actions in Flight Data reflect in planner execution context.

Acceptance:

- No isolated sub-flows that require manual refresh/hacks.
- Data written in one screen is visible where expected in other screens.

---

#### 5. Placeholder / Incomplete Components

Audit for placeholders that block operations:

- HUD: should show real values, not fixed mock placeholders.
- Mission execution panel: should show real command history + phase transitions.
- Fence and Rally sections: should provide actionable workflow guidance.

Acceptance:

- Placeholder text, if present, is non-blocking and clearly informational.
- Core operator actions are fully functional.

---

### C. Stability Regression Checklist

Run through this sequence and mark pass/fail:

1. Connect -> telemetry visible  
2. Arm -> mode/status update  
3. Takeoff -> climb/alt changes  
4. Build mission -> write -> read back  
5. Set AUTO -> start mission  
6. Observe waypoint progression  
7. Trigger RTL and verify mode transition  
8. Trigger LAND and verify descent/disarm path  
9. Stop/disconnect cleanly  
10. Reconnect and confirm state recovery

Pass Criteria:

- Sequence completes without app reload.
- No uncaught exceptions in console.
- No stuck pending command states.

---

## 17) Proper MVP Operational Flow

This is the required MVP operator runbook (Mission Planner style behavior target).

### Step 1: Start SITL

- Open `Simulation`.
- Start SITL with desired vehicle/profile.
- Keep auto-connect enabled when using default SITL output.

Expected:

- Simulation status becomes `RUNNING`.

### Step 2: Auto-Connect MAVLink

- Open `Flight Data`.
- Confirm transport connects (`CONNECTING -> CONNECTED`).

Expected:

- Telemetry stream live.
- Vehicle marker appears and updates.

### Step 3: View Live Telemetry

Verify in Flight Data:

- HUD values change over time.
- GPS, battery, mode, heartbeat age valid.
- Map follows vehicle (if auto-follow enabled).

### Step 4: Create Mission

- Open `Flight Planner`.
- Add waypoints manually or use `Survey grid`.
- Configure altitudes/commands/parameters in table.

Expected:

- Waypoints render on map and table consistently.

### Step 5: Upload Mission

- Click `Write`.
- Monitor `XFER` transfer status and final result.

Expected:

- Upload reaches `DONE` with `ok=true`.
- No hidden protocol failures.

### Step 6: ARM

- Return to `Flight Data`.
- Trigger `ARM`.

Expected:

- Command log shows pending -> accepted.
- UI indicates armed state.

### Step 7: Start AUTO Mission

- Set mode `AUTO` (Flight Data selector or Planner control).
- Trigger `Start Mission`.

Expected:

- Mission begins executing.
- Mission current waypoint increments over time.

### Step 8: Watch Route Execution Live

Observe:

- Vehicle movement on map and trail growth.
- Waypoint progress in planner (`CURRENT` highlight).
- HUD + telemetry reflect active flight.

### Step 9: Trigger RTL / LAND

- Use quick actions to issue `RTL` or `LAND`.

Expected:

- ACK reported in command history.
- Mode transition visible.
- Vehicle path reflects return/landing behavior.

### Step 10: Review Logs / Messages

- Open `Help & Diagnostics`.
- Inspect MAVLink message distribution.
- Analyze flight log (if available), export CSV summary.

Expected:

- Post-flight diagnostics are available without external tooling for basic triage.

---

## MVP Acceptance Criteria

MVP is considered operational when all conditions are true:

- End-to-end flow runs without manual restarts between steps.
- No critical dead buttons in core flight workflow.
- No critical broken routes in normal operation path.
- Mission write/read/start cycle is reliable.
- Command ACK/result visibility is present to operator.
- Live vehicle execution is visible on map + telemetry + mission progress.
- RTL/LAND safety actions are dependable and user-visible.

---

## Known Non-MVP / Deferred (Still Acceptable for MVP)

- Full Mission Planner parity for terrain/corridor/structure scans.
- Advanced log FFT/graph tooling.
- Full transponder tab depth and advanced map provider suite.
- Full swarm orchestration manager UI.

These remain backlog items and do not block MVP operational readiness.

