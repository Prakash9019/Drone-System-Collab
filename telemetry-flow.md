# Mission Planner HUD — Telemetry Flow

End-to-end path from **MAVLink** to **on-screen HUD values** for the Mission Planner C# HUD (`ExtLibs/Controls/HUD.cs`), hosted on **Flight Data** (`GCSViews/FlightData.cs`).

## 1. High-level sequence

```mermaid
sequenceDiagram
  participant Link as Link_log_or_network
  participant MAV as MAVLink_interface
  participant CS as CurrentState_MAV_cs
  participant Loop as FlightData_mainloop_thread
  participant UI as UI_dispatcher
  participant BS as bindingSourceHud
  participant HUD as HUD_control

  Link->>MAV: bytes_frames
  MAV->>CS: packet_handler_updates_fields
  Loop->>UI: BeginInvoke_updateBindingSourceWork
  UI->>BS: UpdateDataSource_MAV_cs
  BS->>HUD: DataBindings_write_properties
  HUD->>HUD: Invalidate_on_change
  UI->>HUD: OnPaint_doPaint
```

**Rates (typical):**

- MAVLink: message-driven (e.g. `ATTITUDE` at vehicle-configured rate).
- Binding push to HUD: **throttled ~10 Hz** in `FlightData.updateBindingSource` (100 ms minimum between `updateBindingSourceWork` runs).
- Paint: event-driven from `Invalidate()`; optional **~30 ms** minimum spacing between paints when there is no video `bgimage`.

## 2. Data ownership

| Piece | Role |
|-------|------|
| `MainV2.comPort.MAV.cs` | Live `CurrentState` instance for the active MAV |
| `CurrentState` | All parsed telemetry fields; large `switch (MAVLINK_MSG_ID)` updates properties |
| `bindingSourceHud` | WinForms `BindingSource` bound to `CurrentState` type; refreshed with `UpdateDataSource(MAV.cs)` |
| `hud1` (`HUD`) | Visual control; properties bound to `CurrentState` field names |

The HUD **does not** parse MAVLink; it only displays bound properties.

## 3. Binding map (Flight Data HUD)

Declared in `FlightData.Designer.cs` — each line is `hud1` property ← `bindingSourceHud` ← `CurrentState` member:

| HUD property | CurrentState field (typical) |
|--------------|------------------------------|
| `airspeed` | `airspeed` |
| `alt` | `alt` |
| `load` | `load` |
| `batterylevel` / `current` / `batteryremaining` | `battery_voltage` / `current` / `battery_remaining` |
| `batterylevel2` / `current2` / `batteryremaining2` | `battery_voltage2` / `current2` / `battery_remaining2` |
| `connected` | `connected` |
| `datetime` | `datetime` |
| `disttowp` | `wp_dist` |
| `ekfstatus` | `ekfstatus` |
| `failsafe` | `failsafe` |
| `gpsfix` / `gpsfix2` | `gpsstatus` / `gpsstatus2` |
| `gpshdop` / `gpshdop2` | `gpshdop` / `gpshdop2` |
| `groundalt` | `HomeAlt` |
| `groundcourse` | `groundcourse` |
| `groundspeed` | `groundspeed` |
| `heading` | `yaw` |
| `linkqualitygcs` | `linkqualitygcs` |
| `message` / `messageSeverity` | `messageHigh` / `messageHighSeverity` |
| `mode` | `mode` |
| `navpitch` / `navroll` | `nav_pitch` / `nav_roll` |
| `pitch` / `roll` | `pitch` / `roll` |
| `prearmstatus` | `prearmstatus` (computed getter) |
| `safetyactive` | `safetyactive` |
| `status` | `armed` |
| `targetalt` | `targetalt` |
| `targetheading` | `nav_bearing` |
| `targetspeed` | `targetairspeed` |
| `turnrate` | `turnrate` |
| `verticalspeed` | `verticalspeed` |
| `vibex` / `vibey` / `vibez` | `vibex` / `vibey` / `vibez` |
| `wpno` | `wpno` |
| `xtrack_error` | `xtrack_error` |
| `AOA` / `SSA` / `critAOA` | `AOA` / `SSA` / `crit_AOA` |
| `lowairspeed` | `lowairspeed` |

## 4. MAVLink messages → HUD-critical fields

Primary messages feeding attitude, navigation, health, and tapes:

| `MAVLINK_MSG_ID` | Updates (representative) |
|------------------|---------------------------|
| `ATTITUDE` | `roll`, `pitch`, `yaw` (deg) — horizon + heading |
| `GLOBAL_POSITION_INT` | `alt` (relative), lat/lon, velocities |
| `GPS_RAW_INT` | `gpsstatus`, `gpshdop`, sats, `groundspeed` / `groundcourse` when valid |
| `GPS2_RAW` | `gpsstatus2`, `gpshdop2`, second receiver fields |
| `NAV_CONTROLLER_OUTPUT` | `nav_roll`, `nav_pitch`, `nav_bearing`, `wp_dist`, `xtrack_error` |
| `HEARTBEAT` | `armed`, `mode`, **`failsafe`** (`MAV_STATE.CRITICAL`) |
| `EKF_STATUS_REPORT` | Variance fields + `flags` → computed **`ekfstatus`** scalar |
| `SYS_STATUS` | `load`, battery fields, `onboard_control_sensors_*` → `sensors_*` → **`prearmstatus`** getter, **`safetyactive`**, health messages |
| `VFR_HUD` | `airspeed`, `groundspeed`, climb / throttle-related state; **`lowairspeed`** when params + airspeed sensors allow |
| `HIGH_LATENCY` / `HIGH_LATENCY2` | Condensed attitude, GPS, failsafe for telemetry/log modes |

Many other messages update `CurrentState` for gauges, messages, and custom HUD user items; the table above is the **backbone** for the standard HUD face.

## 5. Derived / computed values relevant to the HUD

- **`ekfstatus`:** In `CurrentState`, from `EKF_STATUS_REPORT`: max of several variances, then flag-bit logic can force a high value (treated as unhealthy in the HUD when `> 0.5` / `> 0.8`).
- **`prearmstatus`:** Not stored; getter combines `connected` with `SYS_STATUS`-derived `sensors_health` / `sensors_enabled` prearm bits.
- **`failsafe`:** From `HEARTBEAT` `system_status` (CRITICAL) or high-latency packets — **not** every ArduPilot “failsafe” reason; it reflects MAVLink vehicle state as interpreted by Mission Planner.

## 6. Threading summary

| Thread | Work |
|--------|------|
| MAVLink / reader | Parse packets, update `CurrentState` |
| `FlightData.mainloop` | Sleep, housekeeping, call `updateBindingSource()` |
| UI thread | `updateBindingSourceWork`, binding writes, `OnPaint` / `doPaint` |

Cross-thread: only **`CurrentState`** is written from the link side; the HUD reads via **bindings** marshaled to the UI thread, reducing direct cross-thread access to the control.

## 7. Explicit non-scope

- **React `drone_gcs`** `AdvancedHUD` — different stack (`vehicle` props, Web APIs), not described here.
- **Parameter download**, mission upload, and map logic — unrelated to HUD telemetry path except indirect effects on `CurrentState`.

---

*Generated for architecture reference; does not modify Mission Planner or GCS code.*
