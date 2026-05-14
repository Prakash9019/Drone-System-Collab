# Mission Planner — CurrentState architecture

Deep reference for [`MissionPlanner/ExtLibs/ArduPilot/CurrentState.cs`](MissionPlanner/ExtLibs/ArduPilot/CurrentState.cs): responsibilities, mutation paths, derived fields, EKF/GPS/failsafe/arm/sensor logic, and concurrency. Companion: [`telemetry-state-flow.md`](telemetry-state-flow.md), [`mavlink-ingestion.md`](mavlink-ingestion.md), [`vehicle-state-model.md`](vehicle-state-model.md).

## 1. Purpose and scope

**`CurrentState`** is the **per-vehicle telemetry aggregate** Mission Planner exposes to the UI, speech, logging, and scripts. It is **not** the parameter list (that lives on **`MAVState.param`**) and not the mission waypoint store (that lives on **`MAVState.wps` / fencepoints / rallypoints`**), though many UI bindings read **`MAV.cs`** for telemetered position.

**Implements:** `ICloneable`, `IDisposable`.

## 2. Wiring to MAVLink

- Each **`MAVState`** owns **`public CurrentState cs = new CurrentState()`** and assigns **`cs.parent = this`** in the `MAVState` constructor.
- Setting **`parent`** subscribes **`parent.parent.OnPacketReceived += Parent_OnPacketReceived`** where **`parent.parent`** is the **`MAVLinkInterface`**.
- **`Dispose`** unsubscribes from **`OnPacketReceived`**.

## 3. Mutation entry points

| Entry | When | Notes |
|-------|------|--------|
| **`Parent_OnPacketReceived`** | Every `OnPacketReceived` after filter | Giant **`switch (msgid)`** updates fields. |
| **`MAVLinkInterface` direct** | Same reader path | e.g. **`STATUSTEXT`** updates **`messages`**, **`messageHigh`**; **`processInfoFromStream`** sets **`HomeLocation`** on `HOME_POSITION`, etc. |
| **`UpdateCurrentSettings(Action<CurrentState> bs, ...)`** | Periodic / explicit | **`lock (this)`**; link quality, timers, wind, stream re-requests; invokes **`bs`** and **`csCallBack`**. |

**Filtering in `Parent_OnPacketReceived`:** applies when `sysid/compid` match **`parent`**, **or** message is **`RADIO` / `RADIO_STATUS`** (link-wide), **or** (optional) **`NAMED_VALUE_FLOAT`** propagated across components of same sysid per setting.

## 4. Static and display configuration

- **`multiplierdist` / `multiplierspeed` / `multiplieralt`** and **`DistanceUnit` / `SpeedUnit` / `AltUnit`**: SI → display conversion for bound fields.
- **`rateattitudebackup`**, **`ratepositionbackup`**, **`ratestatusbackup`**, **`ratesensorsbackup`**, **`ratercbackup`**: defaults set in **static ctor** (e.g. attitude 4 Hz, position 2 Hz).
- Instance **`rateattitude`**, **`rateposition`**, **`ratestatus`**, **`ratesensors`**, **`raterc`**: restored in **`ResetInternals`** from backups — used when **`requestDatastream`** is called from **`UpdateCurrentSettings`**.

## 5. Derived and computed behavior (selected)

| Mechanism | Behavior |
|-----------|-----------|
| **`yaw` / `groundcourse` setters** | Normalize to 0–360°. |
| **`alt` setter** | Updates **`climbrate`** / **`verticalspeed`** from delta vs **`datetime`** when interval ≥ 0.2 s, unless **`gotVFR`** (then VFR climb preferred). |
| **`connected`** | `BaseStream` open **or** **`logreadmode`**. |
| **`prearmstatus`** getter | `connected && (sensors_health.prearm \|\| !sensors_enabled.prearm)`. |
| **`ter_curalt` / `ter_alt`** | Apply **`multiplieralt`** on get. |
| **`alt` get** | `(_alt - altoffsethome) * multiplieralt`. |
| **`dowindcalc`** | Fixed-gain observer using airspeed, yaw, pitch, groundspeed, groundcourse → **`wind_dir` / `wind_vel`**. |

## 6. Heartbeat handling (`HEARTBEAT` case)

- Skip MAV type **GCS** heartbeats in the main branch.
- **`armed`**: `(base_mode & SAFETY_ARMED) == SAFETY_ARMED`.
- On transition disarmed → armed: reset **`timeSinceArmInAir`** (with related air-time logic elsewhere).
- **`landed`**: `system_status == STANDBY`.
- **`failsafe`**: `system_status == CRITICAL`.
- **Safety messaging:** if armed and motor control not enabled in sensors but sensors “seen”, set **`messageHigh`** to safety hint.
- **`mode` / `_mode`**: when `CUSTOM_MODE_ENABLED`, resolve **`custom_mode`** through firmware-specific mode list; speech on mode change when enabled.

## 7. EKF state management (`EKF_STATUS_REPORT`)

- Unpack variances: velocity, compass, horizontal pos, vertical pos, terrain alt.
- Store **`ekfflags`** and set **`ekfstatus`** = **max** of variances.
- If any variance ≥ 1, set **`messageHigh`** to localized error string for that variance.
- **Flag loop:** missing expected **`EKF_STATUS_FLAGS`** bits can force **`ekfstatus = 1`** (e.g. no attitude; horizontal velocity missing when GPS lock); **`EKF_UNINITIALIZED`** sets **`ekfstatus = 1`**.

## 8. GPS state handling

- **`GPS_RAW_INT`**: `gpsstatus` = `fix_type`, HDOP, satellites, optional MAVLink2 accuracies and **`gpsyaw`**; may set lat/lon/altasl when **`useLocation`** is false; groundspeed/course from vel/COG when valid.
- **`GPS2_RAW`**: parallel second receiver (`gpsstatus2`, `lat2`, …).
- **`GLOBAL_POSITION_INT`**: relative alt, velocities; lat/lon with **`useLocation`** guards against zero/invalid.
- **`GPS_STATUS`**: legacy sat count.

## 9. Failsafe state logic

- **Primary:** **`failsafe = (heartbeat.system_status == MAV_STATE.CRITICAL)`** (non-GCS HB).
- **High latency / other paths:** packed telemetry can set **`failsafe`** (e.g. `HIGH_LATENCY` style messages in `CurrentState`).

**Semantic note:** This reflects **MAVLink `MAV_STATE`**, not a full decode of every ArduPilot internal failsafe reason.

## 10. Arm / disarm and safety

- **Arm state:** from **`HEARTBEAT`** `SAFETY_ARMED` bit (see §6).
- **`SYS_STATUS`:** **`safetyactive = !sensors_enabled.motor_control`** (motor interlock / safety switch presentation).

## 11. Sensor status management (`SYS_STATUS`)

- Assign **`sensors_enabled`**, **`sensors_health`**, **`sensors_present`** from **`onboard_control_sensors_*`** bitmasks (`**Mavlink_Sensors**` wrapper over **`MAV_SYS_STATUS_SENSOR`**).
- Set **`terrainactive`**, **`load`**, battery fields, error counts.
- **Prioritized `messageHigh`:** prearm failure text from last **`STATUSTEXT`** containing `"PreArm:"` when prearm sensor unhealthy; else GPS, gyro, accel, compass, baro, LiDAR, optical flow, vision, terrain, geofence, AHRS, etc. health strings.

## 12. Parameter synchronization (from CurrentState’s perspective)

- **Parameters are not stored in `CurrentState`.** They live in **`MAVState.MAVLinkParamList param`** and are updated in **`MAVLinkInterface.processInfoFromStream`** / param fetch routines.
- **`UpdateCurrentSettings`** and telemetry fields may **read** params via **`parent.parent.MAV.param`** in other code paths (e.g. low airspeed thresholds) — cross-layer but common pattern.

## 13. `UpdateCurrentSettings` (housekeeping)

Runs under **`lock (this)`**, gated to ~**20 Hz** (`DateTime.Now > lastupdate + 50 ms` unless `updatenow`):

- **Link quality:** if **`packetsnotlost`** nonzero and **`lastvalidpacket`** within 10 s, **`linkqualitygcs`** = percentage from lost vs not lost; else **0** if silent > 10 s.
- **Once per wall-clock second** (`datetime.Second` change): **`distTraveled`**, **`timeInAir` / `timeSinceArmInAir`** when armed and throttle/groundspeed thresholds met; **`dowindcalc`** if no dedicated wind message.
- **Stream re-request:** if **`lastdata`** older than ~8 s and stream open, **`requestDatastream`** for EXTENDED_STATUS, POSITION, EXTRA1/2, EXTRA3, RAW_SENSORS, RC_CHANNELS using **`rate*`** fields; then bump **`lastdata`** forward **30 s** to avoid flooding.
- **`csCallBack`** event, then **`bs?.Invoke(this)`** for binding refresh.

## 14. Concurrency and consistency

- **Reader thread** mutates many **`CurrentState`** fields without per-field locks.
- **`UpdateCurrentSettings`** uses **`lock (this)`** for its block — avoid calling back into long-running UI work inside the lock.
- Mission Planner historically accepts **short-term inconsistency** between consecutive messages; use **`MAVState`** locks for **`param`** and packet queues.

## 15. `ResetInternals`

Clears mode, messages, **`useLocation`**, restores **`rate*`** from static backups, resets **`datetime`**, battery integrators, distance/time counters, version/capabilities placeholders — used when resetting session state for a vehicle.

## 16. Reusable vs WinForms-specific

| Reusable backend | WinForms / binding |
|------------------|-------------------|
| Decode switch, EKF aggregation, GPS math, wind observer, sensor bitmask class | `BindingSource.UpdateDataSource`, designers, `BeginInvoke` in views |
| `UpdateCurrentSettings` stream requests (MAVLink API) | `Action<CurrentState>` delegates wired from forms |

---

*Architecture reference only; does not modify Mission Planner code.*
