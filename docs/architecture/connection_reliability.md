# MAVLink + Bluetooth/Serial Reliability Architecture

## Problem Summary

Observed issue:
- Bluetooth link appears connected at OS level, but MAVLink session becomes dead after backend refresh/restart.
- User must forget/re-pair Bluetooth device and reboot controller.

Primary root causes:
- serial/Bluetooth transport not stabilized before session handshake,
- stale transport state after process restart,
- overlapping reload processes (`--reload`) can contend for same serial resource,
- session health and reconnect logic not strict enough during startup/recovery windows.

---

## Mission Planner Principles We Mirror

Mission Planner avoids this class of failure by combining:
- strict teardown ordering,
- startup stabilization delays/toggles on serial transports,
- heartbeat-gated connect acceptance,
- ongoing heartbeat monitoring,
- automatic reconnect + stream renegotiation,
- transport/session separation.

---

## What We Implemented

## 1) Serial/Bluetooth Stabilized Open

In `python_service/mavlink_link.py`:
- added `_open_transport_with_stabilization()` used by both initial connect and reconnect.
- open attempts retried (3 attempts).
- post-open settle delay to allow serial/BLE stack readiness.
- optional DTR/RTS pulse (when port supports it) to clear stale line state.

Why:
- prevents connecting to a “half-open but dead” transport state after restart.

## 2) Stronger Handshake Acceptance

- startup now requires multiple heartbeat confirmations (`heartbeat_required_for_connect = 2`) plus telemetry activity before session is considered connected.

Why:
- avoids false-positive “connected” state during unstable startup.

## 3) Reconnect Backoff + Recovery

- reconnect attempts are throttled (`reconnect_retry_delay_s`) to prevent reconnect thrash loops.
- reconnect path uses same stabilized transport open.
- stream renegotiation remains part of successful recovery flow.

Why:
- controlled recovery is more reliable than rapid reopen churn on BLE/serial links.

## 4) Harder Socket Cleanup

`purge_socket()` now:
- attempts input/output buffer reset before close when available,
- closes low-level serial port explicitly,
- then closes MAVLink transport object.

Why:
- reduces stale COM lock and zombie buffer issues.

## 5) Uvicorn Reload Safety

In `python_service/main.py`:
- set `reload=False` in `__main__` launch path with explicit reliability note.

Why:
- auto-reload can spawn overlapping processes during code refresh and corrupt serial/BLE lifecycle for hardware links.

---

## Lifecycle State Model

Implemented runtime states:
- `CONNECTING`
- `WAITING_FOR_HEARTBEAT`
- `CONNECTED`
- `HEARTBEAT_LOST`
- `RECONNECTING`
- `DISCONNECTED`

This state machine is transport-aware and heartbeat-driven.

---

## Reliability Guarantees (Current)

With these changes, system now provides:
- restart-safe transport reopen attempts with stabilization,
- heartbeat-validated connection establishment,
- automatic reconnect after heartbeat loss,
- stream renegotiation after recovery,
- explicit degraded states when transport/session unhealthy.

---

## Operational Guidance

For hardware links, **do not run backend with dev reload**.

Preferred start:
- `python3 drone_gcs/python_service/main.py`
or
- `uvicorn main:app --host 0.0.0.0 --port 8000` (without `--reload`).

If running from another process manager, ensure single active backend instance at a time.

---

## Remaining Work for Full Production Parity

- dedicated Bluetooth manager and serial manager classes (layered architecture),
- richer reconnect diagnostics (reason history, attempt counters),
- parser resync handling for corrupted byte streams,
- multi-port failover and multi-vehicle primary role migration,
- integration tests that simulate backend restart during active serial/BLE streams.
