# Vehicle state schema (target)

Maps Mission Planner’s **`CurrentState` + `MAVState`** split ([`vehicle-state-model.md`](vehicle-state-model.md)) onto a **versioned, documented JSON model** for Drone-System-Collab. Today’s reference implementation is **`VehicleState`** + `to_dict()` in [`drone_gcs/python_service/vehicle_state.py`](drone_gcs/python_service/vehicle_state.py). **No code changes in this document** — schema design only.

---

## 1. Design principles

1. **Explicit units** in field metadata or naming (`*_deg`, `*_rad`, `*_ms`, `*_m`).
2. **Staleness** alongside values (target): `attitude.meta.stale`, `attitude.meta.updated_at`.
3. **Stable keys** for UI binding — avoid renaming without version bump.
4. **Separation:** **telemetry snapshot** ≠ **parameter dictionary** ≠ **mission arrays** (MP keeps params on `MAVState`; today `VehicleState.parameters` exists — document whether long-term it stays merged or splits).

---

## 2. Top-level object (conceptual)

```json
{
  "schema_version": "2026.1",
  "sysid": 1,
  "compid": 1,
  "connection_state": "CONNECTED",
  "position": {},
  "attitude": {},
  "velocity": {},
  "battery": {},
  "status": {},
  "ekf": {},
  "vibration": {},
  "rc": {},
  "servo": {},
  "navigation": {},
  "home": {},
  "messages": [],
  "link": {},
  "mission": { "current_seq": -1 }
}
```

---

## 3. Attitude (fix units)

| Field | Current code note | Target schema |
|-------|-------------------|----------------|
| roll / pitch / yaw | `handle_message` assigns **radians** from MAVLink `ATTITUDE` | Expose **`roll_deg`** etc. in snapshot **or** document `*_rad` and convert in HUD once |

Mission Planner stores **degrees** in `CurrentState` from rad conversion — **align** web HUD with degrees for ergonomics.

---

## 4. Status and sensors

Mirror MP `SYS_STATUS` usage ([`currentstate-architecture.md`](currentstate-architecture.md) §11):

- `sensors_present`, `sensors_enabled`, `sensors_health` as **int bitmasks** + optional **expanded** `{ "gyro": "OK|FAIL|OFF" }` for UI.

Add **derived**:

- `prearm_ready: boolean` (computed from bitmasks + optional STATUSTEXT parser).
- `failsafe: boolean` — policy: MAV_STATE CRITICAL from HEARTBEAT (MP) **plus** optional FC-specific STATUSTEXT.

---

## 5. EKF

Current: raw variances + flags in `ekf_status` object.

Target:

- `ekf.variances.{velocity, pos_horiz, ...}` — raw floats.
- `ekf.aggregate_score` — max variance (MP-style scalar).
- `ekf.health: "OK" | "WARN" | "BAD"` — thresholds aligned with MP HUD (>0.5 amber, >0.8 red) for consistency.

---

## 6. Link metadata

Extend `link_status` toward MP `linkqualitygcs` + `lastvalidpacket`:

```json
"link": {
  "quality_percent": 100,
  "packets_lost_est": 0,
  "packets_per_second": 45.2,
  "heartbeat_age_s": 0.4,
  "last_any_packet_age_s": 0.02
}
```

---

## 7. Messages

Cap list length (MP caps STATUSTEXT list); include `severity`, `text`, `t`.

---

## 8. Multi-drone envelope

WS may send:

```json
{ "kind": "FLEET_SNAPSHOT", "vehicles": { "1": { ... }, "2": { ... } } }
```

Or retain per-vehicle messages with `vehicle_id` (current pattern) — **pick one** in implementation phase; schema_version should bump if changed.

---

## 9. Map / HUD projections (derived views)

Not stored on wire from autopilot — **computed**:

- `map.chase`: lat, lng, heading, zoom hint.
- `hud.derived`: slip/skid placeholders, wind vector if `dowindcalc` equivalent added.

---

## 10. Compatibility matrix (migration)

| Current `to_dict` path | Target |
|------------------------|--------|
| Nested objects | Keep + add `meta` blocks |
| Flatten for perf | Optional second projection `vehicle.flat.*` |

---

*Design-only document.*
