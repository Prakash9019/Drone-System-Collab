# Architecture Implementation Gap Report

This report compares the documents in `docs/architecture` with current code implementation.

## Coverage Summary

| Architecture Doc | Status | Notes |
|---|---|---|
| `parameter_system.md` | ⚠ Partial | Core sync/recovery, verified set, cache implemented; metadata/range/enum/reboot-required still missing. |
| `connection_reliability.md` | ⚠ Partial | Stabilized open, heartbeat FSM, reconnect/backoff implemented; parser resync + layered managers + multi-port failover missing. |
| `sitl_architecture.md` | ⚠ Partial | Start/stop/reset/status implemented; swarm, profiles, stream routing, logs missing. |
| `geofence_system.md` | ❌ Mostly Missing | Mission type plumbing exists, but dedicated fence endpoints/editor/state sync not implemented. |
| `osd_system.md` | ❌ Mostly Missing | No OSD profile service/editor/overlay pipeline implemented. |
| `phase2_implementation_notes.md` | ✅ Documentation | Reflects implemented slices; action items remain open. |

---

## Missing Items By Area

## 1) Parameter System

- metadata schema for parameter constraints (`min/max`, enums, reboot-required)
- frontend safe-range validation and write blocking
- richer param diff/import/export preset pipeline

## 2) Connection Reliability

- parser resync for corrupted MAVLink frames
- dedicated Bluetooth Manager + Serial Manager layer split
- reconnect diagnostics history and attempt telemetry
- multi-link failover handling

## 3) SITL

- multi-instance swarm launch orchestration
- profile persistence and preset launch
- stdout/stderr log surfacing in UI
- per-instance routing model for multi-vehicle SITL

## 4) Geofence

- dedicated fence read/write API endpoints
- fence domain model (mode/action/limits) in API
- frontend fence workflow and map editing behaviors

## 5) OSD

- OSD profile persistence backend
- OSD profile CRUD API
- frontend OSD editor shell

---

## Implementation Started In This Pass

Immediate implementation targets from this report:

1. SITL profile persistence + logs (backend + UI wiring)
2. Geofence protocol endpoints (`FENCE` mission type dedicated API path)
3. OSD profile service shell (backend persistence + endpoints)

Further parity tasks will continue incrementally after these are integrated and validated.
