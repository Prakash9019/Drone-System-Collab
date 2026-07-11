Use ArduPilot Multi-Vehicle SITL (Recommended) ⭐⭐⭐⭐⭐

This is exactly what ArduPilot provides.

You're currently running:

cd ~/ardupilot

Tools/autotest/sim_vehicle.py \
-v ArduCopter \
-f quad \
--custom-location=17.385,78.4867,540,0 \
--out=udp:127.0.0.1:14550 \
--map \
--console

For fleet testing, you should use the built-in multi-vehicle support instead of manually opening many terminals.

Example:

cd ~/ardupilot

Tools/autotest/sim_vehicle.py \
-v ArduCopter \
-f quad \
--count 10 \
--auto-sysid \
--location CMAC \
--no-rebuild

or specify a custom location:

Tools/autotest/sim_vehicle.py \
-v ArduCopter \
-f quad \
--count 10 \
--auto-sysid \
--custom-location=17.385,78.4867,540,0

sim_vehicle.py already supports options such as --count (multiple vehicles), --instance, and --auto-sysid specifically for multi-vehicle SITL

Verdict: ✅ Yes — your Fleet Platform handles all 10 drones correctly.

I ran the full verification against your 10 running SITL vehicles. Everything is live right now (Python :8000, Node gateway :8090, 10 sessions online).

Step 1 — Detect all 10 drones ✅

GET /fleet → count=10, online=10. Each drone is a distinct DroneSession bound to its own vehicle:

┌─────────────────────┬───────────┬───────┬────────┐
│       Session       │   Port    │ sysid │ Status │
├─────────────────────┼───────────┼───────┼────────┤
│ default (drone-01)  │ 5762      │ 1     │ ONLINE │
├─────────────────────┼───────────┼───────┼────────┤
│ drone-02 … drone-10 │ 5772…5852 │ 2…10  │ ONLINE │
└─────────────────────┴───────────┴───────┴────────┘

Step 2 — Dashboard ⚠️ (see caveat)

- Unique DroneSession per drone: ✅ each session sees exactly one vehicle with its own sysid — no muxing, no sysid collision.
- Telemetry updating: ✅ heartbeat ages <1s across all drones.
- Isolation (one drone affecting another): ✅ proven in Step 4.
- "All 10 visible in a dashboard / switch between drones": ❌ there is no fleet dashboard UI yet — the frontend on this branch is still the single-drone GCS (Phase 5B deferred). Everything above was verified via the API + /metrics, not the browser.

Step 3 — /metrics ✅

┌─────────────────┬───────────────────────────────────────────────────────────────────┐
│     Metric      │                               Value                               │
├─────────────────┼───────────────────────────────────────────────────────────────────┤
│ Active sessions │ fleet_drones=10, fleet_drones_online=10                           │
├─────────────────┼───────────────────────────────────────────────────────────────────┤
│ Telemetry/sec   │ ~610–630 frames/s, split evenly (~2995/drone)                     │
├─────────────────┼───────────────────────────────────────────────────────────────────┤
│ WS connections  │ ws_clients=3 (I attached test clients), ws_messages_sent climbing │
├─────────────────┼───────────────────────────────────────────────────────────────────┤
│ ZMQ             │ zmq_connected=1, zmq_frames_received_total climbing               │
├─────────────────┼───────────────────────────────────────────────────────────────────┤
│ CPU / Memory    │ Python 18% / 40 MB RSS, Node 3% / 95 MB RSS                       │
└─────────────────┴───────────────────────────────────────────────────────────────────┘

(Minor observability nit: Python's zmq_publisher_up gauge reads 0 even though frames flow fine — a metric-wiring bug, not a functional one. Python's custom registry also omits process CPU/mem; those came from the OS.)

Step 4 — Failure test ✅

- Kill drone 5 (arducopter -I4, sysid 5): drone-05 → OFFLINE, other 9 stayed ONLINE — fully isolated. The session correctly detected the loss and retried with backoff.
- Restart: drone-05 reconnected, telemetry resumed and sustained (heartbeat <1s over a 10s watch), back to 10/10.

Two things you should know

1. No fleet dashboard exists yet. If you want Step 2 in the browser (sessions list, live per-drone telemetry, drone switcher), that's net-new frontend work — say the word and I'll build a minimal one.
2. How drones attach matters. Your shared MAVProxy muxes all 10 sysids onto every 1455x UDP port, so those aren't one-vehicle-each. I attached each session to the per-instance SERIAL1 TCP port (5762, 5772 … 5852) instead — clean single-vehicle streams. Also: a single SITL relaunched standalone dies when its SERIAL0 client drops (MAVProxy normally holds it open) — so to restart one drone, either re-run the whole sim_vehicle --count 10, or relaunch that instance and connect to SERIAL0 once without churning the connection.

Housekeeping

- Currently running (I started these): fleet Python :8000, Node gateway :8090, 3 test WS clients, and a replacement SITL for sysid 5. Your original sim_vehicle fleet is otherwise untouched.
- I stashed your uncommitted video work (git stash on main: video_settings.json, .gitignore) and switched to fleet-platform. To restore it: git checkout main && git stash pop. Your command_stimulator.md is backed up in the scratchpad.