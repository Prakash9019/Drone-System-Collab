# Data Tab — GPS / Altitude Telemetry Audit & Mission Planner Parity Fix

**Scope:** Drone GCS *Data Tab* (FlightData page → TelemetryGrid).
**In scope:** SAT count visibility, GPS health surfacing, altitude semantics (Alt / Alt ASL / Alt AGL).
**Out of scope (untouched):** mission, fence, battery, flight-mode, radio, motor-test, calibration tabs.

---

## 1. End-to-end telemetry chain

```
ArduPilot                                            Python (FastAPI)              Node                  React store / UI
─────────                                            ────────────────              ────                  ─────────────────
MAVLink message       →  message_handlers.py    →    VehicleState           →  /telemetry WS  →     useTelemetryStore  →   TelemetryRegistry
                                                                                                                              │
                                                                                                                              ├── AdvancedHUD
                                                                                                                              ├── QuickTab        (Data Tab)
                                                                                                                              ├── GaugesTab       (Data Tab)
                                                                                                                              ├── StatusTab       (Data Tab)
                                                                                                                              ├── PreFlightTab    (Data Tab)
                                                                                                                              └── Connection ribbon
```

| MAVLink field | Python field | WS path | Frontend usage |
|---|---|---|---|
| `GPS_RAW_INT.fix_type` | `status.gps_fix` (int 0-6) | `vehicle.status.gps_fix` | `gpsFix`, `gpsStatus`, HUD pill |
| `GPS_RAW_INT.satellites_visible` | `status.satellites` (int) | `vehicle.status.satellites` | `satellites` (renamed "Sat Count"), `gpsStatus`, HUD pill, PreFlightTab |
| `GPS_RAW_INT.eph` (HDOP × 100) | `status.gps_hdop` (float) | `vehicle.status.gps_hdop` | `gpsHdop`, `gpsStatus`, PreFlightTab |
| `GPS_RAW_INT.epv` (VDOP × 100) | `status.gps_vdop` (float) | `vehicle.status.gps_vdop` | `gpsVdop`, StatusTab |
| `GLOBAL_POSITION_INT.relative_alt` | `position.alt_rel` (m) | `vehicle.position.alt_rel` | **`altitude` → "Alt (Rel Home) (m)"**, HUD tape, GaugesTab |
| `GLOBAL_POSITION_INT.alt` | `position.alt_amsl` (m) | `vehicle.position.alt_amsl` | **`altAmsl` → "Alt ASL (m)"** |
| `TERRAIN_REPORT.current_height` (NEW) | `position.alt_terrain` (m) + `alt_terrain_valid` | `vehicle.position.alt_terrain` | **`altAGL` → "Alt AGL (m)"** (fallback source) |
| `RANGEFINDER.distance` / downward `DISTANCE_SENSOR` (NEW) | `position.rangefinder_dist` (m) + `rangefinder_valid` | `vehicle.position.rangefinder_dist` | **`altAGL` → "Alt AGL (m)"** (preferred source) |

---

## 2. Feature 1 — SAT count audit & fix

### State BEFORE the change

SAT count was already plumbed end-to-end:

| Layer | File | Status |
|---|---|---|
| MAVLink ingestion | `drone_gcs/python_service/message_handlers.py:83` `state.status.satellites = msg.satellites_visible` | ✅ Correct |
| Serialization | `drone_gcs/python_service/vehicle_state.py:198` `"satellites": self.status.satellites` | ✅ Correct |
| Registry widget | `drone_gcs/frontend/src/utils/TelemetryRegistry.js:196-201` (`satellites`, label "Satellites") | ✅ Existed |
| Default Quick Tab list | `drone_gcs/frontend/src/components/tabs/QuickTab.jsx:6-10` included `satellites` | ✅ Existed |
| HUD pill | `drone_gcs/frontend/src/components/AdvancedHUD.jsx:472-480` formatted as `"3D Fix 14"` | ✅ Existed |
| FlightData ribbon | `drone_gcs/frontend/src/pages/FlightData.jsx:277` `"GPS: 3D / 14 sats"` | ✅ Existed |
| PreFlightTab | `drone_gcs/frontend/src/components/tabs/PreFlightTab.jsx:81` | ✅ Existed |

### Why operators reported it as "not visible"

Two real UX problems:
1. The label was **"Satellites"** in plain text, not Mission Planner's familiar `"Sat Count"`.
2. Fix type / sat count / HDOP were **three separate cells**, each labelled differently — operators reading Mission Planner-style telemetry expect a **single combined line** that summarises GPS health in one glance.

### Fixes applied

1. **Renamed label** to match Mission Planner — `CurrentState.cs:395-398` exposes `satcount` with `DisplayText("Sat Count")`. We now use the same string:
   ```js
   // drone_gcs/frontend/src/utils/TelemetryRegistry.js
   satellites: { label: 'Sat Count', getValue: (s) => String(s?.status?.satellites ?? 0), ... }
   ```
2. **Added a combined `gpsStatus` widget** — a single Mission Planner-style readout:
   ```
   3D · 14 sats · HDOP 0.82
   ```
   This is now in the Quick Tab default layout, so the operator gets a one-line GPS health summary without enabling extra cells.
3. **Bumped QuickTab `LS_KEY` from `v2` → `v3`** so the new default cell layout takes effect even on browsers that cached the old layout.

---

## 3. Feature 2 — Altitude logic audit & fix

### Reference: what Mission Planner shows

From `MissionPlanner/ExtLibs/ArduPilot/CurrentState.cs`:

| MP property | MAVLink source | MP meaning | Drone GCS equivalent |
|---|---|---|---|
| `cs.alt` | `GLOBAL_POSITION_INT.relative_alt / 1000` (line 3251) | Altitude relative to HOME — the **primary HUD value** | `position.alt_rel` |
| `cs.altasl` | `GLOBAL_POSITION_INT.alt / 1000` (line 3263) | Altitude above mean sea level (ASL) | `position.alt_amsl` |
| `cs.ter_alt` | `TERRAIN_REPORT.terrain_height` (line 3221) | Height above terrain (AGL when terrain DB is loaded) | `position.alt_terrain` (added) |
| `cs.rangefinder1/2` | `RANGEFINDER.distance` / `DISTANCE_SENSOR` | Downward laser/ultrasonic AGL | `position.rangefinder_dist` (added) |

### State BEFORE the change

Backend mapping was **correct**, but frontend labels were **ambiguous**.

| Layer | What it showed | Truth |
|---|---|---|
| `message_handlers.py:95-96` | `alt_amsl = msg.alt/1000`, `alt_rel = msg.relative_alt/1000` | ✅ Correct |
| `TelemetryRegistry.altitude` | Label **`"Altitude (m)"`**, value `alt_rel` | ⚠ Ambiguous — looked like a generic altitude but was actually rel-home |
| `TelemetryRegistry.altAmsl` | Label **`"Alt AMSL (m)"`**, value `alt_amsl` | ⚠ Correct but the term AMSL/ASL was inconsistent with Mission Planner's "Alt ASL" |
| HUD altitude tape | Label **`"ALT"`**, value `alt_rel` | ⚠ Ambiguous — couldn't tell if rel-home or ASL |
| AGL | Not surfaced anywhere | ❌ Missing |
| `EKFStatus.terrain_alt_variance` was captured but the actual terrain altitude was never read from `TERRAIN_REPORT` | — | ❌ Missing |

### Fixes applied

1. **Backend (`drone_gcs/python_service/vehicle_state.py`)** — extended `Position` with:
   - `alt_terrain` + `alt_terrain_valid` (from `TERRAIN_REPORT.current_height`)
   - `rangefinder_dist` + `rangefinder_valid` (from `RANGEFINDER.distance` or a downward `DISTANCE_SENSOR`)

   Inline comments document the Mission Planner correspondence so future readers don't have to re-derive it.

2. **Backend (`drone_gcs/python_service/message_handlers.py`)** — new handlers:
   - `TERRAIN_REPORT` → writes `position.alt_terrain[_valid]`
   - `RANGEFINDER` → writes `position.rangefinder_dist[_valid]`
   - `DISTANCE_SENSOR` → only treated as AGL when `orientation ∈ {0, 25}` (downward / MAV_SENSOR_ROTATION_PITCH_270); converts `current_distance` cm → m.

3. **Frontend (`drone_gcs/frontend/src/utils/TelemetryRegistry.js`)** — labels now state explicitly *which* altitude is which:
   - `altitude` →  **`Alt (Rel Home) (m)`** (was: `Altitude (m)`)
   - `altAmsl`  →  **`Alt ASL (m)`** (was: `Alt AMSL (m)` — switched to MP's "ASL" wording)
   - `altAGL` (new) → **`Alt AGL (m)`** — prefers rangefinder, falls back to terrain database, shows `—` when neither is reporting (no fake/derived value).

4. **HUD tape (`drone_gcs/frontend/src/components/AdvancedHUD.jsx`)** — altitude footer label changed from `"ALT"` → **`"ALT (REL)"`** with a hover tooltip explaining it's `GLOBAL_POSITION_INT.relative_alt`.

5. **GaugesTab (`drone_gcs/frontend/src/components/tabs/GaugesTab.jsx`)** — `"Altitude"` arc gauge label → **`"Alt (Rel Home)"`**.

6. **StatusTab (`drone_gcs/frontend/src/components/tabs/StatusTab.jsx`)** — GPS rows now read:
   ```
   alt_rel_home_m  alt_asl_m  alt_agl_m
   ```
   with `alt_agl_m` falling back through rangefinder → terrain → `'--'` to mirror the Quick-tab widget.

7. **QuickTab default layout** (`drone_gcs/frontend/src/components/tabs/QuickTab.jsx`) — now leads with **the three altitude rows in order** (`altitude`, `altAmsl`, `altAGL`), so an operator sees Mission Planner-style telemetry at a glance:

   ```
   Alt (Rel Home) (m)     Alt ASL (m)        Alt AGL (m)        GroundSpeed (m/s)
   Vertical Speed (m/s)   Airspeed (m/s)     Heading (deg)      Throttle (%)
   Mission Seq            Dist to WP (m)     Dist to Home (m)   Time in Air
   Battery                GPS Status         Sat Count          GPS HDOP
   ```

---

## 4. Mission Planner parity matrix

| Telemetry concept | Mission Planner | Drone GCS (BEFORE) | Drone GCS (AFTER) | Parity |
|---|---|---|---|---|
| GPS Fix type | `gpsstatus` enum | `status.gps_fix` int | `status.gps_fix` int | ✅ |
| Satellite count, label | "Sat Count" | "Satellites" | **"Sat Count"** | ✅ |
| GPS HDOP | `gpshdop` | `status.gps_hdop` | `status.gps_hdop` | ✅ |
| Combined GPS one-liner | MP shows on map + HUD | none | **`gpsStatus` widget** `3D · 14 sats · HDOP 0.82` | ✅ |
| Primary altitude (HUD) | `alt` = relative-to-home | `alt_rel`, mislabelled "Altitude (m)" | `alt_rel`, **"Alt (Rel Home) (m)"** | ✅ |
| Sea-level altitude | `altasl` | `alt_amsl`, "Alt AMSL (m)" | `alt_amsl`, **"Alt ASL (m)"** | ✅ |
| Above-ground altitude | `ter_alt` / rangefinder | missing | **`altAGL`** widget, rangefinder→terrain→— | ✅ |
| HUD altitude label | "Alt" | "ALT" | **"ALT (REL)"** + tooltip | ✅ |
| Sources behind AGL | RANGEFINDER + TERRAIN_REPORT | not captured | both captured + `_valid` flags | ✅ |

---

## 5. Files changed

| File | Change |
|---|---|
| `drone_gcs/python_service/vehicle_state.py` | `Position` extended with `alt_terrain` + `alt_terrain_valid` + `rangefinder_dist` + `rangefinder_valid`; `to_dict()` updated; comments document MP correspondence. |
| `drone_gcs/python_service/message_handlers.py` | New handlers for `TERRAIN_REPORT`, `RANGEFINDER`, downward `DISTANCE_SENSOR`. |
| `drone_gcs/frontend/src/utils/TelemetryRegistry.js` | `altitude` label → "Alt (Rel Home) (m)"; `altAmsl` → "Alt ASL (m)"; new `altAGL` (rangefinder→terrain→—); new combined `gpsStatus` widget; `satellites` label → "Sat Count". |
| `drone_gcs/frontend/src/components/tabs/QuickTab.jsx` | `LS_KEY` v2 → v3; `DEFAULT_KEYS` reordered to lead with the three altitudes and the combined GPS status. |
| `drone_gcs/frontend/src/components/AdvancedHUD.jsx` | Altitude tape footer label "ALT" → "ALT (REL)" with hover tooltip. |
| `drone_gcs/frontend/src/components/tabs/GaugesTab.jsx` | Arc gauge label "Altitude" → "Alt (Rel Home)". |
| `drone_gcs/frontend/src/components/tabs/StatusTab.jsx` | GPS rows relabelled (`alt_rel_home_m`, `alt_asl_m`, `alt_agl_m`); `satellites` row → `sat_count`. |

No other Data-Tab features touched. Mission, Fence, Battery, Flight Modes, Radio, Motor Test, calibration code paths untouched.

---

## 6. How to verify

### SAT count
1. Connect to SITL or real vehicle.
2. Open *Data Tab → Quick*. Last row now reads:
   `Battery · GPS Status · Sat Count · GPS HDOP`
   - **GPS Status** cell shows `3D · 14 sats · HDOP 0.82` (single line).
   - **Sat Count** cell shows the integer count.
3. Hover the HUD's altitude tape footer → tooltip confirms it's `GLOBAL_POSITION_INT.relative_alt`.

### Altitude
1. SITL: at HOME (alt above MSL ≈ 584 m for KSFO) confirm:
   - `Alt (Rel Home) (m)` ≈ 0 on the ground, rises as the vehicle climbs.
   - `Alt ASL (m)` ≈ home elevation, rises by the same delta.
   - `Alt AGL (m)` shows `—` until a rangefinder or `TERRAIN_REPORT` is published, then shows the AGL value.
2. Real flight with downward rangefinder (e.g. LightWare SF11): `Alt AGL (m)` tracks measured ground distance.
3. Status Tab → GPS group lists three altitude rows with the new keys.

### Regression — nothing else should have moved
1. Setup → Calibration → Level Horizon still ACCEPTED (unchanged).
2. Mission, Fence, Failsafe, Battery, Flight Modes panels still render their existing data.
