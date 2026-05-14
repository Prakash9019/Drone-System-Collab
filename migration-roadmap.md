# Migration roadmap (Drone-System-Collab → Mission Planner–inspired modern GCS)

**Constraints honored:** no new folders created by this document, no code edits, no scaffolding committed here — **planning only**. References: [`MODERN_GCS_ARCHITECTURE.md`](MODERN_GCS_ARCHITECTURE.md), MP docs listed therein.

---

## 1. What can be reused (keep)

| Asset | Why |
|-------|-----|
| **`LinkManager` + pymavlink`** | Solid connect/bootstrap/reconnect, UDP forward, ADS-B store, message counts |
| **`VehicleState` + `handle_message`** | Already a compact MP `CurrentState`-like aggregate; extend rather than replace |
| **`MissionManager` / fence / rally APIs`** | Clear separation MP achieves via `processInfoFromStream` for mission items |
| **`ParameterSyncManager` + param cache JSON** | Mirrors MP `MAVState.ParamCachePath` intent |
| **Node as WS gateway** | Good place to grow **event bus** without rewriting Python first |
| **Zustand + operational phase** | Good UX primitive; refine with slices |
| **React pages** | Flight Data / Planner / Params — incremental migration |

---

## 2. What should be refactored (same module, cleaner shape)

| Area | From | Toward |
|------|------|--------|
| Message decode | Growing `if/elif` in `message_handlers.py` | **Registry** table `msg_type → handler` |
| Telemetry publish | Full `to_dict()` every 100ms | **Patches** or throttled groups + `schema_version` |
| Units | ATTITUDE radians in state | **Normalize at decode** to schema contract ([`vehicle-state-schema.md`](vehicle-state-schema.md)) |
| WS payloads | Ad hoc `type` strings | **Namespaced kinds** + version ([`event-bus-design.md`](event-bus-design.md)) |

---

## 3. What should be redesigned (new contracts, existing folders)

| Concern | Redesign |
|---------|----------|
| Cross-layer coupling | Introduce **envelope contract** between Python ↔ Node ↔ React |
| Plugin / extension | **Bus subscription API** + sandboxed handlers |
| Multi-drone UX | Fleet roster + per-vehicle tabs without clearing non-primary state |
| Staleness | Explicit metadata per telemetry group |
| HUD fidelity | Optional **Canvas/WebGL** HUD module matching MP ladder/heading tape behaviors |

---

## 4. Mission Planner logic → existing Drone systems map

| Mission Planner | Drone-System-Collab |
|-----------------|---------------------|
| `readPacketAsync` | `LinkManager.read_loop` + `recv_match` |
| `processInfoFromStream` (mission items) | `MissionManager` + mission endpoints |
| `CurrentState` HEARTBEAT arm/mode | `handle_message` HEARTBEAT + `decode_mode` |
| `CurrentState` SYS_STATUS | `handle_message` SYS_STATUS |
| `CurrentState` EKF aggregation | **Missing** — add in Python `aggregate` module or Node |
| `UpdateCurrentSettings` stream requests | Partially implicit — add explicit **StreamPolicy** loop |
| `bindingSourceHud` | `AdvancedHUD` + `useTelemetryStore` |
| `FlightData.mainloop` | `TelemetryPublisher` + WS + client timers |
| `MAVState.packetsLast` | **Missing** — optional add to `LinkManager` for debug |

---

## 5. Phased roadmap

### Phase A — Contract hardening (low risk)

- Add **`schema_version`** + **`seq`** to JSON payloads (Python publish + Node passthrough + client ignore-unknown-fields).
- Document units in [`vehicle-state-schema.md`](vehicle-state-schema.md) and align HUD assumptions.

### Phase B — Event bus MVP (medium risk)

- Node: parse incoming ZMQ JSON, **re-emit** structured envelopes to WS ([`event-bus-design.md`](event-bus-design.md)).
- Frontend: single `telemetryReducer` before Zustand `set`.

### Phase C — Engine features (medium)

- Staleness metadata in Python aggregate layer ([`telemetry-engine-design.md`](telemetry-engine-design.md)).
- EKF composite + failsafe boolean aligned with MP policies.

### Phase D — Packaging (optional product)

- **Electron** shell wrapping existing dev/prod build ([`frontend-sync-architecture.md`](frontend-sync-architecture.md) §4).
- Supervised child processes for Python service on desktop.

### Phase E — Plugins (higher)

- Node or Python plugin host with **subscribe API**; never block ingest.

---

## 6. Risk register

| Risk | Mitigation |
|------|------------|
| Double source of truth (REST vs WS) | Define **one primary** for live telemetry (WS); REST for bootstrap/history |
| Schema drift | `schema_version` + CI contract tests |
| CPU on JSON | Move to MessagePack or protobuf **after** contracts stable |

---

## 7. Future folder structure (recommendation only — **not created now**)

When the repo is allowed to evolve structurally, prefer **feature slices** under existing roots:

- `drone_gcs/python_service/telemetry/` — ingest, decode registry, aggregate, publish adapters  
- `drone_gcs/node_api/bus/` — envelope, priorities, WS adapter  
- `drone_gcs/frontend/src/telemetry/` — client bus, slices, HUD projection  

Alternative: single `packages/gcs-protocol` monorepo package — **only when** tooling supports it; user requested **no new folders** in this phase.

---

## 8. Exit criteria per phase

- **A:** All clients tolerate unknown fields; HUD works unchanged.
- **B:** One synthetic load test: 5 msg types, no WS stall > 100ms p95.
- **C:** Staleness visible in UI mock.
- **D:** Electron build loads same WS URL localhost stack.
- **E:** Sample plugin logs `ATTITUDE` rate without modifying core.

---

*Design-only document.*
