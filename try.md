# try.md — Mission Execution + Debug Playbook

**Date**: 2026-05-25
**Audience**: pilot running the GCS / following step-by-step
**Companion docs**: `FLIGHT_PLANNER_USER_GUIDE.md`, `FLIGHT_PLANNER_MISSION_CENTRALIZED.md`, `FLIGHT_PLANNER_MISSION_AUDIT_TABLE.md`

This file is the **only** thing you need to follow to reproduce / debug the failing mission ("takes off, climbs, moves slightly, then RTLs back unexpectedly"). Read top to bottom. Do **not** skip steps.

---

## 0. TL;DR — the most likely root cause

> **Your fence is still enabled from a previous session, and its polygon does not enclose your current home.**

Verified from `drone_gcs/python_service/param_cache/1_1.json`:

```
FENCE_ENABLE  = 1     ← fence is ON
FENCE_ACTION  = 1     ← action on breach = RTL
FENCE_TYPE    = 7     ← AltMax + Circle + Polygon, all armed
FENCE_TOTAL   = 11    ← 11 polygon vertices loaded on the autopilot
FENCE_RADIUS  = 1000  (1 km — OK on its own)
FENCE_ALT_MAX = 1000  (OK)
```

When ArduPilot arms with a polygon fence and the takeoff point is *outside* every inclusion polygon, the **moment the drone moves a metre out of the GPS noise circle it scores a Polygon breach → FENCE_ACTION=1 → RTL**. From the operator's seat this looks exactly like:

> takes off → climbs → moves slightly → returns back

If that does not match what you see, the rest of this document walks every other failure mode and a clean way to reproduce.

**HOME is NOT being rewritten by "Insert TAKEOFF".** The code does not call `set_home_location` from that path — see §3 below. The thing that *moves* when you click "Insert TAKEOFF" is the **first WP table row** (index 0), and the new TAKEOFF marker is rendered *on top of* the existing HOME marker because TAKEOFF is auto-placed at HOME's lat/lng. Two markers at the same pixel ≠ HOME being rewritten.

---

## 1. CONCEPTS — HOME vs TAKEOFF (read this once, never reread)

Mission Planner / ArduPilot model:

| concept   | what it is                                                                 | where it lives                                   | how to change it                                              |
| --------- | -------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| HOME      | the anchor point the drone returns to on RTL. Always mission **seq 0**.    | autopilot EEPROM, streamed as `HOME_POSITION`    | `MAV_CMD_DO_SET_HOME` (179) — or autopilot sets it on arming  |
| TAKEOFF   | a **mission command** (cmd 22) that tells Copter to climb to a target alt  | **seq 1** in the uploaded mission                | "Insert TAKEOFF" button — adds a row at the **top of the WP table** |
| EKF origin| where the EKF anchors its math. May differ from HOME on first GPS lock.    | autopilot internal; streamed as GPS_GLOBAL_ORIGIN| set by autopilot                                              |

Key parity facts vs MP:

1. The **WP table index 0 is your TAKEOFF**. The autopilot's HOME is inserted **server-side** as seq 0 by `_inject_home()` in `python_service/mission_manager.py:150-174` at the moment of upload. You never type HOME into the WP table.
2. The HOME marker on the map (white "H" icon) is rendered from telemetry `vehicle.home`, **not** from any WP table row. Inserting TAKEOFF does not touch it.
3. After **Read**, the downloaded mission contains the autopilot's HOME at index 0 of the table (because that's what the autopilot stores at seq 0). This is a display difference from MP — see User-Error #4 below.

---

## 2. MISSION COMMAND CHEAT SHEET

| cmd | name          | what it does                                                                 |
| --- | ------------- | ---------------------------------------------------------------------------- |
| 16  | NAV_WAYPOINT  | fly to lat/lng/alt and continue                                              |
| 17  | LOITER_UNLIM  | hold at a point forever                                                      |
| 20  | NAV_RTL       | return to launch (= HOME)                                                    |
| 21  | NAV_LAND      | land at lat/lng                                                              |
| 22  | NAV_TAKEOFF   | takeoff to param7 alt; lat/lng IGNORED on Copter (uses current position)     |

These are the only five you need to fly a mission.

---

## 3. STEP-BY-STEP EXECUTION (do this exactly)

### STEP 1 — bring up the stack

1. Start the python service, the node API, and the frontend (whatever your usual `start.sh` / `npm start` is). Open the GCS in the browser.
2. **Setup → connect to the vehicle / SITL.** Wait until:
   - HUD mode is something other than UNKNOWN (e.g. STABILIZE / GUIDED)
   - GPS fix is **3** or higher
   - **HOME marker** is visible on the map (white "H" icon)

If HOME is not visible after ~10s of connection, the autopilot has not streamed `HOME_POSITION` yet. Do not proceed. Wait. If it never arrives, your SITL has no GPS lock.

### STEP 2 — wipe stale fence FIRST (this is the bug you're hitting)

You almost certainly have leftover fence state. Clear it before you touch anything else.

1. **Flight Planner → mission-type dropdown** → choose **FENCE**.
2. Look at the **Fence diagnostics** panel (the green/red row at the top):
   - If **Enabled = YES** with Action = RTL, that's the killer.
   - If **HOME inside inclusion** = NO (amber), the takeoff point is outside your polygon.
3. Click **Read** (this downloads the current onboard fence into the table). Even if you don't see polygons drawn on the map, the table will show how many vertices are stored. Per your param cache, this is currently **11 vertices**.
4. Click **Clear** (clears the table) → click **Write** (uploads zero vertices) → wait for `XFER … DONE` in the toolbar.
5. In the **fence config row**, uncheck **Enable** → click **Apply Fence Config**. Watch `XFER` until DONE.
6. Re-read the diagnostics: it should now show **Enabled = NO**.

> If you actually *want* a fence, use a polygon that encloses your takeoff and a margin >0. Don't skip this step on the assumption "I'll deal with the fence later" — it is what's causing your RTL.

### STEP 3 — set HOME (only if needed)

You only need to do this if HOME is missing, at (0,0), or your autopilot is at the wrong location.

- **Preferred**: right-click the map → **Set home here**. This sends `MAV_CMD_DO_SET_HOME` (179) via `link_manager.set_home_location` (`mavlink_link.py:628`).
- **Verify**: the white "H" marker moves to where you clicked, and `vehicle.home.valid` flips true (visible in the HUD / status row).

What HOME does *not* affect: TAKEOFF altitude. TAKEOFF climbs by `param7` of cmd 22, relative to HOME.

### STEP 4 — build the mission (correct order)

1. **Flight Planner → mission-type dropdown = MISSION**.
2. **Insert TAKEOFF first.** Two ways, both correct:
   - Right-click on the map anywhere → **Insert TAKEOFF**. (After the M1 fix in `MapEditor.jsx:373-389`, this **inserts at index 0** using HOME's lat/lng — not at the end.)
   - Or click the red **⚠ Insert TAKEOFF** button that appears in the mission toolbar when you don't have one yet (`FlightPlanner.jsx:566-571`).
   The TAKEOFF marker appears as **"0"** on top of the HOME marker. This is correct. Lat/lng of TAKEOFF is ignored by Copter; only alt matters.
3. **Open the WP table** and confirm row 0 shows `cmd=22`, `alt=10`. Adjust alt if you want (10 m is sensible for SITL).
4. **Left-click the map** to drop NAV_WAYPOINTs (cmd 16). Each click appends a row. Set the alt in the WP table (default 50 m).
5. **End the mission**: right-click an empty map area → **Insert RTL** (or **Insert LAND**). This appends `cmd=20` (or `21`) at the end. This is the **only correct place for RTL**.

Validated mission shape:

```
WP table (what you see):                Onboard mission (what _inject_home builds):
  0: TAKEOFF  cmd=22  alt=10              seq 0: HOME      cmd=16  (auto-injected, your HOME)
  1: WAYPOINT cmd=16  alt=50              seq 1: TAKEOFF   cmd=22  alt=10
  2: WAYPOINT cmd=16  alt=50              seq 2: WAYPOINT  cmd=16  alt=50
  3: RTL      cmd=20                      seq 3: WAYPOINT  cmd=16  alt=50
                                          seq 4: RTL       cmd=20
```

> The +1 shift between "WP table index" and "MAVLink seq" is **normal**. The Mission Execution panel handles it (`MissionExecutionPanel.jsx:70`). When ArduPilot says "WP 1 active", that is your TAKEOFF — not your first NAV_WAYPOINT.

### STEP 5 — WRITE

1. Verify the **pre-flight checklist** chips in the mission toolbar:
   - ✓ Connected, ✓ GPS lock, ✓ Home set, ✓ TAKEOFF cmd, ✓ Waypoints. (`FlightPlanner.jsx:611-628`)
   - Some chips (Armed, AUTO mode) will still be ✗ at this point — that's fine, you arm later.
2. Click **Write**. Watch the `XFER:` counter in the toolbar:
   - `upload SENDING_COUNT 0/N` → `UPLOADING_ITEMS i/N` → `DONE N/N`.
   - If you see `FAILED`, read the `error: …` token — see Debug Checks below.
3. Optional but recommended: click **Read**. The mission downloaded back will have **one extra row at the top** — that's the HOME ArduPilot stored at seq 0. If row 0 shows `cmd=16` with your HOME's lat/lng, the upload + readback is correct.

### STEP 6 — START THE MISSION

1. Go to **Flight Data**.
2. Click **ARM**. If it's rejected:
   - The message will name the failed pre-arm check. Address it (most commonly GPS, EKF, or a pre-arm failsafe).
   - If it says "mode not armable", switch to **GUIDED** or **STABILIZE** first, then ARM, then change to AUTO.
   - Do **not** force-arm to bypass the check; the symptom that brought you here looks like a fence breach, force-arming will not help.
3. Once armed, go back to **Flight Planner** (the chip row will show ✓ Armed).
4. Click **Set AUTO**. Wait for the mode chip to flip to **AUTO** (~1 sec).
5. Click **Start Mission**.
   - This sends `MAV_CMD_MISSION_START` (300) via the node API mapping in `node_api/server.js:293`.
   - You should see, in order:
     - throttle ramps up
     - drone lifts off
     - alt climbs to the TAKEOFF target (10 m by default)
     - active WP chip advances: HOME → TAKEOFF → WP1 → WP2 → … → RTL
     - on the RTL row, the autopilot flips mode to RTL (this is the "Mission complete" badge in `MissionExecutionPanel.jsx:88-101` — it is **not** a failsafe).
   - End: drone returns to HOME, descends, lands, disarms.

---

## 4. USER-ERROR CHECKLIST (read each one against what you're seeing)

| #  | Mistake                                                                                                       | Symptom                                                                                  | Fix                                                                                  |
| -- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1  | Fence enabled from a prior session, polygon doesn't enclose HOME                                              | takes off, climbs, moves slightly, RTLs (your current report)                            | Step 2 above. **This is #1 by a wide margin in this codebase.**                      |
| 2  | TAKEOFF inserted at the **end** of the mission instead of index 0                                             | mission upload validates, but AUTO refuses with "Auto: Missing Takeoff Cmd"              | Use **⚠ Insert TAKEOFF** button (auto-places at index 0)                             |
| 3  | RTL inserted in the **middle** of the mission, not the end                                                    | takes off, flies to some waypoints, then RTLs early                                      | Delete the misplaced RTL row. RTL must be the **last** item.                         |
| 4  | After `Read`, user edits row 0 (HOME) by mistake thinking it's their first WP                                 | next Write actually moves the autopilot's HOME (because seq 0 of an upload sets HOME)    | Do not touch row 0 after a Read. To remove it, click **Clear** and rebuild.          |
| 5  | Forgot to click **Write** after editing                                                                       | autopilot still has the old mission; new edits aren't on the drone                       | Click Write. Watch for `DONE` in the XFER counter.                                   |
| 6  | TAKEOFF alt set to 0 (or left at the FENCE-mode default)                                                      | drone arms, "takes off" to 0 m, never leaves the ground, then RTLs at end of mission     | Set TAKEOFF row alt to something like 10 m in the WP table.                          |
| 7  | Waypoint altitudes above `FENCE_ALT_MAX`                                                                      | takeoff OK, climb to first WP triggers AltMax breach → action=RTL                        | Either lower WP alts or raise `FENCE_ALT_MAX` (Flight Planner → FENCE → Apply Config) |
| 8  | Mode set to AUTO before ARM                                                                                   | ARM rejected ("not armable in AUTO" depending on version) or "Auto: Missing GPS"         | ARM first (GUIDED / STABILIZE), then switch to AUTO, then Start Mission.             |
| 9  | "Set home here" used right before Write, vehicle.home telemetry hasn't streamed back yet                      | mission uploads with stale HOME at seq 0, autopilot accepts → HOME reset to old value    | Wait ~2 s after Set Home until the white H marker visibly moves, then Write.         |
| 10 | Only one waypoint between TAKEOFF and RTL, sitting inside the WPNAV_RADIUS                                    | takes off, "reaches" WP1 immediately, RTLs                                               | Place WP1 ≥ WPNAV_RADIUS away from HOME (default 200 cm, but check your params)      |
| 11 | GCS failsafe armed (`FS_GCS_ENABLE=2`) and the GCS link drops mid-mission                                     | mission ends mid-way with mode flipping to RTL or LAND                                   | Stable link; or set FS_GCS_ENABLE=0 for SITL bench-testing.                          |
| 12 | Battery failsafe                                                                                              | mid-mission mode flip to RTL/LAND, STATUSTEXT will say so                                | Check `BATT_LOW_VOLT` / `BATT_FS_LOW_ACT` in Params.                                 |
| 13 | EKF failsafe (`FS_EKF_ACTION=3` is "Land")                                                                    | mid-mission flip to LAND with "EKF variance" STATUSTEXT                                  | Recalibrate compass / accel; do not raise FS_EKF_ACTION blindly.                     |

---

## 5. DEBUG CHECKLIST (when the mission misbehaves)

Open these one by one. If everything passes, you have an autopilot-config issue (params), not a GCS issue.

### 5.1 — Did the upload actually land?

- **Mission toolbar** → `XFER:` counter should show `upload DONE N/N` after Write.
- **Click Read** → re-downloaded mission count = your uploaded count + 1 (the extra +1 is HOME at seq 0). If the count is off, the upload was partial.

### 5.2 — Is the mission seq sane during the run?

- **Flight Data → Mission Execution panel** shows the live `mission seq` and which item is active. It also resolves the +1 shift (planner row vs autopilot seq).
- If `mission seq` jumps straight to your RTL row, the mission is structurally bad (RTL too early, mis-placed, or the autopilot tripped a failsafe and flipped to RTL mode — see 5.5).

### 5.3 — Is HOME where you expect?

- HUD chip should show `Home set`.
- Right-click on the map → "Set home here" → confirm the white H marker jumps. If it doesn't move at all, the autopilot is rejecting `MAV_CMD_DO_SET_HOME` (check STATUSTEXT for `DO_SET_HOME failed`).

### 5.4 — Is the active WP advancing while you watch?

- The active WP chip in the mission toolbar (`WP: i / N`) should tick up as the drone reaches each item.
- If it stays on a low number and the drone is already RTLing, mode was changed *externally* (failsafe / fence). Go to 5.5.

### 5.5 — Has a failsafe / fence breach flipped the mode?

- **STATUSTEXT** ribbon (Flight Data → status messages, also stored in `vehicle.status_messages`). Look for any of:
  - `Fence Breach Polygon` — fence polygon hit (this is your #1 suspect)
  - `Fence Breach Circle` — circle radius hit
  - `Fence Breach Alt Max` / `Alt Min` — alt limits hit
  - `RTL: Critical battery` — battery failsafe
  - `EKF variance` / `EKF primary changed` — EKF failsafe
  - `RC: Failsafe` — RC link lost
  - `GCS Failsafe` — GCS link lost (`FS_GCS_ENABLE`)
- **Fence diagnostics panel** (Flight Planner → FENCE mode): if `Breach (live)` shows YES, the autopilot is currently in breach.
- The Mission Execution panel will badge "Mission complete" *only* when the mode flip to RTL/LAND matches the seq pointing at a final cmd 20/21. Anything else is a failsafe — not normal end-of-mission.

### 5.6 — Are the relevant params sane?

From `param_cache/1_1.json` (currently snapshotted):

| param            | current  | what to make of it                                                    |
| ---------------- | -------- | --------------------------------------------------------------------- |
| `FENCE_ENABLE`   | **1**    | **Disable for testing** unless you actively want the fence            |
| `FENCE_ACTION`   | 1 (RTL)  | If you keep the fence, RTL on breach is fine                          |
| `FENCE_TYPE`     | 7        | AltMax + Circle + Polygon; pare back if you only want one             |
| `FENCE_TOTAL`    | 11       | 11 polygon vertices loaded — if you didn't draw them, Clear+Write     |
| `FENCE_RADIUS`   | 1000     | OK on its own, only bites if Circle bit (2) is set in FENCE_TYPE      |
| `FENCE_ALT_MAX`  | 1000     | OK                                                                    |
| `FENCE_MARGIN`   | 2        | OK                                                                    |
| `FS_GCS_ENABLE`  | 2        | Continue mission if GCS link lost; set 0 for solo bench tests         |
| `FS_EKF_ACTION`  | 3        | Land on EKF failsafe — keep                                           |
| `RTL_ALT`        | 50       | RTL climbs to 50 m before returning — match your WP alts or expect a climb |
| `BATT_LOW_VOLT`  | 3.9 V/cell| not directly causing RTL unless cells sag                            |

Refresh params via Setup → Refresh, or `POST /api/parameters/refresh`.

### 5.7 — Did MISSION_ACK return ACCEPTED?

In `mission_manager.py:317-323` the upload reports the last ACK type. Phase `DONE` with `ok=true` means `MAV_MISSION_ACCEPTED`. Anything else (INVALID_SEQUENCE, ERROR, NO_SPACE) leaves a hint in `transfer_status.error` and is shown in the toolbar's XFER row.

---

## 6. MISSION PLANNER PARITY — quick reference

| MP concept                                                | this GCS — equivalent                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| WP table: row 0 = HOME (read-only)                        | WP table: row 0 = TAKEOFF (HOME is *server-side injected* on upload)                  |
| HOME altitude: takes home alt                             | `_inject_home()` uses `vehicle.home.alt_m`                                            |
| "Insert TAKEOFF" via toolbar inserts as row 1             | "Insert TAKEOFF" inserts as row 0 (because we don't show HOME); same MAVLink result   |
| Auto Mode requires TAKEOFF                                | enforced client-side: `blockingErrors()` refuses Write without cmd 22                 |
| Fence draw → Save fence → Enable                          | Draw polygon → Write → Enable in fence config → Apply                                 |
| Mission complete = mode flips to RTL                      | Same; UI badges "Mission complete" in MissionExecutionPanel                           |
| `MISSION_ITEM_INT` upload                                 | `mission_manager.upload_mission` uses `mission_item_int_send` (`mission_manager.py:266`) |
| MP appends HOME automatically                             | `_inject_home()` does it on the python side (`mission_manager.py:150-174`)            |

---

## 7. WHAT TO ACTUALLY DO RIGHT NOW

1. Open Flight Planner → switch to **FENCE** → confirm what your fence diagnostics say.
2. **Clear fence** (table empty → Write) + **disable fence** (Apply Config with Enable unchecked).
3. Switch to **MISSION**. Wipe the table (**Clear**).
4. Drop **⚠ Insert TAKEOFF** → 2-3 NAV_WAYPOINTs spaced ≥ 10 m apart from HOME and from each other → right-click → **Insert RTL** at the end.
5. Write. Wait for `XFER DONE`.
6. Flight Data → **ARM**.
7. Flight Planner → **Set AUTO** → **Start Mission**.
8. Watch the Mission Execution panel as the active WP advances. Drone should: climb to 10 m → fly each waypoint → climb to `RTL_ALT` (50 m) on the RTL row → return → land → disarm.

If after step 2 the symptom is gone, the fix was fence-only — there is no GCS code bug to chase.

If after step 2 the symptom persists, capture:
- the full STATUSTEXT ribbon (especially the line at the moment the drone starts returning)
- `transfer_status.error` after Write
- the WP table contents (export via **Save File**)

…and bring them back to the next session. With those three artefacts the exact failure mode is unambiguous.

---

## 8. WHAT THIS DOCUMENT IS NOT

- It is **not** an architecture doc. Read `FLIGHT_PLANNER_MISSION_CENTRALIZED.md` for the full mission-protocol audit.
- It is **not** a list of every WP command. The five in §2 are the ones you need.
- It is **not** a substitute for reading STATUSTEXT. The autopilot tells you why it RTLed; read what it says.
