# Premature RTL during AUTO mission — Root Cause & Fix (SETTLED, video + autopilot log)

**Date**: 2026-05-27
**Inputs**: full screen recording (`Screen Recording 2026-05-27 at 2.15.03 PM.mov`, 145 s) analysed
frame-by-frame, plus the autopilot's own **Messages (STATUSTEXT)** log from a re-run.
**Status**: Root cause confirmed by the autopilot itself. The cause is a **polygon fence breach**.

---

## 1. Symptom

Mission `TAKEOFF → WP → WP → RTL` (4.16 km span). Vehicle arms, enters AUTO, climbs,
flies a short distance, then switches to RTL and returns **before reaching WP1**. WP
progress never advances past seq 2.

## 2. Frame-by-frame timeline (recording starts 2:15:03 PM)

| Video t | Wall clock | Frame evidence |
|---|---|---|
| ~0–65 s | 2:15–2:16:09 | Flight Planner; mission written; `XFER: upload DONE 5/5` |
| ~67 s | 2:16:10 | `mode:AUTO` success **and** `ARMED → FLYING` at the same instant — vehicle lifts off on **Set AUTO** (SITL throttle was up → `auto_armed`) |
| 69 s | 2:16:12 | `mission_start` ACCEPTED (2 s after climb already began) |
| 72 s | 2:16:15 | WP table verified: `0 TAKEOFF / 1 NAV_WP / 2 NAV_WP / 3 RTL`, 4.16 km, `▶ RUNNING` |
| 86 s | 2:16:29 | WP 2/4, GS 9.7 m/s, AUTO, heading out |
| **94 s** | **2:16:37** | `FLYING → RTL`. GS → 0.5 m/s. Battery 75 %, GPS RTK-Fixed 10, EKF green |
| 95–97 s | 2:16:38–40 | Mode RTL; **no failsafe toast shown** |
| 143 s | 2:17:26 | Landed back home at 1.29 m; WP still 2/4 |

## 3. Autopilot's own reason (Messages / STATUSTEXT, re-run)

```
[INFO]   Mission: 2 WP
[NOTICE] Polygon fence breached      ← the trigger
[INFO]   Manual recovery started
[NOTICE] Fence breach cleared
```

**`Polygon fence breached` is the cause.** A polygon fence is enabled on the vehicle; the
mission flies outside it (~200 m from home), the breach fires, and the fence action returns
the vehicle. This matches the video exactly.

## 4. Why this was repeatedly mis-diagnosed as "not fence"

Two real GCS defects hid the autopilot's explanation:

1. **The breach message is severity `NOTICE` (5).** The HUD STATUSTEXT toast only showed
   severity ≤ 4 (`AdvancedHUD.jsx` `STATUSTEXT_TOAST_SEVERITY = 4`), so `Polygon fence
   breached` was **filtered out and never toasted** during flight. It only existed in the
   Messages tab, which the operator was not watching.
2. **The onboard fence persists in autopilot EEPROM.** Clearing the drawn polygon on the map
   does **not** clear `FENCE_TOTAL` / `FENCE_ENABLE` on the vehicle. So "we removed the fence"
   in the UI left a live fence on the autopilot. Confirmed earlier in `try.md` (the original
   fence theory) — it was correct; it was just invisible.

The vehicle, mission, upload, AUTO, and mission_start were all **working correctly** (see §6).

## 5. What was NOT the problem (verified)

- **Mission ordering / corruption** — the uploaded mission is correct. Video WP table is
  `TAKEOFF→WP→WP→RTL`; `mission_manager._inject_home` prepends HOME at seq 0 and renumbers
  **in order**; `upload_mission` sends items sequentially with `int(lat*1e7)` scaling. `XFER
  DONE 5/5`. No reorder, no coordinate mangling.
- **Premature mission completion / WP-reached bug** — WP stayed at seq 2; it never falsely
  "reached" anything. The RTL is external to the mission.
- **GCS-commanded RTL** — the Command/ACK log shows only `arm`, `mode:AUTO`, `mission_start`.
  No `rtl`. The mode flip is the autopilot's.
- **Battery / GPS / EKF failsafe** — at the RTL moment: battery 74 %, GPS RTK-Fixed 10 sats,
  EKF healthy.
- **The planned RTL** — that fires at seq 4 (4/4). This fired at seq 2.

## 6. The `0/4 → 1/4` on Set AUTO is normal (separate, already settled)

See `MISSION_AUTO_START_ROOT_CAUSE.md`. ArduCopter advances `MISSION_CURRENT` to the TAKEOFF
on AUTO entry; Mission Planner shows the same. Not a bug.

## 7. Fixes shipped (this pass)

| File | Change | Effect |
|------|--------|--------|
| `frontend/src/components/AdvancedHUD.jsx` | STATUSTEXT toast now also surfaces any line containing `fence` / `breach` / `failsafe` regardless of severity, and paints it red with a `FENCE` label | `Polygon fence breached` (NOTICE) now toasts in real time during flight |
| `frontend/src/components/MissionExecutionPanel.jsx` | New persistent **UNPLANNED RETURN** banner: when mode is RTL/LAND/BRAKE and it is *not* the planned mission end, show the autopilot's most recent fence/failsafe STATUSTEXT + the WP it happened at, with fence-clearing guidance | The operator instantly sees *why* it returned, instead of guessing |
| `frontend/src/pages/FlightData.jsx` | Pass `status_messages` + `fence_status.last_breach_text` into the panel | Feeds the banner |

These make the autopilot's reason **impossible to miss**. They do not (and cannot) stop a
real fence breach — that is autopilot behavior — they expose it.

## 8. How to actually stop the premature RTL (operator action)

The fence is on the **vehicle**, not the map. To clear it:

1. Flight Planner → mission-type **FENCE**.
2. **Read** (downloads the onboard fence; you will see the stored polygon vertex count).
3. **Clear** → **Write** (uploads zero vertices).
4. Uncheck **Enable** → **Apply Fence Config** (this writes `FENCE_ENABLE = 0`, verified by
   `main.py:/fence/config`). Confirm the Fence diagnostics panel shows **Enabled = NO**.
5. Re-fly. If you *want* a fence, draw a polygon that **encloses the whole mission** and set
   `FENCE_MARGIN < FENCE_RADIUS`.

## 9. Canonical execution flow

```
WRITE mission            HOME injected at seq 0 → onboard: 0 HOME / 1 TAKEOFF / 2 WP / 3 WP / 4 RTL
  │
CHECK FENCE (new)        FENCE tab → Read → confirm Enabled=NO (or polygon encloses mission)
  │
ARM                      armed; MISSION_CURRENT = 0  → WP 0/4
  │
Set AUTO                 MISSION_CURRENT → 1 (TAKEOFF cursor). On SITL with throttle up the
  │                      vehicle lifts off here; on a real TX it holds (see AUTO_START doc).
Start Mission            MAV_CMD_MISSION_START (if not already auto-armed)
  │
TAKEOFF → WP1 → WP2      MISSION_CURRENT advances per waypoint reached
  │                      ⚠ if a fence boundary is crossed → "Polygon fence breached" →
  │                         fence action → UNPLANNED RETURN (now banner + red toast)
RTL (seq 4)              planned end → "MISSION COMPLETE"
  │
land → disarm
```

## 10. Mission Planner parity

- MP surfaces fence breaches loudly (red HUD message + persistent message pane). Ours hid
  them behind a manual tab + a severity filter — now fixed (§7).
- Found a display inconsistency to note: the HUD prints `MISSION_CURRENT+1 / total` ("3/5")
  while the Mission panel prints `MISSION_CURRENT / total-1` ("2/4") for the same seq. Not
  the RTL cause; worth unifying in a follow-up.
