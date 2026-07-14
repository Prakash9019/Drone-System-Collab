# Fleet Platform — How It Actually Works (main vs. fleet-platform, MAVLink linking, drone identity, auth)

**Purpose of this document:** a plain, code-grounded walkthrough answering four specific questions:
1. What did the GCS architecture on `main` look like?
2. What did `fleet-platform` change/add on top of it?
3. How does the platform link to *multiple* MAVLink vehicles at once?
4. How are drones identified ("signed") and how is authentication/authorization built for fleet management?

This is a companion to `FLEET_MASTER_ARCHITECTURE.md` (the full 19-section spec). That document is intentionally exhaustive and forward-looking (it describes built, approved-but-unbuilt, and future-designed work side by side). This document only answers the four questions above, with file:line references into the actual code, and is explicit everywhere about **built vs. not built**.

---

## 1. `main` branch — the single-drone GCS (baseline)

`main` is a classic single-vehicle Ground Control Station. Its defining trait: **process-global singletons**. Look at `drone_gcs/python_service/main.py` on `main`:

```python
link_manager = None
mission_manager = None
telemetry_publisher = None
parameter_manager = None
sitl_manager = None
osd_manager = None
preflight_manager = None
camera_manager = None
```

These eight module-level variables are created once at process startup and used everywhere. There is exactly one `LinkManager` (one MAVLink connection), so the whole backend can only ever talk to one vehicle at a time.

```
┌─────────────────────────────────────────────────────────────┐
│                      main.py (FastAPI)                      │
│                                                               │
│  link_manager          (module global — ONE MAVLink link)   │
│  mission_manager       (module global)                       │
│  parameter_manager     (module global)                       │
│  preflight_manager     (module global)                       │
│  camera_manager        (module global)                       │
│  telemetry_publisher   (module global — ONE ZMQ PUB socket)  │
│                                                               │
│  Routes: /connection/*, /command, /mode, /mission/*, ...     │
│  (all unscoped — implicitly operate on "the" drone)          │
└──────────────────────┬────────────────────────────────────────┘
                        │ ZMQ PUB (10 Hz)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                  Node (drone_gcs/node_api)                    │
│  ZMQ SUB → WebSocket broadcast (no per-drone tagging needed) │
│  REST proxy to Python                                         │
└──────────────────────┬────────────────────────────────────────┘
                        │ REST + WS
                        ▼
                 React single-drone GCS UI
```

- **Authentication/authorization:** none. Every route is open; the frontend is trusted implicitly because it's assumed to be one operator at one console.
- **Persistence:** none beyond a local `param_cache/*.json` file per session and ad-hoc `recordings/` files. Nothing survives a restart except those files — vehicle state, mission state, connection state are all in RAM.
- **Identity:** there is no `drone_id` concept at all. "The drone" is whatever MAVLink sysid shows up on the one connection.

This is the correct architecture for what it is — a GCS, one operator, one vehicle, console-trusted. It is **not** wrong code; it's just structurally incapable of running N drones, because "N drones" was never a requirement it was built against.

---

## 2. What `fleet-platform` changed

The strategic decision (documented as ADR-001 in the master doc) was: **do not rewrite the MAVLink/mission/parameter code — wrap the existing single-drone code in a per-drone container, and run N containers in one process.** The diff from `main` to `fleet-platform` confirms this in practice — `mavlink_link.py`, `mission_manager.py`, `parameter_manager.py`, `preflight_manager.py` are essentially untouched; the new code sits *around* them.

### 2.1 The core structural change: globals → sessions

| main.py (before) | fleet-platform (after) |
|---|---|
| `link_manager = LinkManager(...)` (module global, one instance) | `fleet/drone_session.py` → `class DroneSession` wraps one `LinkManager` + one `MissionManager` + one `ParameterSyncManager` + one `PreflightManager` (+ optional `CameraManager`), all scoped to that session |
| Calibration progress (`_mag_cal_data`, `_accel_cal_pos`) as module globals | Moved onto `DroneSession` instance attributes — two drones can calibrate concurrently without clobbering each other's state |
| Nothing owns "the set of drones" — there's only ever one | `fleet/session_registry.py` → `class SessionRegistry`: an in-memory `Dict[drone_id, DroneSession]`, with `create()`, `get()`, `require()`, `remove()` |
| Routes operate on the implicit single drone (`/connection/start`, `/command`, ...) | New `fleet/routes.py`, prefix `/fleet`, every route takes `{drone_id}` in the path (`/fleet/drones/{drone_id}/command`, etc.) and resolves it to a session via `_require_session(drone_id)` |
| — | **Backward compatibility, not a rewrite**: `SessionRegistry` always keeps a session literally named `"default"` (`DEFAULT_DRONE_ID = "default"`); the *old* unscoped routes in `main.py` are kept and now just resolve to that one `"default"` session. Existing single-drone GCS behavior is provably unchanged — you get fleet capability *added*, not swapped in. |

`fleet/drone_session.py:1-10` states this explicitly in its own module docstring:

> "Bundles what used to be process-global singletons in main.py — LinkManager, MissionManager, ParameterSyncManager, PreflightManager, optional CameraManager, and calibration progress state — so N drones can run isolated in one process. Isolation guarantee: every manager here holds a reference to THIS session's LinkManager only. A disconnect, reconnect storm, or exception in one session cannot touch another session's link or state."

### 2.2 Additions layered on top (Phases 3–5B)

| Area | What was added | File(s) |
|---|---|---|
| **Observability** | Structured JSON logging w/ correlation IDs, `/health`, `/metrics` (Prometheus) on both Python and Node tiers, fail-fast env-var validation | `observability/*.py`, `node_api/lib/{health,logger,metrics}.js` |
| **Telemetry, fleet-scoped** | ZMQ PUB payloads now carry `drone_id`; Node's WS layer supports per-client per-drone subscriptions instead of one global broadcast | `telemetry_pub.py`, `node_api/ws/{zmqSubscriber,subscriptionManager,broadcaster}.js` |
| **Persistence (Phase 5B)** | A real database layer: SQLAlchemy Core + Alembic, SQLite by default / PostgreSQL opt-in, repository pattern (`db/repositories/*.py`), `drones` table replaces the RAM-only registry as the source of truth on restart, `commands_audit`, `flights`, `telemetry_history`, `alert_rules`/`alerts`, `connection_profiles`, `capabilities`, `mission_templates/instances/runs`, `org` settings/feature flags, `provisioning_tokens`, `connection_allowlist` | `db/` (new top-level package), `fleet/routes.py` (`set_repositories`, `_require_repos`) |
| **Tests** | Fleet-session tests, production-hardening tests, DB integration tests | `tests/test_fleet_sessions.py`, `tests/test_production.py`, `tests/test_db_*.py` |

**Net effect:** `main` → one drone, no persistence, no identity model, no auth. `fleet-platform` → N drones per process (each isolated), DB-backed drone identity/registry/audit/history, but — as detailed in §5 below — **still no authentication or authorization**. That part of the master doc's design has not been implemented yet.

---

## 3. How multiple MAVLink links are managed (the "multi-linking" question)

There is **one MAVLink connection per drone**, not one shared connection multiplexed by sysid. This is a deliberate, documented rejection of the alternative design (see callout below). The mechanism:

### 3.1 One `LinkManager` per `DroneSession`

`fleet/drone_session.py:46-50`:
```python
self.link_manager = LinkManager(
    connection_string=connection_string,
    baudrate=baudrate,
    udp_forwarding_endpoints=list(udp_forwarding_endpoints or []),
)
```

Each `DroneSession` constructs its own `LinkManager`, which opens its own `mavutil.mavlink_connection(...)` — its own socket/serial port. `mavutil` already abstracts every wire transport as a connection string (`tcp:host:port`, `udpin:0.0.0.0:port`, `serial:/dev/ttyUSB0:baud`), so adding a new transport is zero new protocol code — it's just a new connection-string scheme reaching the same `LinkManager`.

### 3.2 `SessionRegistry` is the fan-out point

`fleet/session_registry.py:20-23`:
```python
class SessionRegistry:
    def __init__(self) -> None:
        self._sessions: Dict[str, DroneSession] = {}
        self._lock = asyncio.Lock()
```

Registering a new drone (`POST /fleet/drones`) calls `SessionRegistry.create(...)`, which builds a brand-new `DroneSession` (and therefore a brand-new `LinkManager`, on its own connection) and stores it under a `drone_id` key. There is no shared/multiplexed transport — N drones means N independent MAVLink sockets, N independent asyncio read loops, all running inside one Python process.

```
SessionRegistry
 ├── "drone-abc123" → DroneSession → LinkManager → mavutil.mavlink_connection("tcp:127.0.0.1:5763")
 ├── "drone-def456" → DroneSession → LinkManager → mavutil.mavlink_connection("tcp:127.0.0.1:5773")
 ├── "drone-ghi789" → DroneSession → LinkManager → mavutil.mavlink_connection("udpin:0.0.0.0:14550")
 └── "default"      → DroneSession → LinkManager → (legacy single-drone route target)
```

**Why this design over the alternative (one shared link, N sysids muxed)?** The master doc records this decision explicitly (§4.1): a tool like `mavlink-router`/MAVProxy fanning one physical link out to many sysids was *considered and rejected as the session model* — MAVProxy in particular muxes every sysid onto every output port, which would break the per-session isolation guarantee (one drone's link flapping must never affect another). Each drone gets its own connection precisely so that a reconnect storm, malformed packet, or dead link on drone A is invisible to drone B — verified at 10 concurrent SITL drones with zero cross-drone blast radius.

### 3.3 Multiple *vehicles* within one link (a different axis)

Independently of the above, a single `LinkManager`/connection can itself see more than one MAVLink `sysid` (e.g., a companion computer or a proxy that happens to forward more than one vehicle's heartbeats onto the same socket). `mavlink_link.py` handles this with a `vehicles: Dict[sysid, VehicleState]` map and a `primary_sysid`:

- Every inbound message is dispatched by `msg.get_srcSystem()` into `self.vehicles[sysid]` (`mavlink_link.py:211-217`).
- The first sysid seen becomes `primary_sysid` automatically (`mavlink_link.py:260-261`).
- `select_primary(sysid)` lets the operator explicitly switch which vehicle on that link receives commands/mode-changes (`mavlink_link.py:326-331`).
- `list_vehicles_payload()` exposes all sysids seen on that link, flagging `is_primary` (`mavlink_link.py:338-354`).

**Do not conflate these two mechanisms:**
- **Fleet-level multi-drone** = N `LinkManager`s, one per drone, orchestrated by `SessionRegistry`. This is the actual "fleet" feature.
- **Per-link multi-vehicle** = a pre-existing single-drone-GCS capability for the edge case of more than one sysid appearing on one physical connection. It predates fleet-platform and is unrelated to fleet scaling.

### 3.4 Connection lifecycle & staggering

Registering, connecting, and reconnecting are all per-session and independently supervised:
- `POST /fleet/drones` → `SessionRegistry.create()` (RAM) → optional DB `upsert` (`drones` table) + a `connection_profiles` row mirroring the transport (`fleet/routes.py:130-186`).
- `POST /fleet/drones/{id}/connection/start` → `DroneSession.connect()` → `LinkManager.connect()`, guarded by a per-session `_connect_lock` so concurrent start calls don't race (`fleet/routes.py:214-229`).
- On process boot with persistence enabled, `SessionRegistry.load_from_db()` rehydrates one `DroneSession` per non-archived `drones` row (RAM identity only — it does **not** auto-open the transport during rehydration); the caller then reconnects `auto_connect=1` drones with its own staggering/backoff, reusing the same per-session reconnect logic already proven at 10 drones (`session_registry.py:75-109`).

---

## 4. Drone identity ("signing" the drone)

This is the piece most likely to cause confusion, because "signing" has two unrelated meanings in this domain — the code implements one of them, and explicitly does **not** implement the other:

| Meaning | Is it implemented? |
|---|---|
| **MAVLink message signing** (MAVLink 2's cryptographic per-packet signing, `sign_key`/`signing`, to authenticate that a message really came from the paired FC and reject spoofed/replayed packets on the wire) | **No.** Grepping the whole `python_service` tree for `signing`/`sign_key` returns nothing. There is no wire-level cryptographic authentication of MAVLink traffic today. |
| **Drone identity/registration** (assigning a durable `drone_id`, associating it with a connection, persisting it as "this fleet's drone #N") | **Yes**, this is what actually exists, and it's almost certainly what "signing the drone" refers to in this codebase's vocabulary. |

### 4.1 How a drone gets its identity

1. **`drone_id` assignment** — `DroneSession.__init__` (`fleet/drone_session.py:41`):
   ```python
   self.drone_id = drone_id or uuid.uuid4().hex[:12]
   ```
   The caller (`POST /fleet/drones`) may supply an explicit `drone_id`; if omitted, a random 12-hex-char UUID fragment is minted. This ID is the fleet-wide primary key for that drone from then on — every route, every DB row, every telemetry frame is tagged with it.

2. **Registration ("signing in")** — `POST /fleet/drones` (`fleet/routes.py:130-186`):
   - Validates the requested `connection_string` against the org's `connection_allowlist` **if persistence is enabled** (`repos.allowlist.is_allowed(...)`) — this closes what the master doc calls finding F2: an unvalidated connection string is an SSRF-class vector (it would let a client point the server's outbound MAVLink dialer at an arbitrary internal host/port). Without this check, "register a drone" is indistinguishable from "make the server dial anywhere I want."
   - Creates the in-RAM `DroneSession` via `SessionRegistry.create()`.
   - If persistence is on, **upserts a row into the `drones` table** (the database becomes the source of truth; RAM is a cache) and ensures a matching `connection_profiles` row exists. If the DB write fails, the RAM session is rolled back so RAM and DB never diverge (`fleet/routes.py:156-182`).
   - Optionally auto-connects immediately (`req.auto_connect`).

3. **Deregistration ("signing out")** — `DELETE /fleet/drones/{drone_id}` (`fleet/routes.py:189-205`): removes the RAM session and **soft-deletes** (archives, not hard-deletes) the DB row, so it won't rehydrate on next boot but its history (`flights`, `commands_audit`, `telemetry_history`) is preserved.

4. **Vehicle-level identity within a link** — separately from the `drone_id`, every MAVLink packet carries a `sysid`/`compid`. `LinkManager` tracks these per-connection (`vehicles: Dict[sysid, VehicleState]`), and `command_manager.py` scopes retries/ACKs to a `(sysid, compid)` pair, now additionally tagged with the owning `drone_id` for audit attribution (`drone_session.py:53-56`):
   ```python
   if getattr(self.link_manager, "command_manager", None) is not None:
       self.link_manager.command_manager.drone_id = self.drone_id
   ```
   So the *full* identity of a command is `(drone_id, sysid, compid)` — fleet-scoped-drone × MAVLink-vehicle × MAVLink-component.

### 4.2 Schema tables that exist for identity (Phase 5B, built)

`db/repositories/`:
- **`drones_repo.py`** — the `drones` table itself: `id` (= `drone_id`), `org_id`, `name`, `connection_string`, `auto_connect`, `metadata_json`, `archived_at`.
- **`connection_profiles_repo.py`** — a drone can own *multiple named connection profiles* (e.g. "primary LTE", "backup serial"), each with a `kind` (udp/tcp/serial/lte/wireguard/companion/sitl); one is `active` at a time.
- **`capabilities_repo.py`** — open-vocabulary hardware facts per drone (`rgb_camera`, `thermal_camera`, `rtk`, `payload`, ...).
- **`provisioning_repo.py`** — a `provisioning_tokens` table exists in the schema (for minting device-level credentials, e.g. for a future Edge Agent) — **the table and repository exist, but nothing in the current routes issues, validates, or consumes a provisioning token today.** It's schema-ready, not wired up.
- **`allowlist_repo.py`** — the `connection_allowlist` table + `parse_connection_string()`/`is_allowed()` — this is the one identity-adjacent security control that **is** actually enforced on the registration path today (see 4.1 above).

### 4.3 Plain-English summary of "how we sign a drone"

There is no cryptographic drone signing. "Registering" a drone means: mint or accept a `drone_id` → validate its connection string against an allow-list → create an isolated in-memory session (its own MAVLink socket, mission manager, parameter manager) → persist a row for it in the `drones` table so it survives a restart. Any MAVLink vehicle that shows up on that drone's connection is trusted by sysid alone, exactly as a single-drone GCS trusts whatever answers on its one port — fleet-platform adds *bookkeeping and isolation* around that trust, not cryptographic verification of it.

---

## 5. Authentication & authorization

**Current state on `fleet-platform`: there is none.** This needs to be said plainly because it's easy to assume the DB/org scaffolding below implies enforcement — it does not yet.

### 5.1 What's actually enforced today

Grepping `node_api/server.js` and `node_api/lib/*.js` for JWT/bearer/passport/API-key/auth-mode logic returns nothing. Every `/fleet/*` and legacy route is reachable by anyone who can reach the Node/Python HTTP ports, with no login, no token, no role check. This matches the master doc's own finding (F2, "verified wide-open") — it is a known, documented gap, not an oversight this document is newly discovering.

### 5.2 What exists that *looks* auth-related but isn't enforcement

- **`org_id`** — every DB row (`drones`, `flights`, `alert_rules`, ...) carries an `org_id` column, and `fleet/routes.py` threads a module-level `_org_id: str = "default"` through every persistence call (`fleet/routes.py:27`, `set_repositories(...)`). This is **multi-tenant data modeling**, not multi-tenant *enforcement* — today every request is silently attributed to the one `"default"` org because there is no auth layer to derive a real org/user from the request. It's the shape the schema needs once auth exists; it does nothing to keep two orgs' data apart yet, because there's only ever one org in play.
- **`provisioning_tokens` table** — as noted in §4.2, schema exists, unused by any route.
- **`connection_allowlist`** — this is real, enforced authorization of a specific action (what a server is allowed to dial out to), but it is not user/operator authentication — it doesn't know or care *who* is calling the API, only *what connection string* they supplied.

### 5.3 What's designed (master doc §13) but not built

For completeness — since the question was "how has auth been developed" — the target design (not yet implemented) is:
- **JWT + refresh tokens**, issued by an auth service; Node validates (not issues) tokens on every request.
- **`AUTH_MODE` env flag**: `enforced` (cloud/on-prem multi-tenant) vs. `disabled` (offline single-trusted-operator escape hatch).
- **RBAC** scoped by `org_id` — roles determine which drones/orgs/actions a user can see or invoke.
- **Device credentials** (provisioning-token-derived) for the future Edge Agent, distinct from user auth — a drone/agent authenticates as a device, not as a human operator.
- **Command audit** (`commands_audit` table — this part **is** built, see §2.2) records `operator_id` per command, but since there's no auth today, `operator_id` has no real identity to attribute to; the column is populated with whatever the (currently anonymous) caller claims, if anything.

### 5.4 Bottom line

Order of what exists: **drone identity/registration (built) → DB multi-tenancy shape (built, unused) → connection allow-listing (built, enforced) → user authentication (not built) → RBAC/authorization by role (not built)**. Anyone treating `org_id`/`provisioning_tokens` as evidence of "auth is in progress" should read this as schema-first groundwork, not partial enforcement — there is a real, open gap between "the database can represent multiple tenants" and "the API refuses a request from the wrong tenant," and that gap is currently the entire authentication/authorization layer.

---

## 6. One end-to-end picture

```
                          ┌─────────────────────────────────────────┐
                          │        SessionRegistry (RAM cache)       │
                          │  rehydrated from `drones` table at boot  │
                          └───────────────┬───────────────────────────┘
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
            DroneSession           DroneSession           DroneSession
          drone_id=abc123        drone_id=def456          drone_id="default"
                    │                     │                     │
              LinkManager           LinkManager           LinkManager
           (own MAVLink socket)  (own MAVLink socket)  (own MAVLink socket)
                    │                     │                     │
              tcp:127.0.0.1:5763    udpin:0.0.0.0:14550   auto/USB serial
                    │                     │                     │
                    ▼                     ▼                     ▼
              Flight Controller     Flight Controller     Flight Controller
                (SITL/real)            (SITL/real)            (SITL/real)

  No auth/authz gate exists between any HTTP client and any of the above.
  The only gate today is: is the connection_string on the org allow-list
  (checked once, at registration time, not per-request).
```

---

## 7. Built vs. designed-only — quick reference

| Capability | Status |
|---|---|
| N independent MAVLink sessions per process, isolated | **Built** (`SessionRegistry`/`DroneSession`/`LinkManager`) |
| Legacy single-drone routes still work unchanged | **Built** (`"default"` session) |
| Multi-vehicle-on-one-link (sysid muxing) | **Built**, pre-dates fleet-platform, orthogonal to fleet scaling |
| Fleet-scoped telemetry (drone_id-tagged ZMQ→WS) | **Built** |
| DB-backed drone registry (survives restart) | **Built** (Phase 5B, `drones` table + rehydration) |
| Connection-string allow-list (closes SSRF gap) | **Built**, enforced at registration |
| Command audit trail | **Built** (`commands_audit`), but `operator_id` is meaningless without auth |
| Org/multi-tenant data model | **Built** as schema/plumbing; not enforced (single implicit `"default"` org) |
| Provisioning tokens (device credentials) | **Schema exists**, not wired to any route |
| MAVLink cryptographic message signing | **Not built** |
| User authentication (JWT/session) | **Not built** |
| Authorization / RBAC | **Not built** |
| Drone Edge Agent | **Not built** (designed only, master doc §5) |

---

## 9. The "Complete High-Level Architecture" diagram, explained layer by layer

This walks through `FLEET_MASTER_ARCHITECTURE.md` §2 (the 7-box stacked diagram) one box at a time, for someone who has never seen this system before. For each layer: **what it is, why it's a separate box, what actually runs there today**, and any jargon defined on first use.

### Why is it drawn as stacked layers at all?

Because each layer talks only to the layer directly above/below it, never reaching over one to touch a third. That's a deliberate rule, not an accident: if the Dashboard talked straight to the Drone Layer, you couldn't swap out how a drone connects (serial vs. LTE vs. future Edge Agent) without rewriting the UI. Every layer is a **replaceable box** as long as it keeps talking the same "language" (protocol/API) to its neighbors. Keep this one idea in your head for every box below: *a layer exists to hide a decision from everything above it.*

### Layer 1 — Drone Layer

**What it is:** the physical airframe — flight controller (ArduPilot/PX4/etc.), companion computer if any, cameras, GPS, payload, onboard storage.

**Why it's its own layer:** this is the one box the platform does not own or control. It's someone else's hardware, running someone else's firmware, speaking a standard protocol (MAVLink). The platform's job starts at "receive what this box sends," not "control what's inside it."

**Status:** existing, code-verified. Not something fleet-platform changed — it's the same MAVLink-speaking hardware a single-drone GCS already supports.

### Layer 2 — Edge Layer (the "Drone Edge Agent")

**What it is:** a small extra program *designed to run on the drone's own companion computer*, sitting between the drone and the network, whose only job is to make a flaky connection (cellular, RF, intermittent) reliable — it buffers data when the link drops and forwards it once the link comes back.

**Why it's its own layer:** without it, every network hiccup is the Fleet Core's problem directly (a raw socket just drops). With it, the drone-side agent absorbs the flakiness and Fleet Core sees a clean, steady, authenticated connection. This is the same reason a phone app buffers unsent messages instead of failing to send the moment you walk into a tunnel.

**Status:** **not built.** Today's reality is what the diagram calls the "bypass path" — drones expose their MAVLink/video endpoints directly, and Fleet Core dials straight in (or the drone dials straight out). This is fine at 10 SITL drones on one LAN; it becomes the biggest weakness at real-world scale over cellular. Don't be misled by the polish of this diagram's Edge Layer box — zero code exists for it yet.

### Layer 3 — Communication Layer

**What it is:** not a program, but a *description of the wire* — what physical/network transport the MAVLink bytes travel over: Serial, UDP, TCP (transport), then WireGuard/LTE/RF/WiFi/VPN (network), then RTSP/RTP/WebRTC for video.

**Why it's its own layer:** the code that reads MAVLink messages (`LinkManager`) doesn't want to know or care whether the bytes came over a USB cable or a cellular modem — `mavutil.mavlink_connection("tcp:...")` vs `("serial:...")` vs `("udpin:...")` is a **one-line string difference**, everything above that string is identical code. This is what "the platform adds no new protocol code for new transports" (master doc §4) means in practice.

**Status:** existing for Serial/UDP/TCP (used every day, including the 10-drone SITL benchmark). VPN profiles (WireGuard/ZeroTier) are a deployment/config concern, not app code — nothing to "build," just something to wire into `docker-compose`/deployment manifests later.

### Layer 4 — Fleet Core (the actual backend — two processes)

This is the layer fleet-platform changed the most, and it is itself split into two halves that talk to each other. This split is the single most important design decision to understand, so it gets its own subsection.

#### 4a. Python — "Drone Gateway" (stateful)

**What it is:** the process that actually owns a MAVLink connection, actually knows what a mission upload looks like, actually parses a `HEARTBEAT` message. This is `SessionRegistry` → N × `DroneSession` (§3 of this doc).

**Why Python owns this:** it's the tier that was already doing this work in the single-drone GCS on `main` — nothing needed to move, it just needed to be duplicated N times safely (one `DroneSession` per drone, §2.1). It is also the only tier that touches the database (§8 master doc) — the rule is "the producer owns the store": whichever code writes a fact (a telemetry sample, a command result) is the same code that persists it, so there's never a question of two processes disagreeing about what's true.

**"Stateful" means:** if this process restarts, in-memory state (which drones are connected right now, what mission is mid-upload) is lost — which is exactly why Phase 5B added the database: on restart, it *rehydrates* (reloads) the drone list from the DB instead of starting with zero drones.

#### 4b. Node — "Fleet Gateway" (stateless)

**What it is:** the process the *browser* actually talks to. It never touches MAVLink or the database directly. Its whole job is: take what Python publishes/returns, reshape it for the browser, and hand it to as many browser tabs as are watching.

**Why a separate process from Python at all, instead of one program doing everything:** two different scaling problems. Python's scaling problem is "how many drones can one process supervise." Node's scaling problem is "how many browser tabs/dashboards can watch this fleet." Those are unrelated numbers (10 drones with 50 operators watching them is a very different load shape than 10 drones with 1 operator) — splitting them into two processes means you can scale one without touching the other. A load balancer can run five copies of Node behind it and none of them need to agree on anything, because none of them hold the real data — Python does.

**"Stateless" means:** if you kill a Node process and start a new one, nothing is lost — a browser reconnects its WebSocket, re-sends "I want to watch drone X," and it's exactly as if nothing happened. Node's only "memory" is a disposable cache of the last telemetry frame per drone (used to compute *diffs*, not to hold truth).

#### The bridge between them: ZMQ, and what "PUB/SUB" actually means

This is the specific piece you asked about. Here's the plain version:

- **ZMQ (ZeroMQ)** is a small library for sending messages between two processes over a socket — think of it as a much simpler, much faster alternative to setting up an HTTP server just to move a stream of small JSON messages from one process to another on the same machine.
- **PUB/SUB** is one of ZMQ's patterns: one side is a **Publisher (PUB)** that just keeps shouting messages into the socket, not caring who's listening or how many listeners there are. The other side is a **Subscriber (SUB)** that connects and starts receiving whatever the publisher shouts, from that point on.
- **In this system:** Python is the Publisher. 10 times a second, `TelemetryPublisher` takes the current state of every connected drone and shouts it out over `tcp://<host>:5556` — tagged with which `drone_id` each message belongs to. Node is the Subscriber (`ZmqTelemetrySubscriber`) — it just sits there and receives whatever Python shouts.

**Why this instead of Node just calling a Python REST endpoint every 100ms (polling)?**
- Polling means Node has to *ask* 10 times a second, whether or not anything changed — wasted requests, and a built-in 100ms-average delay between "state changed" and "Node found out."
- Publishing means Python pushes the instant it has a new frame — no delay, no wasted asking, and Python never has to track "who's asking me right now."
- If Node crashes and restarts, Python doesn't need to know or care — it just keeps publishing into the void until a new Subscriber connects. This is exactly why Node can be "stateless" and freely restartable: the Publisher/Subscriber relationship doesn't require either side to track the other's health.
- If ZERO Node processes are subscribed, Python's publish loop doesn't block or slow down — PUB sockets are fire-and-forget by design. That's important because the telemetry loop is the one truly real-time path in the system (§9.2 of the master doc) — nothing is allowed to make it wait.

So: **ZMQ SUB in Node = "listen for whatever Python is broadcasting, and don't bother Python to get it."** Once a frame arrives, Node re-shapes it (normalizes units, adds a staleness flag, tags it per-drone) and re-broadcasts it again — this time over **WebSocket**, to browsers, filtered so each browser only receives the drones it actually asked to watch.

#### What else lives in the Python half

- **Repository Layer** — the *only* code allowed to know SQL exists. Everything else (session registry, command manager, telemetry publisher) calls plain methods like `drones_repo.upsert(...)` and gets back a dict — it never writes a query itself. This is what makes swapping SQLite for PostgreSQL later a non-event for the rest of the codebase.
- **Database** — SQLite by default (a single file, zero setup), PostgreSQL as an opt-in for bigger/multi-node deployments. Built (Phase 5B).
- **Object Storage** — big files (video recordings) are never put *in* the database; the database stores a pointer (a file path or S3 URL) and the actual bytes live on disk (or S3 later). Same reason you don't email someone a 2GB video file — you send them a link.

#### What else lives in the Node half

- **Fleet API** — the REST endpoints the browser calls (`/fleet/drones`, etc.) — mostly a thin proxy that forwards to Python and reshapes the response.
- **Auth (designed, not built)** — where JWT validation would happen, once it exists (§5 of this doc).
- **Event Bus** (`eventBus.js`) — exists as plumbing today with nobody actually publishing or subscribing to it yet. The intended future use: something detects "battery low" → publishes an `alert.fired` event → a notification service (email/SMS/Slack) and the dashboard's live Alerts panel both react to it independently, without the alert-detector needing to know either of them exists.
- **Metrics/Health** (`/metrics`, `/health`) — built, used by anything monitoring whether this process is alive and healthy (Prometheus-style).

### Layer 5 — Application Layer

**What it is:** just a naming/versioning convention for the API surface (`/api/v1/*`), so that when the API needs to change shape in the future, old clients calling `/api/v1/*` keep working unchanged while a new `/api/v2/*` is introduced alongside it.

**Status:** designed, not really enforced yet — today's routes are unversioned (`/fleet/*`, `/api/*`), not `/api/v1/*`. This layer is mostly a promise about *future* discipline, not a running component today.

### Layer 6 — Dashboard

**What it is:** the React frontend — what a human operator actually looks at and clicks.

**Status:** today, this is still fundamentally the single-drone GCS UI (map, HUD, mission planner, parameters). Fleet-awareness exists only as a raw `GET /fleet` endpoint returning a list — there's no dedicated fleet UI (Fleet Map, Fleet Health, Video Wall, etc.) built yet. Those are designed (master doc §12) as future modules, explicitly meant to *wrap* today's existing per-drone pages rather than replace them (e.g., "Drone Details" in the target design is just today's GCS page, reused, addressed by `drone_id`).

### Layer 7 — External Integrations

**What it is:** everything outside this platform that it might eventually talk to — GIS systems, regulatory reporting tools, SIEM log export, Slack/email/SMS providers, an external identity provider (SSO).

**Status:** none of this exists yet. It's listed to show the platform has a deliberate "front door" for these integrations (the event bus / storage abstraction) rather than each one growing its own ad-hoc hook into the middle of the codebase later.

---

## 10. The "Final Architecture Diagram" — what's different from the diagram above, and why it exists

`FLEET_MASTER_ARCHITECTURE.md` §20 draws what looks like a second, similar diagram. It is **not a duplicate** — it's the same 7 layers, but with the **Fleet Core box exploded open** to show its internal parts, because that's the box doing all the interesting engineering work. Read it as "§2's diagram, zoomed in on one box."

Everything in Layers 1, 2, 3, 5, 6, 7 is identical in meaning to §9 above — the only new detail worth calling out:

- **`SessionRegistry [DB-backed, rehydrated at boot]`** — this label is the one-line summary of the single biggest change Phase 5B made: before it, restarting the Python process meant every registered drone silently vanished (you'd have to re-register all of them by hand). After it, the database is what's actually true, and the in-memory registry is just a *cache* of it that gets rebuilt automatically every time the process starts.
- **"N × DroneSession { ... VideoRegistry entries }"** — `VideoRegistry` is bracketed as part of a `DroneSession` here because that's the *target* design (letting each drone stream more than one camera — RGB and thermal — at once). Today, video is still a single global singleton, not yet one-per-drone — this bracket is a "not built yet" the same way the Edge Layer is.
- **"Object Storage (fs / S3, §8.10)"** — `fs` means "just write the file to the local filesystem," which is what happens today (`recordings/` folder); S3 is the future opt-in for cloud deployments. Same code path either way, just a different storage driver underneath.
- **The arrow labelled `ZMQ PUB (drone_id-tagged) · REST (fleet API)` between the Python and Node boxes** is exactly the ZMQ PUB/SUB mechanism explained in §9 above, plus the plain REST calls Node makes to Python for anything that isn't a live telemetry stream (e.g., "send this command," "upload this mission") — those are ordinary request/response HTTP calls, not ZMQ, because a command needs a definite yes/no answer, not a broadcast.
- **Everything else drawn but labelled "designed here"** (Auth, RBAC, versioned `/api/v1/*`, the full Dashboard module list, External Integrations) is the same **not-built** set already itemized in §7 of this document ("Built vs. designed-only — quick reference"). If a box in this diagram doesn't appear in that table as "Built," treat it as a blueprint, not a running system.

**The one-sentence takeaway for a newcomer:** both diagrams describe the same seven layers of one platform; the first shows how they stack, the second opens up the busiest layer (Fleet Core) to show that it is actually two cooperating processes — a stateful Python brain that owns every drone connection and the database, and a stateless Node front door that only exists to serve browsers — glued together by a fire-and-forget broadcast (ZMQ PUB/SUB) for live data and ordinary request/response (REST) for everything that needs a definite answer.

---

## 11. Where to look next

- Full forward-looking design (multi-tenant auth, Edge Agent, video-at-scale, DR, roadmap): `FLEET_MASTER_ARCHITECTURE.md`.
- DDL-level database reference: `FLEET_PHASE5B_DATABASE_ARCHITECTURE.md`.
- 10-drone concurrency/isolation evidence: `FLEET_BENCHMARK_10_DRONES.md`.
- Code entry points to read in this order if extending: `fleet/session_registry.py` → `fleet/drone_session.py` → `fleet/routes.py` → `db/repositories/hub.py`.
