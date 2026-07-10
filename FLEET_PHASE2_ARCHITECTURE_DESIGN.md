# FLEET PHASE 2 — Enterprise Fleet Architecture Design

**Status:** Design proposal — awaiting approval before Phase 3 implementation
**Date:** 2026-07-09
**Baseline:** `FLEET_PHASE1_ARCHITECTURE_REPORT.md` (single-drone dependency inventory P1–P8, N1–N6, F1–F6)
**Prime directive:** Evolve the existing three-tier system. No rewrites. Every existing module is either reused as-is, wrapped, or parameterized by `drone_id`.

---

## 1. Architecture Explanation

### 1.1 Core insight from Phase 1

The MAVLink protocol layer (mission microprotocol, command ACK machine, parameter sync, video pipeline) is correct and battle-tested. The single-drone limitation is purely *structural*: module-level singletons and a single "primary vehicle" funnel. The fleet transformation is therefore a **scoping refactor + a new persistence/identity layer**, not a new system:

> **Everything that is a global today becomes a per-drone `DroneSession` tomorrow. Everything that has no owner today (users, orgs, drones, history) gets a database row.**

### 1.2 Target architecture

```
                        ┌────────────────────────────────────────────────────┐
 Drones (LTE/5G/RF/     │                 FLEET PLATFORM                     │
 WireGuard/ZeroTier)    │                                                    │
                        │  ┌──────────────── Node Fleet API :8080 ─────────┐ │
 drone-A ──UDP:14550──► │  │ • Auth Gateway (JWT + refresh, RBAC)          │ │
 drone-B ──UDP:14551──► │  │ • Fleet API (orgs, drones, users, missions,   │ │
 drone-C ──TCP:5760───► │  │   flights, alerts, maintenance, firmware)     │ │
        │               │  │ • Telemetry Gateway (per-drone WS channels,   │ │
        │               │  │   subscription protocol, rate limiting)       │ │
        ▼               │  │ • Command Gateway (authz + audit + proxy)     │ │
 ┌─────────────────┐    │  │ • Log Gateway (upload/download/search)        │ │
 │ Python Drone    │    │  └───────┬───────────────────┬──────────────────┘ │
 │ Gateway :8000   │◄───┼── REST ──┘         ┌─────────▼────────┐           │
 │ (1..N workers)  │    │                    │ PostgreSQL       │           │
 │                 │    │                    │ (SQLite offline) │           │
 │ SessionRegistry │    │                    │ + object storage │           │
 │ ├ DroneSession A│──ZMQ PUB (topic=drone)──►                 │           │
 │ ├ DroneSession B│    │                    └──────────────────┘           │
 │ └ DroneSession C│    │                                                   │
 │ VideoRegistry   │◄───┼── /ws/video/* (per drone_id/stream_id) ─┐         │
 └─────────────────┘    └─────────────────────────────────────────┼─────────┘
                                                                  │
                     React Fleet Dashboard ◄──────────────────────┘
                     (fleet overview, multi-drone map, drone cards,
                      per-drone operations = existing GCS pages scoped by drone_id)
```

**Process count is unchanged for local/offline deployment** (Python + Node + frontend). Scale-out adds instances, not new kinds of services. This satisfies cloud / local / offline / hybrid with one codebase.

### 1.3 The five structural changes

1. **`DroneSession` (Python)** — a class bundling what are today module globals (P1): one `LinkManager` + `MissionManager` + `ParameterSyncManager` + `CameraManager` + `PreflightManager` + calibration state + optional `VideoReceiver` set, keyed by `drone_id` (UUID assigned at registration). A `SessionRegistry` owns sessions; asyncio makes N concurrent sessions per process cheap (each `read_loop` is already non-blocking). Isolation guarantee: an exception, disconnect, or reconnect storm in one session cannot touch another (per-session tasks, per-session backoff, supervised by the registry).
2. **Drone identity & registration** — drones become database entities: `drone_id` (UUID), org, name, model, connection profile (transport, endpoint, sysid, credentials), provisioning token. Replaces "first heartbeat wins" (P3). sysid collisions across drones become a non-issue because scoping is by session/transport, not sysid.
3. **Scoped APIs** — every drone-specific route gains a `/drones/{drone_id}` prefix in both tiers (P3/N5/F3). Legacy unscoped routes remain as aliases to a "default" drone for full backward compatibility (single-drone workflows keep working unchanged).
4. **Persistence + identity layer (Node)** — PostgreSQL (SQLite driver for offline single-box installs) behind a thin repository layer; JWT auth with refresh tokens; RBAC (super_admin, org_admin, operator, pilot, viewer); audit log on every command.
5. **Subscription-based telemetry fan-out (Node)** — the WS server stops broadcasting everything to everyone (N4). Clients send `{op:"subscribe", drones:[...]}` (the inbound WS path is currently unused — free real estate). Per-drone channels + per-client rate limiting + delta/keyframe cadence gives thousands of updates/sec headroom.

### 1.4 Networking (LTE / 5G / RF / VPN / ZeroTier / WireGuard)

MAVLink transport is already abstracted by `mavutil.mavlink_connection` — LTE/5G/RF telemetry all present themselves as UDP/TCP/serial endpoints. The design adds no new protocol code:

- Each registered drone has a **connection profile**: `udpin:0.0.0.0:{port}` (drone dials in over LTE/VPN), `udpout/tcp` (GCS dials out), or `serial` (local RF modem). Port allocation is managed per drone by the registry.
- **WireGuard/ZeroTier are deployment concerns, not code concerns**: the platform listens on the VPN interface; docs + docker-compose profiles ship a WireGuard sidecar. MAVLink signing (already supported by pymavlink) covers link authentication where no VPN exists.
- Companion-computer agent (future, Phase 4+): a tiny onboard script that registers via provisioning token and opens the reverse tunnel — designed but not required for MVP since `udpin` covers the common LTE/NAT-traversal-via-VPN case.

### 1.5 Video at fleet scale

`VideoManager` singleton (P5) becomes a `VideoRegistry: Dict[(drone_id, stream_id) → GstVideoReceiver]`. The receiver/tee/webrtc/raw/recorder pipeline is reused **verbatim** — it is already self-contained per instance. WS endpoints become `/ws/video/{drone_id}/{stream_id}/signaling|raw`. RGB + thermal = two streams on one drone = two registry entries. Bandwidth adaptation: keep WebRTC's native congestion control (already there); add per-stream `max-bitrate` caps and lazy pipeline start (streams start on first viewer, stop on last disconnect + grace period).

### 1.6 Multi-GCS / multi-operator / scale-out

- Node Fleet API is stateless above Postgres → N instances behind a load balancer; WS subscriptions make any instance able to serve any client.
- Python Drone Gateway scales by running multiple workers; each worker registers which `drone_id`s it hosts in the DB (`drone_sessions` table with worker heartbeats); the Fleet API routes REST calls to the owning worker. Single-worker deployments (local/offline) skip this entirely — same code, registry finds everything in-process.
- Telemetry history writes are batched (1 Hz downsample to DB; full 10 Hz retained in per-flight `.jsonl` — the existing replay format — uploaded to object storage post-flight).

---

## 2. Existing Code Analysis (what is reused, wrapped, or replaced)

| Existing module | Fate |
|---|---|
| `mavlink_link.py` LinkManager | **Reused** — becomes the per-session connection object; remove primary-sysid funneling, add `drone_id` + on_state callbacks |
| `mission_manager.py`, `command_manager.py`, `parameter_manager.py`, `camera_manager.py`, `preflight_manager.py` | **Reused verbatim** — already take a LinkManager; instantiated per session instead of once |
| `telemetry_pub.py` | **Wrapped** — one ZMQ PUB socket shared, messages gain `drone_id` in envelope + topic prefix |
| `video_service/*` | **Reused verbatim** — instantiated per (drone_id, stream_id) via VideoRegistry |
| `message_handlers.py`, `vehicle_state.py` | **Unchanged** |
| `sitl_manager.py` | **Extended** — N SITL instances (port-offset), each auto-registering as a fleet drone (great for demos/tests) |
| Node `telemetryEngine.js`, `staleTelemetry.js`, `schemas.js` | **Reused** — engine instances keyed by drone_id; fleet-wipe-on-disconnect (N3) becomes per-drone wipe |
| Node `server.js` proxies | **Reused** — proxy table gains `drone_id` path segment + authz middleware; COMMAND_MAP unchanged |
| Node `eventBus.js` | **Activated** — alert engine and DB writer become its first real subscribers |
| Frontend stores/selectors/pages | **Reused** — pages mount under `/drone/:droneId/*`; a `DroneScopeProvider` feeds `drone_id` into an API client layer; `selectPrimaryVehicle` becomes `selectVehicle(droneId)` |
| `api_gateway/`, `web_ui/` (empty dirs) | **Deleted** |

---

## 3. Files to Modify / 4. Files to Create

### Python (`python_service/`)
| Action | File | Purpose |
|---|---|---|
| CREATE | `fleet/drone_session.py` | DroneSession class (bundles managers, lifecycle, health) |
| CREATE | `fleet/session_registry.py` | Registry, supervision, reconnect policy, cleanup |
| CREATE | `fleet/worker_config.py` | Env-driven config (ports, DB URL for worker registration) |
| CREATE | `routes/` package | `main.py`'s ~70 routes split into routers, each taking `drone_id` (with legacy aliases) |
| MODIFY | `main.py` | Lifespan creates registry (auto-creates "default" session for back-compat); mounts routers |
| MODIFY | `mavlink_link.py` | Accept `drone_id`, emit session-scoped connection events, remove global primary funneling (keep per-session primary for multi-sysid links) |
| MODIFY | `telemetry_pub.py` | drone_id envelope + topic prefix |
| MODIFY | `video_service/video_manager.py` | Singleton → VideoRegistry |
| MODIFY | `sitl_manager.py` | Multi-instance with port offsets |

### Node (`node_api/`)
| Action | File | Purpose |
|---|---|---|
| CREATE | `db/` (schema.sql or Prisma schema, migrations/, repositories) | Postgres/SQLite persistence |
| CREATE | `auth/` (jwt.js, rbac.js, routes.js, middleware.js) | Login, refresh, roles, org scoping |
| CREATE | `fleet/droneRegistry.js` | Drone CRUD, provisioning tokens, worker routing |
| CREATE | `fleet/healthMonitor.js` | Online/offline, last_seen, signal/battery thresholds → alerts |
| CREATE | `fleet/alertEngine.js` | Rule evaluation on telemetry (eventBus subscriber) |
| CREATE | `ws/subscriptionManager.js` | Per-client drone subscriptions, rate limiting |
| CREATE | `telemetry/telemetryRecorder.js` | Downsampled DB writes + flight session detection |
| MODIFY | `server.js` | Auth middleware, `/api/drones/:droneId/*` routing, WS subscribe protocol, env-config for all URLs (N1) |
| MODIFY | `telemetry/vehicleStateManager.js` | Key by (drone_id, sysid); per-drone disconnect handling (N3) |

### Frontend (`frontend/src/`)
| Action | File | Purpose |
|---|---|---|
| CREATE | `api/client.js` | Single axios instance: base URL from `VITE_API_BASE` (finally wired), JWT header, refresh interceptor |
| CREATE | `pages/FleetDashboard.jsx`, `components/fleet/*` | Fleet map, drone cards, filters, stats, alerts panel |
| CREATE | `pages/Login.jsx`, `store/useAuthStore.js`, route guards | Auth UI |
| CREATE | `store/useFleetStore.js` | Drone registry, health, alerts |
| CREATE | `context/DroneScope.jsx` | Provides droneId to existing pages mounted at `/drone/:droneId/*` |
| MODIFY | `useTelemetryStore.js` | Key state by drone_id; WS subscribe messages; env-based WS URL (F1/F6) |
| MODIFY | `useMissionStore.js` | Per-drone editing buffers (F4) |
| MODIFY | existing pages | Replace hardcoded URLs with api client; take droneId from scope (mechanical change) |

### Deployment (repo root / `deploy/`)
CREATE: `Dockerfile.python`, `Dockerfile.node`, `Dockerfile.frontend` (nginx), `docker-compose.yml` (+ `docker-compose.offline.yml` with SQLite, `docker-compose.wireguard.yml` profile), `k8s/` manifests, Prometheus `/metrics` endpoints in both backends, health-check routes.

---

## 5. Dependency Graph (phase ordering)

```
Phase 3 (DroneSession + registry, Python)  ──►  Phase 4 (gateways, scoped routes, WS subscriptions)
        │                                              │
        ▼                                              ▼
Phase 5 (multi-drone telemetry + DB storage) ──► Phase 7 (fleet dashboard)
Phase 6 (video registry)                     ──► Phase 7
Phase 8 (auth/RBAC/orgs) — DB schema lands early (Phase 3) but enforcement can ship in parallel from Phase 4
Phase 9 (logs) depends on Phase 5 storage; Phase 10 (deployment) is parallelizable, finalized last
```

## 6. API Changes (summary)

- New: `POST /api/auth/login|refresh|logout`, `GET/POST /api/orgs`, `GET/POST /api/users`, `GET/POST /api/drones` (register/provision), `GET /api/drones/:id/health`, `GET /api/fleet/summary`, `GET /api/alerts`, `GET /api/flights`, `GET /api/drones/:id/flights/:fid/replay`.
- Scoped: every existing `/api/<x>` route also available as `/api/drones/:droneId/<x>`. Unscoped legacy routes resolve to the caller's default drone → **zero breaking changes**.
- WS: `ws://host:8080/ws?token=…` with `{op:"subscribe"|"unsubscribe", drones:[…]}`; server messages unchanged in shape, plus `drone_id` in envelope (additive — matches the engine's existing additive-enrichment rule).

## 7. Database Changes

New schema (migration 001): `organizations`, `users`, `refresh_tokens`, `drones` (uuid, org_id, name, model, connection_profile jsonb, status, last_seen), `drone_sessions` (worker routing), `flights` (detected arm→disarm spans), `telemetry_history` (1 Hz downsample, partitioned by day), `missions` (versioned), `mission_runs`, `commands_audit`, `alerts`, `alert_rules`, `maintenance_records`, `firmware_records`, `media` (recordings/snapshots/logs metadata). Postgres in cloud, SQLite offline — repository layer hides the difference (both via Knex).

## 8/9. Frontend & Backend Changes — covered in §3–4.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Regression of the working single-drone GCS | Legacy alias routes + auto-created default session; full existing SITL workflow re-tested each phase |
| asyncio contention with many sessions | Sessions are I/O-bound; benchmark with N SITL instances (Phase 5 test); worker scale-out is the escape hatch |
| ZMQ single socket becomes bottleneck | Topic-prefixed PUB scales far beyond need (10 Hz × drones × ~2 KB); Node subscribes per topic |
| GStreamer resource limits with many pipelines | Lazy start/stop on viewer count; per-worker stream caps |
| Auth added on top of previously-open APIs breaks dev flows | `AUTH_MODE=disabled` env for local dev/offline single-user installs |
| sysid collisions across drones | Scoping by session/transport, never global sysid |

## 11. Testing Strategy

Per phase: pytest for Python (session registry lifecycle, 3× SITL concurrent missions, reconnect isolation), Jest/vitest for Node (auth, RBAC matrix, subscription fan-out, repository layer against SQLite), Playwright smoke for dashboard. The existing SITL orchestrator becomes the fleet integration harness (N simulated drones). Every phase ends with the **legacy single-drone regression run**: connect SITL → mission upload → fly → video → params, via unscoped routes.

## 12. Rollback Strategy

Each phase is a separate git branch/PR; legacy routes mean any phase can be reverted without breaking the previous one; DB migrations are reversible (down migrations required); feature flags: `AUTH_MODE`, `FLEET_MODE` (off = exactly today's behavior with one default session).

## 13. Implementation — begins Phase 3 (separate deliverable, per phase).

## 14. Validation Checklist (Phase 2)

- [x] Every Phase-1 inventory item (P1–P8, N1–N6, F1–F6) has a named remedy in this design
- [x] No existing protocol/pipeline module is rewritten — reuse table in §2
- [x] All deployment modes (cloud/local/offline/hybrid) served by one codebase
- [x] All required capabilities mapped (orgs, RBAC, registration, provisioning, health, alerts, logs, firmware, thermal/RGB, analytics)
- [x] Backward compatibility guaranteed via legacy alias routes + default session
