# FLEET PHASE 5 — Production Architecture Review

**Reviewer role:** Principal Enterprise Systems Architect (architecture-review skill, Architect persona)
**Date:** 2026-07-09
**Scope reviewed:** Phases 1–4 as implemented on branch `fleet-platform` (code-verified, not docs-only), plus the Phase 2 target design
**Benchmarks:** DJI FlightHub 2, FlytBase Enterprise, PDRL AeroGCS Enterprise, Dronecloud
**Verdict (up front): APPROVE-WITH-CHANGES.** The session-scoping foundation is correct and should not be reworked. But the platform as it stands is a **multi-drone GCS, not yet a fleet platform**: it has no durable state, no identity, no security boundary, and several verified single points of failure. The changes below are ordered so each one is prerequisite to the features planned after it.

---

## 1. Problem Restatement (no solution language)

An operator organization needs to run many drones — owned by different organizations, flown by different people, connected over unreliable cellular/RF links — from shared infrastructure, with confidence that: telemetry and video arrive with low latency; commands are only executed by authorized people and are traceable afterward; a drone, link, or server failure affects the smallest possible blast radius; history (flights, logs, video) survives restarts and is queryable; and the same software runs in cloud, on-premise, and fully offline field deployments. The existing single-drone GCS workflow must keep working throughout.

## 2. What Phases 3–4 Got Right (do not rework)

- **Session isolation as the core primitive.** `DroneSession` bundling per-drone managers mirrors how QGC models vehicles and is the correct unit of supervision, health, and (later) worker placement.
- **Additive wire evolution.** `drone_id` tagging with a `default` alias preserved byte-compatible frames for the legacy client — the strangler-fig pattern applied properly.
- **Subscription WS with firehose fallback** is the right client contract shape; commercial platforms (FlytBase, FlightHub) all use per-resource channel subscription.
- **Reuse of the MAVLink protocol layer** (mission microprotocol, ACK machine, param sync) — this is the hardest code in the platform and it was scoped, not rewritten.
- **1:1 path mirroring between gateway and fleet API** keeps the proxy generic — near-zero marginal cost per new endpoint.

## 3. Critical Findings (evidence-based)

Ordered by severity. **F1–F4 are production-disqualifying; F5–F9 are scale/operability ceilings; F10+ are enterprise capability gaps.**

### F1 — The drone registry is RAM. `SEV-CRITICAL`
`SessionRegistry` lives in Python process memory. A service restart silently deregisters every drone except the env-configured default. There is no source of truth, no rehydration, no drone identity that survives a reboot — while `param_cache/`, `recordings/`, and profiles *do* persist, so state becomes internally inconsistent after restart. **Every commercial platform treats the fleet registry as durable data with the runtime session as a cache over it.** This inverts our current model and must land before any feature that references a drone by ID (missions, alerts, history, RBAC).

### F2 — No security boundary exists at all. `SEV-CRITICAL`
Verified: FastAPI binds `0.0.0.0:8000` with no auth and no CORS policy; the Node gateway is wide-open CORS with no auth; the generic fleet forwarder exposes the *entire* Python control surface (arm, mode, mission upload, parameter writes) to any host that can reach either port; `connection_string` on drone registration is passed unvalidated into `mavutil.mavlink_connection` (arbitrary host/port/serial-device dial-out = SSRF-class primitive); no TLS anywhere; no MAVLink signing. Original plan deferred auth ("JWT later") — acceptable for localhost GCS, disqualifying for fleet. **Consequence: authentication cannot remain Phase 8. Every endpoint shipped before auth is rework.** Benchmarks: FlightHub 2 and FlytBase are OAuth2/token-gated per organization on every call and stream, with per-device credentials.

### F3 — The Node ZMQ subscriber dies permanently on error. `SEV-CRITICAL` (verified bug)
`runZmqSubscriber()` (`node_api/server.js:163-181`): on any ZMQ error the `for await` exits into a `catch` that logs and returns. **Telemetry silently stops for every client until manual Node restart**; REST keeps working, so the failure is partially masked. No reconnect, no backoff, no liveness signal. This is the exact class of failure fleet ops teams are paid to never have.

### F4 — Process-level SPOFs with no supervision or health surface. `SEV-HIGH`
Three processes, all singletons, started manually in terminals; no `/healthz`/`/readyz`, no restart policy, no watchdog. Python worker death takes down every drone link *and* video *and* the fleet API. K8s/Docker can supervise (Phase 10) but only if health endpoints exist — they don't.

### F5 — Telemetry pipeline saturates in the low hundreds of drones. `SEV-HIGH`
Measured hot path per 10 Hz tick per vehicle: Python `vehicle.to_dict()` → `json.dumps` → ZMQ → Node `JSON.parse` → **deep clone via `JSON.parse(JSON.stringify(data))`** (`telemetryEngine.js:85`) → enrichment → `JSON.stringify` → per-client `ws.send` of the full string. Full snapshots always; no deltas, no per-client rate adaptation, no batching, no binary framing. Single-threaded Node does ~3 JSON codec passes per frame. **First bottleneck: Node CPU at roughly 2–5k frames/s ≈ 200–500 drones at 10 Hz — before accounting for viewer fan-out multiplication.** Second: Python's per-session 100 Hz poll loop (`recv_match(blocking=False)` + `asyncio.sleep(0.01)`, `mavlink_link.py:244-246`) burns CPU per idle session. Third: full-snapshot serialization in `publish_loop` regardless of change.

### F6 — Commands have no queue, no audit, no idempotency. `SEV-HIGH`
Command path is synchronous HTTP through two hops with in-memory retry state. Nothing records *who* commanded *what*, *when*, with *what result* — table stakes for enterprise (AeroGCS retains command/flight logs for regulator compliance; FlightHub logs every operator action). No offline queueing for intermittently connected drones, no priority (RTL must preempt), no server-side validation policy (geofence/altitude limits).

### F7 — Telemetry history does not exist; "replay" is a local file tap. `SEV-HIGH`
`.jsonl` recordings on local disk, manually started. No flight detection (arm→disarm), no time-series store, no downsampled history, no analytics substrate. Every benchmark platform provides per-flight history + fleet analytics as a core commercial feature.

### F8 — Video remains a process singleton with per-viewer WebRTC from the worker. `SEV-MEDIUM`
One `GstVideoReceiver` per process (Phase 6 planned); each WebRTC peer gets its own `webrtcbin` on the ingest host — viewer count multiplies load exactly where drone links terminate. No TURN (symmetric-NAT/WAN viewers fail — self-documented), no lazy pipeline lifecycle, no viewer accounting, no recording upload. Benchmarks separate **ingest** from **distribution** (FlightHub relays RTMP/WebRTC through media servers; FlytBase uses managed WebRTC SFU).

### F9 — Zero observability. `SEV-MEDIUM`
`console.log`/basic `logging`, no metrics endpoint, no traces, no SLOs, no correlation IDs, no structured JSON logs with `drone_id`. Violates the org observability standard (golden signals, SLO-first). You cannot operate a fleet you cannot measure; you cannot even *demonstrate* the F5 ceiling without metrics.

### F10 — Enterprise capability gaps (vs. benchmark feature baseline)
No multi-tenancy/orgs/RBAC (F2 prerequisite) · no provisioning identity (drone_id is client-supplied; no per-device credentials — FlightHub binds devices via activation codes, FlytBase per-device tokens) · no alert/notification engine · no health scoring · no object storage abstraction (local disk only) · no API versioning (`/api/*` frozen-by-accident; new surface should be `/api/v1/*`) · no config/feature-flag management · no DR story (nothing to back up *because* of F1 — fixing F1 creates the backup obligation) · **no edge agent**: drones are expected to expose raw MAVLink endpoints; every benchmark platform ships an authenticated outbound-dialing device agent (dock/companion) doing TLS + store-and-forward over LTE. This is the single biggest *strategic* divergence from FlightHub/FlytBase for "thousands of drones over cellular."

### Minor (fix opportunistically)
`subscribe('')` with post-parse filtering — ZMQ topic-prefix (`drone_id|`) filtering happens in C and is nearly free · monotonic_ms is a counter, not a clock · `auto` connection sweep is wrong as a fleet default (grabs whatever serial device answers first) · frontend `VITE_API_BASE` still unwired (known, Phase 7).

## 4. Scalability Assessment — where it breaks

| Load | Outcome (current code) |
|---|---|
| 1–20 drones, LAN | Works today. |
| ~50 drones | Works; Python poll-loop overhead visible; no metrics to see it (F9). |
| 200–500 drones | **Node JSON pipeline saturates a core (F5)**; telemetry latency grows unboundedly (no backpressure — `ws.send` buffers grow per slow client). |
| 1000+ drones | Requires worker sharding (designed in Phase 2, not built), delta/binary telemetry, broker-grade fan-out, media separation (F8). |
| Viewers | Each browser gets every subscribed drone at full 10 Hz; a 50-drone dashboard ×20 operators = 10k msg/s egress from one Node process. Per-client rate limiting is mandatory before the fleet dashboard ships (Phase 7). |

**Scaling model to adopt:** vertical per worker → horizontal by *drone-to-worker assignment* (each drone owned by exactly one Python worker; DB row records placement; Node routes by lookup). Not a distributed-systems problem — an ownership-table problem. Defer Kafka/MQTT brokers until a measured need; **abstract the transport now, buy the broker later** (persona rule: don't design for scale that doesn't exist; standard: swap requires ADR).

## 5. Failure Mode Table (key components)

| Component fails | Today | Required |
|---|---|---|
| Node ZMQ sub errors | Telemetry stops forever, silently (F3) | Reconnect w/ backoff + `telemetry_lag` metric + stale banner in UI |
| Python worker dies | All links+video+fleet API gone; registry erased (F1, F4) | Supervised restart; DB rehydrate sessions; auto-reconnect drones; UI shows per-drone OFFLINE |
| One drone's link flaps | Isolated ✅ (session backoff; per-drone wipe verified in tests) | Keep; add alert rule |
| DB down (future) | n/a | Live telemetry/commands keep working (DB is not on the hot path); registry mutations + history buffer and fail loud |
| Slow WS client | Node buffers grow unboundedly | Per-client send-queue cap + drop-oldest + disconnect notice |
| GStreamer pipeline hang | Watchdog exists per receiver ✅ | Keep; add per-stream health metric + auto-restart budget |
| Video viewer surge | Ingest host CPU death (F8) | Lazy pipelines, viewer caps, SFU escape hatch documented |

## 6. Alternatives Assessment (genuine tradeoffs)

| Alternative | Tradeoff | Verdict |
|---|---|---|
| **MQTT broker core now** (FlightHub-style device cloud) | Right end-state for cellular fleets; but replaces the working ZMQ path, adds broker ops burden to offline deployments, and blocks feature work for weeks | Defer. Abstract publisher/consumer interfaces now; introduce MQTT with the edge agent (new Phase 11) |
| **mavlink-router / mavp2p in front, one process per drone** | Battle-tested process isolation; but destroys the shared-session model, explodes memory (N× Python), and makes the fleet API a distributed system on day one | Reject; revisit only if per-session fault isolation proves insufficient |
| **Rewrite gateway in Go/Rust for telemetry throughput** | 10× headroom; but abandons working enrichment code and the team's stack | Reject. Delta+binary+rate-limit in Node buys the same headroom at current scale |
| **Postgres-only (no SQLite offline)** | One driver, simpler migrations; but breaks the offline/field deployment requirement | Reject; Knex targeting both, repository layer hides the difference |
| **Buy video (managed WebRTC/LiveKit) vs. build SFU** | Managed = fastest to video-wall scale; but offline deployments need self-hosted; per-minute costs | Keep own ingest (exists, works); make distribution pluggable; document LiveKit/mediasoup as the scale path |

## 7. Required Changes → Updated Roadmap

Re-sequenced. Auth and persistence move **ahead** of features; each phase remains independently shippable and backward-compatible.

**Phase 5A — Stabilize (days, do first):** fix F3 (ZMQ reconnect w/ backoff); `/healthz` + `/readyz` both tiers; structured JSON logs with `drone_id`/`request_id`; `prom-client` + `prometheus-client` `/metrics` (frames/s, WS clients, per-drone last-seen age, send-queue depth); per-client WS send-queue cap. *Exit: kill -9 any process → full recovery without human action.*

**Phase 5B — Durable core:** Postgres/SQLite via Knex + migrations; tables `organizations, users, drones, drone_credentials, flights, telemetry_history(1Hz), commands_audit, alerts, alert_rules`; registry becomes DB-backed with session rehydration on boot; flight detection (arm→disarm) writing `flights`; provisioning tokens replace client-supplied drone_ids; `connection_string` allow-list validation (closes the F2 dial-out primitive). *Exit: restart loses zero registered drones; every flight appears in history.*

**Phase 5C — Security boundary (pulled forward from Phase 8):** JWT + refresh; RBAC (super_admin/org_admin/operator/pilot/viewer); org scoping on drones + all fleet routes; WS auth (token on connect, subscriptions filtered by org); command authorization + audit write; CORS allow-list; `AUTH_MODE=disabled` escape for offline single-user; `/api/v1/*` versioned surface with legacy `/api/*` frozen. *Exit: unauthenticated request can read/actuate nothing; every command has an audit row.*

**Phase 5D — Telemetry scale pass:** delta frames (keyframe every N), per-client rate limiting (dashboard 1 Hz, focused drone 10 Hz), ZMQ topic-prefix publishing, remove the JSON round-trip clone, poll-loop → `add_reader`/batched reads. *Exit: 200 simulated drones + 20 clients on one host with p99 end-to-end < 500 ms (measured via 5A metrics).*

**Phase 6 — Video registry** (as designed) + lazy lifecycle, viewer counts, TURN config, per-stream health; distribution kept pluggable.
**Phase 7 — Fleet dashboard** + drone-scoped GCS pages (`/drone/:id/*` reusing existing pages), wired `VITE_API_BASE`, login UI.
**Phase 8 (revised) — Alerting & health:** rule engine on the (finally real) eventBus, notification dispatch abstraction (webhook first; email/SMS/Slack as plugins), drone+fleet health scores.
**Phase 9 — Logs & media pipeline:** storage abstraction (local FS default, S3/MinIO driver), post-flight upload, BIN/tlog management, retention policies.
**Phase 10 — Deployment:** Dockerfiles, compose profiles (cloud/offline/wireguard), K8s + Helm, Grafana dashboards as code, CI.
**Phase 11 (new, strategic) — Edge agent & broker ingestion:** authenticated outbound-dialing device agent (companion/dock) with TLS + store-and-forward; MQTT ingestion path beside ZMQ. This is what makes "thousands of drones over LTE" true rather than aspirational.

## 8. ADR Draft

**ADR-001: Fleet platform evolves via durable-registry + security-first re-sequencing**
- **Status:** proposed
- **Context:** Phases 3–4 delivered in-memory multi-drone sessions with backward compatibility. Review found durable identity, security, and fault-tolerance gaps that every subsequent feature depends on.
- **Decision:** (1) DB (Postgres; SQLite offline; Knex) becomes the source of truth for drones/orgs/users/flights; runtime sessions are caches rehydrated at boot. (2) AuthN/RBAC/audit land before any new feature surface; new APIs ship under `/api/v1`. (3) Telemetry transport stays ZMQ behind an interface; brokers deferred to the edge-agent phase. (4) Scale-out model is drone-to-worker ownership recorded in the DB, not clustering. (5) Video ingest stays GStreamer-per-stream; distribution is pluggable.
- **Consequences:** ~2 phases of foundation before visible features; every later phase gets identity, persistence, and authz for free; offline deployments stay single-box with `AUTH_MODE=disabled`; a broker migration later is an ingestion-adapter change, not a rewrite.

## 9. Open Questions (need owner decisions)

1. **Deployment reality check:** how many drones, orgs, and concurrent operators in the first real deployment? (Sets whether 5D can slip after 7.)
2. **Postgres availability on-prem** at customer sites, or is SQLite the on-prem default too?
3. **Regulatory logging** (DGCA/DGAC-style flight-log retention, as AeroGCS targets) — compliance requirement or not? Affects `flights`/audit schema now.
4. **Companion hardware** on the drones (RPi/Jetson dock?) — determines Phase 11 agent feasibility and whether raw-MAVLink-over-VPN is a permanent mode or a bridge.
5. **Video viewer scale target** (ops team of 5 vs. video wall of 100) — decides if an SFU enters the roadmap this year.

## 10. Evaluator Self-Grade (`evaluators/architecture.md`)

```
Problem/goals:      [x] pass        — restated w/o solution language; goals quantified (§4, 5D exit)
Design correctness: [x] pass        — critical path traced code-level; gaps evidenced (F1-F9 w/ file:line)
Service boundaries: [x] pass        — data ownership fixed by F1 remedy; no cross-service DB reads introduced
Simplicity:         [x] pass        — broker/SFU/rewrite explicitly deferred with reasons (§6)
Failure modes:      [x] pass        — per-component table w/ required behavior (§5)
Scalability:        [x] pass        — first bottleneck named w/ numbers (Node JSON path, 200-500 drones)
Ops readiness:      [~] partial     — plan defined (5A) but nothing exists today; that is finding F9/F4
Alternatives:       [x] pass        — 5 alternatives w/ genuine tradeoffs (§6)
Principles:         [~] partial     — API-first/security-by-design violations found and re-sequenced (5C)

Overall: APPROVE_TO_PROCEED (with the required changes and re-sequenced roadmap above)
```

**Bottom line:** the Phase 3–4 foundation is sound and reusable in full. Do not build another feature until 5A (days) and 5B/5C (the durable, secured core) are done — everything after that compounds instead of accruing rework.
