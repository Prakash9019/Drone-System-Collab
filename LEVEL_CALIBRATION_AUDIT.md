# Level Calibration — Root Cause Audit & Mission Planner Parity Fix

**Status:** FIXED
**Scope:** Setup → Calibration → "Level Horizon" button only.
All other Setup features (Mission, Fence, Battery, Flight Modes, Radio, Motor Test, ESC, Gyro, Accel 6-pos, Compass) are intentionally left unchanged.

---

## 1. Symptom

| Action | Drone GCS result | Mission Planner result |
|---|---|---|
| Click `Setup → Calibration → Level Horizon → Run` | `level: UNSUPPORTED` | `Completed` (FC writes `AHRS_TRIM_X/Y`) |

The MAVLink ACK from ArduPilot for `MAV_CMD_PREFLIGHT_CALIBRATION` returned
`MAV_RESULT_UNSUPPORTED (3)`, which `command_manager.mav_result_text()` maps to the literal
string `"UNSUPPORTED"` (drone_gcs/python_service/command_manager.py:14).

---

## 2. Root Cause

`drone_gcs/python_service/main.py` was sending the wrong parameter slot of
`MAV_CMD_PREFLIGHT_CALIBRATION (241)` for the `level` preset.

### Before (broken)

```python
# drone_gcs/python_service/main.py:825-833 (before fix)
presets = {
    "accelerometer": {"command": 241, "p5": 1.0},
    "compass":       {"command": 42424, "p1": 0.0, "p2": 1.0, "p3": 1.0},
    "level":         {"command": 241, "p7": 1.0},   # ← BUG: p7=1 is ESC cal
    "esc":           {"command": 241, "p1": 3.0},
    "gyro":          {"command": 241, "p1": 1.0},
}
```

`param7 = 1` on `MAV_CMD_PREFLIGHT_CALIBRATION` is the **ESC calibration** parameter,
not level. Worse, when the FC sees this command without a valid level/accel/gyro flag
its `GCS_MAVLINK::_handle_command_preflight_calibration()` falls through to a
`MAV_RESULT_UNSUPPORTED` return because on a multicopter without an ESC-cal pathway
matching the magic param-shape (or because the value `1` doesn't satisfy the firmware's
`is_equal(packet.param5, 2.0f)` check used for board-level), ArduPilot rejects it.

The official MAVLink semantics for `MAV_CMD_PREFLIGHT_CALIBRATION (241)`:

| Param | Value | Meaning |
|---|---|---|
| param1 | 1 | Gyro calibration |
| param1 | 3 | Gyro temperature calibration |
| param2 | 1 | Magnetometer calibration |
| param3 | 1 | Ground pressure calibration |
| param4 | 1 | Radio RC calibration |
| param4 | 2 | RC trim calibration |
| **param5** | **1** | **Accelerometer 6-position calibration** |
| **param5** | **2** | **Board-level calibration ← THIS is "Level Horizon"** |
| param5 | 3 | Accelerometer temperature calibration |
| param5 | 4 | Simple accelerometer calibration |
| param6 | 1 | APM: compass-motor interference (PX4: airspeed, deprecated) |
| param6 | 2 | Airspeed calibration |
| param7 | 1 | ESC calibration |
| param7 | 3 | Barometer temperature calibration |

Source: `MissionPlanner/ExtLibs/Mavlink/Mavlink.cs:1088` (canonical enum description string).

### After (fixed)

```python
# drone_gcs/python_service/main.py:830 (after fix)
"level":         {"command": 241, "p5": 2.0},
```

---

## 3. Mission Planner & QGroundControl Parity Evidence

### Mission Planner (authoritative reference)

`MissionPlanner/GCSViews/ConfigurationView/ConfigAccelerometerCalibration.cs:143-163`:

```csharp
private void BUT_level_Click(object sender, EventArgs e)
{
    Log.Info("Sending level command (mavlink 1.0)");
    if (MainV2.comPort.doCommand((byte) MainV2.comPort.sysidcurrent,
                                 (byte) MainV2.comPort.compidcurrent,
                                 MAVLink.MAV_CMD.PREFLIGHT_CALIBRATION,
                                 0, 0, 0, 0, 2, 0, 0))  // ← p5 = 2
    {
        BUT_level.Text = Strings.Completed;
    }
    ...
}
```

### QGroundControl (cross-check)

`qgroundcontrol/src/Vehicle/Vehicle.cc:2357-2358`:

```cpp
case QGCMAVLink::CalibrationLevel:
    param5 = 2;
    break;
```

Both GCSes send the **exact** same `COMMAND_LONG` payload — there is no ambiguity here.

### Side-by-side payload

| Field | Mission Planner | QGroundControl | Drone GCS (BEFORE) | Drone GCS (AFTER) |
|---|---|---|---|---|
| command | 241 (`PREFLIGHT_CALIBRATION`) | 241 | 241 | 241 |
| param1 | 0 | 0 | 0 | 0 |
| param2 | 0 | 0 | 0 | 0 |
| param3 | 0 | 0 | 0 | 0 |
| param4 | 0 | 0 | 0 | 0 |
| **param5** | **2** | **2** | **0** ❌ | **2** ✅ |
| param6 | 0 | 0 | 0 | 0 |
| **param7** | **0** | **0** | **1** ❌ | **0** ✅ |
| confirmation | 0 (true=blocking but params unchanged) | 0 | 0 | 0 |
| target sysid/compid | primary | primary | primary | primary |

---

## 4. ACK Flow (after fix)

1. Frontend `Setup.jsx → CalibrationTab.runQuickCal('level')` → `POST /api/calibration/run { kind: 'level' }`.
2. Node API `server.js:470` forwards to Python `POST /calibration/run`.
3. Python `main.py:817 run_calibration` resolves preset → calls
   `link_manager.send_command(..., 241, 0,0,0,0, 2.0, 0,0)`.
4. `command_manager.execute_command` issues `COMMAND_LONG` and awaits `COMMAND_ACK` with matching `command == 241`.
5. ArduPilot's `_handle_command_preflight_calibration` matches `is_equal(packet.param5, 2.0f)` →
   runs `ins.calibrate_trim_simple()` → writes `AHRS_TRIM_X/Y` → returns `MAV_RESULT_ACCEPTED`.
6. `mav_result_text(0)` → `"ACCEPTED"`; response back to UI shows `level: ACCEPTED`.

Failure surface that *correctly* surfaces now:
- Vehicle armed → ArduPilot returns `MAV_RESULT_TEMPORARILY_REJECTED` (handled by existing front-end armed-check, also surfaced by `mav_result_text`).
- Vehicle moving during sample → ArduPilot returns `MAV_RESULT_FAILED` + STATUSTEXT.

---

## 5. Files Changed

| File | Change |
|---|---|
| `drone_gcs/python_service/main.py` | `"level"` preset switched from `p7=1.0` to `p5=2.0`; comment block updated to enumerate the full official param map for future maintainers. |
| `drone_gcs/frontend/src/pages/Setup.jsx` | Quick-cal card hint changed from `p7=1` to `p5=2`; doc.mavlink string updated to `param5=2 (board level cal)` to match the new wire format. |

No other Setup features touched. Mission, Fence, Battery, Flight Modes, Radio, Motor Test untouched.

---

## 6. Mission Planner Parity Summary

| Aspect | Mission Planner | Drone GCS (now) | Parity |
|---|---|---|---|
| MAVLink command ID | 241 | 241 | ✅ |
| Param packing | `p5=2`, rest 0 | `p5=2`, rest 0 | ✅ |
| Target sysid/compid | primary vehicle | primary vehicle | ✅ |
| Pre-arm check | requires DISARMED | requires DISARMED (front-end + FC) | ✅ |
| User instruction | "Place vehicle level then click" | "Place vehicle on flat, level surface" | ✅ |
| Success indication | button text → "Completed" | UI shows `level: ACCEPTED` | ✅ |
| Failure indication | dialog "Command Failed" | UI shows ACK text (FAILED/TEMPORARILY_REJECTED) | ✅ |
| Reboot required | No (params written immediately) | No | ✅ |

---

## 7. How to Verify

1. Boot ArduCopter SITL or real FC, connect Drone GCS.
2. Open `Setup → Calibration`, locate the **Level Horizon** quick-cal card under "Quick Calibration Actions".
3. Ensure vehicle is **disarmed** and physically level on a flat surface.
4. Click **Run**.
5. Expected status: `level: ACCEPTED` (previously: `level: UNSUPPORTED`).
6. Check `AHRS_TRIM_X` / `AHRS_TRIM_Y` parameters — they will have been updated to small non-zero offsets reflecting the IMU's mounted tilt.
