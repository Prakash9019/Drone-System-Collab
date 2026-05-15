# SETUP TAB IMPLEMENTATION PLAN
## Mission Planner Feature Parity — Setup/Calibration/Configuration

---

## 1. CURRENT STATE GAP ANALYSIS

| Feature | Current | Target |
|---------|---------|--------|
| Accel Calibration | Button only, no step guidance | Step-by-step 6-position workflow with STATUSTEXT tracking |
| Compass Calibration | Button only | Real-time MAG_CAL_PROGRESS polling, fitness display |
| Radio Calibration | Missing | Live channel bars, min/max recording, param write |
| Flight Mode Config | Missing | FLTMODE1-6 dropdowns with all modes |
| Failsafe Config | Missing | All FS_ params with descriptions |
| Battery Monitor | Missing | BATT_ params + live telemetry display |
| Motor Test | Missing | Individual motor spin, throttle/duration control, safety checks |
| Parameters Import | Partial | Add diff preview, confirm dialog, read-back verification |

---

## 2. BACKEND ROUTES ADDED

### Python (main.py)
| Route | Method | Purpose |
|-------|--------|---------|
| `/calibration/status` | GET | STATUSTEXT + MAG_CAL_PROGRESS for cal feedback |
| `/motor_test` | POST | MAV_CMD_DO_MOTOR_TEST (209) with safety validation |
| `/setup/flight_modes` | GET/POST | Read/write FLTMODE1-6 parameters |
| `/setup/failsafe` | GET/POST | Read/write all FS_ failsafe parameters |
| `/setup/battery` | GET/POST | Read/write BATT_ monitor parameters |
| `/setup/radio` | GET/POST | Read/write RC_MIN/MAX/TRIM/DZ params |

### MAVLink Commands Used
| Command ID | Name | Purpose |
|-----------|------|---------|
| 241 | MAV_CMD_PREFLIGHT_CALIBRATION | Accel (p5=1), Compass (p6=1), Level (p7=1) |
| 209 | MAV_CMD_DO_MOTOR_TEST | Individual motor test |
| 246 | MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN | Reboot FC |

---

## 3. SETUP TAB STRUCTURE

```
Setup Page
├── Calibration Tab
│   ├── AccelCalibration (step-by-step 6-position)
│   ├── CompassCalibration (progress bar + fitness)
│   ├── Level Horizon (quick button)
│   ├── ESC Calibration (safety warning)
│   └── Gyro Calibration
├── Radio Cal Tab
│   └── RadioCalibration (live bars, min/max, save)
├── Flight Modes Tab
│   └── FlightModeConfig (FLTMODE1-6 dropdowns)
├── Failsafe Tab
│   └── FailsafeConfig (all FS_ params)
├── Battery Tab
│   └── BatteryMonitor (BATT_ params + live display)
├── Motor Test Tab
│   └── MotorTest (per-motor spin, safety checks)
└── Parameters Tab
    └── Params.jsx (existing, enhanced)
```

---

## 4. SAFETY REQUIREMENTS

- Motor test: DISARMED check mandatory before execution
- Calibration: DISARMED check mandatory
- All param writes: use `set_parameter_verified()` with read-back
- Motor test: max throttle capped at 30% in backend
- Motor test: max duration capped at 10s in backend

---

## 5. PARAMETER REFERENCE

### Flight Modes (ArduCopter)
FLTMODE1-6 → RC switch positions (mapped from FLTMODE_CH ranges)

| Value | Mode |
|-------|------|
| 0 | Stabilize | 1 | Acro | 2 | AltHold | 3 | Auto |
| 4 | Guided | 5 | Loiter | 6 | RTL | 7 | Circle |
| 9 | Land | 16 | PosHold | 17 | Brake | 21 | Smart_RTL |

### Failsafe Params
- FS_BATT_ENABLE: 0=Disabled, 1=Land, 2=RTL, 3=SmartRTL, 4=SmartRTL+Land, 5=Terminate
- FS_RC_ENABLE: 0=Disabled, 1=Land, 2=RTL, 3=SmartRTL, 4=Brake+Land, 5=SmartRTL+Land  
- FS_GCS_ENABLE: 0=Disabled, 1=Land, 2=RTL, 3=SmartRTL, 4=SmartRTL+Land, 5=Terminate
- FS_EKF_ACTION: 1=Land, 2=AltHold, 3=Land+Disarm

### Battery Monitor Params
- BATT_MONITOR: 0=Disabled, 3=Voltage, 4=Voltage+Current, 7=SMBUS, 8=UAVCAN

### Radio Cal
- RC{n}_MIN/MAX: PWM limits per channel (typical 982-2006)
- RC{n}_TRIM: neutral PWM (typical 1500)
- RC{n}_DZ: dead zone around trim
- RC{n}_REVERSED: 0=normal, 1=reversed

---

## 6. IMPLEMENTATION STATUS

| Feature | Status |
|---------|--------|
| Backend: calibration/status | DONE |
| Backend: motor_test | DONE |
| Backend: setup/flight_modes | DONE |
| Backend: setup/failsafe | DONE |
| Backend: setup/battery | DONE |
| Backend: setup/radio | DONE |
| Node.js proxy routes | DONE |
| Frontend: AccelCalibration | DONE |
| Frontend: CompassCalibration | DONE |
| Frontend: RadioCalibration | DONE |
| Frontend: FlightModeConfig | DONE |
| Frontend: FailsafeConfig | DONE |
| Frontend: BatteryMonitor | DONE |
| Frontend: MotorTest | DONE |
| Frontend: Setup.jsx rebuild | DONE |
| CSS additions | DONE |


 Backend (Python — main.py)

  ┌──────────────────────────────┬─────────────────────────────────────────────────────────────────┐
  │            Route             │                             Purpose                             │
  ├──────────────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ GET /calibration/status      │ Returns recent STATUSTEXT + MAG_CAL_PROGRESS for calibration UI │
  ├──────────────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ POST /motor_test             │ MAV_CMD_DO_MOTOR_TEST (209), throttle capped at 30% for safety  │
  ├──────────────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ GET/POST /setup/flight_modes │ Read/write FLTMODE1-6 with verified parameter writes            │
  ├──────────────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ GET/POST /setup/failsafe     │ All FS_ params (battery/RC/GCS/EKF failsafe)                    │
  ├──────────────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ GET/POST /setup/battery      │ All BATT_ monitor params                                        │
  ├──────────────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ GET/POST /setup/radio        │ RC1-16 MIN/MAX/TRIM/DZ params                                   │
  └──────────────────────────────┴─────────────────────────────────────────────────────────────────┘

  mavlink_link.py — Added _mag_cal_cb hook in receive loop so MAG_CAL_PROGRESS/REPORT messages flow to calibration progress
  tracking.

  ---
  Backend (Node.js — server.js)

  Proxy routes added for all 6 new endpoint groups.

  ---
  Frontend — 7 Setup Tabs

  ┌─────────────┬─────────────────────────────┬──────────────────────────────────────────────────────────────────────────────┐
  │     Tab     │          Component          │                                   Feature                                    │
  ├─────────────┼─────────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Calibration │ AccelCalibration,           │ 6-position accel workflow with STATUSTEXT tracking; compass with             │
  │             │ CompassCalibration          │ MAG_CAL_PROGRESS bars; Level/ESC/Gyro/Reboot quick buttons                   │
  ├─────────────┼─────────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Radio Cal   │ RadioCalibration            │ Live PWM bars for all channels, records min/max while calibrating, writes    │
  │             │                             │ RC_MIN/MAX params                                                            │
  ├─────────────┼─────────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Flight      │ FlightModeConfig            │ FLTMODE1-6 dropdowns with all ArduCopter modes, highlights current active    │
  │ Modes       │                             │ mode                                                                         │
  ├─────────────┼─────────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Failsafe    │ FailsafeConfig              │ Battery/RC/GCS/EKF failsafe params with descriptions and select dropdowns    │
  ├─────────────┼─────────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Battery     │ BatteryMonitor              │ Live voltage/current/remaining display + all BATT_ params editable           │
  ├─────────────┼─────────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Motor Test  │ MotorTest                   │ Quad/hex layout diagram, per-motor selection, throttle/duration sliders,     │
  │             │                             │ DISARMED check, safety confirmation                                          │
  ├─────────────┼─────────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Parameters  │ Params (existing)           │ Full parameter sync, import/export, compare                                  │
  └─────────────┴─────────────────────────────┴──────────────────────────────────────────────────────────────────────────────┘
