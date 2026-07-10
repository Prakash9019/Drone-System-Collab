# Fleet Platform — 10-Drone Benchmark Baseline

**Date:** 2026-07-10
**Branch:** `fleet-platform` (Phase 5A production stabilization)
**Purpose:** Baseline resource/throughput/recovery figures for the fleet backend running
10 concurrent drones, for regression comparison in Phase 5B and beyond.

> Numbers below are a single-run baseline on the machine listed, not a statistical
> benchmark. Re-run the same procedure (bottom of doc) to compare after future changes.

---

## Test environment

| | |
|---|---|
| **Hardware** | Apple Mac14,10 (Mac mini) |
| **CPU** | Apple M2 Pro — 12 cores (8 performance + 4 efficiency) |
| **RAM** | 16 GB |
| **OS** | macOS 26.5.2 (build 25F84), Darwin kernel 25.5.0 |
| **Python** | 3.11.11 (`prometheus-client` installed) |
| **Node** | v24.15.0 (`prom-client`) |

### Topology under test

- **Simulator:** ArduPilot SITL, 10× ArduCopter instances via
  `sim_vehicle.py -v ArduCopter -f quad --count 10 --auto-sysid --location CMAC --no-rebuild`
  (sysid 1–10, instances `-I0`…`-I9`).
- **Fleet backend:** Python service on `:8000`, ZMQ pub on `:5556`; Node gateway on `:8090`
  (`8080` was occupied). Telemetry rate 10 Hz.
- **Attachment:** one `DroneSession` per drone. Sessions attach to each SITL instance's
  **SERIAL1 TCP port** (`+2` offset: `5762, 5772, … 5852`) — a clean single-vehicle stream.
  (drone-05 was attached to SERIAL0 `5800` — see Known issue #1.) The shared MAVProxy
  `--out` UDP ports (`14550…14640`) are **not** used: MAVProxy muxes all 10 sysids onto
  every one of them, so they are not one-vehicle-per-port.
- **WS clients:** 3 subscribed (`subscribe_all`).

---

## Results

### Sessions
| Metric | Value |
|---|---|
| `fleet_drones` | **10** |
| `fleet_drones_online` | **10** |
| Unique `DroneSession` per drone (isolated sysid) | ✅ each session sees exactly 1 vehicle |

### Throughput
| Metric | Value |
|---|---|
| Telemetry published (Python → ZMQ) | **~622 frames/sec** |
| Telemetry received (Node ← ZMQ) | **~622 frames/sec** (no loss vs. published) |
| Per-drone share | ~62 frames/sec/drone, evenly distributed |
| Publish tick rate | **10.00 ticks/sec** (matches 10 Hz target exactly) |

### Resource usage (steady state, 10 drones @ 10 Hz)
| Process | CPU (1 core = 100%) | Memory (RSS) |
|---|---|---|
| Python service (`:8000`) | **~12%** | **~44 MB** |
| Node gateway (`:8090`) | **~3.7%** | **~75 MB** |

*(CPU/RSS captured at OS level via `ps` — see Known issue #2. Headroom is large: ~15% of
one core across both tiers on a 12-core machine.)*

### Latency
| Metric | Value |
|---|---|
| `GET /fleet` HTTP round-trip (local) | **~2.0 ms** (5 samples: 2.08 / 2.04 / 2.06 / 2.05 / 1.85 ms) |

### Recovery (failure test — kill drone 5, restart)
| Metric | Value |
|---|---|
| Failure detection (process death / TCP close) | **< 1 s** (socket closes → immediate transport error → `HEARTBEAT_LOST`) |
| Failure detection (silent link loss, no TCP close) | **≤ 3 s** (`heartbeat_timeout_s = 3.0` in `mavlink_link.py`) |
| Impact on other 9 drones | **None** — stayed online throughout (per-session isolation) |
| Reconnect after SITL available again | **~2.6 s** (from re-issuing connect to `CONNECTED`) |
| Fleet state after restart | back to **10/10 online** |

`online` = link state in `{CONNECTED, ACTIVE}`. The session auto-retries with backoff
(`reconnect_retry_delay_s = 1.0`) while the endpoint is unreachable.

---

## Observability endpoints verified
- Python `/metrics`: `fleet_drones`, `fleet_drones_online`, `telemetry_frames_published_total{drone_id,type}`,
  `telemetry_ticks_total`, `zmq_publisher_up` (**fixed this session — now reports 1**).
- Node `/metrics`: `ws_clients`, `ws_messages_sent_total`, `zmq_frames_received_total`,
  `zmq_connected`, `telemetry_frames_processed_total{drone_id}`, plus prom-client default
  process CPU/memory/event-loop series.
- `/healthz` (liveness) and `/readyz` (readiness) OK on both tiers.

---

## Known issues / caveats

1. **Standalone-relaunched SITL instance is unstable.** A single `arducopter` launched
   outside `sim_vehicle` (used here to restart drone 5) exits when its SERIAL0 TCP client
   disconnects, and its `+2` telemetry port only opens after a client connects to SERIAL0
   to unblock boot. Workaround: connect to SERIAL0 (`5800`) **once and leave it**, or restart
   the whole `sim_vehicle --count 10`. **This is a simulator harness limitation, not a fleet
   defect** — the fleet's detection + reconnect logic works correctly (verified).
2. **Python `/metrics` omits process CPU/memory.** The service uses a dedicated
   `CollectorRegistry` without the `prometheus_client` default process collector, so
   `process_cpu_seconds_total` / `process_resident_memory_bytes` are absent on the Python tier
   (Node exposes them). CPU/RSS above were read via `ps`. *Candidate fix for Phase 5B.*
3. **No fleet dashboard UI yet** (Phase 5B). 10-drone state is observed via the API
   (`GET /fleet`) and `/metrics`, not the browser — the frontend is still the single-drone GCS.
4. **MAVProxy `--out` ports mux all sysids.** Use per-instance `+2` TCP ports for
   per-session isolation, as done here.

---

## Reproduce

```bash
# 1. SITL (10 vehicles)
cd ~/ardupilot
Tools/autotest/sim_vehicle.py -v ArduCopter -f quad --count 10 --auto-sysid \
  --location CMAC --no-rebuild

# 2. Python fleet backend (drone-01 = default session -> SERIAL1 of instance 0)
cd "drone_gcs/python_service"           # venv has prometheus-client
DRONE_CONNECTION_STRING=tcp:127.0.0.1:5762 DRONE_NAME=drone-01 ZMQ_PUB_PORT=5556 \
  venv/bin/python main.py

# 3. Node gateway
cd drone_gcs/node_api
HTTP_PORT=8090 PYTHON_API_URL=http://127.0.0.1:8000 ZMQ_PUB_URL=tcp://127.0.0.1:5556 \
  node server.js

# 4. Register drones 02..10 on SERIAL1 ports 5772,5782,...,5852
for i in $(seq 2 10); do port=$((5762+(i-1)*10)); id=$(printf drone-%02d $i);
  curl -s -X POST http://127.0.0.1:8000/fleet/drones -H 'Content-Type: application/json' \
    -d "{\"drone_id\":\"$id\",\"connection_string\":\"tcp:127.0.0.1:$port\",\"auto_connect\":true}"; done

# 5. Verify
curl -s http://127.0.0.1:8000/fleet        # -> count 10, online 10
curl -s http://127.0.0.1:8000/metrics      # fleet_drones, telemetry_*, zmq_publisher_up
curl -s http://127.0.0.1:8090/metrics      # ws_clients, zmq_frames_received_total, ...
```
