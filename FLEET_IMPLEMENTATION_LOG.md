# FLEET IMPLEMENTATION LOG

Running log of the fleet-platform build-out, one section per phase.
Design reference: `FLEET_PHASE2_ARCHITECTURE_DESIGN.md`. Baseline: `FLEET_PHASE1_ARCHITECTURE_REPORT.md`.
Branch: `fleet-platform`.

---

## Phase 3 — Python backend: DroneSession / SessionRegistry (2026-07-09)

**What changed** — the process-global singletons in `python_service/main.py` (P1–P3, P6 in the Phase 1 inventory) became per-drone sessions:

- NEW `python_service/fleet/drone_session.py` — `DroneSession` bundles one `LinkManager` + `MissionManager` + `ParameterSyncManager` + `PreflightManager` + optional `CameraManager` + per-drone calibration progress state (`mag_cal_data`, `accel_cal_pos`, both previously module globals). Exposes `connect/disconnect/close`, `online`, `last_seen`, `to_summary()`.
- NEW `python_service/fleet/session_registry.py` — `SessionRegistry`: create (409 on duplicate id), get/require, remove (closes the link; the `default` session cannot be removed), `fleet_summary()`, `close_all()`.
- NEW `python_service/fleet/routes.py` — `/fleet` API: `GET /fleet`, `GET|POST /fleet/drones`, `GET|DELETE /fleet/drones/{id}`, per-drone `connection/start|stop|status`, `state`, `vehicles[/select]`, `command`, `mode`, `mission[/upload|/transfer/status]`, `parameters/refresh|status|set`. Handlers mirror the legacy routes 1:1.
- MODIFIED `main.py` — lifespan builds the registry and a **default session** from the same env vars as before (`DRONE_CONNECTION_STRING`, `DRONE_BAUDRATE`, `DRONE_UDP_FORWARD`, new optional `DRONE_NAME`); the old module globals (`link_manager`, `mission_manager`, …) now alias the default session's managers, so **every legacy route works unchanged**. Calibration globals were removed; legacy calibration routes read the default session's state.
- MODIFIED `telemetry_pub.py` — `publish_loop()` now accepts the registry (or, back-compat, a bare LinkManager) and publishes every session's telemetry each 10 Hz tick, tagging all payloads with additive `drone_id`. ADS-B 1 Hz throttle is per-drone. A publish failure in one session no longer kills the loop (per-tick exception guard).

**Deliberately deferred** — only the default session gets a `CameraManager`: the video subsystem is still a process singleton until Phase 6. SITL multi-instance lands with Phase 4/5 test harness. Node/frontend are untouched by this phase (ZMQ shape is additive-only).

**Tests** — `python_service/tests/test_fleet_sessions.py` (13 passing): manager isolation between sessions, per-drone calibration state, registry CRUD + duplicate rejection + default-session protection, fleet API via full-app TestClient (register/list/deregister/404/409), and a legacy-surface regression suite (`/state`, `/connection/status`, `/vehicles`, `/calibration/status`, `/command` error path). Dev deps: `requirements-dev.txt`.

**Verification** — `python -m py_compile` on all touched files; app import mounts 110 routes (19 fleet + full legacy surface); `pytest -q` → 13 passed.

**Rollback** — revert branch `fleet-platform`; no schema, no wire-format breaks (drone_id field is additive).

---

## Phase 4 — Node fleet gateway: scoped routes, drone-aware telemetry, WS subscriptions (2026-07-09)

**What changed** — remedies N1, N3, N4, N5 from the Phase 1 inventory:

- `node_api/server.js` — `HTTP_PORT`, `PYTHON_API_URL`, `ZMQ_PUB_URL` are now env-configurable (N1). New fleet routes: `POST /api/drones/:droneId/command/:cmd` (same COMMAND_MAP, addressed per drone) plus a generic verbatim forwarder `(/api/fleet/*, /api/drones/*) → python /fleet/*` — Python's fleet paths mirror the gateway's 1:1, so registration/connection/state/mission/parameters all proxy with zero per-route boilerplate, and Python's 404/409 status codes pass through.
- NEW `node_api/ws/subscriptionManager.js` — inbound WS ops `{op:"subscribe"|"unsubscribe"|"subscribe_all", drones:[…]}`. Clients that never subscribe get the legacy firehose (N4 back-compat); subscribed clients receive only their drones' frames plus untagged frames. Server replies `SUBSCRIPTION_ACK`.
- `node_api/telemetry/vehicleStateManager.js` — state is per-drone: composite vehicle keys (`droneId:sysid`; the default drone keeps bare sysid keys so the legacy frontend sees identical wire shapes), per-drone connection state and primary sysid, and **disconnect now wipes only that drone's vehicles** (N3 — the old code wiped the whole fleet). Legacy getters (`lastConnectionState`, `primarySysId`) reflect the default drone.
- `node_api/telemetry/telemetryEngine.js` — extracts `drone_id` from each ZMQ frame (absent → `default`), threads it into state keying, stale detection, `engine_envelope.drone_id`, `telemetry_engine.fleet.{drone_id, drone_ids}`, and passes it to `broadcast(data, droneId)` for subscription filtering. Same sysid on two drones no longer collides.

**Tests** — `node_api/test/fleet.test.js` (12 passing, `npm test` wired to `node --test`): composite keying, per-drone wipe isolation, legacy getters, envelope tagging, sysid-collision safety, debug snapshot, subscription back-compat/filter/unsubscribe/garbage-tolerance.

**Verification (live integration)** — booted Python (:8000) + Node (`HTTP_PORT=8090`, proving the env config): registered `scout-1` through the Node proxy (201), duplicate → 409, unknown drone → 404 passthrough, legacy `/api/connection/status` unchanged; a WS client saw both drones' frames on the firehose, then only `scout-1` frames after subscribing.

**Rollback** — revert the four files; wire format is additive-only.

---

## Phase 5A — Production stabilization (2026-07-10)

Scope is **stabilization only** (per `FLEET_PHASE5_PRODUCTION_ARCHITECTURE_REVIEW.md` §7): fix the verified SPOFs and give both tiers a health/metrics/logging surface and clean lifecycle. No persistence, auth, dashboard, video, or analytics work — those remain 5B+. Full backward compatibility with the single-drone and multi-drone APIs is preserved (existing 13 Python + 12 Node tests still pass unchanged).

**Node gateway (`node_api/`)** — new dependency `prom-client`.
- NEW `lib/config.js` — env validation with fail-fast. `validateConfig(env)` is pure (returns `{config, errors}`); `loadConfigOrExit` runs it at boot and `process.exit(1)` on any bad value (port range, URL shape, log level, backoff ordering, booleans) **before** any socket binds.
- NEW `lib/logger.js` — structured single-line JSON logs. Correlation IDs (`request_id`) propagate via `AsyncLocalStorage` (`runWithContext`), so handlers log without threading IDs. `child()` binds subsystem fields; never throws on unserializable fields.
- NEW `lib/metrics.js` — `prom-client` registry: default process metrics + `http_requests_total`, `http_request_duration_seconds`, `ws_clients`, `ws_messages_sent_total`, `ws_send_dropped_total`, `ws_clients_disconnected_total`, `zmq_frames_received_total`, `zmq_reconnects_total`, `zmq_connected`, `zmq_last_frame_age_seconds`, `telemetry_frames_processed_total{drone_id}`, `drone_last_seen_age_seconds{drone_id}`.
- NEW `lib/health.js` — `HealthState`: liveness (ok → `shutting_down`); readiness gated on ZMQ-connected + telemetry freshness, with a cold-start grace window so readiness doesn't flap before anything publishes.
- NEW `ws/zmqSubscriber.js` — **fixes F3.** `ZmqTelemetrySubscriber` runs a supervised loop: on any ZMQ error *or* clean stream end it reconnects with exponential backoff + full jitter (capped), forever, until `stop()`. Connection state, frames, and reconnects feed health + metrics. Socket factory and sleep are injectable → unit-tested with a fake socket, no broker.
- NEW `ws/broadcaster.js` — per-client send-queue cap using `ws.bufferedAmount`: soft cap sheds the frame (next snapshot supersedes it), hard cap terminates the slow client with a `SLOW_CONSUMER` notice. Stops one slow client OOM-ing the single Node process.
- MODIFIED `server.js` — wires all of the above: fail-fast config load; correlation-id + request-metrics middleware; `/healthz`, `/readyz`, `/metrics` endpoints; supervised ZMQ subscriber replaces the old catch-and-return `runZmqSubscriber`; broadcast goes through the capped broadcaster; 404 + final error-handling middleware; `SIGTERM`/`SIGINT` graceful shutdown (drains WS, stops ZMQ, closes server, force-exit timer); `uncaughtException`/`unhandledRejection` panic recovery.

**Python service (`python_service/`)** — new dependency `prometheus-client`.
- NEW `observability/` package (dependency-light, no gi/MAVLink imports → unit-testable):
  - `config.py` — `load_config(env)` validates and returns a frozen `ServiceConfig`, raising `ConfigError` with **all** problems at once; `main` calls it at import and `SystemExit(1)` on failure.
  - `logging_config.py` — JSON formatter on the root logger; `request_id`/`drone_id` via `contextvars` so correlation propagates through async handlers.
  - `metrics.py` — dedicated `CollectorRegistry`: `http_requests_total`, `http_request_duration_seconds`, `telemetry_frames_published_total{drone_id,type}`, `telemetry_publish_errors_total`, `telemetry_tick_duration_seconds`, `telemetry_ticks_total`, `telemetry_tick_failures_total`, `fleet_drones`, `fleet_drones_online`, `drone_last_seen_age_seconds{drone_id}`, `zmq_publisher_up`.
  - `health.py` — `HealthState` mirroring the Node semantics; `reset_for_startup()` clears state each lifespan so a re-init begins clean.
- MODIFIED `telemetry_pub.py` — `_send_zmq` retries transient send failures with bounded linear backoff (config-driven) and counts errors; `publish_loop` records a tick into health + metrics each cycle, updates fleet/last-seen gauges, and a bad tick is counted and survived (never kills the loop). Constructor stays backward-compatible (new args are keyword-optional).
- MODIFIED `main.py` — config validated at import (fail-fast); JSON logging installed; correlation-id + request-metrics HTTP middleware with panic recovery (clean JSON 500, no leaked stack); `/healthz`, `/readyz`, `/metrics` endpoints; publisher wired with health + metrics + retry policy; lifespan resets health on startup and marks shutting-down on teardown (uvicorn drives the signal handling).

**Tests**
- Node `test/production.test.js` (20 passing; suite total **32** with the Phase 4 fleet tests, `npm test` now runs the whole `test/` dir): config validation, JSON logging + correlation, metrics exposition, health/readiness transitions, supervised ZMQ **reconnect-after-error + backoff cap + handler-throw survival (F3)**, and the slow-client soft/hard send-queue cap.
- Python `tests/test_production.py` (14 passing; suite total **27**; `pytest.ini` sets `asyncio_mode=auto`): config validation, JSON formatter + context, health/readiness, metrics exposition, `_send_zmq` retry-then-succeed / give-up-after-budget, `publish_loop` tick recording + survives a raising source, and a live `TestClient` check of `/healthz` `/readyz` `/metrics` + correlation-id echo + a legacy-route backward-compat assertion.

**Verification (live)** — booted the Node gateway with **no publisher running**: process stays alive and keeps reconnecting (old code died silently — F3), `/healthz` 200, `/readyz` 200 (grace) then 503 when stale, `/metrics` serves Prometheus text, `x-request-id` echoed. `SIGTERM` → `shutdown_initiated`/`shutdown_complete`, exit 0. Bad config (`HTTP_PORT=abc` / `LOG_LEVEL=chatty`) → both tiers exit 1 with a structured error. *Exit criterion met: kill/misconfigure a process → clean fail or full recovery without human action.*

**Deliberately deferred to 5B+** — DB persistence & registry rehydration, auth/RBAC/CORS allow-list, `connection_string` allow-list (F2 dial-out), telemetry delta/rate-limit scale pass (F5/5D). Not started, per scope.

**Rollback** — new files are additive; the `server.js`/`main.py`/`telemetry_pub.py` edits revert cleanly. Wire format unchanged; no schema. Requires `npm install` (prom-client) and `pip install prometheus-client`.

---

## Phase 5B — Persistence layer (durable core) — 2026-07-11

**Single source of truth:** `FLEET_MASTER_ARCHITECTURE.md` §8 + `FLEET_PHASE5B_DATABASE_ARCHITECTURE.md` (§4A = the 6 approved additions). Python owns the DB (ADR-002); Node keeps **zero** DB deps (`package.json` untouched, verified). SQLAlchemy Core 2.0 + Alembic, Repository Pattern (ADR-003), SQLite default / PostgreSQL opt-in via `DATABASE_URL` (ADR-004). **Entire layer is dark unless `FLEET_PERSISTENCE_ENABLED=true`** — verified: with it unset, no DB file is created (even with `DATABASE_URL` set), `main.repo_hub` stays `None`, and the new persistence routes return 503. Zero breaking changes; `DroneSession`/`SessionRegistry` architecture unchanged; legacy unscoped routes and the "default" session/drone behave exactly as before.

**New package `python_service/db/`**
- `settings.py` — `DBSettings` from env (`DATABASE_URL`, `FLEET_PERSISTENCE_ENABLED`, `DB_AUTO_MIGRATE`, `TELEMETRY_PERSIST_HZ`, `TELEMETRY_PERSIST_QUEUE_MAX`, `RETENTION_*_DAYS`, `OBJECT_STORE_URL`); `sync_url()` for Alembic.
- `schema.py` — ONE `MetaData`, 19 tables. `AutoPK = BigInteger().with_variant(Integer, "sqlite")` for high-volume append PKs (a plain BIGINT PK does **not** autoincrement on SQLite). 6 new models: `connection_profiles`, `drone_capabilities`, `mission_templates`/`mission_instances`/`mission_runs`, `org_settings`, `organization_feature_flags`.
- `base.py` — async engine; on SQLite installs `PRAGMA foreign_keys=ON` + `journal_mode=WAL` + `busy_timeout` (so ON DELETE rules fire); `create_all`/`drop_all` for tests.
- `migrate.py` + `migrations/` — Alembic. Baseline `0001_baseline` = `metadata.create_all(bind)` (never drifts from schema.py) + seeds default org/drone/active connection-profile/dev allow-list. **env.py uses `fileConfig(..., disable_existing_loggers=False)`** — else the app's JSON loggers go silent after the boot migration.
- `repositories/` — drones, allowlist (mavutil connection-string parser + org allow-list, closes F2), connection_profiles (one active, mirrors `drones.connection_string`), capabilities, flights, telemetry (only file that knows partitioning/prune), org (settings + feature flags), retention, commands, missions, alerts, provisioning, recordings, objectstore (fs driver, path-escape guarded; S3 opt-in stub). `RepositoryHub` = one facade.
- `services/` — flight_tracker (arm→disarm detection + rollup + link-loss/shutdown close), persistence_sampler (low-rate loop off the ZMQ path; drives flight detection + per-org-rate-gated telemetry writes), telemetry_writer (bounded deque, drop-oldest + metric, batched drain — never blocks), org_settings_resolver (per-org Hz/retention with TTL cache, env fallback), retention_manager (hourly, per-org windows, `retention_hold` exempt), command_audit (sink builder).

**Integration seams (all additive, guarded)**
- `main.py` lifespan — after the default session, if persistence enabled: bootstrap (migrate + engine + hub + object store), `SessionRegistry.load_from_db()` rehydrate (**F1 fix**), staggered auto-connect, start flight tracker + telemetry writer + sampler + retention manager, register the command-audit sink. Shutdown tears them down in order (closes open flights `end_reason=shutdown`, final writer flush, clears audit sink, disposes engine).
- `fleet/routes.py` — registration is now DB-authoritative (allowlist gate → `drones.upsert` → connection-profile backfill; RAM rolled back on persist failure); deregister archives (soft-delete so it doesn't rehydrate). New routes: connection-profiles CRUD/activate, capabilities, flights history, telemetry track, org settings + feature flags, mission templates/instances/runs, alert rules + alerts, recordings, command audit. All new routes 503 when persistence is off.
- `command_manager.py` — `execute_command` now wraps `_execute_command_core`; a process-wide `set_audit_sink` writes one `commands_audit` row per command on every route (NO_CONNECTION/accepted/timeout), capturing sysid/command/params/result/source_route + `flight_id` (from tracker); `operator_id` NULL until 5C. Audit failure never affects the command.
- `fleet/drone_session.py` — sets `command_manager.drone_id` (harmless when off). `mavlink_link.py` — 4 command wrappers pass a `source_route` label.
- `observability/metrics.py` — added `telemetry_persist_written_total`, `telemetry_persist_dropped_total`, `telemetry_persist_queue_depth`, `retention_rows_pruned_total{table}`, `retention_last_run_at`.

**Deps (additive):** `SQLAlchemy[asyncio]==2.0.51`, `alembic==1.14.1`, `aiosqlite==0.22.1` (Postgres `asyncpg`/`psycopg2` and S3 `boto3` documented opt-ins). Node: none.

**Tests — Python 90/90, Node 32/32.** New Python suites: `test_db_foundation` (schema/settings/Alembic baseline), `test_db_persistence` (drones repo, rehydration, allowlist incl. SSRF-reject), `test_db_profiles_capabilities`, `test_db_flights` (tracker + sampler), `test_db_telemetry_retention` (bounded writer drop-oldest, per-org rate gate, retention-hold), `test_db_command_audit`, `test_db_objectstore_config` (fs store, recordings, missions, alerts, tokens), `test_db_app_integration` (F1 restart-survives + allowlist-block + profiles/capabilities/org-settings/flags/templates through the real app). **Run app-boot tests with `ZMQ_PUB_PORT=5599`** — a live `python main.py` often holds 5556.

**Exit criteria met:** F1 — registered drone survives a restart (verified end-to-end through the app). F2 — every `connection_string` validated against the org allow-list before `mavutil.mavlink_connection()` (SSRF `169.254.169.254` rejected). Every arm→disarm yields a flight; every command yields an audit row.

**Rollback** — new files additive; edits to `main.py`/`fleet/*`/`command_manager.py`/`mavlink_link.py`/`observability/metrics.py`/`requirements.txt` revert cleanly. Pre-DB rollback point is the `fleet-phase5A` tag. Wire format unchanged. **Not committed — awaiting user approval.**

**Deliberately deferred:** 5C (auth/RBAC/CORS — `users`/`operator_id` columns already present), 5D (telemetry delta/rate scale), Phase 8 (alert *firing* engine — tables + repos exist), mission *execution* wiring, S3 object-store driver, Postgres declarative partitioning (SQLite uses batched-delete prune now).
