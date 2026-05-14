# Telemetry engine design (target)

Design for a **modular telemetry service layer** inspired by Mission Planner’s separation of **ingestion** ([`mavlink-ingestion.md`](mavlink-ingestion.md)), **vehicle model** ([`vehicle-state-model.md`](vehicle-state-model.md)), and **housekeeping** ([`currentstate-architecture.md`](currentstate-architecture.md) `UpdateCurrentSettings`). **No implementation** — applies to evolving `drone_gcs/python_service` + `node_api` + frontend.

---

## 1. Current baseline (Drone-System-Collab)

- **Ingestion:** `LinkManager` asyncio `read_loop`, pymavlink `recv_match`, per-message `handle_message` → mutates `VehicleState`.
- **Publish:** `TelemetryPublisher.publish_loop` — **10 Hz** JSON: `CONNECTION_STATUS`, `TELEMETRY_UPDATE` per vehicle, `PARAM_SYNC_STATUS`, `ADSB_UPDATE`.
- **Bridge:** ZMQ PUB → Node SUB → WebSocket broadcast (opaque JSON strings).

**Gaps vs Mission Planner:**

- No **`processInfoFromStream`-class** single place for stream-derived protocol side effects; mission/param are separate modules (good) but telemetry path doesn’t emit **fine-grained events**.
- No **`packetsLast`-style** per-message cache for tooling/plugins.
- No explicit **stream rate request** loop tied to a central policy (MP uses `requestDatastream` from `UpdateCurrentSettings`).

---

## 2. Target modules (logical)

| Module | Responsibility |
|--------|----------------|
| **Ingest** | Bytes → decoded message + `(sysid, compid, msgid, timestamp, link_id)` |
| **Route** | Demux to vehicle bucket; create `VehicleState` on first HB (already similar in `LinkManager`) |
| **Decode** | Replace monolithic growth with **registry**: `msgid → handler(VehicleState, msg, ctx)` (refactor of `handle_message`) |
| **Protocol cache** | Mission/fence/rally/param mirrors (today: `MissionManager`, `ParameterSyncManager`; keep boundary) |
| **Aggregate** | Derived fields: EKF composite scalar, failsafe boolean policy, wind/climb, link quality EMA — Mission Planner `CurrentState` patterns |
| **Staleness** | Per-field or per-group `updated_at`, `valid`, `stale_after_ms` |
| **Publish** | Event bus + optional coalesced snapshot for HUD |

---

## 3. Event shapes (conceptual)

Dual output (Mission Planner parallel):

1. **State patch** — JSON Merge Patch or protobuf-like field paths for UI stores.
2. **Domain event** — `{ event, sysid, compid, ts, payload }` for logs, plugins, recording.

---

## 4. Rate and coalescing

| Source | Policy |
|--------|--------|
| ATTITUDE (50 Hz) | Coalesce to UI **20–30 Hz** or **on-change** threshold (roll/pitch delta) |
| GLOBAL_POSITION_INT | 10–20 Hz typical |
| Full snapshot | Retain **≤10 Hz** for “dumb” consumers; add **delta** channel for efficiency |

Mission Planner uses **BindingSource ~10 Hz** + HUD **Invalidate** on change — target engine should **avoid** sending full `to_dict()` at 50 Hz for all clients.

---

## 5. Staleness (recommended)

For each telemetry **group** (attitude, position, battery, rc):

- `last_rx_monotonic` / `last_rx_wall` (use monotonic for timeouts).
- `status: FRESH | STALE | LOST` where `LOST` matches link `HEARTBEAT_LOST` / no packet for N× expected interval.
- HUD shows last attitude with **tinted banner** if STALE (MP often shows last value silently — explicit UX is better for web).

---

## 6. Multi-drone

- Preserve `vehicles: Dict[sysid, VehicleState]`.
- **Primary** selection API (already `primary_sysid`) + explicit **UI selection** that doesn’t clear other vehicles’ state on roster updates.
- Optional **fleet view**: same WS channel, client filters — engine still publishes all or policy-limited set.

---

## 7. Reconnect (align with MP + current strengths)

Current `LinkManager` already documents Mission Planner–style serial settle and reconnect delays — **retain** as **LinkPolicy** in design:

- Transport open retries, DTR/RTS nudge, `heartbeat_timeout_s`, `RECONNECTING` state.
- On reconnect: emit `LINK_RESET` event; engine sets all vehicle fields to `STALE` until first HB, or soft-reset copies like `ResetInternals` in MP.

---

## 8. Technology mapping

| Concern | Suggested host (target) |
|---------|-------------------------|
| pymavlink / SITL | Keep **Python** link service (proven in repo) |
| Fan-out / auth / WSS | **Node** telemetry engine or merge into enhanced `node_api` |
| Heavy math / future JIT | Optional **Rust** worker — *not required for v1* |

---

## 9. Migration hint

Phase 1: add **envelope** + `schema_version` to ZMQ/WS payloads without changing folder layout.  
Phase 2: split **decode registry** from `handle_message`.  
Phase 3: introduce **delta** + staleness metadata — see [`migration-roadmap.md`](migration-roadmap.md).

---

*Design-only document.*
