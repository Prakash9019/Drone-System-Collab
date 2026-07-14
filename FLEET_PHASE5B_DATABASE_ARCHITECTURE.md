# Fleet Platform — Phase 5B Database Architecture (Design for Review)

**Status:** DRAFT — for review & approval. **No implementation code has been written.**
**Branch:** `fleet-platform`  ·  **Baseline:** Phase 5A (`fleet-phase5A` tag)  ·  **Date:** 2026-07-10
**Scope authority:** `FLEET_PHASE5_PRODUCTION_ARCHITECTURE_REVIEW.md` §7 (Phase 5B durable core), §6, §9, ADR-001.

> This document defines the persistence layer only. It is the gate before any Phase 5B code.
> Read it, mark decisions D1–D6 (§2) approved/changed, and the schema follows.

---

## 1. Where we are today (ground truth from the code)

There is **no database anywhere in the application** — verified by full grep; every `sqlite3/sqlalchemy/asyncpg/knex` hit is inside `venv`. State lives in two places:

| Kind | What | Survives restart? |
|---|---|---|
| **JSON files** | `param_cache/<sysid>_<compid>.json`, `osd_profiles.json`, `sitl_profiles.json`, `video_settings.json` | ✅ (ad-hoc) |
| **JSONL files** | `recordings/<uuid>.jsonl` (telemetry replay) | ✅ (ad-hoc) |
| **RAM only** | Fleet `SessionRegistry._sessions` (**registered drones vanish on restart** — this is F1), live `VehicleState`, ADS-B store, command state, arm/disarm status, StatusText log | ❌ |

Consequences that directly shape this design:

- **F1 — no durable registry.** `SessionRegistry` is a `Dict[str, DroneSession]`. A process restart loses the entire fleet. The DB must become the source of truth, with sessions rehydrated at boot (ADR-001).
- **No flight record.** `VehicleState.to_dict()` is a live snapshot; nothing captures arm→disarm as a flight. Flight history must be *synthesized* by a new detector watching `Status.armed` transitions.
- **No command audit.** `command_manager._active_commands` is transient RAM, overwritten by the next command, and **captures no operator identity** (the request models carry no auth). Audit is greenfield.
- **No connection allow-list.** `connection_string` flows straight into `mavutil.mavlink_connection()` with no scheme/host validation (F2 — dial-out/SSRF surface). The DB layer must gate it.
- **No DB deps declared** in `requirements.txt` or `package.json`. Whatever we choose, we add from scratch.

---

## 2. Key decisions requiring sign-off (D1–D6)

These shape the schema. Each states a **recommendation + rationale**; change any before approval.

### D1 — Which tier owns the database? (**RECOMMEND: Python**, SQLAlchemy Core + Alembic)

§7 literally says *"Postgres/SQLite via Knex + migrations"* (Knex = Node). **I recommend overriding that** to Python ownership:

| | Python (SQLAlchemy Core + Alembic) — **recommended** | Node (Knex) — as §7 literally states |
|---|---|---|
| Who produces the data? | **All of it.** Registry, telemetry, arm/disarm detection, commands, params — every writer is Python. | None. Node is a read/broadcast gateway; it would need new write paths. |
| Boot rehydration (ADR-001) | Natural — the Python process that owns `SessionRegistry` reads the DB and repopulates it. | Node would rehydrate, then re-teach Python the fleet over HTTP. Two sources of truth. |
| Write amplification | One writer, one connection pool. | Telemetry crosses the ZMQ boundary to Node just to be written — double hop. |
| Cost | New dep set (`sqlalchemy`, `alembic`, `aiosqlite`/`asyncpg`). | New dep set (`knex`, `better-sqlite3`/`pg`) **and** new Python→DB read path for rehydration anyway. |

**Rationale:** the producer owns the store. Node keeps zero DB code; it stays a stateless broadcaster. This is the single most consequential decision in the doc — flagged explicitly because it diverges from §7's wording.

### D2 — Primary target & dialect strategy (**RECOMMEND: SQLite default, PostgreSQL for scale**)

Per §6 (Postgres-only was *rejected*), we ship **both**, hidden behind a repository layer:
- **SQLite (default)** — single-node / edge / offline / dev. Zero-ops, file-backed.
- **PostgreSQL (opt-in via `DATABASE_URL`)** — multi-node, high telemetry volume, regulatory retention.
- A thin **repository layer** is the only code that knows the dialect (see §7). SQLAlchemy Core emits portable SQL; the few divergences (partitioning, upsert, JSON type) are dialect-branched in one place.

### D3 — Telemetry write rate (**RECOMMEND: 1 Hz persisted, decoupled from the 10 Hz wire**)

Telemetry publishes at **10 Hz** (`TELEMETRY_HZ`). §7 mandates `telemetry_history(1Hz)`. We persist a **1 Hz downsample** (every 10th tick, or last-sample-per-second per drone) on a **separate async writer with a bounded queue** — never inline in the publish loop (that loop must stay real-time; see Phase 5A resilience). If the queue saturates we drop-oldest and count it in `/metrics`. Live telemetry stays 10 Hz on the wire; only the historical record is 1 Hz.

### D4 — Retention & regulatory hold (**RECOMMEND defaults below; confirm jurisdiction**)

§9 flags DGCA/DGAC retention as an open question. Assumed defaults (all env-overridable, enforced by a periodic pruner):
- `telemetry_history`: **90 days** rolling.
- `commands_audit`: **1 year** (audit/forensics).
- `flights`: **indefinite** (the flight *summary* is small and is the regulatory artifact).
- `alerts`: **1 year**; `alert_rules`: indefinite (config).
- **Regulatory hold flag**: any `flight` (and its telemetry window) marked `retention_hold=true` is exempt from pruning until released. This satisfies "keep this incident's data" without disabling global pruning.

> **Confirm:** jurisdiction (DGCA India? EASA?) and minimum retention. If a regulator mandates e.g. 3-year flight-log retention, only the default constant changes — schema is unaffected.

### D5 — First-deployment scale (**RECOMMEND design for the number below; confirm**)

§9 open question 1. Design target assumed: **≤ 50 drones, ≤ 5 orgs, ≤ 50 operators, single region.** At 50 drones × 1 Hz = 50 rows/s ≈ 4.3 M rows/day telemetry. SQLite handles this comfortably for weeks; Postgres+partitioning is the path beyond ~100 drones or multi-node. Nothing in the schema blocks scaling to thousands — the scale-out story is ADR-001's drone→worker ownership table (§8), not schema change.

### D6 — Object storage integration (**RECOMMEND: local FS default + S3/MinIO driver, DB stores only metadata**)

Per ADR-001. Large blobs (telemetry recordings, video, logs, param snapshots) live in an object store; the DB stores **only a pointer row** (`uri`, `backend`, `size`, `checksum`). Default backend = local filesystem (`recordings/`, existing). S3/MinIO via a driver selected by `OBJECT_STORE_URL`. See §9.

---

## 3. ER model

```
organizations ──1:N──> users
      │                   │
      │ 1:N               │ (created_by / operator FK, nullable)
      ▼                   │
   drones <───────────────┤
      │  │                │
      │  │ 1:1            ▼
      │  └──> drone_credentials
      │
      │ 1:N        ┌──────────────────────────┐
      ├──> flights │ (arm→disarm session)     │
      │     │      └──────────────────────────┘
      │     │ 1:N
      │     ▼
      │  telemetry_history   (also FK drone_id; flight_id nullable)
      │
      ├──> commands_audit    (FK drone_id, operator_id, flight_id nullable)
      │
      └──> alerts            (FK drone_id nullable, alert_rule_id)
                 ▲
   alert_rules ──┘ (org-scoped)

provisioning_tokens ──> (mints drones)      [supporting]
connection_allowlist  (org-scoped)          [supporting, closes F2]
recordings ──> flights / drones             [object-store metadata]
schema_migrations                            [Alembic version table]
```

**Cardinality summary**

| Parent | Child | Card. | On delete |
|---|---|---|---|
| organizations | users, drones, alert_rules, connection_allowlist | 1:N | RESTRICT (never cascade an org away silently) |
| drones | drone_credentials | 1:1 | CASCADE |
| drones | flights | 1:N | RESTRICT (flights are the regulatory record) |
| flights | telemetry_history | 1:N | SET NULL on flight (telemetry keeps drone_id) |
| drones | commands_audit | 1:N | RESTRICT |
| users | commands_audit (operator) | 1:N | SET NULL (keep audit even if user removed) |
| alert_rules | alerts | 1:N | SET NULL |

---

## 4. Schema (portable DDL — SQLite/Postgres notes inline)

Conventions:
- **PKs:** `TEXT` UUIDs (app-generated `uuid4().hex`) for entities that exist before insert & cross tiers (drones already do this today). `telemetry_history`/`commands_audit`/`alerts` use `BIGINT` autoincrement (high-volume, never referenced by external systems).
- **Timestamps:** stored as `epoch_seconds` (`DOUBLE`/`REAL`) to match the code (everything already uses `time.time()` floats) **plus** a generated human `ts` is *not* stored — we keep one canonical float column named `*_at`. Portable, no timezone ambiguity, matches `created_at`, `saved_at`, `last_seen` everywhere in the code.
- **JSON:** `metadata`, sensor blobs → `JSONB` on Postgres, `TEXT` (JSON string) on SQLite. Repository layer serializes.
- **Booleans:** native on Postgres, `INTEGER 0/1` on SQLite (SQLAlchemy handles).

### 4.1 `organizations`
```sql
CREATE TABLE organizations (
  id            TEXT PRIMARY KEY,               -- uuid4 hex
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  created_at    DOUBLE NOT NULL,
  metadata      JSON
);
```

### 4.2 `users`
```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  email         TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'operator', -- operator|admin|viewer (RBAC lands in 5C)
  password_hash TEXT,                             -- nullable now; auth is Phase 5C
  created_at    DOUBLE NOT NULL,
  disabled_at   DOUBLE,
  UNIQUE(org_id, email)
);
```
> Users/auth are minimal here (columns exist so FKs resolve); **RBAC enforcement is Phase 5C**. 5B only needs `operator_id` to exist so `commands_audit` can reference it.

### 4.3 `drones` — formalizes `DroneSession.to_summary()` + registry
Maps directly to `fleet/drone_session.py` fields (`drone_id, name, metadata, created_at, connection_string, baudrate`). This table **replaces the RAM registry as source of truth (F1)**.
```sql
CREATE TABLE drones (
  id                TEXT PRIMARY KEY,             -- == drone_id (uuid4().hex[:12] today)
  org_id            TEXT NOT NULL REFERENCES organizations(id),
  name              TEXT NOT NULL,
  connection_string TEXT NOT NULL DEFAULT 'auto',
  baudrate          INTEGER NOT NULL DEFAULT 115200,
  udp_forwarding    JSON,                          -- endpoints list (DroneRegistration.udp_forwarding_endpoints)
  auto_connect      INTEGER NOT NULL DEFAULT 0,
  metadata          JSON,
  -- last-known cache (rehydration hint; live truth is RAM after boot)
  last_seen_at      DOUBLE,
  last_conn_state   TEXT,                          -- ConnectionState enum value
  primary_sysid     INTEGER,
  created_at        DOUBLE NOT NULL,
  archived_at       DOUBLE,                        -- soft delete (default session never archived)
  UNIQUE(org_id, name)
);
```
- `connection_string` is **validated against `connection_allowlist` before insert/connect** (see 4.11, closes F2).
- Boot: registry rehydrates every non-archived drone; those with `auto_connect=1` reconnect.

### 4.4 `drone_credentials` — provisioning identity (1:1)
Replaces client-supplied `drone_id` trust (§7 "provisioning tokens replace client-supplied drone_ids").
```sql
CREATE TABLE drone_credentials (
  drone_id      TEXT PRIMARY KEY REFERENCES drones(id) ON DELETE CASCADE,
  secret_hash   TEXT NOT NULL,                    -- hashed shared secret / device key
  issued_at     DOUBLE NOT NULL,
  rotated_at    DOUBLE,
  revoked_at    DOUBLE
);
```

### 4.5 `flights` — synthesized arm→disarm sessions (**new detector**)
No flight concept exists today; a detector watches `Status.armed` transitions (`vehicle_state.py`).
```sql
CREATE TABLE flights (
  id             TEXT PRIMARY KEY,                -- uuid4 hex
  drone_id       TEXT NOT NULL REFERENCES drones(id),
  org_id         TEXT NOT NULL REFERENCES organizations(id),
  sysid          INTEGER,
  armed_at       DOUBLE NOT NULL,                 -- transition disarmed->armed
  disarmed_at    DOUBLE,                          -- NULL while in-flight
  duration_s     DOUBLE,                          -- filled on disarm
  start_mode     TEXT,
  max_alt_rel    DOUBLE,                          -- rolled up from telemetry
  distance_m     DOUBLE,
  start_lat      DOUBLE, start_lon DOUBLE,
  end_lat        DOUBLE, end_lon  DOUBLE,
  end_reason     TEXT,                            -- disarm|link_lost|timeout
  retention_hold INTEGER NOT NULL DEFAULT 0,      -- D4 regulatory exemption
  created_at     DOUBLE NOT NULL
);
```
- Detector rule: `armed False→True` opens a flight; `True→False` closes it. **Link loss while armed** → close after `heartbeat_timeout_s`-derived grace with `end_reason='link_lost'` (so an unclean flight still yields a record). Exit criterion (§7): *every flight appears in history*.

### 4.6 `telemetry_history` — 1 Hz historical record (**highest volume**)
Downsampled from `VehicleState.to_dict()`. Hot numeric columns are promoted; the rest stays in a JSON blob to avoid a 40-column table while keeping common queries indexable.
```sql
CREATE TABLE telemetry_history (
  id           BIGINT PRIMARY KEY,               -- autoincrement / IDENTITY
  drone_id     TEXT NOT NULL REFERENCES drones(id),
  flight_id    TEXT REFERENCES flights(id),      -- nullable (telemetry while disarmed)
  sysid        INTEGER NOT NULL,
  recorded_at  DOUBLE NOT NULL,                  -- epoch, 1 Hz
  lat          DOUBLE, lon DOUBLE,
  alt_rel      DOUBLE, alt_amsl DOUBLE,
  heading      DOUBLE, groundspeed DOUBLE,
  batt_voltage DOUBLE, batt_remaining INTEGER,
  mode         TEXT, armed INTEGER,
  gps_fix      INTEGER, satellites INTEGER,
  sensors      JSON                              -- attitude, ekf_status, rc, link_status, home, ekf_origin (full to_dict() overflow)
);
```
**Partitioning / retention:** see §5. Promoted columns are exactly the fields UIs/reports query (track, battery, mode timeline); the long tail (EKF variances, sensor health bitmasks) rides in `sensors` JSON — retrievable but not indexed.

### 4.7 `commands_audit` — **new**, first audit trail
Maps `command_manager.execute_command` inputs + result. Adds the operator identity that RAM state never captured.
```sql
CREATE TABLE commands_audit (
  id             BIGINT PRIMARY KEY,
  drone_id       TEXT NOT NULL REFERENCES drones(id),
  org_id         TEXT NOT NULL REFERENCES organizations(id),
  operator_id    TEXT REFERENCES users(id),       -- SET NULL on user delete; NULL for pre-5C/legacy
  flight_id      TEXT REFERENCES flights(id),      -- nullable
  sysid          INTEGER NOT NULL,
  command        INTEGER NOT NULL,                 -- MAV_CMD id
  params         JSON,                             -- {p1..p7, frame, is_int}
  issued_at      DOUBLE NOT NULL,
  result         INTEGER,                          -- MAV_RESULT
  result_text    TEXT,                             -- ACCEPTED/TIMEOUT/...
  reason         TEXT,                             -- mavlink|accepted|timeout|no_connection
  source_route   TEXT                              -- '/fleet/.../command' | '/command' | '/mode' | 'calibration' ...
);
```
- Written at command completion (accept/timeout) so `result` is known. Covers both legacy (`/command`, `/mode`) and fleet routes, plus the hardcoded-MAV_CMD endpoints (calibration/reboot/motor_test) via a shared audit hook in `command_manager`.

### 4.8 `alert_rules` — **new** (config for Phase 8, table defined now per §7)
```sql
CREATE TABLE alert_rules (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL,
  metric      TEXT NOT NULL,                       -- batt_remaining|link_lost|geofence|gps_fix|...
  operator    TEXT NOT NULL,                       -- '<' '>' '==' 'transition'
  threshold   DOUBLE,
  severity    TEXT NOT NULL DEFAULT 'warning',     -- info|warning|critical
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  DOUBLE NOT NULL
);
```

### 4.9 `alerts` — **new** (fired instances)
```sql
CREATE TABLE alerts (
  id             BIGINT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id),
  alert_rule_id  TEXT REFERENCES alert_rules(id),
  drone_id       TEXT REFERENCES drones(id),
  flight_id      TEXT REFERENCES flights(id),
  severity       TEXT NOT NULL,
  message        TEXT NOT NULL,
  triggered_at   DOUBLE NOT NULL,
  cleared_at     DOUBLE,                            -- NULL = active
  context        JSON
);
```

### 4.10 `provisioning_tokens` — **supporting** (§7 provisioning)
```sql
CREATE TABLE provisioning_tokens (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id),
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   DOUBLE,
  used_at      DOUBLE,
  created_drone_id TEXT REFERENCES drones(id),      -- filled when redeemed
  created_at   DOUBLE NOT NULL
);
```

### 4.11 `connection_allowlist` — **supporting** (closes F2 dial-out/SSRF)
```sql
CREATE TABLE connection_allowlist (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  scheme      TEXT NOT NULL,                        -- tcp|udp|serial
  host_pattern TEXT,                                -- CIDR or host glob (NULL for serial)
  port_min    INTEGER, port_max INTEGER,
  device_glob TEXT,                                 -- e.g. /dev/ttyACM* for serial
  created_at  DOUBLE NOT NULL
);
```
- Every `connection_string` (registration or SITL) is parsed and matched against this table's rows for the org **before** it reaches `mavutil.mavlink_connection()`. `auto` (serial autodetect) is gated by a `serial` allow entry. Default seed for dev: `tcp 127.0.0.1:5760-5900`, `udp 127.0.0.1:14550-14650`, `serial /dev/tty*`.

### 4.12 `recordings` — **object-store metadata** (D6)
```sql
CREATE TABLE recordings (
  id           TEXT PRIMARY KEY,                    -- == replay session uuid today
  org_id       TEXT NOT NULL REFERENCES organizations(id),
  drone_id     TEXT REFERENCES drones(id),
  flight_id    TEXT REFERENCES flights(id),
  backend      TEXT NOT NULL,                        -- 'fs' | 's3'
  uri          TEXT NOT NULL,                         -- recordings/<uuid>.jsonl  or  s3://bucket/key
  size_bytes   BIGINT,
  duration_s   DOUBLE,
  checksum     TEXT,
  started_at   DOUBLE NOT NULL,
  created_at   DOUBLE NOT NULL
);
```

### 4.13 `schema_migrations`
Alembic's version table (auto-managed). One row: current head revision.

---

## 4A. Final architectural improvements (approved additions to the 5B set)

Six models added before implementation so the schema supports multi-transport drones, hardware capability description, reusable missions, and per-organization operational policy **without a future migration redesign**. All are additive, org- or drone-scoped, and behind the same `FLEET_PERSISTENCE_ENABLED` rollout flag as the rest of 5B.

### 4A.1 `connection_profiles` — per-drone multi-transport (improvement 1)
A drone owns **many** transport configurations (bench serial today, LTE `udpout` in the field, a WireGuard TCP tunnel next week); exactly one is active. Supersedes the single `drones.connection_string` column, which becomes a **cached mirror** of the active profile (kept for backward compatibility — legacy code that reads `drones.connection_string` still works).
```sql
CREATE TABLE connection_profiles (
  id                TEXT PRIMARY KEY,               -- uuid4 hex
  drone_id          TEXT NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
  org_id            TEXT NOT NULL REFERENCES organizations(id),
  name              TEXT NOT NULL,                  -- 'bench-usb', 'field-lte', 'wg-tunnel'
  kind              TEXT NOT NULL,                  -- udp|tcp|serial|lte|wireguard|companion|sitl
  connection_string TEXT NOT NULL,                  -- mavutil string; validated vs connection_allowlist
  baudrate          INTEGER,                        -- serial only
  udp_forwarding    JSON,
  priority          INTEGER NOT NULL DEFAULT 100,   -- lower = preferred for auto-failover (future)
  is_active         INTEGER NOT NULL DEFAULT 0,     -- exactly one active per drone (repo-enforced)
  metadata          JSON,
  created_at        DOUBLE NOT NULL,
  UNIQUE(drone_id, name)
);
```
- Every `connection_string` here is validated against `connection_allowlist` (§4.11) on insert/activate — same F2 gate, now applied per profile.
- Repo invariant: activating a profile deactivates the drone's others and updates `drones.connection_string`/`baudrate` to mirror it. **The existing `DroneSession` is unchanged** — it still receives one connection string at connect time; the profile layer just chooses which one.
- Backfill (revision 0001): each existing `drones` row gets one `default` profile mirroring its current `connection_string`, `is_active=1`.

### 4A.2 `drone_capabilities` — installed hardware / supported features (improvement 2)
Describes what a drone physically has and can do, so the dashboard/analytics can filter ("show thermal-equipped drones") without probing the vehicle.
```sql
CREATE TABLE drone_capabilities (
  id          TEXT PRIMARY KEY,
  drone_id    TEXT NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
  capability  TEXT NOT NULL,                        -- rgb_camera|thermal_camera|rtk|payload|ai|
                                                    -- spotlight|loudspeaker|dock_compatible|...
  present     INTEGER NOT NULL DEFAULT 1,
  spec        JSON,                                 -- {resolution, fov, model, sensor_id, ...}
  created_at  DOUBLE NOT NULL,
  updated_at  DOUBLE,
  UNIQUE(drone_id, capability)
);
```
- Open vocabulary (a `TEXT` capability key, not an enum column) precisely so a new capability is a data row, not a migration — the same "capability is data, not protocol" principle as `parameter_metadata.py` (master §3.1).

### 4A.3 Missions: `mission_templates` / `mission_instances` / `mission_runs` (improvement 3)
Separates the **reusable definition** from a **bound instance** from the **execution-history record** — three distinct lifecycles. `flights` (§4.5) remains the arm→disarm regulatory record; a `mission_run` links a flight to the mission it was executing (nullable — not every flight runs a stored mission).
```sql
CREATE TABLE mission_templates (            -- reusable definition, org-scoped, drone-agnostic
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  name          TEXT NOT NULL,
  description   TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  definition    JSON NOT NULL,                      -- waypoints/fence/rally/survey params (MAVLink items)
  created_by    TEXT REFERENCES users(id),
  created_at    DOUBLE NOT NULL,
  archived_at   DOUBLE,
  UNIQUE(org_id, name, version)
);
CREATE TABLE mission_instances (            -- a template bound to a drone + concrete params, ready to run
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  template_id   TEXT REFERENCES mission_templates(id),   -- nullable: an ad-hoc instance has no template
  drone_id      TEXT REFERENCES drones(id),
  name          TEXT NOT NULL,
  params        JSON,                                -- overrides/bindings applied to the template
  status        TEXT NOT NULL DEFAULT 'draft',       -- draft|ready|uploaded|archived
  created_by    TEXT REFERENCES users(id),
  created_at    DOUBLE NOT NULL,
  archived_at   DOUBLE
);
CREATE TABLE mission_runs (                 -- execution-history record (one per attempted execution)
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  instance_id   TEXT REFERENCES mission_instances(id),
  template_id   TEXT REFERENCES mission_templates(id),   -- denormalized for history even if instance deleted
  drone_id      TEXT NOT NULL REFERENCES drones(id),
  flight_id     TEXT REFERENCES flights(id),          -- links execution to the arm→disarm session
  started_at    DOUBLE NOT NULL,
  ended_at      DOUBLE,
  outcome       TEXT,                                 -- completed|aborted|rtl|failed|partial
  progress      JSON,                                 -- {reached_seq, total, distance_m, ...}
  created_at    DOUBLE NOT NULL
);
```
- 5B ships schema + thin repos (CRUD + history append). Mission-template **execution** (pushing a template through the existing MAVLink mission microprotocol) is wired to the unchanged `mission_manager.py` in a later phase — no protocol change here.

### 4A.4 `org_settings` — per-org telemetry frequency & retention (improvements 4 & 5)
One row per org (1:1). Dethrones the hardcoded 1 Hz persistence (D3) and the global retention constants (D4): both become **per-org policy**, with the env-var/global value as the fallback when a column is `NULL`.
```sql
CREATE TABLE org_settings (
  org_id                     TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  telemetry_persist_hz       DOUBLE,               -- improvement 4; NULL → global TELEMETRY_PERSIST_HZ
  retention_telemetry_days   INTEGER,              -- improvement 5; NULL → RETENTION_TELEMETRY_DAYS
  retention_alerts_days      INTEGER,              -- NULL → RETENTION_ALERTS_DAYS
  retention_commands_days    INTEGER,              -- NULL → RETENTION_COMMANDS_DAYS
  retention_recordings_days  INTEGER,              -- NULL → RETENTION_RECORDINGS_DAYS
  retention_logs_days        INTEGER,              -- NULL → RETENTION_LOGS_DAYS
  updated_at                 DOUBLE
);
```
- The 1 Hz sampler (§8) reads the owning drone's org `telemetry_persist_hz` (cached, refreshed periodically) to decide its per-drone sample interval; absent a row it uses the global default. This is why persistence frequency is no longer "hardcoded 1 Hz" — it is a resolved policy: `org_settings.telemetry_persist_hz ?? env TELEMETRY_PERSIST_HZ (default 1.0)`.
- `RetentionManager` (§5.3) resolves each window the same way: per-org column, else env default. `flights` stays indefinite (retention_hold-exempt); `retention_logs_days` governs exported/log-file object-store rows.

### 4A.5 `organization_feature_flags` — product tiers without schema redesign (improvement 6)
```sql
CREATE TABLE organization_feature_flags (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  flag        TEXT NOT NULL,                        -- 'video_wall'|'analytics'|'edge_agent'|'ai'|...
  enabled     INTEGER NOT NULL DEFAULT 0,
  value       JSON,                                 -- optional tier params (quotas, limits)
  updated_at  DOUBLE,
  UNIQUE(org_id, flag)
);
```
- A tier/entitlement is a row, not a column — new tiers (or per-org overrides for A/B rollout) need zero migration. Read-side only in 5B; enforcement points land with the features they gate (5C+).

### 4A.6 Delete behavior for the additions
| Parent | Child | Card. | On delete |
|---|---|---|---|
| drones | connection_profiles | 1:N | CASCADE |
| drones | drone_capabilities | 1:N | CASCADE |
| organizations | org_settings | 1:1 | CASCADE |
| organizations | organization_feature_flags | 1:N | CASCADE |
| organizations | mission_templates, mission_instances, mission_runs | 1:N | RESTRICT (history/regulatory) |
| mission_templates | mission_instances | 1:N | SET NULL (instance survives template edit) |
| mission_instances | mission_runs | 1:N | SET NULL (run history survives instance deletion) |
| flights | mission_runs | 1:N | SET NULL |

### 4A.7 Additional indexes
| Table | Index | Serves |
|---|---|---|
| connection_profiles | `(drone_id)`, partial `WHERE is_active=1` | active-profile lookup, rehydration |
| drone_capabilities | `(drone_id)`, `(capability)` | capability filter ("all thermal drones") |
| mission_templates | `(org_id, name)` | template picker |
| mission_runs | `(drone_id, started_at DESC)`, `(flight_id)` | mission history, flight↔mission join |
| organization_feature_flags | `(org_id)` | flag resolution at request time |

---

## 5. Indexing, partitioning & retention

### 5.1 Indexes
| Table | Index | Serves |
|---|---|---|
| drones | `(org_id)`, `(org_id, archived_at)` | fleet list, rehydration scan |
| flights | `(drone_id, armed_at DESC)`, `(org_id, armed_at DESC)`, `(disarmed_at) WHERE disarmed_at IS NULL` | flight history, in-flight lookup |
| **telemetry_history** | `(drone_id, recorded_at DESC)`, `(flight_id, recorded_at)` | track playback, per-flight path |
| commands_audit | `(drone_id, issued_at DESC)`, `(operator_id, issued_at DESC)` | audit queries |
| alerts | `(org_id, triggered_at DESC)`, `(cleared_at) WHERE cleared_at IS NULL` | active-alert board |
| provisioning_tokens | `token_hash UNIQUE` | redemption |

Partial indexes (`WHERE ... IS NULL`) are supported on both SQLite (3.8+) and Postgres.

### 5.2 Telemetry partitioning (the one genuinely dialect-divergent area)
`telemetry_history` is the only table that grows without bound (D5: ~4.3 M rows/day @ 50 drones).

- **PostgreSQL:** native **declarative range partitioning by `recorded_at`, one partition per day** (`telemetry_history_YYYYMMDD`). A daily maintenance job (a) pre-creates tomorrow's partition and (b) `DROP`s partitions older than the retention window — an O(1) metadata op, no row-by-row delete, no vacuum storm. This is why Postgres is the scale target.
- **SQLite:** no partitioning. Two-part strategy: (a) the daily pruner issues a bounded `DELETE ... WHERE recorded_at < :cutoff AND flight_id NOT IN (held flights)` in batches; (b) optionally **roll the whole DB file monthly** (`telemetry-2026-07.sqlite`) with an attached-DB read view for historical queries — offered as a config, not default.
- **Repository layer** exposes `write_telemetry_batch()` / `query_track(drone_id, t0, t1)`; the partition mechanics live entirely behind it. Callers never branch on dialect.

### 5.3 Retention enforcement (D4)
A single periodic **`RetentionManager`** (async task, hourly) applies §2/D4 windows:
- Skips any row whose `flight_id` has `retention_hold=1`.
- Postgres → drop expired partitions; SQLite → batched delete.
- Emits `/metrics`: `retention_rows_pruned_total`, `retention_last_run_at`, `retention_partitions_dropped_total`.
- All windows are env vars: `RETENTION_TELEMETRY_DAYS=90`, `RETENTION_COMMANDS_DAYS=365`, `RETENTION_ALERTS_DAYS=365`.

---

## 6. SQLite / PostgreSQL compatibility strategy

**Single schema, one migration set, dialect differences isolated to ~5 spots**, all behind the repository layer (§7):

| Concern | SQLite | PostgreSQL | How hidden |
|---|---|---|---|
| JSON columns | `TEXT` (json string) | `JSONB` | SQLAlchemy `JSON` type + repo (de)serialize |
| Booleans | `INTEGER 0/1` | `BOOLEAN` | SQLAlchemy `Boolean` |
| Autoincrement PK | `INTEGER PRIMARY KEY` | `BIGINT GENERATED ... IDENTITY` | SQLAlchemy `BigInteger` + `autoincrement` |
| Upsert (param cache, drone last_seen) | `INSERT ... ON CONFLICT DO UPDATE` | same syntax | identical (both support it) |
| Timestamps | `DOUBLE` epoch | `DOUBLE PRECISION` epoch | one canonical float column — no `TIMESTAMP` type at all |
| Partitioning | pruned deletes / file-roll | declarative range | repo `write_telemetry_batch` branch (§5.2) |
| Concurrency | WAL mode, one writer | MVCC, pool | connection factory sets `PRAGMA journal_mode=WAL` on SQLite |
| Connection | `aiosqlite` | `asyncpg` (SQLAlchemy async) | `DATABASE_URL` scheme selects driver |

**Driver selection:** `DATABASE_URL` env. Absent → `sqlite+aiosqlite:///fleet.db` (default). `postgresql+asyncpg://...` → Postgres. No other code changes to switch.

**What we deliberately avoid** for portability: stored procedures, triggers, DB-side JSON path queries in hot paths, vendor-specific types (`INET`, `UUID` native, arrays). UUIDs are `TEXT`; JSON is read whole into the app.

---

## 7. Repository layer (the abstraction that makes D2/D6 work)

```
routes / registry / telemetry_pub / command_manager
        │  (call typed repo methods — no SQL)
        ▼
  repositories/                      (Python package, new)
    ├─ base.py            engine, async session factory, PRAGMA/pool setup
    ├─ drones_repo.py     upsert_drone, list_for_rehydrate, archive
    ├─ flights_repo.py    open_flight, close_flight, rollup
    ├─ telemetry_repo.py  write_batch, query_track, prune   ← only file that knows partitioning
    ├─ commands_repo.py   record_command
    ├─ alerts_repo.py     fire, clear, list_active
    ├─ allowlist_repo.py  is_allowed(connection_string, org)
    └─ objectstore.py     put/get/delete  (fs | s3 driver — D6)
        ▼
  SQLAlchemy Core + Alembic  →  SQLite | PostgreSQL
```

Only the repository layer imports SQLAlchemy. Domain code (registry, publisher, command manager) sees plain async methods returning dataclasses/dicts — identical to how they pass data today. This is the "repository layer hides the difference" from §6, made concrete.

---

## 8. Registry rehydration & write paths (how the tables get populated)

- **Boot (ADR-001):** `SessionRegistry.load_from_db()` reads `drones` (non-archived) → recreates `DroneSession` objects → those with `auto_connect=1` start connecting. The `default` session is seeded if absent. **Exit criterion: restart loses zero registered drones.**
- **Registration** (`POST /fleet/drones`): validate `connection_string` via `allowlist_repo` → `drones_repo.upsert` → then create the in-RAM session. DB write is authoritative; RAM is the cache.
- **Telemetry** (`telemetry_pub`): the 10 Hz loop stays untouched for the wire; a **1 Hz sampler** enqueues one row/drone/second to a bounded async queue drained by `telemetry_repo.write_batch` (D3). Never blocks the publish loop.
- **Flight detection:** a hook on `VehicleState.status.armed` transitions (fed by the same telemetry the publisher already reads) calls `flights_repo.open_flight/close_flight`, and stamps `flight_id` onto subsequent telemetry rows + commands.
- **Commands:** `command_manager` gains a completion hook → `commands_repo.record_command` (works for all routes, legacy + fleet + hardcoded).

---

## 9. Object storage integration (D6)

- **Interface** (`objectstore.py`): `put(key, bytes|stream) -> uri`, `open(uri) -> stream`, `delete(uri)`, `stat(uri)`.
- **Drivers:** `fs` (default — writes under `recordings/` / configured root, `uri = fs://relpath`) and `s3` (`boto3`/`minio`, `uri = s3://bucket/key`), selected by `OBJECT_STORE_URL` (absent → fs).
- **What moves to object storage:** telemetry **recordings** (`recordings/*.jsonl`, already file-based — just add a `recordings` metadata row + optional S3 backend), future video segments (Phase 6/9), exported flight logs. **Not** telemetry_history rows (those stay relational for query).
- **DB holds pointers only** (`recordings` table §4.12): `backend`, `uri`, `size_bytes`, `checksum`, `duration_s`. Deleting a recording deletes the blob via the driver then the row.
- **Migration of existing artifacts:** a one-time backfill registers current `recordings/*.jsonl` (and, if desired, `param_cache/*.json`) as `fs`-backed rows — no data movement, just indexing.

---

## 10. Migration strategy

1. **Tooling:** Alembic (Python). `alembic upgrade head` on startup (guarded by `DB_AUTO_MIGRATE=true`, default true for SQLite/dev, recommended false + explicit deploy step for Postgres/prod).
2. **Revision 0001 — baseline:** all tables in §4. Idempotent; creates seed `organizations('default')`, the `default` drone row, and dev `connection_allowlist` seeds.
3. **JSON-file → DB backfill (revision 0002 data migration / one-shot script):**
   - `param_cache/<sysid>_<compid>.json` → optional `parameter_snapshots` (deferred; not in mandated set — left as files unless requested).
   - `recordings/*.jsonl` → `recordings` rows (fs backend).
   - `osd_profiles.json`, `sitl_profiles.json`, `video_settings.json` → **left as-is for 5B** (config blobs, not fleet-core; revisit if a settings table is wanted). Documented so reviewers know they're intentionally out of scope.
4. **Rollback:** every revision has `downgrade()`. The `fleet-phase5A` tag is the pre-DB rollback point; DB is additive (no existing behavior removed — legacy file paths keep working until explicitly cut over).
5. **Zero-downtime posture:** 5B is purely additive — the RAM registry keeps working; DB read/rehydrate is switched on behind a `FLEET_PERSISTENCE_ENABLED` flag so we can land the code dark, then flip it. Backward compat (the "default session" alias) is preserved.
6. **Tests:** repo-layer unit tests run against **SQLite in-memory**; a Postgres integration suite runs behind a marker (`PYTEST_POSTGRES_URL`), so CI stays fast and the dual-target claim is actually exercised.

---

## 11. New dependencies (all additive)

**Python (`requirements.txt`):** `sqlalchemy[asyncio]>=2.0`, `alembic`, `aiosqlite`; optional extras group for Postgres: `asyncpg`; for S3: `boto3` **or** `minio`.
**Node:** **none** (D1 keeps all DB code in Python).

---

## 12. Open items for the reviewer to confirm

| # | Question | Default assumed | Impacts |
|---|---|---|---|
| D1 | Python-owned DB (override §7's "Knex")? | **Yes, Python** | whole architecture |
| D2 | SQLite default + Postgres opt-in? | Yes | §6 |
| D3 | Persist telemetry at 1 Hz, async, decoupled? | Yes | §4.6, §5, §8 |
| D4 | Retention windows + jurisdiction (DGCA?) | 90d tele / 1y cmd / flights kept; hold flag | §5.3 |
| D5 | First-scale target | ≤50 drones/5 orgs/50 ops, single region | §5.2 partitioning trigger |
| D6 | Object store: fs default + S3 driver, DB = pointers? | Yes | §9 |
| — | Leave `osd/sitl/video` JSON configs as files (out of 5B scope)? | Yes | §10.3 |

**On approval**, implementation order: (1) repo layer + Alembic baseline (all tables incl. the §4A additions) + config/driver selection, (2) drones table + registry rehydration behind flag (delivers F1 exit criterion), (3) connection allow-list (closes F2) + `connection_profiles` (§4A.1) + `drone_capabilities` (§4A.2), (4) flight detector + flights, (5) 1 Hz telemetry writer with **per-org `telemetry_persist_hz`** (§4A.4) + retention with **per-org windows** (§4A.4), (6) commands_audit hook, (7) recordings metadata + object store + config-only tables (`provisioning_tokens`, `alerts`/`alert_rules`, `mission_templates`/`mission_instances`/`mission_runs` §4A.3, `org_settings` §4A.4, `organization_feature_flags` §4A.5 — schema + thin repos; firing/execution/enforcement logic is Phase 8/5C+).

*No code will be written until this document is reviewed and approved.*
