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
  





I now have the full picture — this repo already did the documentation consolidation and left a self-audit trail. Here's the breakdown.

The short answer

Yes — almost everything is centralized. There are 3 meta-docs at the root that already explain this exact situation:

1. DOCUMENTATION_INDEX.md — the "start here" map of all docs
2. DOCUMENTATION_MERGE_REPORT.md — a table showing which of the ~55 old files were merged into which master doc, and why
3. REMOVE_THESE_FILES.md — the pre-vetted safe-to-delete list, with the exact rm commands (never executed)

This happened on 2026-05-27, consolidating fragmented docs into 4 master docs.

The 4 master docs (everything lives here now)

┌────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                File                │                                                    Covers                                                    │
├────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ MASTER_GCS_ARCHITECTURE.md         │ Full system architecture — Python/Node/React layers, telemetry pipeline, vehicle state schema, API endpoints │
├────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ MASTER_FLIGHT_PLANNER.md           │ Mission, Fence, Survey Grid, mission execution debugging, premature-RTL and WP-counter root causes           │
├────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ MASTER_DATA_TAB.md                 │ Data/Flight tab — HUD, map, actions, modes, parameters, MissionExecutionPanel                                │
├────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ MASTER_OPERATIONS_AND_DEBUGGING.md │ Setup + run commands, SITL, flight workflow, all debugging playbooks, calibration, param reference           │
└────────────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

How to start the app (from MASTER_OPERATIONS_AND_DEBUGGING.md §1–2)

# Install (one-time)
cd drone_gcs/frontend && npm install
cd drone_gcs/python_service && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
cd drone_gcs/node_api && npm install

# Run — 3 terminals
cd drone_gcs/python_service && source .venv/bin/activate && python main.py   # :8000
cd drone_gcs/node_api && node server.js                                     # :8080
cd drone_gcs/frontend && npm run dev                                         # :5173
Open http://localhost:5173. SITL instructions (via the GCS Simulation page or manual sim_vehicle.py) are in §3 of the same doc.

What's kept intentionally (not clutter)

- Root-cause investigation docs: PREMATURE_RTL_ROOT_CAUSE.md, MISSION_AUTO_START_ROOT_CAUSE.md — confirmed findings with evidence, referenced from the master docs
- Companion audit tables: FLIGHT_PLANNER_AUDIT_TABLE.md, FLIGHT_PLANNER_MISSION_AUDIT_TABLE.md, DATA_TAB_AUDIT_TABLE.md, LEVEL_CALIBRATION_AUDIT.md, DATA_TAB_GPS_ALTITUDE_AUDIT.md — line-by-line detail the master docs reference but don't inline
- Historical context: MASTER_GCS_REQUIREMENTS.md, MISSION_PLANNER_PARITY_BOARD_REPORT.md
- README.md — currently just a one-line title, not useful as-is

Files marked safe to delete (already fully absorbed)

~40 files, grouped in REMOVE_THESE_FILES.md:
- Old "centralized" docs: FLIGHT_PLANNER_CENTRALIZED.md, FLIGHT_PLANNER_MISSION_CENTRALIZED.md, DATA_TAB_CENTRALIZED.md, MODERN_GCS_ARCHITECTURE.md
- Design/flow docs: telemetry-engine-design.md, vehicle-state-schema.md, mavlink-ingestion.md, vehicle-state-model.md, currentstate-architecture.md, telemetry-flow.md, telemetry-state-flow.md, hud-architecture.md, event-bus-design.md, migration-roadmap.md, mission-map-flow.md, mission-sync-flow.md, parameter-sync-flow.md, preflight-validation-flow.md, replay-event-flow.md
- Engine/migration notes: MISSION_ENGINE.md, MISSION_MIGRATION_NOTES.md, PARAMETER_ENGINE.md, PARAMETER_MIGRATION_NOTES.md, PREFLIGHT_ENGINE.md, PREFLIGHT_MIGRATION_NOTES.md, TELEMETRY_REPLAY_ENGINE.md, REPLAY_MIGRATION_NOTES.md, MAP_INTEGRATION.md, MAP_MIGRATION_NOTES.md
- Stale audits: DATA_TAB_GAP_ANALYSIS.md, DATA_TAB_IMPLEMENTATION_PLAN.md, DATA_TAB_IMP.md, DATA_TAB_AUDIT_PROGRESS.md
- Absorbed operational: FLIGHT_PLANNER_USER_GUIDE.md, try.md, walkthrough.md
- Other: FEATURE_AUDIT_REPORT.md, FINAL_FEATURE_VERIFICATION_REPORT.md, PLAN_TAB_IMP.md, SETUP_TAB_IMP.md, GCS_DOCUMENTATION.md, VIDEO_SUBSYSTEM_PLAN.md (keep if video subsystem still planned)

Full list with the exact rm commands is at the bottom of REMOVE_THESE_FILES.md. Per your standing preference, I read the audit docs before answering and made no edits or deletions — say the word if you want me to actually run the cleanup.

✻ Brewed for 50s

※ recap: Goal is decluttering the drone GCS repo's markdown docs; you asked me to survey them and I found everything's already centralized into 4 master docs with a pre-vetted delete list. Next: tell me if you want me to actually run that cleanup. (disable recaps in /config)