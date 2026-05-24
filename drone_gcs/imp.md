Step 1 — Fix SITL home to Hyderabad

  Go to Simulation page and change the Home field from the Australia default to your Hyderabad coordinates:

  17.456979, 78.372855, 50, 0

  Then click Reset Simulation → Start Simulation.

  Step 2 — Upload mission (same as before, your waypoints are correct)

  Click Write in Flight Planner.

  Step 3 — Arm the drone

  Go to Flight Data → Actions tab and click the green ARM button. Wait for status to show "Armed".

  Step 4 — Set AUTO and start

  Go to Flight Planner and click:
  1. Set AUTO
  2. Start Mission

  ---
  Fence — Complete Step-by-Step Guide
  
  What is a Fence?

  A geofence is a virtual boundary around the drone. If the drone leaves the allowed zone (inclusion) or enters a forbidden zone (exclusion),
  ArduPilot triggers a breach action (RTL, Land, etc.).

  - Inclusion zone (cmd 5001) — drone must stay inside this polygon
  - Exclusion zone (cmd 5002) — drone must stay outside this polygon


Part 1 — Draw and Upload the Fence
  
  Step 1 — Switch to FENCE mode

  In Flight Planner, change the dropdown from MISSION to FENCE. The toolbar changes to show the polygon radio buttons.

  Step 2 — Pick polygon type before drawing

  In the toolbar, select either:
  - ● Inclusion (5001) — safe flying area (draw the outer boundary)
  - ○ Exclusion (5002) — no-fly zone (draw a forbidden area inside your flight zone)

  Step 3 — Draw the polygon on the map

  Right-click on the map → you'll see a context menu. Click points around your intended area. Each click adds a vertex. Minimum 3 points 
  required per polygon (the system warns if fewer).

  The toolbar status shows:
  Fence: DISABLED | Incl(4pts)
  meaning 1 inclusion polygon with 4 vertices.
  
  Step 4 — (Optional) Add a second polygon of a different type

  Switch the radio button to Exclusion, then draw another polygon. The system groups consecutive vertices by type automatically. Example result:
  Incl(4pts) + Excl(3pts)
  
  ▎ ⚠ Rule: If you have an exclusion zone, you MUST also have an inclusion zone, otherwise ArduPilot has no defined safe area and will likely 
  ▎ reject it.

  Step 5 — Upload the fence

  Click Write. The XFER counter shows upload IN_PROGRESS | 0/N → N/N. When done: "FENCE uploaded successfully!".

  ---
  Part 2 — Configure Fence Behaviour

  After uploading, use the Fence Config row (visible when FENCE mode is selected):

  ┌─────────────────┬─────────────────────────────────────────────────────────────────┐
  │      Field      │                          What it does                           │
  ├─────────────────┼─────────────────────────────────────────────────────────────────┤
  │ Enable checkbox │ Toggles FENCE_ENABLE ON/OFF on the drone                        │
  ├─────────────────┼─────────────────────────────────────────────────────────────────┤
  │ Action dropdown │ What happens on breach — see below                              │
  ├─────────────────┼─────────────────────────────────────────────────────────────────┤
  │ Radius m        │ Circular fence radius (meters from home) — backup if no polygon │
  ├─────────────────┼─────────────────────────────────────────────────────────────────┤
  │ Alt Max         │ Maximum altitude (meters) — fence breach if drone goes higher   │
  ├─────────────────┼─────────────────────────────────────────────────────────────────┤
  │ Alt Min         │ Minimum altitude (meters, usually 0)                            │
  └─────────────────┴─────────────────────────────────────────────────────────────────┘

  Action options:
  - 0 - Report — logs the breach only, drone keeps flying (use for testing)
  - 1 - RTL — drone returns to launch point ✓ (recommended)
  - 2 - Land — drone lands immediately where it is
  - 3 - Brake — drone hovers and stops

  Step 6 — Apply the config

  Set your values, then click Apply Fence Config. The status message shows "Fence configuration applied.".

  ---
  Part 3 — Verify it's Active
  
  After applying, the toolbar status line updates from the live drone parameters:
  Fence: ENABLED | Action: 1 | Incl(4pts)

  To confirm on the Flight Data page, check:
  - Status bar should show fence enabled
  - Or go to Setup → Parameters and confirm FENCE_ENABLE = 1

  ---
  Full Workflow (same location fix applies)
  
  Just like the mission, the SITL home must match your map location. Same fix applies:

  1. Simulation page → Set home to your Hyderabad coordinates: 17.456979, 78.372855, 50, 0
  2. Reset + Start Simulation
  3. Flight Planner → Switch to FENCE
  4. Select Inclusion → right-click map → draw polygon (3+ points around your flight area)
  5. Write → upload the fence
  6. Enable ✓ → Action: RTL → Alt Max: 120 → click Apply Fence Config
  7. Switch back to MISSION → plan your mission as before
  8. ARM → Set AUTO → Start Mission

