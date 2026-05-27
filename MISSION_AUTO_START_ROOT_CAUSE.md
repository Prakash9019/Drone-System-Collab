# Mission AUTO / "WP jumps 0→1 on Set AUTO" — Root Cause & Fix (SETTLED)

**Date**: 2026-05-27
**Status**: Resolved. This document is the authoritative answer to the recurring
report *"clicking Set AUTO advances the WP counter from 0/4 to 1/4 before I press
Start Mission."* Read this before re-investigating — the premise that the GCS
sends `MISSION_START` on Set AUTO is **false** and was verified false across all
four layers.

---

## 1. The report

```
Mission:  0=TAKEOFF  1=WP1  2=WP2  3=RTL      (planner table; HOME injected as seq 0 on upload)
Flow:     Write → ARM → Set AUTO
Symptom:  the WP counter immediately reads 1/4 without clicking Start Mission.
```

**Observed (confirmed with the operator, 2026-05-27): the counter moves to 1/4 but
the vehicle stays on the ground.** It does not climb, does not RTL. Only the number
changes.

## 2. Root cause

The `0 → 1` change is the **autopilot's own `MISSION_CURRENT`**, not anything the GCS sends.

- When ArduCopter enters AUTO (with a valid EKF origin), `ModeAuto` runs
  `mission.start_or_resume()`, which sets the mission state to RUNNING and advances
  the current command from seq 0 (HOME) to the **first NAV command — seq 1, your
  TAKEOFF**. It emits `MISSION_CURRENT(seq=1)`.
- The vehicle does **not** fly yet. Physical execution of the TAKEOFF is gated by
  ArduCopter's `auto_armed` flag, which becomes true only when the **throttle is
  raised** (real TX) **or** `MAV_CMD_MISSION_START` is received (our Start Mission
  button). On the bench/SITL with the throttle at idle, the vehicle sits armed and
  waiting — exactly what the operator saw.

So `MISSION_CURRENT = 1` means *"the autopilot's cursor is on the TAKEOFF"*, which
is **not** the same as *"the mission has started."*

### Why this is NOT a GCS bug (verified path)

| Layer | File:line | What Set AUTO does |
|-------|-----------|--------------------|
| Frontend | `FlightPlanner.jsx:513` `setMode()` | calls `setFlightMode(mode)` → `POST /api/mode` **only** |
| Frontend | `FlightPlanner.jsx:524` `startMission()` | the **only** caller of `mission_start`; wired solely to the Start Mission button (`:770`). No `useEffect` auto-fires it. |
| Node | `server.js:344` `/api/mode` | pure proxy to Python `/mode`; no command coupling |
| Python | `mavlink_link.py:584` `set_mode()` | sends `set_mode_send(custom_mode)` **only** |
| Python | `message_handlers.py:155` | `state.mission_current_seq = int(msg.seq)` — records the autopilot's value verbatim, never forces it |

There is no code path in which entering AUTO sends `MAV_CMD_MISSION_START` (300).

## 3. Mission Planner parity

Mission Planner behaves **identically** — it does not mask the seq:

- `CurrentState.cs:3403` → `wpno = wpcur.seq;` (maps `MISSION_CURRENT` straight to the
  displayed current WP, same as us).
- `CurrentState.cs:3405` → `if (mode.ToLower() == "auto" && wpno != 0) lastautowp = (int)wpno;`
  — MP's own code expects `wpno` to be **non-zero in AUTO**, confirming the cursor
  advances to ≥1 on AUTO entry.

Therefore *masking the seq to keep it at 0 would diverge from Mission Planner, not
match it.* The correct fix is to **label the run-state**, keeping the real seq.

## 4. The fix (shipped)

UI-clarity only. We keep the real `MISSION_CURRENT` seq (MP parity) and add an
explicit run-state derived from telemetry so "WP 1/N while holding" can't be
misread as "started".

| File | Change |
|------|--------|
| `frontend/src/pages/FlightPlanner.jsx` | Added `missionRunState` (`DISARMED` / `ARMED` / `HOLDING` / `RUNNING`) from `armed`, `inAutoMode`, and `airborne` (`position.alt_rel > 0.8 m`). Mission row now shows **"⏸ HOLDING · mission not started — seq N is the autopilot's TAKEOFF cursor. Click Start Mission."** when armed+AUTO on the ground, and **"▶ RUNNING"** once airborne. |
| `frontend/src/components/MissionExecutionPanel.jsx` | Added matching `holding` detection (`vehicleArmed && mode==AUTO && !airborne && seq≥1`). Shows a **"HOLDING · NOT STARTED"** badge and an explanatory note next to WP Progress. |

**Run-state definition** (FlightPlanner.jsx):

```
armed=false                       → DISARMED
armed + AUTO + on ground (≤0.8m)  → HOLDING   ← the case the operator hit
armed + AUTO + airborne (>0.8m)   → RUNNING
armed + not AUTO                  → ARMED
```

`airborne` flips on `position.alt_rel`, so the state tracks the real vehicle
whether the mission is started by Start Mission (MISSION_START) or by raising the
throttle.

## 5. Canonical execution flow

```
WRITE                                      mission uploaded; HOME injected at seq 0 (Python)
  │                                        onboard: 0=HOME 1=TAKEOFF 2=WP1 3=WP2 4=RTL
  ▼
ARM (Flight Data)                          motors armed; mode still STABILIZE/GUIDED
  │                                        MISSION_CURRENT = 0 → UI: WP 0/4
  ▼
Set AUTO                                    mode → AUTO. Autopilot runs mission.start_or_resume():
  │                                        MISSION_CURRENT → 1 (TAKEOFF cursor)
  │                                        UI: WP 1/4  ⏸ HOLDING · mission not started   ← EXPECTED
  │                                        vehicle stays on the ground (auto_armed not set)
  ▼
Start Mission                              sends MAV_CMD_MISSION_START (300) → auto_armed set
  │                                        UI: ▶ RUNNING
  ▼
TAKEOFF (seq 1)                            climbs to TAKEOFF alt
  ▼
WP1 (seq 2) → WP2 (seq 3)                  MISSION_CURRENT advances per waypoint reached
  ▼
RTL (seq 4)                                AUTO → RTL; UI: "MISSION COMPLETE" (not a failsafe)
  ▼
land → disarm
```

On a real vehicle the operator may instead start the mission by raising the
throttle in AUTO; `auto_armed` is set the same way and the UI flips HOLDING→RUNNING
on `alt_rel`. Either path is correct.

## 6. What this fix does NOT change

- It does **not** alter any MAVLink command, mode logic, or mission protocol.
- It does **not** mask or rewrite `MISSION_CURRENT` (that would break MP parity).
- It does **not** touch fence — fence was a separate, earlier theory (`try.md`) and
  the param cache no longer carries `FENCE_ENABLE=1`. This issue is independent.
