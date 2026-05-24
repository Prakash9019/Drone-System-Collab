# FLIGHT PLANNER — USER GUIDE
**Audience**: GCS operators / pilots
**Companion**: `FLIGHT_PLANNER_CENTRALIZED.md` (architecture + audit), `FLIGHT_PLANNER_AUDIT_TABLE.md` (gap matrix)

This guide is button-by-button. If a step says "click X", click exactly that.

---

## TABLE OF CONTENTS

1. Before every flight (golden rule)
2. How to fly a MISSION
3. How to set up a FENCE (correct order)
4. How to read the FENCE DIAGNOSTICS PANEL
5. How to use SURVEY GRID
6. The Map / AutoPan
7. Troubleshooting

---

## 1. BEFORE EVERY FLIGHT — golden rule

**The SITL home must match the area you draw on the map.**

If you tell the Simulation page that home is Hyderabad and then draw the polygon over Hyderabad, the vehicle will arm at Hyderabad and stay inside your polygon. If the SITL was launched with the default Canberra home and you draw over Hyderabad, the vehicle is on the wrong continent and every fence check will fail.

```
Simulation page → Home field → 17.456979, 78.372855, 50, 0
              → click Reset Simulation
              → click Start Simulation
              → wait ~10 s for EKF to settle
```

---

## 2. HOW TO FLY A MISSION

> The mission flow is the one that's known to work. The fence and survey flows below build on top of it.

1. **Simulation** page → set home → **Reset Simulation** → **Start Simulation**.
2. **Flight Planner** page → mission-type dropdown **MISSION**.
3. Click on the map to drop a waypoint.
   - First click = where you want TAKEOFF. Change its cmd cell in the WP table to **22 (TAKEOFF)** and set alt to e.g. **10 m**.
   - Subsequent clicks add NAV_WAYPOINTs.
4. End the mission with **20 (RTL)** or **21 (LAND)**.
5. Click **Write**.
6. **Flight Data → Actions → ARM**.
7. Back in Flight Planner → **Set AUTO** → **Start Mission**.
8. Active WP is highlighted green on the map and in the WP table.

**Helpful buttons:**
- **⚠ Insert TAKEOFF** (only visible when WP 0 isn't TAKEOFF) — auto-inserts a TAKEOFF at HOME.
- **Save File / Load File** — `.waypoints` (QGC WPL 110) file IO, Mission Planner compatible.
- **Zoom Fit** — pans + zooms to fit every waypoint.

---

## 3. HOW TO SET UP A FENCE — correct order

### A. Start clean
1. **Simulation** page → set home → **Reset Simulation** → **Start Simulation**. Wait for EKF.
2. (Recommended) **Setup → Parameters** → look up `FENCE_ENABLE`. If it's `1` from a previous run, set to `0`. Look up `FENCE_RADIUS`: if it's small (< 200) and your mission goes farther, plan to bump it in step E.

### B. Draw the inclusion
3. **Flight Planner** → mission-type dropdown → **FENCE**.
4. Polygon radio → **Inclusion (5001)**.
5. Click on the map around your flight area. Min 3 points. The toolbar status updates: `Incl(Npts)`.

### C. (Optional) Draw an exclusion
6. Polygon radio → **Exclusion (5002)** → click around the no-fly area. Toolbar shows `Incl(4pts) + Excl(3pts)`.
   - Rule: exclusions only make sense **inside** an inclusion polygon.

### D. Upload the polygon list
7. Click **Write**. Wait for `FENCE uploaded successfully!` and the XFER counter to show `DONE`.

### E. Configure runtime behaviour (the row right below the toolbar)
8. ☑ **Enable**.
9. **Action** → **RTL**.
10. **Alt Max** → e.g. **120**.
11. **Alt Min** → leave at **0**.
12. **Radius** → set **larger than the farthest mission WP from HOME** (or disable Circle in step 13). If unsure: 500.
13. **Margin** → leave at **2** (must be `< Radius`).
14. **Types** (NEW) — bitmask checkboxes. Common picks:
   - **Polygon only**: ☑ AltMax, ☑ Polygon, ☐ Circle, ☐ AltMin → only the polygon + alt cap is enforced. **This is the safest pick when you're not sure what FENCE_RADIUS is set to**.
   - **Everything**: ☑ AltMax, ☑ Circle, ☑ Polygon — the Copter default. Use only if you've set Radius large enough.
15. Click **Apply Fence Config**. Wait for `Fence configuration applied.`.

### F. Verify with the Diagnostics Panel (NEW — see §4)
16. The panel should show:
    - Enabled: **YES**
    - Polygon active: **YES**
    - Circle active: **NO** (or YES with a radius you trust)
    - HOME inside inclusion: **YES**
    - HOME inside exclusion: **NO**
    - Breach (live): **NO**

If any of those are wrong, fix before arming. The most common mistake is HOME being outside the polygon — see Troubleshooting §7.

### G. Fly the mission
17. Switch mission-type → **MISSION**.
18. Draw your mission **inside** the inclusion, **outside** exclusions, **below** Alt Max.
19. Note the pre-flight strip now includes:
    - **HOME in fence** ✓ — HOME is inside inclusion + not in any exclusion
    - **WPs in fence** ✓ — every WP is inside the fence
    - **Alt < AltMax** ✓ — every WP alt is under FENCE_ALT_MAX
20. **Write** → **Flight Data → ARM** → back to planner → **Set AUTO** → **Start Mission**.

---

## 4. HOW TO READ THE FENCE DIAGNOSTICS PANEL

The panel appears under the fence config row when mission-type = FENCE. It has three layers:

### Top row — global state
- **Shield-green** icon = no breach right now.
- **Shield-red** icon + panel highlighted red = breach is active (FENCE_STATUS reports breach_status>0).

### Grid of indicators (read top-to-bottom, left-to-right)
| Indicator | Source | What "good" looks like |
|-----------|--------|------------------------|
| Enabled | `FENCE_ENABLE` param | YES (green) before flight |
| Polygon active | bit 4 of `FENCE_TYPE` | YES (green) if you drew polygons |
| Circle active | bit 2 + `FENCE_RADIUS>0` | NO unless you set Radius intentionally |
| Action on breach | `FENCE_ACTION` | Whatever you picked (usually RTL) |
| HOME inside inclusion | client-side ray-cast | YES |
| HOME inside exclusion | client-side | NO |
| Vehicle inside inclusion | client-side | YES (once GPS is good) |
| Vehicle inside exclusion | client-side | NO |
| Breach (live) | `FENCE_STATUS` msg | NO |
| Breach count | `FENCE_STATUS` msg | 0 |

### Bottom row — last fence message
Anything ArduPilot wrote about the fence to STATUSTEXT lands here verbatim. Examples you might see:
- `Fence Enabled` / `Fence Disabled`
- `Fence Breach Polygon` → you crossed an inclusion edge or entered an exclusion
- `Fence Breach Circle` → you exceeded FENCE_RADIUS
- `Fence Breach Alt Max` → you climbed past FENCE_ALT_MAX

These are the autopilot's own words. If something unexpected appears, screenshot it for debugging.

---

## 5. HOW TO USE SURVEY GRID

1. **Flight Planner** → mission-type **MISSION**.
2. Right-click the map at the **centre of your survey area** → **Survey grid…** (or click the toolbar **Survey grid** button — defaults to home).
3. In the modal, fill out:
   - **Center lat / lng** — pre-filled from your right-click; you can edit.
   - **Width / Length** — survey footprint in metres.
   - **Heading** — direction of flight lines (0 = north).
   - **Altitude** — flight altitude (relative).
   - **Along spacing** — distance between consecutive WPs on a stripe (smaller = more accurate, more WPs).
   - **Line spacing** — distance between parallel stripes.
4. (Optional) ☑ **Camera overlap mode** → enter overlap %, sensor width mm, focal length mm. Line spacing auto-computed from camera FOV at altitude.
5. **NEW — Camera + speed** (the new two-input row):
   - **Camera trigger every (m)** — emits `CAM_TRIGG_DIST` (cmd 206). 0 = no photos. Typical: 5 m at 50 m AGL.
   - **Survey speed (m/s)** — emits `DO_CHANGE_SPEED` (cmd 178). 0 = leave at `WPNAV_SPEED`. Typical: 5–8 m/s.
6. Options:
   - ☑ **Prepend TAKEOFF** — now placed at HOME (no longer at the first grid corner).
   - ☑ **Append RTL** — also emits a "stop camera" (CAM_TRIGG_DIST=0) before RTL so it doesn't shoot on the return leg.
   - ☑ **Spline WPs** — smoother turns.
7. Click **Replace mission** (wipes current mission) or **Append grid** (adds after existing WPs).
8. Inspect the WP table:
   - WP 0 = TAKEOFF at HOME
   - WP 1 = DO_CHANGE_SPEED (if you set speed)
   - WP 2 = CAM_TRIGG_DIST start (if you set camera)
   - WP 3+ = grid passes
   - Last but one = CAM_TRIGG_DIST stop
   - Last = RTL
9. **Write** → ARM → **Set AUTO** → **Start Mission**.

> Polygon-fill mode (draw any polygon and fill with grid) is on the roadmap; the current grid generates a rotated rectangle around the centre point.

---

## 6. THE MAP / AUTOPAN

A new toggle button sits in the top-left of every map (Plan tab and Data tab). Glyph: **⊕**.

### Behaviour rules
- **ON** (green background): the map follows HOME (if valid). If no HOME, it follows the vehicle GPS.
- **OFF**: the map stays where you put it.
- **Drag = pause**: if you manually drag the map, AutoPan auto-turns off so it doesn't fight you. Click the button to re-enable.
- **HOME change = re-centre**: when ArduPilot sends a new HOME_POSITION (e.g. you right-click → Set home here), the map jumps to the new home — provided AutoPan is ON.
- **Persisted**: your last AutoPan state is remembered between reloads.

### When you want AutoPan ON
- Watching the vehicle execute a mission (Data tab).
- Verifying the fence polygon is centred on HOME (Plan tab, FENCE mode).

### When you want AutoPan OFF
- Drawing a polygon somewhere away from HOME.
- Reading the WP table without the map jumping around.

---

## 7. TROUBLESHOOTING

### A. Mission triggers AUTO → RTL right after takeoff

Open the **Fence Diagnostics** panel (switch to FENCE mode briefly to see it) **and** Flight Data → Messages, then check:

| Symptom in diagnostics or Messages | Cause | Fix |
|------------------------------------|-------|-----|
| `Fence Breach Polygon` + HOME inside inclusion = NO | SITL home doesn't match polygon area | Set Simulation home to match polygon, restart sim |
| `Fence Breach Polygon` + Vehicle inside exclusion = YES | Exclusion polygon contains HOME or first WP | Move the exclusion polygon |
| `Fence Breach Circle` + Circle active = YES (small radius) | FENCE_RADIUS too small for the mission | Increase Radius, or untick the **Circle** checkbox in Types |
| `Fence Breach Alt Max` | Mission alt > FENCE_ALT_MAX | Lower mission altitudes or raise Alt Max |
| Breach count keeps incrementing but breach_status flickers | Vehicle skimming an edge | Increase Margin (within Radius) |

### B. Survey grid runs but no photos
- You didn't set **Camera trigger every (m)**. It defaults to 0 (off). Set to e.g. 5.

### C. Survey grid runs too slowly
- `WPNAV_SPEED` is too cautious. Set **Survey speed (m/s)** in the panel (e.g. 7).

### D. Map keeps snapping back to HOME while I'm drawing
- AutoPan is ON. Click the ⊕ button in the top-left of the map (it'll turn from green to grey).

### E. I drew a polygon but Write fails immediately
- Check the toolbar status — `⚠` next to a polygon means < 3 vertices.
- Check the validation warnings count — click the amber **N Warnings** button.

### F. "Margin ≥ Radius — ArduPilot will reject"
- FENCE_MARGIN must be **strictly less** than FENCE_RADIUS. Reduce Margin or increase Radius.

### G. After Apply Fence Config, Enabled stays NO
- The param write probably hit a verification timeout. Check Flight Data → Messages for `Param … rolled back`. Try Apply again.

### H. AutoPan glitches on a stationary vehicle
- The map ignores moves < ~3 m to avoid GPS-noise jitter. If you want a hard recentre, click ⊕ off and on again.

---

## CHANGE LOG

- 2026-05-24 — initial version covering new Fence Diagnostics panel, FENCE_TYPE checkboxes, AutoPan toggle, Survey camera + speed inputs.
