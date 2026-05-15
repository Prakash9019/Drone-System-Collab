# DATA TAB IMPLEMENTATION PLAN
## Mission Planner Feature Parity — Complete Analysis & Roadmap

---

## 1. CURRENT STATE GAP ANALYSIS

### 1.1 What Exists (Partial/Broken)

| Component | File | Gap Level |
|-----------|------|-----------|
| AdvancedHUD | `AdvancedHUD.jsx` | 40% — Basic horizon, no speed/alt tapes, no roll arc, no VSI |
| QuickTab | `QuickTab.jsx` | 55% — Shows blank when disconnected, only 11 fields |
| ActionsTab | `ActionsTab.jsx` | 50% — 10 actions only, API wrong for some paths |
| PreFlightTab | `PreFlightTab.jsx` | 30% — Only 6 checks, blank when disconnected |
| StatusTab | `StatusTab.jsx` | 70% — Good but blank when disconnected |
| ServoTab | `ServoTab.jsx` | 60% — Good but blank when disconnected |
| MessagesTab | `MessagesTab.jsx` | 85% — Good |
| TelemetryRegistry | `TelemetryRegistry.js` | 30% — Only 11 fields, missing 30+ MP fields |

### 1.2 Core Problem
Every tab that receives `vehicleState` returns early with a blank/error message when disconnected.
Mission Planner renders the complete UI even without a drone — values show 0 / N/A / Disconnected.

---

## 2. IMPLEMENTATION PHASES

---

### PHASE 1 — DISCONNECTED STATE FIX (All Tabs)

**Problem:** All tabs return empty when `vehicleState` is null.
**Fix:** Provide a safe `DEFAULT_STATE` object used when no vehicle is connected.
**Files:** QuickTab, PreFlightTab, StatusTab, ServoTab

**Default value strategy:**
- Numbers → 0 or 0.0
- Strings → "—" or "N/A"
- GPS → 0 fix, 0 sats
- Arm → Disarmed (safe)
- Checks → FAIL (honest, not misleading)

---

### PHASE 2 — TELEMETRY REGISTRY EXPANSION

**Target: 45+ telemetry fields** matching Mission Planner's Quick tab options.

**Fields to add:**
```
airspeed           Airspeed (m/s)
heading            Heading (deg)
roll               Roll (deg)
pitch              Pitch (deg)
throttle           Throttle (%)
vertClimbRate      Climb Rate (m/s)
distTraveled       Distance Traveled (m)  [accumulated]
timeInAir          Time in Air (s)        [accumulated from arm]
windSpeed          Wind Speed (m/s)       [from wind message]
windDir            Wind Direction (deg)
range              Rangefinder (m)
ch1-ch8            RC Channels 1-8
servo1-servo8      Servo Output 1-8
ekfVelVar          EKF Velocity Variance
ekfHorizVar        EKF Horiz Variance
ekfVertVar         EKF Vert Variance
ekfCompassVar      EKF Compass Variance
rcRssi             RC Signal Strength
boardVoltage       Board Voltage (V)
temp               Temperature (°C)
vibX / vibY / vibZ Vibration X/Y/Z
clip0/1/2          Vibration Clipping
latency            Link Latency (ms)
packetLoss         Packet Loss (%)
```

---

### PHASE 3 — HUD COMPLETE REBUILD

**Target:** Mission Planner HUD visual & functional parity at ~95%.

#### 3.1 Visual Layout (Mission Planner Reference)

```
┌─────────────────────────────────────────┐
│  [Roll Arc with tick marks at top]      │
│ ┌──────────────────────────────────────┐│
│ │ N  45  E  135  S  225  W  315  N  45 ││  ← Compass Strip
│ └──────────────────────────────────────┘│
│                                         │
│ ┌─────┐ ╔════════════════╗ ┌─────┐     │
│ │ 30  │ ║  SKY (Blue)    ║ │ 120 │     │  ← Speed Tape | Horizon | Alt Tape
│ │ 25  │ ║───── pitch10 ──║ │ 110 │     │
│ │►20  │ ║──── pitch5 ───║ │►100 │     │
│ │ 15  │ ║────── 0 ──────║ │ 90  │     │
│ │ 10  │ ║═══════════════║ │ 80  │     │
│ │  5  │ ║  GND (Brown)   ║ │ 70  │     │
│ └─────┘ ╚════════════════╝ └─────┘     │
│         [Wing Symbol (fixed)]           │
│                                         │
│ [GPS: 3D FIX 12sats] [EKF: OK]         │
│ [ARMED] [STABILIZE] [Bat: 12.6V 85%]   │
│ [Climbrate: +0.3m/s]  [HDOP: 1.2]     │
└─────────────────────────────────────────┘
```

#### 3.2 HUD Elements to Implement

| Element | Mission Planner Source | Implementation |
|---------|----------------------|----------------|
| Artificial Horizon | GDI+ drawing | CSS transform rotate+translateY |
| Sky/Ground gradient | GDI+ fill | CSS linear-gradient |
| Pitch Ladder (-30°→+30°, every 5°) | GDI+ lines+text | CSS absolute positioned divs |
| Roll Arc + ticks (±60°) | GDI+ arc | SVG arc |
| Center aircraft wings | GDI+ bitmap | CSS/SVG |
| Speed Tape (left, moving) | ZedGraph-style | CSS scrolling list |
| Speed Bug (current AS) | Marker | CSS highlighted center row |
| Altitude Tape (right, moving) | ZedGraph-style | CSS scrolling list |
| Alt Bug (current alt) | Marker | CSS highlighted center row |
| VSI needle/bar (right) | Custom GDI+ | CSS/SVG height-proportional bar |
| Compass Strip (top) | Repeating labels | CSS transform translate |
| N/E/S/W cardinal labels in compass | GDI+ text | Repeat pattern with letters |
| Heading digital readout | Label | CSS text |
| EKF status chip | Color-coded label | Colored span |
| GPS status chip | Color-coded label | Colored span |
| Arm status + mode | Bold overlay | Center top text |
| Battery overlay | Bottom text | Status bar |
| VIBE warning | Blinking text | Animated warning |
| Failsafe warning | Red blinking | Animated warning |
| "Not Ready to Arm" text | Status label | Red text overlay |
| Pre-arm failure reason | Status messages | Scrolling text |
| Throttle bar | Thin vertical bar | CSS width-based bar |

#### 3.3 Pitch Ladder Math
```
pitchOffset = pitchDeg * PIXELS_PER_DEGREE
Each line at: 0, ±5, ±10, ±15, ±20, ±25, ±30
Labels at: ±10, ±20, ±30
Line lengths: full (10, 20, 30) or half (5, 15, 25)
```

#### 3.4 Speed/Altitude Tape
```
Each tape: 200px tall visible window
Tape spacing: 10px per unit
Tape range: ±20 units visible
Center = current value, highlighted with colored box
Numbers shown every 5 units
```

---

### PHASE 4 — ACTIONS TAB EXPANSION

**Target:** All Mission Planner actions functional.

#### 4.1 Action Groups

**Group 1: Flight Control**
- ARM / DISARM
- TAKEOFF (with altitude input)
- LAND
- RTL
- LOITER
- LOITER UNLIMITED

**Group 2: Flight Modes**  
- STABILIZE, ALT_HOLD, LOITER, AUTO, GUIDED, LAND, RTL, CIRCLE, ACRO, SPORT, BRAKE, THROW, SMARTRTL, FLOWHOLD, ZIGZAG

**Group 3: Preflight Calibration (MAV_CMD_PREFLIGHT_CALIBRATION = 241)**
- Accel Calibrate (p5=1)
- Compass Calibrate (p6=1)  
- Level Horizon (p7=1)
- ESC Calibrate (p1=3)
- Gyro Calibrate (p1=1)

**Group 4: Advanced Actions**
- REBOOT FC (MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN=246, p1=1)
- REBOOT AP (p2=1)
- TRIGGER CAMERA (MAV_CMD_DO_DIGICAM_CONTROL=203)
- DO PARACHUTE (MAV_CMD_DO_PARACHUTE=208, p1=2)
- ENGINE START (MAV_CMD_DO_ENGINE_CONTROL=223, p1=1)
- ENGINE STOP (MAV_CMD_DO_ENGINE_CONTROL=223, p1=0)
- BATTERY RESET (MAV_CMD_BATTERY_RESET=2001)
- TOGGLE SAFETY SWITCH (MAV_CMD_DO_SET_SAFETY_SWITCH_STATE=2004)
- SET RELAY 1 ON/OFF (MAV_CMD_DO_SET_RELAY=181)

#### 4.2 Action Result Handling
- Show spinner while waiting for ACK
- Show green SUCCESS / red FAIL banner
- Display MAV_RESULT text
- Auto-clear banner after 5 seconds

---

### PHASE 5 — PREFLIGHT TAB EXPANSION

**Target:** Full Mission Planner pre-arm check replication.

#### 5.1 Check List (Mission Planner Reference)

| # | Check | Source Data | Pass Condition |
|---|-------|-------------|----------------|
| 1 | GPS Lock | `status.gps_fix` | >= 3 (3D Fix) |
| 2 | GPS Quality | `status.gps_hdop` | HDOP <= 2.0 |
| 3 | Satellites | `status.satellites` | >= 6 |
| 4 | EKF Health | `ekf_status.flags` | flags != 0 |
| 5 | EKF Velocity Variance | `ekf_status.velocity_variance` | < 0.5 |
| 6 | EKF Horiz Variance | `ekf_status.pos_horiz_variance` | < 0.5 |
| 7 | EKF Vert Variance | `ekf_status.pos_vert_variance` | < 0.5 |
| 8 | EKF Compass Variance | `ekf_status.compass_variance` | < 0.5 |
| 9 | Battery Voltage | `battery.voltage` | >= 10.5V |
| 10 | Battery Level | `battery.remaining` | >= 20% |
| 11 | Sensor Health | `status.sensors_health` | == sensors_present |
| 12 | Compass Present | `status.sensors_present & 4` | present bit set |
| 13 | Accel Present | `status.sensors_present & 1` | present bit set |
| 14 | Barometer | `status.sensors_present & 8` | present bit set |
| 15 | Gyro Health | `status.sensors_health & 2` | health bit set |
| 16 | RC Channels | `rc_channels.rssi` | > 0 |
| 17 | RSSI Adequate | `rc_channels.rssi` | >= 50 |
| 18 | Arm State | `status.armed` | false (safe to arm) |
| 19 | Failsafe Active | `status.failsafe` | false |
| 20 | Vibration X | `vibration.vibration_x` | < 30 |
| 21 | Vibration Y | `vibration.vibration_y` | < 30 |
| 22 | Vibration Z | `vibration.vibration_z` | < 30 |
| 23 | Clipping | `vibration.clipping_0` | == 0 |
| 24 | Link Active | `last_heartbeat` | < 3s ago |

#### 5.2 Summary Score
Show overall: X/24 checks PASSED  
Color: Green (≥20), Orange (15-19), Red (<15)

#### 5.3 Individual Check Display
Each check shows:
- Check name
- Current value
- PASS / FAIL / WARN / N/A badge
- Why it matters (tooltip)

---

### PHASE 6 — NEW TAB: GAUGES

**Replace current "Gauges" tab** (which shows an AdvancedHUD copy) with proper round/arc gauges.

#### Gauges to implement:
1. **Airspeed Gauge** — 0-50 m/s arc dial
2. **Groundspeed Gauge** — 0-50 m/s arc dial  
3. **Altitude Gauge** — 0-500m arc dial
4. **VSI Gauge** — -10 to +10 m/s needle
5. **Heading Compass Rose** — 0-360° rotating compass
6. **Battery Gauge** — 0-100% with voltage label
7. **Throttle Gauge** — 0-100% bar

Each gauge:
- CSS/SVG arc dial with needle
- Color-coded (green/orange/red zones)
- Shows current value as number overlay
- Works with default values when disconnected

---

### PHASE 7 — NEW TAB: AUX FUNCTIONS

Mission Planner has AUX function switches. Add:

- DO_SET_RELAY (relay 1/2/3 ON/OFF)
- DO_REPEAT_RELAY
- DO_SET_SERVO (channel + PWM)
- RC Override controls (CH1-CH8)
- Camera trigger controls
- Scripting commands (start/stop)

---

### PHASE 8 — MAP ENHANCEMENTS

Current: Basic MapLibre with drone tracking.

Mission Planner additions needed:
- Drone icon rotates with heading (yaw)
- Track trail (path line showing flight history)
- Home marker with house icon
- Waypoint numbers displayed on map
- Geofence polygon overlay (from /fence API)
- Rally point markers
- Distance rings (100m, 500m, 1km circles around home)
- ADSB traffic markers (already partially done)
- Right-click context menu: "Fly Here", "Set Home", "Set ROI"
- Map tile provider options (Satellite, Road, Terrain)

---

## 3. API MAPPING

### Backend Endpoints (Python service port 8000, Node gateway port 8080)

| Action | Method | Path | Body |
|--------|--------|------|------|
| ARM | POST | `/api/shortcuts/arm` | `{}` |
| DISARM | POST | `/api/shortcuts/disarm` | `{}` |
| TAKEOFF | POST | `/api/shortcuts/takeoff` | `{"altitude_m": N}` |
| RTL | POST | `/api/shortcuts/rtl` | `{}` |
| LAND | POST | `/api/shortcuts/land` | `{}` |
| Set Mode | POST | `/api/mode` | `{"mode": "STABILIZE"}` |
| MAVLink Command | POST | `/api/mavlink/command` | `{command, p1-p7}` |
| Parameters | GET | `/api/parameters/status` | — |
| Set Param | POST | `/api/parameters/set` | `{param_id, param_value}` |
| Calibrate | POST | `/api/calibration/run` | `{"kind": "accelerometer"}` |
| Preflight | GET | `/api/preflight` | — |

---

## 4. IMPLEMENTATION STATUS TRACKER

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Disconnected state — all tabs | PLANNED |
| 2 | TelemetryRegistry expansion (45+ fields) | PLANNED |
| 3 | HUD — artificial horizon + compass | PLANNED |
| 3 | HUD — speed tape + altitude tape | PLANNED |
| 3 | HUD — pitch ladder (-30° to +30°) | PLANNED |
| 3 | HUD — roll arc indicator | PLANNED |
| 3 | HUD — VSI bar | PLANNED |
| 3 | HUD — EKF/GPS status chips | PLANNED |
| 3 | HUD — arm/failsafe/mode overlay | PLANNED |
| 3 | HUD — battery status | PLANNED |
| 3 | HUD — VIBE warnings | PLANNED |
| 4 | Actions — all flight control buttons | PLANNED |
| 4 | Actions — calibration group | PLANNED |
| 4 | Actions — advanced actions group | PLANNED |
| 4 | Actions — takeoff altitude input | PLANNED |
| 4 | Actions — result banner | PLANNED |
| 5 | PreFlight — 24 checks | PLANNED |
| 5 | PreFlight — summary score | PLANNED |
| 5 | PreFlight — works when disconnected | PLANNED |
| 6 | Gauges tab — 7 instrument gauges | PLANNED |
| 7 | AUX tab | PLANNED |

---

## 5. CSS ARCHITECTURE

All new styles go in `index.css` under clear section headers.

New CSS sections needed:
```
/* HUD v2 — Speed Tape */
/* HUD v2 — Altitude Tape */
/* HUD v2 — Pitch Ladder */
/* HUD v2 — Roll Arc */
/* HUD v2 — VSI Bar */
/* HUD v2 — Status Chips */
/* Gauges Tab */
/* PreFlight Tab v2 */
/* Actions Tab v2 */
/* AUX Tab */
```

---

## 6. IMPLEMENTATION ORDER (Priority)

```
STEP 1:  TelemetryRegistry.js — add 35+ fields
STEP 2:  QuickTab.jsx — fix disconnected state
STEP 3:  PreFlightTab.jsx — full 24 checks + disconnected
STEP 4:  ActionsTab.jsx — all actions + groups + API fix
STEP 5:  AdvancedHUD.jsx — complete rebuild
STEP 6:  GaugesTab.jsx — new file
STEP 7:  AuxTab.jsx — new file
STEP 8:  TelemetryGrid.jsx — add Gauges and AUX tabs
STEP 9:  index.css — add all new styles
STEP 10: ServoTab.jsx / StatusTab.jsx — disconnected state fix
```
