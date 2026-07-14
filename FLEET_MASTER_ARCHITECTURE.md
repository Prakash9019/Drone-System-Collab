# FLEET MASTER ARCHITECTURE

**Status:** Authoritative — single source of truth for the Fleet Management Platform
**Author role:** Architect (architecture-review skill)
**Date:** 2026-07-11
**Branch:** `fleet-platform`
**Supersedes (as narrative, not as history):** `FLEET_PHASE1_ARCHITECTURE_REPORT.md`, `FLEET_PHASE2_ARCHITECTURE_DESIGN.md`, `FLEET_PHASE5_PRODUCTION_ARCHITECTURE_REVIEW.md`, `FLEET_PHASE5B_DATABASE_ARCHITECTURE.md`, `FLEET_IMPLEMENTATION_LOG.md`, `FLEET_BENCHMARK_10_DRONES.md`. Those documents remain the point-in-time evidence trail; this document is the durable spec a new engineer should read first. Where this document and a phase document disagree on a still-open decision, this document wins; where it describes something already shipped, the phase docs are the code-verified proof.
**No code is implemented or changed by this document.**

---

## 0. How to read this document

This platform is being built by evolution, not rewrite (ADR-001, §19). Three things are simultaneously true and load-bearing throughout every section below:

1. **What exists today** (Phases 1–5A, code-verified): a single Python process (`python_service/`) running one `SessionRegistry` of `DroneSession` objects, one Node gateway (`node_api/`) doing stateless REST-proxy + ZMQ→WebSocket relay, and a React SPA — all with production-grade health/metrics/logging (Phase 5A), but **no durable registry, no auth, no DB, no video-at-scale story**. Verified at 10 concurrent SITL drones: ~622 telemetry frames/sec, ~12% CPU (Python) + ~3.7% CPU (Node) on one core, sub-3-second failure detection, zero blast radius across drones (`FLEET_BENCHMARK_10_DRONES.md`).
2. **What is approved but not yet built**: the Phase 5B database design (D1–D6 decisions, §8 below) — schema is final, code does not exist yet.
3. **What is designed here for the first time**: the Edge Agent (§5), the Fleet Dashboard module map (§12), the full security model (§13), scale targets to 10,000 drones (§14), deployment topologies (§15), and disaster recovery (§17).

Every section states which of these three buckets it falls into.

---

## 1. Vision

### 1.1 What is Fleet Management (and why this is not "a GCS with more tabs")

A **Ground Control Station (GCS)** is software that lets one operator fly and monitor **one vehicle** (or a small hand-tracked set) in real time: stick input, HUD, map, mission upload, parameter tuning. Its unit of concern is the *flight*. Mission Planner, QGroundControl, and this platform's own single-drone mode are GCSes.

A **Fleet Management Platform** is software whose unit of concern is the *organization operating many vehicles over time*. It answers questions a GCS structurally cannot:
- "Which of my 40 drones are airworthy right now, and why not the other 6?"
- "Who commanded RTL on drone-17 at 14:02 and what was the outcome?"
- "What is my fleet's average battery degradation this quarter?"
- "Show me every flight within 2 km of this incident location, across all operators."

Consequences of this shift in unit of concern:
- **Identity outlives the connection.** A drone is a database row with a lifecycle (provisioned → deployed → maintained → retired), not a MAVLink sysid that appears when a heartbeat arrives.
- **History is a product feature, not a debugging aid.** Flights, commands, and alerts are queried by humans and regulators, not just tailed in a terminal.
- **Multi-tenancy and authorization are core, not deferred.** Different organizations, roles, and drones share infrastructure; a GCS assumes one trusted operator at a console.
- **Failure isolation is measured in drones-affected, not just "did the app crash."** One drone's link flapping must never be visible to the other 9,999.

This platform's engineering strategy (§7, ADR-001) is: **keep the GCS's proven flight-control code (MAVLink protocol layer, mission microprotocol, video pipeline) unchanged, and wrap it in fleet-scoped identity, persistence, security, and aggregation** — rather than building a new flight-control stack. Phase 1's inventory confirmed the existing MAVLink/mission/parameter code is "correct and battle-tested" and needs scoping, not rewriting.

### 1.2 Difference between Fleet Management and Swarm

These are frequently conflated and must not be:

| | Fleet Management (this platform) | Swarm |
|---|---|---|
| **Control model** | N independent vehicles, each with its own mission, each commanded (or supervised) by a human operator or per-drone automation | N vehicles executing a *shared, coordinated* mission with inter-vehicle awareness (formation, collision avoidance between members, distributed task allocation) |
| **Coupling between vehicles** | None at the control layer — drone A's mission is independent of drone B's. Fleet Core aggregates for *visibility*, not *coordination* | Tight — vehicles exchange state with each other (directly or via a coordinator) to make joint decisions in real time |
| **Failure blast radius** | One drone's loss affects only that drone's operator/mission | One vehicle's loss can require the whole formation to replan |
| **Latency requirement between vehicles** | None — each drone's telemetry/command loop is independent (10 Hz to its own session) | Sub-second to hard real-time, often requiring a dedicated low-latency mesh/RF layer, not internet/cellular |
| **Where this platform sits** | This is the platform | Out of scope. A swarm coordinator could be built as a Fleet Core service (§6, "Plugin Framework") that *consumes* this platform's per-drone telemetry/command APIs, but swarm flight algorithms are not part of this architecture |

**Consequence for design:** Fleet Core must never assume vehicles need to know about each other to operate (that would be swarm coupling creeping into the fleet layer). Every cross-drone feature in this document (Fleet Map, Fleet Health, Fleet Analytics) is **read-side aggregation**, never write-side coordination.

### 1.3 Supported deployment models

One codebase, five deployment postures, selected by configuration/topology — never by forking code (persona rule: reversibility, consistency; standard: no bespoke per-customer branches):

| Model | Description | Primary driver | DB default | Auth |
|---|---|---|---|---|
| **Cloud** | Multi-tenant SaaS; Fleet Core + DB run in a managed cloud region; drones connect over internet/LTE/5G, typically via VPN or MAVLink-over-TLS | Enterprise customers wanting zero infrastructure ownership | PostgreSQL (managed) | Full JWT + RBAC, `AUTH_MODE=enforced` |
| **On-premise** | Customer runs Fleet Core on their own servers/datacenter; same containers as cloud | Defence, utilities, mining — data sovereignty, no external network dependency | PostgreSQL (self-hosted) or SQLite for small sites | Full JWT + RBAC, org = customer's own directory |
| **Offline** | Single-box deployment with no external network at all; field kit, disaster response, remote agriculture | No connectivity guarantee; must run stand-alone indefinitely | SQLite (D2, §8) | `AUTH_MODE=disabled` escape hatch (single trusted operator) or local-only JWT |
| **Hybrid** | On-prem or offline edge site with periodic sync to a cloud aggregation tier (roll-up analytics, fleet-wide dashboards across sites) | Multi-site operators (e.g., agriculture co-ops, inspection contractors with regional depots) | SQLite at edge, PostgreSQL at cloud aggregator; sync is an explicit, auditable batch job — never live replication of the transactional path | Per-site local auth; cloud aggregator has its own RBAC scoped to read-only roll-ups |
| **Edge** | The Drone Edge Agent (§5) runs on companion hardware, aggregating locally, store-and-forwarding to any of the above | Cellular-constrained, high-latency, or intermittently-connected drones (LTE dead zones, RF-only sites) | N/A (Edge Agent has a local cache, not a queryable DB) | Device credential (provisioning token, §13.9), not user auth |

All five share **one Fleet Core codebase**; the only things that change are configuration (`DATABASE_URL`, `AUTH_MODE`), deployment manifests (§15), and, for Edge, an additional agent process. This is the same principle already proven at Phase 5A/5B scale (SQLite/Postgres behind one repository layer, §8) extended to the whole platform.

### 1.4 Supported customer verticals

The platform is domain-agnostic at the Fleet Core layer (drones, telemetry, missions, alerts are vertical-neutral primitives); vertical needs are met through the **Plugin Framework** (§6) and configuration, not through vertical-specific forks:

| Vertical | Primary fleet need | How this architecture serves it |
|---|---|---|
| **Enterprise** (logistics, delivery pilots) | Uptime, SLA reporting, many orgs | Multi-tenant orgs (§8.1), Fleet Analytics (§12), SLO-driven observability (§16) |
| **Defence** | Data sovereignty, no external dependency, audit trail, link security | On-prem/offline deployment, MAVLink signing + VPN (§4), full command audit (§8.7/§13), air-gapped mode |
| **Agriculture** | Many drones over large rural areas, intermittent cellular, survey-mission repetition | Offline/hybrid deployment, Edge Agent store-and-forward (§5), mission templates (Fleet Core Mission Service, §6) |
| **Inspection** (powerline, pipeline, structural) | Thermal + RGB dual-stream, snapshot/recording, per-asset flight history | Dual-stream Video Architecture (§10), flight-linked recordings (`recordings` table, §8), Fleet Analytics |
| **Mining** | Harsh RF environment, dust/heat on companion hardware, safety-critical geofencing | RF/serial transport (§4), Edge Agent health/diagnostics (§5), Alert Service geofence rules (§6) |
| **Oil & Gas** | Remote sites, regulatory retention, hazardous-area operation | Offline deployment, long-retention audit/flight tables (§8, D4), connection allow-list (§13) |
| **Utilities** | Asset inspection at scale, integration with existing GIS/asset-management systems | External Integrations layer (§2), Plugin Framework (§6), Fleet Map (§12) |
| **Security / Public Safety** | Real-time multi-agency visibility, chain-of-custody on video/telemetry, rapid incident response | Low-latency video (§10), audit-grade command log (§8.7), RBAC scoped per agency-as-org (§13) |

---

## 2. Complete High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                                   DRONE LAYER  (§3)                                │
│   Flight Controller (PX4 / ArduPilot / INAV / BetaFlight)  +  Companion Computer   │
│   Camera(s) (RGB/Thermal)  ·  Payload  ·  GPS/RTK  ·  Sensors  ·  Storage          │
└───────────────────────────────────────────────────────────────────────────────────┘
                                          │  MAVLink / RTSP / RTP
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                                   EDGE LAYER  (§5)                                 │
│         Drone Edge Agent (future) — on companion computer or nearby gateway        │
│  MAVLink relay · Video relay · Reconnect/backoff · Buffering · Store-and-forward   │
│  Compression · Encryption · Health/OTA/Diagnostics · Local + Mission cache          │
│         (bypassed today: drones expose MAVLink/video endpoints directly)          │
└───────────────────────────────────────────────────────────────────────────────────┘
                                          │  Serial/UDP/TCP, or Edge Agent's outbound TLS
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                              COMMUNICATION LAYER  (§4)                            │
│  Transport: Serial · UDP · TCP · MAVProxy · mavlink-router                        │
│  Network:   WireGuard · ZeroTier · LTE/5G · RF · WiFi · generic VPN                │
│  Video:     RTSP · RTP · RTMP · WebRTC                                            │
│  Payload types over the above: Telemetry · Commands · Mission Upload · Logs        │
└───────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                                  FLEET CORE  (§6, §7)                             │
│  ┌─────────────────────────── Python Drone Gateway ───────────────────────────┐  │
│  │ SessionRegistry → N × DroneSession (LinkManager, MissionManager,           │  │
│  │ ParameterSyncManager, PreflightManager, CameraManager)                     │  │
│  │ Telemetry Publisher (ZMQ PUB, drone_id-tagged)                             │  │
│  │ Repository Layer  →  Database (§8)  +  Object Storage (§8.9)               │  │
│  └───────────────────────────────┬──────────────────────────────────────────┘  │
│                                  │ ZMQ SUB · REST proxy                        │
│  ┌───────────────────────────────▼──────────────────────────────────────────┐  │
│  │ Node Fleet Gateway (stateless): Auth · Fleet API · Telemetry Gateway      │  │
│  │ (subscriptions, rate limiting) · Command Gateway (authz+audit passthrough)│  │
│  │ Alert/Notification dispatch (event-bus subscriber) · Metrics/Health       │  │
│  └───────────────────────────────┬──────────────────────────────────────────┘  │
└──────────────────────────────────┼─────────────────────────────────────────────┘
                                   │ REST (JWT) · WebSocket (subscribed)
                                   ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                              APPLICATION LAYER                                    │
│        Fleet API contracts, versioned (`/api/v1/*`), OpenAPI-documented           │
└───────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                              DASHBOARD  (§12)                                     │
│  Fleet Overview · Fleet Map · Fleet Health · Fleet Analytics · Mission Control    │
│  Drone Details (existing single-drone GCS pages, scoped by drone_id)              │
│  Video Wall · Alerts · Maintenance · Settings                                    │
└───────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                          EXTERNAL INTEGRATIONS                                    │
│  GIS/Asset Management · Regulatory reporting · SIEM/Log export · Webhooks/SMS/    │
│  Email/Slack notification providers · Object storage (S3/MinIO) · IdP (SSO/SAML) │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Reading the diagram against reality:** everything from Drone Layer through the Node Fleet Gateway box exists today (Phases 1–5A), minus the Repository Layer/Database (Phase 5B, designed not built) and the Edge Layer (designed here, not built). The Application Layer's versioning (`/api/v1`) and the full Dashboard are designed, not built (current API is unversioned `/api/*`; current frontend is the single-drone GCS, fleet-aware only via `GET /fleet`). External Integrations are green-field.

---

## 3. Drone Layer

**Status: existing capability (code-verified) + explicit multi-FC support statement.**

### 3.1 Flight Controller

The platform's transport-and-protocol layer talks **MAVLink**, so any flight controller that speaks MAVLink is a supported drone:

| FC firmware | MAVLink support | Platform posture |
|---|---|---|
| **ArduPilot** | Native, full dialect (`ardupilotmega.xml`) | **Primary target today.** All calibration, motor-test, failsafe, parameter-metadata code (`parameter_metadata.py`) is ArduPilot-specific. SITL harness (`sim_vehicle.py`) is ArduPilot's. |
| **PX4** | Native, `common.xml` + PX4-specific messages | Supported at the transport/telemetry/mission layer (standard MAVLink is standard MAVLink); PX4-specific parameter metadata and calibration flows are **not yet implemented** — tracked as a Fleet Core extension, not a re-architecture (the `parameter_metadata.py` module is already the seam: it is a data table, not protocol code). |
| **INAV** | Partial MAVLink (subset, primarily for GCS telemetry/OSD) | Telemetry/HUD works via the same generic MAVLink handlers (`message_handlers.py`); command/calibration parity is FC-dependent and out of scope until a customer need is confirmed. |
| **BetaFlight** | MSP primarily, MAVLink via bridge/adapter only | Not natively supported; would require a protocol adapter at the Edge Layer (§5) translating MSP→MAVLink, analogous to how mavlink-router bridges transports today. Explicitly a future Edge Agent responsibility, not Fleet Core's. |

**Design principle:** Fleet Core's `DroneSession` and MAVLink handling layer are firmware-agnostic by construction — they operate on MAVLink messages, not ArduPilot internals, except in the clearly-isolated `parameter_metadata.py` / calibration-route layer. Adding PX4 parameter parity is additive work in that seam, not a rearchitecture.

### 3.2 Companion computer

Where present (increasingly standard on inspection/mining/defence airframes), the companion computer (Raspberry Pi, NVIDIA Jetson, DJI Manifold-class devices) is the natural host for the **Drone Edge Agent** (§5). Today, in the absence of an Edge Agent, the companion computer (if any) is transparent to the platform — it simply relays MAVLink/video onward (e.g., via mavlink-router) to whatever endpoint the drone is configured to reach.

### 3.3 Camera / Payload

- **RGB**: primary video source; existing pipeline (`gst_video_receiver.py`) already handles H.264/H.265 over RTSP/RTP/MPEGTS. See §10.
- **Thermal**: second camera stream, same pipeline topology instantiated per-stream (VideoRegistry design, §10) — RGB and thermal are just two `(drone_id, stream_id)` entries.
- **Payload** (sprayers, sensors, delivery mechanisms, gimbals): controlled via MAVLink `MAV_CMD_*` messages already routed through `command_manager.py`; payload-specific commands are data (a command ID + params), not new protocol code.

### 3.4 GPS / RTK

Standard MAVLink `GLOBAL_POSITION_INT` / `GPS_RAW_INT` messages are already parsed (`message_handlers.py`). RTK correction status (fix type, satellites, HDOP) is part of the existing telemetry schema and rolls up into `telemetry_history.gps_fix` / `satellites` (§8.6). RTK correction *injection* (base station → rover over MAVLink `GPS_RTCM_DATA`) is a transport-layer pass-through — no Fleet Core change required, since it is MAVLink traffic on the same link.

### 3.5 Sensors, storage, network

Onboard sensor health (EKF variances, vibration, IMU) already flows through the existing telemetry schema into the `sensors` JSON column of `telemetry_history` (§8.6) — promoted to a first-class column only if a specific query pattern demands an index. Onboard storage (SD card logs, `.bin` files) is out of Fleet Core's real-time path; post-flight log upload is a Fleet Core service (§6, Storage) once the Edge Agent or a manual upload delivers the file. Network is whatever the Communication Layer (§4) provides — the drone layer is intentionally ignorant of it.

---

## 4. Communication Layer

**Status: transport/network items are existing capability; video protocol items are existing (RTSP/RTP ingest, WebRTC egress) except RTMP (not implemented); VPN/WireGuard/ZeroTier are deployment-layer, not yet wired into docs/compose (designed here).**

The design principle carried over unchanged from Phase 2: **`mavutil.mavlink_connection` already abstracts every wire transport as a connection string** (`tcp:host:port`, `udpin:0.0.0.0:port`, `serial:/dev/ttyUSB0:baud`). The platform adds no new protocol code for new transports — it adds **connection profiles** (stored per drone, §8.3) and **allow-list validation** (§8.11, closing the SSRF-class F2 finding) around that existing abstraction.

### 4.1 Transport (MAVLink carrier)

| Transport | Use case | Status |
|---|---|---|
| **Serial** | Direct USB/UART link (bench testing, tethered/short-range RF modems) | Existing (`connection_manager.py` auto-detect + explicit `serial:` connection strings) |
| **UDP** | Most common: SITL, telemetry radios in UDP mode, companion computer forwarding | Existing (`udpin`/`udpout`) |
| **TCP** | SITL per-instance ports (used in the 10-drone benchmark's `+2` SERIAL1 ports), some telemetry radios | Existing |
| **MAVProxy** | Local multiplexing/testing tool (`sim_vehicle.py`'s default `--out` UDP ports) | **Explicitly not used for per-drone attachment** — MAVProxy muxes all sysids onto every `--out` port, breaking per-session isolation (documented pitfall, `FLEET_BENCHMARK_10_DRONES.md` §"Known issues #4"). Fine as an operator debugging tool alongside the platform, never as the platform's own attachment point. |
| **mavlink-router** | Would allow one physical link (e.g., one LTE modem) to fan out to multiple consumers | Not currently used; Phase 2 explicitly rejected "mavlink-router / mavp2p in front, one process per drone" as the *session model* (destroys shared-session efficiency) — but mavlink-router remains a valid **companion-computer-side** tool for fan-out to the Edge Agent, orthogonal to Fleet Core's session model. |

### 4.2 Network (how the transport reaches Fleet Core)

| Network layer | Use case | Status |
|---|---|---|
| **WireGuard** | Preferred VPN for on-prem/offline/hybrid deployments needing simple, fast, auditable tunnels between drone sites and Fleet Core | Deployment concern (docker-compose profile, §15) — no application code needed since MAVLink already runs over the resulting virtual interface as plain UDP/TCP |
| **ZeroTier** | Alternative VPN for NAT-traversal-heavy, ad-hoc field deployments (no static IP infrastructure) | Same as WireGuard — deployment profile, zero app code |
| **LTE / 5G** | Primary cellular carrier for field drones; NAT/carrier-grade-NAT means drones typically dial **out** to Fleet Core (`udpout`) rather than Fleet Core dialing in | Existing transport support (`udpout` connection strings); the **Edge Agent** (§5) is the strategic answer for reliability over cellular (reconnect, buffering, store-and-forward) — without it, cellular drones are exposed to every link hiccup directly |
| **RF (proprietary telemetry radios)** | Long-range point-to-point (SiK radios, RFD900, proprietary 900MHz/2.4GHz links) | Existing — presents as serial or UDP to `mavutil`, no special-casing needed |
| **WiFi** | Short-range, high-bandwidth (video-heavy inspection at close range) | Existing — presents as UDP/TCP |
| **Generic VPN** | Any customer-mandated corporate VPN (IPSec, OpenVPN) for on-prem/defence deployments | Deployment concern; Fleet Core is VPN-agnostic (binds to whatever interface the OS presents) |

### 4.3 Video protocols

| Protocol | Direction | Status |
|---|---|---|
| **RTSP** | Camera → Fleet Core ingest | Existing (`gst_video_receiver.py` source_bin) |
| **RTP** (raw UDP H.264/H.265, port 5600 convention) | Camera → Fleet Core ingest | Existing |
| **RTMP** | Would be an alternative ingest/distribution protocol (common for cloud media servers) | **Not implemented.** Noted as a future distribution-layer option (§10) if a managed media server (e.g., an RTMP-ingesting CDN) is introduced — orthogonal to the GStreamer ingest pipeline, which stays RTSP/RTP. |
| **WebRTC** | Fleet Core → Dashboard, low-latency egress | Existing (`webrtc_sender.py`, STUN only, **no TURN** — documented gap, §10.5) |

### 4.4 Payload types carried over the above

Telemetry, Commands, Mission Upload, and Logs are not separate transports — they are separate **MAVLink message classes / separate REST payloads** riding the same connection:
- **Telemetry**: MAVLink stream → `LinkManager` → 10 Hz ZMQ publish (§11).
- **Commands**: `COMMAND_LONG` + ACK machine (`command_manager.py`), synchronous request/response over the same MAVLink link.
- **Mission Upload**: MAVLink mission microprotocol (`MISSION_COUNT` → `REQUEST_INT`/`ITEM_INT` loop → `MISSION_ACK`), same link, existing and unchanged (`mission_manager.py`).
- **Logs**: today, post-flight `.bin`/`.tlog` files are manually uploaded via a REST multipart endpoint (proxied through Node); the Edge Agent's future OTA/diagnostics responsibility (§5) is to automate this.

---

## 5. Edge Layer — the Drone Edge Agent (designed here; not yet built)

**Status: this is the single largest net-new component in this document.** Today, drones expose raw MAVLink/video endpoints directly to Fleet Core — this is explicitly called out in Phase 5's review as "the single biggest strategic divergence from FlightHub/FlytBase for thousands of drones over cellular" (F10). The Edge Agent closes that gap.

### 5.1 What it is

A small, authenticated, outbound-dialing process running on the drone's companion computer (or a nearby gateway device co-located with a non-networked drone, e.g. at a ground relay). It is the platform's only component that must run *disconnected-first* — assume the network is absent by default, present as a bonus.

### 5.2 Responsibilities

| Responsibility | Behavior |
|---|---|
| **MAVLink relay** | Terminates the drone's local MAVLink link (serial/UDP from the FC) and re-presents it to Fleet Core over a single authenticated outbound TLS connection — replacing raw `udpin`/`tcp` exposure. |
| **Video relay** | Same posture for the video pipeline: receives RTSP/RTP locally, forwards over the authenticated channel, so Fleet Core never dials into the field. |
| **Reconnect** | Exponential backoff + jitter (mirroring the pattern already proven in Node's `ZmqTelemetrySubscriber`, Phase 5A) against Fleet Core's endpoint; never gives up, never blocks local operation. |
| **Buffering** | Bounded in-memory ring buffer for telemetry/commands while the uplink is degraded or absent — bounded so a permanently-offline agent cannot exhaust device memory. |
| **Store-and-forward** | When the buffer would overflow, or the device expects extended offline periods (agriculture, mining), telemetry and flight records spool to local disk (SQLite or flat files) and are forwarded in order once connectivity resumes — same drop-oldest-with-metric philosophy already used for the WS slow-client cap (Phase 5A `broadcaster.js`), applied to the uplink direction. |
| **Compression** | Telemetry batches and log uploads are compressed before the uplink hop (cellular data cost matters for agriculture/mining at scale). |
| **Encryption** | TLS on the outbound control channel; the device's identity is a provisioning-token-derived credential (§13.9), never a bare drone_id. |
| **Health** | Publishes its own liveness (distinct from the drone's link health) — battery/CPU/temperature/storage of the companion computer itself, and uplink quality (RTT, packet loss) as first-class metrics ingested by the Alert Service (§6). |
| **OTA** | Receives and applies its own software updates (agent binary, not flight-controller firmware) from Fleet Core, gated by the same provisioning identity; flight-controller firmware OTA is a separate, higher-risk capability explicitly deferred pending a safety-review ADR. |
| **Diagnostics** | Local self-test (uplink reachability, camera presence, FC heartbeat) exposed both locally (for a field technician) and remotely (for Fleet Core alerting). |
| **Local cache** | Recent telemetry/parameter/state snapshot survives an agent restart without waiting for the drone to re-establish its own link. |
| **Mission cache** | The last-uploaded mission is cached on-device so a connectivity blip mid-mission does not require re-upload from Fleet Core — the agent can re-arm the FC's own mission store from its cache if the FC itself lost it (rare, but the agent is the natural place to hold this belt-and-suspenders copy). |

### 5.3 Where it fits architecturally

The Edge Agent is a **new ingestion path alongside the existing direct-connect path**, not a replacement — this is the same "keep the working path, add the new one behind an interface" pattern as ADR-001's transport abstraction (§7, §19). Fleet Core's `SessionRegistry`/`DroneSession` does not need to know whether a session's `LinkManager` is talking to a raw UDP endpoint or to an Edge-Agent-terminated TLS tunnel that happens to expose the same MAVLink stream — the connection-profile abstraction (§8.3 `drones.connection_string`) already accommodates this as just another connection string scheme once an agent-aware connector is added.

**Explicitly deferred (per Phase 5 review, "new Phase 11"):** MQTT-based ingestion, full device fleet management (bulk OTA rollout policies), is designed at the level of "this is the right shape" here, with implementation sequenced in the roadmap (§18, Phase 10).

---

## 6. Fleet Core — Backend Services

**Status: some services exist today (Drone Session, Fleet Registry-as-RAM, Mission, Telemetry, Command); most are designed here as the target state.**

| Service | Today | Target (this document) |
|---|---|---|
| **Drone Session Service** | `DroneSession` (Python) bundles `LinkManager` + `MissionManager` + `ParameterSyncManager` + `PreflightManager` + optional `CameraManager` per drone; `SessionRegistry` owns lifecycle (create/get/remove), each session independently supervised (verified: one drone's failure has zero impact on the other 9 in the 10-drone benchmark) | Same, plus: DB-backed rehydration on boot (§8.8), drone-to-worker ownership for horizontal scale-out (§14) |
| **Fleet Registry** | `SessionRegistry` is pure RAM — the F1 finding: a restart silently deregisters every drone except the env-configured default | Becomes DB-backed (`drones` table, §8.3): the database is the source of truth, the in-RAM registry is a rehydrated cache. This single change is the platform's most consequential open item (ADR-001, D1) |
| **Mission Service** | `mission_manager.py`: MAVLink mission microprotocol (upload/fence/rally), reused verbatim per session | Adds: mission *versioning* and *template* storage (reusable survey patterns for agriculture/inspection — a DB table, not a protocol change), `mission_runs` history |
| **Telemetry Service** | `telemetry_pub.py`: 10 Hz full-snapshot ZMQ PUB, `drone_id`-tagged, per-tick failure isolation (Phase 5A) | Adds: 1 Hz downsampled persistence (§8.6, D3), delta/keyframe framing for scale (§14, Phase 5D) |
| **Video Service** | `video_service/*` (GStreamer tee → WebRTC/raw-WS/recorder), one active stream today (process singleton) | Becomes a `VideoRegistry: Dict[(drone_id, stream_id) → GstVideoReceiver]` — designed in Phase 2, not yet built (§10) |
| **Command Service** | `command_manager.py`: COMMAND_LONG + ACK-wait + retries, per-(sysid,compid) lock | Adds: audit write on completion (§8.7), priority/preemption (RTL must preempt a lower-priority in-flight command — designed, not built), offline queueing via the Edge Agent (§5) |
| **Alert Service** | Does not exist (`eventBus.js` has zero subscribers today) | New: rule engine (`alert_rules` table, §8.8) evaluating telemetry/health events (battery, link-loss, geofence, GPS-fix-loss) into `alerts` rows; first real consumer of the Node event bus |
| **Notification Service** | Does not exist | New: dispatch abstraction (webhook first-class; email/SMS/Slack as plugins via the Plugin Framework) triggered by Alert Service events |
| **Authentication** | None (F2 — verified wide-open) | New: JWT + refresh, org-scoped (§13) |
| **Organizations** | Table designed (§8.1), not populated beyond a seed "default" org | New: multi-tenant boundary for every drone/user/alert/rule |
| **Storage** | Ad-hoc local files (`recordings/`, `param_cache/`) | Formalizes into the Object Storage abstraction (§8.9): DB holds pointers, driver (fs default, S3/MinIO opt-in) holds bytes |
| **Analytics** | None | New: read-side aggregation over `telemetry_history`/`flights` (fleet-wide battery trends, flight-hour totals, per-drone health scores) — explicitly a **read model**, never a write path; built on the same repository layer, never a second source of truth |
| **Audit** | None (commands are RAM, no operator identity captured) | New: `commands_audit` (§8.7) — every command, every route, records operator + result |
| **Logging** | Structured JSON with correlation IDs, both tiers (Phase 5A, shipped) | Unchanged — already meets the observability standard (§16) |
| **Configuration** | Env-var validation, fail-fast, both tiers (Phase 5A, shipped) | Unchanged; extended with per-org feature flags (e.g., `AUTH_MODE`) as they're introduced |
| **Plugin Framework** | `eventBus.js` exists as unused infrastructure | New: formalizes the event bus as the extension seam for notification providers, vertical-specific alert rules, and swarm-coordinator integrations (§1.2) — plugins subscribe to events, they never get direct DB or MAVLink access, preserving the service boundary rule (§7) |
| **AI Service** | None | Future extension point only (§18 roadmap does not currently schedule it); if built, it would consume telemetry/video **read-side** (anomaly detection, computer-vision payload analysis) via the same event bus / object storage contracts as any other plugin — never given write access to session or command paths |

### 6.1 Interactions

```
Drone Session Service ──publishes──► Telemetry Service ──ZMQ──► Node Telemetry Gateway ──WS──► Dashboard
        │                                    │
        │ (arm/disarm transition)            │ (1 Hz sample)
        ▼                                    ▼
   Mission Service                    Repository Layer ──► Database (flights, telemetry_history)
        │                                    │
        │ (command issued)                   │ (rule evaluation)
        ▼                                    ▼
   Command Service ──audit write──►   Alert Service ──event──► Notification Service ──► webhook/email/SMS
        │                                    │
        ▼                                    ▼
  commands_audit table              alerts / alert_rules tables
```

Authentication, Organizations, Storage, Audit, Logging, and Configuration are **cross-cutting** — every service above calls through them, none of them is a hop in the data-flow chain. This mirrors the standard's "shared libraries for cross-cutting concerns, never business logic" rule (§7 standard reference).

---

## 7. Backend Architecture

**Status: existing division of labor (Python/Node), formalized here; Repository/Service/Event layers are partially built (Phase 5A observability, not persistence).**

### 7.1 Python — Drone Gateway

**Owns:** everything that touches MAVLink, video codecs, and (from Phase 5B onward) the database. Python is the platform's only stateful tier.

- **Responsibility:** drone connection lifecycle, protocol translation (MAVLink ⇄ internal state), mission/parameter/command execution, video ingest, telemetry publishing, persistence.
- **Ownership boundary:** Python is the sole writer of every table in §8. No other tier ever writes to the database directly (standard: "services own their data — no cross-service direct DB reads/writes").

### 7.2 Node — Fleet Gateway

**Owns:** everything that touches the browser client and cross-cutting HTTP concerns. Node is **stateless by design**.

- **Responsibility:** REST proxy/aggregation to Python, WebSocket fan-out with per-client subscription filtering, JWT validation (not issuance — see below), rate limiting, request correlation, metrics/health surfaces.
- **Node holds no source-of-truth state.** Its only in-memory state is *derived* (current WS subscriptions, per-client telemetry cache for diffing) and is fully reconstructable from Python + DB after a restart — this is what "stateless" means operationally, not "holds no memory at all."

### 7.3 Why Python owns persistence (ADR, expanded from Phase 5B's D1)

Restated with the general principle, not just the Phase 5B specifics: **the producer owns the store.** Every writer of fleet data — the session registry, the telemetry publisher, the arm/disarm detector, the command executor, the parameter sync manager — already lives in Python. Making Node the DB owner would require either (a) Node re-deriving write paths for data it doesn't produce (duplicated business logic, a boundary smell per the org standard), or (b) Python writing to Node over HTTP to reach its own database (a pointless network hop and a second source of truth during any partial failure). Boot-time registry rehydration (§8.8) is natural when the process that owns `SessionRegistry` is the same process reading the table it rehydrates from — Node rehydrating and then "re-teaching" Python the fleet over REST would be two sources of truth colliding at every restart.

### 7.4 Why Node is stateless

Node's job — browser-facing REST/WS, auth token validation, rate limiting — is the textbook shape for horizontal, stateless scale-out (standard default: cloud-native, stateless compute). Keeping Node state-free means:
- **N Node instances behind a load balancer** serve any client, with WebSocket subscriptions re-established on reconnect (client-driven, not server-affinitized) — no sticky sessions required.
- **A Node crash loses nothing** — Phase 5A's graceful-shutdown + supervised-reconnect work already assumes this (SIGTERM drains WS, restarts reconnect ZMQ from scratch, nothing to recover).
- Node scaling to meet dashboard/API load is decoupled from Python scaling to meet drone-count load (§14) — the two tiers scale on different axes and must not be coupled by shared mutable state.

### 7.5 Repository Layer

Exists **only** in Python (§8.7 diagram), post-5B. It is the sole code that imports the DB driver (SQLAlchemy Core + Alembic) — every other Python module (session registry, telemetry publisher, command manager) calls typed repository methods and receives plain dataclasses/dicts, exactly as they exchange data today. This is what makes the SQLite/PostgreSQL dialect split (§8.6) invisible to domain code, and what lets the repository layer be the single place that knows about telemetry partitioning strategy.

### 7.6 Service Layer

Domain services (`DroneSession`, `MissionManager`, `CommandManager`, the future `AlertService`) contain business logic and call the Repository Layer; they never construct SQL, never know the dialect, never touch object-storage drivers directly (they call the Storage service's interface, §8.9).

### 7.7 API Layer

FastAPI (Python, internal fleet API + legacy single-drone routes) and Express (Node, public-facing `/api/v1/*`). The API Layer's only job is request/response marshalling, auth enforcement, and routing to the Service Layer — no business logic lives here (standard: "HTTP handlers contain no business logic").

### 7.8 Event Layer

The Node `eventBus.js` (currently unused infrastructure) becomes the platform's internal pub/sub seam: Alert Service publishes `alert.fired`/`alert.cleared`; Notification Service and the Plugin Framework subscribe. This is intentionally **not** a distributed message broker (Kafka/MQTT) at this layer — that's the Edge Agent's future ingestion concern (§5, §19) — it is in-process pub/sub inside the already-stateless Node tier, scoped to browser-facing event fan-out.

---

## 8. Database Architecture

**Status: fully designed and approved (Phase 5B, D1–D6), zero code implemented.** This section is a structural summary; `FLEET_PHASE5B_DATABASE_ARCHITECTURE.md` remains the authoritative DDL-level reference — read it before writing migration code.

### 8.1 ER Diagram

```
organizations ──1:N──► users
      │                   │
      │ 1:N               │ (created_by / operator FK, nullable)
      ▼                   │
   drones <───────────────┤
      │  │                │
      │  │ 1:1            ▼
      │  └──► drone_credentials
      │
      │ 1:N        ┌──────────────────────────┐
      ├──► flights │ (arm→disarm session)     │
      │     │      └──────────────────────────┘
      │     │ 1:N
      │     ▼
      │  telemetry_history   (FK drone_id; flight_id nullable)
      │
      ├──► commands_audit    (FK drone_id, operator_id, flight_id nullable)
      │
      └──► alerts            (FK drone_id nullable, alert_rule_id)
                 ▲
   alert_rules ──┘ (org-scoped)

provisioning_tokens ──► (mints drones)      [supporting]
connection_allowlist  (org-scoped)          [supporting, closes F2]
recordings ──► flights / drones             [object-store metadata]
schema_migrations                            [Alembic version table]
```

### 8.2 Relationships (cardinality + delete behavior)

| Parent | Child | Card. | On delete |
|---|---|---|---|
| organizations | users, drones, alert_rules, connection_allowlist | 1:N | RESTRICT — never cascade an org away silently |
| drones | drone_credentials | 1:1 | CASCADE |
| drones | flights | 1:N | RESTRICT — flights are the regulatory record |
| flights | telemetry_history | 1:N | SET NULL on flight — telemetry keeps drone_id |
| drones | commands_audit | 1:N | RESTRICT |
| users | commands_audit (operator) | 1:N | SET NULL — audit survives user deletion |
| alert_rules | alerts | 1:N | SET NULL |

### 8.3 Core tables (see Phase 5B doc §4 for full DDL)

`organizations`, `users`, `drones` (replaces the RAM registry — F1 fix), `drone_credentials` (provisioning identity), `flights` (synthesized arm→disarm sessions), `telemetry_history` (downsample, highest volume), `commands_audit` (first audit trail — captures operator identity RAM never did), `alert_rules` / `alerts`, `provisioning_tokens`, `connection_allowlist` (closes the F2 SSRF-class dial-out gap), `recordings` (object-store metadata), `schema_migrations` (Alembic).

**Approved 5B additions (Phase 5B doc §4A, ADR-008):** `connection_profiles` (per-drone multi-transport — UDP/TCP/Serial/LTE/WireGuard/Companion/SITL; `drones.connection_string` becomes a cached mirror of the active profile), `drone_capabilities` (installed hardware/features — RGB/thermal camera, RTK, payload, AI, spotlight, loudspeaker, dock-compat as open-vocabulary data rows), `mission_templates`/`mission_instances`/`mission_runs` (reusable definition vs. bound instance vs. execution history — distinct from `flights`, the regulatory arm→disarm record), `org_settings` (per-org `telemetry_persist_hz` **and** per-org retention windows for telemetry/alerts/commands/recordings/logs — dethroning the hardcoded 1 Hz and the global retention constants), and `organization_feature_flags` (product tiers/entitlements as rows, so new tiers need zero migration).

### 8.4 Telemetry storage

10 Hz live telemetry stays on the wire (ZMQ→WS) unchanged; only a **downsample** is persisted (D3) — at a **per-organization configurable rate** (`org_settings.telemetry_persist_hz`, default 1 Hz via `TELEMETRY_PERSIST_HZ`; Phase 5B doc §4A.4), written by a dedicated async writer with a bounded queue that never blocks the real-time publish loop — if the queue saturates, it drop-oldest and counts the drop in `/metrics` (same backpressure philosophy as the Node WS slow-client cap, Phase 5A). Hot numeric fields (position, battery, mode, GPS fix) are promoted to indexed columns; the long tail (EKF variances, sensor bitmasks) rides in a JSON column, queryable but not indexed.

### 8.5 Partitioning

The only genuinely dialect-divergent area, because `telemetry_history` is the only unbounded-growth table (≈4.3M rows/day at the 50-drone D5 design target):
- **PostgreSQL:** native declarative range partitioning by `recorded_at`, one partition per day; a daily job pre-creates tomorrow's partition and drops expired ones — O(1) metadata operation, no row-by-row delete, no vacuum storm.
- **SQLite:** no partitioning primitive; retention is enforced via bounded batched `DELETE` (skipping rows under `retention_hold`), with monthly DB-file rolling offered as an opt-in config for very long-lived offline deployments.
- Both strategies live entirely behind `telemetry_repo.write_batch()` / `query_track()` — callers never branch on dialect.

### 8.6 Indexes

| Table | Index | Serves |
|---|---|---|
| drones | `(org_id)`, `(org_id, archived_at)` | fleet list, rehydration scan |
| flights | `(drone_id, armed_at DESC)`, `(org_id, armed_at DESC)`, partial `WHERE disarmed_at IS NULL` | flight history, in-flight lookup |
| telemetry_history | `(drone_id, recorded_at DESC)`, `(flight_id, recorded_at)` | track playback, per-flight path |
| commands_audit | `(drone_id, issued_at DESC)`, `(operator_id, issued_at DESC)` | audit queries |
| alerts | `(org_id, triggered_at DESC)`, partial `WHERE cleared_at IS NULL` | active-alert board |

### 8.7 Repository pattern

```
routes / registry / telemetry_pub / command_manager
        │  (call typed repo methods — no SQL)
        ▼
  repositories/   drones_repo · flights_repo · telemetry_repo (only file that knows
                  partitioning) · commands_repo · alerts_repo · allowlist_repo · objectstore.py
        ▼
  SQLAlchemy Core + Alembic  →  SQLite | PostgreSQL
```

### 8.8 SQLite / PostgreSQL

**SQLite is the default** (single-node/edge/offline/dev, zero-ops, file-backed); **PostgreSQL is opt-in** via `DATABASE_URL` for multi-node/high-volume/regulatory-retention deployments. A single schema and one Alembic migration set targets both; the ~5 genuine dialect divergences (JSON column type, boolean representation, autoincrement PK syntax, partitioning, WAL vs. MVCC concurrency) are isolated behind the driver/repository layer — application code never branches on dialect. Boot-time rehydration (`SessionRegistry.load_from_db()`) is identical regardless of which dialect is active; this is the exit criterion for F1: **restart loses zero registered drones.**

### 8.9 Retention

Defaults (env-overridable, enforced by an hourly `RetentionManager`): `telemetry_history` 90 days rolling; `commands_audit` 1 year; `flights` indefinite (the small regulatory artifact); `alerts` 1 year, `alert_rules` indefinite; `recordings`/exported logs env-configurable. Each window is **per-organization overridable** (`org_settings.retention_{telemetry,alerts,commands,recordings,logs}_days`; Phase 5B doc §4A.4) — the env default is the fallback when an org sets no override. A `retention_hold` flag on `flights` exempts a specific incident's data from pruning without disabling the global policy — satisfies "keep this incident" without a special-case code path.

### 8.10 Object storage

Large blobs (telemetry recordings, video segments, exported logs) never live in the relational DB — the DB stores only a pointer row (`backend`, `uri`, `size_bytes`, `checksum`). Default backend is local filesystem (matches today's `recordings/` layout exactly — zero migration for existing data beyond a metadata backfill); S3/MinIO is a driver swap behind `OBJECT_STORE_URL`, never a code change in callers.

### 8.11 What closes F1 and F2

- **F1 (RAM-only registry, drones vanish on restart):** the `drones` table becomes the source of truth; `SessionRegistry` becomes a rehydrated cache populated at boot.
- **F2 (unvalidated `connection_string` → SSRF-class dial-out):** every registration/SITL connection string is matched against the org-scoped `connection_allowlist` table **before** it reaches `mavutil.mavlink_connection()`.

---

## 9. Event-Driven Architecture

**Status: designed here.** The event bus infrastructure exists (`eventBus.js`) but has zero subscribers today — this section defines what it becomes.

### 9.1 Events vs. Commands

- **Events** are facts that already happened, published for any number of interested subscribers to react to asynchronously: `telemetry.tick`, `flight.started`, `flight.ended`, `alert.fired`, `alert.cleared`, `drone.connected`, `drone.disconnected`, `command.completed`.
- **Commands** are directed requests expecting a specific outcome from a specific target (a drone), synchronous from the caller's point of view even though they traverse MAVLink's ACK machine underneath: arm, disarm, RTL, mode change, mission upload. Commands are not events — they are the *cause* of events (`command.completed` is the event a command execution emits once resolved).

This distinction matters operationally: events are fan-out (0..N subscribers, none of which can block the publisher), commands are point-to-point with a required response — conflating them would either make commands unreliable (best-effort fan-out) or make events a bottleneck (waiting for N ack's before the publisher continues).

### 9.2 Queues, subscriptions, retries, acknowledgements

| Concern | Design |
|---|---|
| **Queues** | In-process pub/sub inside the stateless Node tier (§7.8) for browser-facing fan-out (WS subscription filtering already ships this way, Phase 4). A durable queue (for command offline-queueing, §6 Command Service) lives in Python behind the Repository Layer — a `commands_audit` row with `result IS NULL` **is** the pending-command queue; no separate queue table needed until proven insufficient (persona rule: simplicity, don't add infrastructure ahead of measured need). |
| **Subscriptions** | WS clients subscribe per-drone (`{op:"subscribe", drones:[...]}`, shipped Phase 4); internal event-bus subscribers (Alert Service, Notification Service, future plugins) subscribe per-event-type at process start, not dynamically. |
| **Retries** | MAVLink command retries are already implemented per-(sysid,compid) with bounded counts (`command_manager.py`); telemetry ZMQ send retries with bounded backoff (Phase 5A, `_send_zmq`). The pattern generalizes: every retry is bounded, counted in `/metrics`, and never blocks the real-time telemetry loop. |
| **Acknowledgements** | MAVLink's own `COMMAND_ACK`/`MISSION_ACK` messages are the ground-truth ack for drone-facing operations — the platform does not invent a parallel ack protocol. Internal events (alert fired → notification dispatched) use at-least-once delivery with idempotent handlers (a notification provider dedupes on `alert_id`, not on delivery count). |
| **Failure recovery** | A slow or crashed event-bus subscriber must never back-pressure the telemetry publish loop (the one hard real-time path in the system) — subscribers are fire-and-forget from the publisher's perspective, mirroring the Phase 5A rule that a bad telemetry tick is counted and survived, never allowed to kill the loop. |

### 9.3 Event flow (concrete example — battery alert)

```
Telemetry Service (1 Hz sample) → Repository (telemetry_history row written)
        │
        ▼
Alert Service (rule evaluator, subscribes to telemetry.tick)
   │  batt_remaining < threshold (alert_rules row) ?
   ▼ yes
alerts row inserted (triggered_at, severity)  ──emit──► event bus: "alert.fired"
        │
        ├──► Notification Service (webhook/email/SMS driver dispatch)
        └──► Node WS broadcast (dashboard Alerts panel updates live, §12)
```

---

## 10. Video Architecture

**Status: ingest pipeline and WebRTC/raw-WS egress exist today (single-stream, process-singleton); multi-stream registry, TURN, and adaptive distribution are designed, not built (Phase 6, deferred per the Phase 5 review — video ships after persistence + auth).**

### 10.1 Pipeline

```
Camera (RGB or Thermal)
   │  RTSP / RTP (H.264/H.265) / TCP-MPEGTS / UDP-MPEGTS
   ▼
Encoder (on-camera or companion-computer transcode — outside Fleet Core's control)
   │
   ▼
GstVideoReceiver  (one GStreamer pipeline: source_bin → tee)
   ├─► webrtc_sender.py   — per-viewer webrtcbin, STUN only today, no transcode
   ├─► raw_ws_sender.py   — appsink → [u64 pts][NAL] framing → browser WebCodecs
   └─► recorder.py        — keyframe-gated valve → mp4/mkv mux → object storage (§8.9)
   │
   ▼
Video Service  (today: VideoManager process singleton — ONE active stream/process)
   │  Target: VideoRegistry: Dict[(drone_id, stream_id) → GstVideoReceiver]
   ▼
Fleet Core (video control REST, `/api/video/*`, proxied through Node unchanged)
   │
   ▼
Dashboard  (Video Wall, §12 — multi-drone grid; today: single `<video>`/`<canvas>` per GCS page)
```

### 10.2 RGB / Thermal

Both are just two entries in the target `VideoRegistry` keyed by `(drone_id, stream_id)` — the receiver/tee/webrtc/raw/recorder pipeline is reused **verbatim** per stream (Phase 2 design, unchanged here). No dual-stream-specific code is needed; it is a consequence of the registry keying, not a special case.

### 10.3 Recording / Snapshots

Recording already exists (`recorder.py`, keyframe-gated valve into mp4/mkv, with an `.ass` subtitle sidecar for OSD overlay). Under this architecture, recordings become `recordings` table rows (§8.9/§8.10) linking to `flight_id`/`drone_id`, stored via the Object Storage abstraction rather than bare files — same bytes, now indexed and queryable. Snapshots (single-frame capture) are a small additive feature on the same `appsink` tap already used for the raw WS path.

### 10.4 Adaptive bitrate / low latency

WebRTC's native congestion control already provides basic adaptive behavior; the target state adds explicit **per-stream `max-bitrate` caps** so a dashboard operator viewing 20 drones simultaneously (Video Wall, §12) does not let one high-motion thermal stream starve the others' bandwidth share. Low latency is WebRTC's default behavior (sub-500ms typical) and is preserved as the primary transport; the raw-WS/WebCodecs path exists as the documented fallback for browsers/networks where WebRTC negotiation fails.

### 10.5 Bandwidth management

The most consequential unresolved gap, called out explicitly in the Phase 5 review (F8): **no TURN server** — WebRTC connections fail for viewers behind symmetric NAT or across WAN boundaries, and there is no ingest/distribution separation, so viewer count multiplies load exactly at the drone-link termination point (the worst place for it to multiply). Target design:
- **TURN relay** added to the STUN-only config for WAN viewers (deployment concern — a coturn instance in the compose/K8s manifests, §15).
- **Lazy pipeline lifecycle**: a stream's GStreamer pipeline starts on first viewer, stops after the last viewer disconnects (plus a grace period) — avoids paying encode/decode cost for unwatched drones, directly bounding the ingest-host CPU ceiling.
- **Ingest/distribution separation** (the FlightHub/FlytBase pattern cited in the Phase 5 review): keep GStreamer-per-stream as the **ingest** point (unchanged, works, self-hosted-friendly for offline deployments) but make **distribution** pluggable — a managed WebRTC SFU (LiveKit/mediasoup) is the documented scale path for large viewer counts, without forcing every deployment (especially offline/on-prem) onto a managed dependency they can't reach.

---

## 11. Telemetry Architecture

**Status: existing, code-verified, benchmarked (622 frames/sec at 10 drones × 10 Hz).**

### 11.1 Complete flow

```
Flight Controller
   │  MAVLink stream (HEARTBEAT, ATTITUDE, GLOBAL_POSITION_INT, VFR_HUD, GPS_RAW_INT,
   │  SYS_STATUS, EKF_STATUS_REPORT, VIBRATION, STATUSTEXT, …)
   ▼
Python — LinkManager.read_loop()  (per-DroneSession, non-blocking asyncio)
   │  handle_message() → VehicleState dataclass, per-sysid, within the owning session
   ▼
Python — TelemetryPublisher.publish_loop()  (10 Hz tick, per-session, isolated failure)
   │  full-snapshot JSON, drone_id-tagged (additive field — legacy single-drone frames
   │  unaffected), tick recorded into health + Prometheus metrics (Phase 5A)
   ▼
ZMQ PUB  tcp://<host>:5556
   │
   ▼
Node — ZmqTelemetrySubscriber  (supervised: reconnect w/ exponential backoff + jitter,
   │  forever, on any error or clean stream end — Phase 5A fix for the F3 SPOF)
   ▼
Node — telemetryEngine.processZmqFrameString()
   │  additive enrichment: schema_version, stale detection (2500/4000ms thresholds),
   │  rad→deg normalization, EKF health score, engine_envelope{kind, vehicle_id, is_replay}
   ▼
Node — vehicleStateManager  (per-drone keying: `droneId:sysid`; default drone keeps bare
   │  sysid keys for legacy wire compatibility; disconnect wipes only that drone's vehicles —
   │  Phase 4 fix for the N3 SPOF)
   ▼
Node — broadcaster  (per-client subscription filter + send-queue cap: soft cap sheds the
   │  frame since the next snapshot supersedes it, hard cap disconnects a SLOW_CONSUMER —
   │  Phase 5A fix, prevents one slow client OOM-ing the process)
   ▼
WebSocket  →  Browser
   │
   ▼
Frontend — telemetryWebSocketBridge.js → telemetrySyncReducer.js (pure reducer)
   │
   ▼
Zustand useTelemetryStore, keyed by vehicle_id  →  selectors  →  AdvancedHUD / MapView /
   TelemetryGrid / Mission Control / Drone Details (§12)
```

### 11.2 Persisted branch (Phase 5B, designed not built)

In parallel with the 10 Hz wire path, a 1 Hz sample is enqueued to a bounded async queue and drained by `telemetry_repo.write_batch()` into `telemetry_history` (§8.4) — this branch **never** shares a code path with the real-time publish loop; a full queue drops the oldest sample and counts it, it never blocks or slows telemetry delivery to live viewers.

### 11.3 Known scale ceiling (F5, unresolved until Phase 5D)

The full-snapshot JSON round-trip (`JSON.parse` → deep clone via `JSON.parse(JSON.stringify(data))` → enrichment → `JSON.stringify` → per-client `ws.send`) is measured to saturate a single Node core at roughly 2,000–5,000 frames/sec — approximately 200–500 drones at 10 Hz, before accounting for viewer fan-out multiplication (a 50-drone dashboard × 20 operators = 10k msg/s egress from one process). §14 details the scaling strategy (delta frames, per-client rate adaptation, removing the JSON clone) that resolves this without a rewrite.

---

## 12. Fleet Dashboard Architecture (design only — no UI implementation)

**Status: designed here.** Today's frontend is the single-drone GCS; fleet awareness exists only via `GET /fleet` (no dedicated UI). This section defines the module map a future Phase 7 implements against.

| Module | Purpose | Data source | Relationship to existing GCS pages |
|---|---|---|---|
| **Fleet Overview** | At-a-glance counts: drones online/offline, active flights, open alerts, org summary | `GET /fleet`, `alerts` (active), `flights` (in-flight) | New — no analogue today |
| **Fleet Map** | All drones' live positions on one map, clustered/filterable by org/status | Telemetry (§11), aggregated client-side across subscribed drones | Reuses `MapView`'s existing secondary-vehicle rendering (already shows other vehicles as passive markers) — promotes it from a side feature to the primary view |
| **Fleet Health** | Per-drone health score (link quality, battery trend, EKF status, last-maintenance) rolled up fleet-wide | `telemetry_history` rollups + a computed health-score service (Analytics, §6) | New |
| **Fleet Analytics** | Historical trend charts: flight hours, battery degradation, command volume, alert frequency, by drone/org/time range | `flights`, `telemetry_history`, `commands_audit`, `alerts` — read-side aggregation only | New |
| **Mission Control** | Cross-drone mission assignment/monitoring; launches into the existing per-drone Flight Planner scoped by `drone_id` | Mission Service (§6) | Wraps existing `FlightPlanner.jsx`, mounted per-drone under a fleet-aware shell |
| **Drone Details** | The existing single-drone GCS experience (HUD, map, planner, setup, params) — unchanged, mounted at `/drone/:droneId/*` | All existing per-drone APIs, scoped | **This is the existing GCS**, reused wholesale — the Phase 2 principle "every existing page is reused, scoped by drone_id" |
| **Video Wall** | Grid of live video tiles across multiple drones simultaneously | Video Service (§10), VideoRegistry | New — depends on the multi-stream VideoRegistry landing first |
| **Alerts** | Active + historical alert list/board, filterable, with clear/acknowledge actions | `alerts`, `alert_rules` | New |
| **Maintenance** | Per-drone maintenance log/schedule (out of MVP DB scope today — `drones` table has no maintenance fields yet; would extend the schema additively) | New table (future) | New |
| **Settings** | Org management, user/role management, alert rule configuration, connection allow-list management, API key/provisioning-token management | `organizations`, `users`, `alert_rules`, `connection_allowlist`, `provisioning_tokens` (§8, §13) | New |

**Design constraint carried from Phase 2, restated:** every fleet-level module is **read-side aggregation** over existing per-drone data — none of them introduces a new write path that bypasses the per-drone services in §6. This keeps the dashboard from becoming a second source of truth.

---

## 13. Security Architecture

**Status: currently zero (F2, verified — no auth, no CORS policy, wide-open forwarder, unvalidated connection strings). This entire section is designed here and is the platform's highest-priority gap** — per the Phase 5 review, "authentication cannot remain a late phase; every endpoint shipped before auth is rework."

### 13.1 Authentication

JWT-based, issued by the Node Fleet Gateway (never Python — Node is the browser-facing tier, §7.2) after credential verification against the `users` table (password hash checked in Python via the repository layer; Node calls an internal auth-check endpoint rather than reading the DB directly, preserving the "no cross-service DB reads" boundary rule).

### 13.2 Authorization / RBAC

Roles (from the Phase 2 design, unchanged): `super_admin`, `org_admin`, `operator`, `pilot`, `viewer`. Every fleet route checks role **and** org scope — a `pilot` in org A must never read or command a drone in org B regardless of role. RBAC is enforced at the API Layer (§7.7), never left to the frontend to hide-but-not-enforce.

### 13.3 Organizations

The multi-tenancy boundary (§8.1 `organizations` table). Every drone, user, alert rule, and connection-allowlist entry is org-scoped; cross-org data leakage is prevented by query-layer org filtering in the repository, not by trusting callers to pass the right `org_id`.

### 13.4 API keys

For machine-to-machine integration (External Integrations layer, §2) distinct from user JWTs — org-scoped, revocable, never given interactive-user privilege levels by default.

### 13.5 JWT / Refresh tokens

Short-lived access JWTs (per org standard default) + longer-lived refresh tokens, rotated on use, stored hashed. `AUTH_MODE=disabled` remains an explicit escape hatch for single-operator offline/field deployments (§1.3) — never the default, always an operator-opted-in config flag logged at startup.

### 13.6 Audit

Every command, from every route (legacy single-drone and fleet-scoped alike), writes a `commands_audit` row (§8.7) capturing operator identity, drone, parameters, and result — closing the gap where RAM-only command state "captures no operator identity."

### 13.7 Encryption

TLS on every external-facing hop (browser↔Node, Edge Agent↔Fleet Core, §5); MAVLink signing (already supported by `pymavlink`, not yet enabled) covers link-level authenticity where no VPN wraps the transport — relevant for RF-only defence/mining deployments (§1.4) with no VPN layer available.

### 13.8 Secrets

Never in code or config files committed to the repo; loaded from environment/vault at boot (org standard default: "config from environment variables from vault"), validated fail-fast alongside the existing Phase 5A config validation (`load_config`/`validateConfig` already exist — secrets validation extends that same pattern, not a new mechanism).

### 13.9 VPN

Deployment-layer (§4.2, §15) — WireGuard/ZeroTier/generic VPN wrap the transport for on-prem/offline/hybrid sites; the application layer is VPN-agnostic.

### 13.10 Connection allow-list

`connection_allowlist` table (§8.11) — every `connection_string` submitted at drone registration or SITL setup is validated against org-scoped allowed schemes/hosts/ports/device-globs **before** reaching `mavutil.mavlink_connection()`. This closes the verified SSRF-class finding (F2): today, an arbitrary host/port/serial-device string flows unvalidated into a live network dial.

### 13.11 Provisioning tokens

`provisioning_tokens` table (§8.3) — replaces client-supplied, trust-on-first-use `drone_id`s. A drone (or its Edge Agent) redeems a single-use, expiring, org-scoped token to mint its `drone_id` and `drone_credentials` row, mirroring how FlightHub/FlytBase bind devices via activation codes rather than accepting self-asserted identity.

---

## 14. Scalability

**Status: 10-drone figure is measured (benchmark doc); 50–10,000 figures are engineering projection based on the measured per-drone cost, not independently benchmarked.**

### 14.1 Measured baseline (10 drones, 10 Hz, one host)

~622 telemetry frames/sec, ~12% CPU (Python, one core) + ~3.7% CPU (Node, one core), ~44MB/~75MB RSS, sub-3-second failure detection, zero cross-drone blast radius, `GET /fleet` at ~2ms. Headroom on the benchmark machine (Apple M2 Pro, 12 cores) was roughly 85% of one core across both tiers combined.

### 14.2 Projected scale table

| Drones | Expected outcome | First bottleneck |
|---|---|---|
| **10** | Measured, verified — comfortable headroom | None observed |
| **50** | Works; Python per-session 100Hz poll-loop overhead becomes visible in metrics (Phase 5A gives visibility that didn't exist before) | Python poll-loop CPU, still well within one core |
| **100** | Still single-process viable; this is the Phase 5B D5 design target (≤50 drones/5 orgs assumed for schema sizing — 100 is within the same order of magnitude, no schema change needed) | Telemetry write-queue depth (1 Hz persistence) becomes worth watching |
| **250** | Node's full-snapshot JSON pipeline (parse → deep-clone → enrich → stringify → per-client send) approaches saturation of a single core — this is the F5 finding's stated range (200–500 drones) | **Node CPU — the JSON codec path**, not network, not Python |
| **500** | Requires Phase 5D's telemetry scale pass (delta/keyframe framing, removal of the `JSON.parse(JSON.stringify())` clone, per-client rate limiting) to avoid unbounded latency growth under slow-consumer backpressure | Node CPU (same bottleneck, now definitely exceeded without 5D) |
| **1,000** | Requires the drone-to-worker ownership model (§14.3) — a single Python process's asyncio event loop, while I/O-bound and cheap per session, becomes the practical ceiling for one host's connection count and video pipeline count | Python process connection/session ceiling (not CPU-bound — I/O-bound sessions are cheap; the ceiling is operational: video pipelines, OS file descriptors, one host's NIC) |
| **5,000** | Requires horizontal Python worker scale-out (multiple Python processes, each owning a shard of drones, DB-recorded ownership) **and** Node horizontal scale-out behind a load balancer (stateless, so this is a config change, not a redesign) | Coordination: which worker owns which drone (an ownership-table lookup problem, explicitly *not* a distributed-systems problem per the Phase 5 review) |
| **10,000** | Same architecture as 5,000, more shards; at this scale PostgreSQL (not SQLite) is mandatory (§8.6, D2) and telemetry partitioning (§8.5) is load-bearing, not optional; video distribution (§10.5) requires the SFU escape hatch, not per-stream WebRTC from the ingest host | Database write throughput (telemetry_history inserts) and video distribution fan-out — both explicitly designed for, per §8 and §10.5 |

### 14.3 Scaling strategy (explicit, from the Phase 5 review, adopted unchanged here)

**Vertical per worker → horizontal by drone-to-worker assignment.** Each drone is owned by exactly one Python worker process; the DB records that ownership (`drones` table gains a `worker_id`/heartbeat concept at the scale where this matters); Node routes REST calls to the owning worker via a DB lookup, not via clustering middleware. This is explicitly **an ownership-table problem, not a distributed-systems problem** — no consensus protocol, no service mesh, no premature Kafka/MQTT broker. The transport is abstracted now (Repository Layer, ZMQ pub/sub interface) precisely so that a broker can be introduced later as an ingestion-adapter change, not a rewrite, if and when the Edge Agent phase (§5, §18 Phase 10/11) proves the need. This is a direct application of the persona rule "don't design for scale that doesn't exist" and the standard's "swap requires an ADR" — Kafka/MQTT is deferred until 1,000+ drones or the Edge Agent phase actually requires it, not adopted speculatively at Phase 5B.

---

## 15. Deployment Architecture

**Status: designed here.** No Dockerfiles/compose/K8s manifests exist in the repo today — this section is the target, sequenced into the roadmap as Phase 10 (§18).

| Target | Composition | Primary use |
|---|---|---|
| **Local** | Three processes started directly (`python main.py`, `node server.js`, `npm run dev`) — exactly today's dev workflow, unchanged | Development, SITL testing (as used for the 10-drone benchmark) |
| **Docker** | `Dockerfile.python`, `Dockerfile.node`, `Dockerfile.frontend` (nginx-served static build) — one image per tier, matching the existing process boundary exactly (no new service split introduced by containerization) | Single-host deployment without orchestration |
| **Docker Compose** | `docker-compose.yml` (cloud/on-prem default, PostgreSQL), `docker-compose.offline.yml` (SQLite, no external DB container, `AUTH_MODE` configurable), `docker-compose.wireguard.yml` profile (adds a WireGuard sidecar for field/on-prem VPN termination) | Small-to-medium on-prem, offline, or hybrid-edge-site deployments |
| **Kubernetes** | Helm chart: Python and Node as separate Deployments (each independently horizontally scalable per §14.3), PostgreSQL as a managed/StatefulSet dependency, health/readiness probes wired to the existing `/healthz`/`/readyz` endpoints (Phase 5A, already shipped — K8s can supervise *because* these exist now) | Cloud multi-tenant scale, large on-prem enterprise/defence sites requiring HA |
| **Cloud** | K8s (managed) + managed PostgreSQL + managed object storage (S3) + managed TURN/SFU for video distribution at scale (§10.5) | Enterprise SaaS posture |
| **On-prem** | Docker Compose or K8s, customer-hosted, PostgreSQL or SQLite depending on scale (§14), no external network dependency required at runtime | Defence, utilities, mining, oil & gas (§1.4) |
| **Offline** | Single Docker Compose stack, SQLite, `AUTH_MODE=disabled` or local-only JWT, zero external network calls at runtime (no CDN dependencies, no external STUN/TURN — a local coturn instance if video is needed) | Field kits, disaster response, remote agriculture |
| **Hybrid** | Offline/on-prem edge stacks + an explicit, auditable batch sync job to a cloud aggregation tier (never live DB replication of the transactional path — §1.3) | Multi-site operators needing fleet-wide roll-up analytics without per-site connectivity guarantees |
| **Edge** | The Drone Edge Agent (§5) as a lightweight companion-computer process/container, independent of the Fleet Core deployment target it reports to | Cellular-constrained or intermittently-connected drones, any deployment target above |

---

## 16. Observability

**Status: shipped in full for both backend tiers (Phase 5A) at the process/service level; SLO definitions, dashboards-as-code, and distributed tracing are designed here as the next increment.**

### 16.1 Metrics (shipped)

Both tiers expose Prometheus-format `/metrics`. Node: default process metrics + `http_requests_total`, `http_request_duration_seconds`, `ws_clients`, `ws_messages_sent_total`, `ws_send_dropped_total`, `ws_clients_disconnected_total`, `zmq_frames_received_total`, `zmq_reconnects_total`, `zmq_connected`, `zmq_last_frame_age_seconds`, `telemetry_frames_processed_total{drone_id}`, `drone_last_seen_age_seconds{drone_id}`. Python: `http_requests_total`, `http_request_duration_seconds`, `telemetry_frames_published_total{drone_id,type}`, `telemetry_publish_errors_total`, `telemetry_tick_duration_seconds`, `telemetry_ticks_total`, `telemetry_tick_failures_total`, `fleet_drones`, `fleet_drones_online`, `drone_last_seen_age_seconds{drone_id}`, `zmq_publisher_up`. **Known gap** (noted in the benchmark doc): Python's dedicated `CollectorRegistry` omits the default process collector, so `process_cpu_seconds_total`/`process_resident_memory_bytes` are absent on that tier — a Phase 5B-adjacent fix, not a redesign.

### 16.2 Prometheus / Grafana

Prometheus scrapes both `/metrics` endpoints today (verified manually in the benchmark run); formal scrape-config and **Grafana dashboards-as-code** (versioned JSON, per the observability standard) are not yet committed to the repo — this is the near-term gap, not a missing capability (the metrics to build them from already exist).

### 16.3 Tracing

**Not implemented.** OpenTelemetry end-to-end tracing (per the org standard: every inbound request creates/continues a trace, every outbound dependency call is a span, `trace_id` in every log line) is designed but not built. Correlation IDs (`request_id`) already propagate through both tiers via `AsyncLocalStorage` (Node) and `contextvars` (Python) — this is the exact mechanism traces need to hang off of; adding OTel spans at the same propagation points is additive work, not new plumbing.

### 16.4 Logs (shipped)

Structured single-line JSON on both tiers, with `request_id`/`drone_id` correlation fields, panic recovery (uncaught exceptions produce a clean JSON log + safe response, never a leaked stack trace to the client).

### 16.5 Health / Startup / Readiness / Liveness (shipped)

Both tiers expose `/healthz` (liveness: process is not shutting down) and `/readyz` (readiness: gated on ZMQ-connected + telemetry freshness for Node, publisher health for Python, with a cold-start grace window so readiness doesn't flap before the first publish). This is precisely what makes the Kubernetes target in §15 viable — K8s can only supervise a process it can ask "are you ready" and get a truthful answer.

### 16.6 SLOs (not yet defined — required before dashboards, per the observability standard)

Not yet written down. Per the standard ("every user-facing service defines SLOs before dashboards"), before Phase 7 (dashboard) ships, define: telemetry end-to-end latency (p99 target, informed by the Phase 5D exit criterion of <500ms at 200 simulated drones), API availability (success rate of valid requests), and command-completion latency. Error-budget burn-rate alerting (2%/5%/10% monthly) follows once SLOs are agreed — an open item, not a design decision this document makes unilaterally.

---

## 17. Disaster Recovery

**Status: designed here, partially validated.** Phase 5A's live verification (kill -9 with no publisher running; bad config; SIGTERM) already proves several of these; the rest are architectural commitments pending Phase 5B+ implementation.

| Failure | Today | Required / designed behavior |
|---|---|---|
| **Python crash** | All links + video + fleet API for that process instance are gone; registry is RAM so every non-default drone is lost on restart (F1) | Supervised restart (K8s/compose restart policy, §15); on boot, `SessionRegistry.load_from_db()` rehydrates every non-archived drone from the `drones` table (§8.8) and reconnects those with `auto_connect=1`. **Exit criterion: restart loses zero registered drones.** |
| **Node crash** | Verified today: process restart loses nothing of value — Node holds no source-of-truth state; WS clients reconnect and re-subscribe | Unchanged — this is already correct by design (§7.4) |
| **Drone disconnect** | Verified isolated: one drone's link flapping has zero impact on other drones (per-session backoff, per-drone state wipe) | Unchanged, already correct; Edge Agent (§5) additionally buffers/store-and-forwards for the drone side of an intermittent link |
| **Video loss** | GStreamer pipeline watchdog exists per receiver (auto-restart) | Add per-stream health metric + bounded auto-restart budget (so a permanently-broken camera doesn't retry-storm); lazy pipeline lifecycle (§10.5) bounds the blast radius to viewers of that one stream |
| **Database failure** | N/A today (no DB exists) | Live telemetry and commands are explicitly designed to **keep working with the DB down** — the DB is never on the hot path (§9, §11.2: persistence is a side-branch, not inline in the publish loop); only registry mutations and history writes buffer and fail loud (metrics-visible), never silently drop without a count |
| **Network failure** (general) | Per-session reconnect with exponential backoff + jitter, both for drone links (Python) and the Python↔Node ZMQ bridge (Node, Phase 5A fix for F3) | Unchanged, already correct; Edge Agent extends the same posture to the drone-to-Fleet-Core hop over cellular |
| **VPN failure** | N/A (VPN not yet wired into any deployment profile) | Same reconnect-with-backoff posture applies transparently — MAVLink/HTTP traffic over a VPN interface is just traffic; a VPN drop looks identical to any other network failure to the application layer, which is the intended benefit of keeping VPN a deployment concern (§4.2, §13.9) |
| **Power failure** (edge/companion computer) | N/A (no Edge Agent yet) | Edge Agent's local cache (§5) ensures the last-known mission/parameter state survives a power cycle without re-fetching from Fleet Core; store-and-forward buffer on disk (not just RAM) ensures queued telemetry/commands survive a power loss mid-buffer |

**Recovery strategy, stated once, generally:** every failure mode above is designed to (a) be detected within seconds via the existing health/metrics surface (§16), (b) recover automatically without a human paging in, and (c) never let one failure's blast radius exceed its own component — a philosophy already proven at the drone-session level (verified: kill drone 5, other 9 stay online) and extended by this document to every other tier.

---

## 18. Future Roadmap

```
Phase 5A — Stabilization                         [DONE — health/metrics/logging, ZMQ reconnect fix]
        │
        ▼
Phase 5B — Persistence (this doc's §8)            [DESIGNED, approved — DB schema, repo layer, no code]
        │
        ▼
Phase 5C — Identity & Security (this doc's §13)   [DESIGNED — JWT/RBAC/orgs/audit/allow-list]
        │
        ▼
Phase 5D — Performance (this doc's §14)           [DESIGNED — delta telemetry, per-client rate limits,
        │                                            poll-loop → add_reader, remove JSON clone]
        ▼
Phase 5E — Integration Testing                    [NEW — multi-phase regression harness: N-SITL fleet +
        │                                            auth + DB + telemetry-scale test, formalizing the
        │                                            "legacy single-drone regression run" already used
        │                                            informally after every phase]
        ▼
Phase 6 — Video (this doc's §10)                  [DESIGNED — VideoRegistry, TURN, lazy lifecycle]
        │
        ▼
Phase 7 — Dashboard (this doc's §12)              [DESIGNED — Fleet Overview/Map/Health/Analytics/
        │                                            Video Wall/Alerts/Maintenance/Settings]
        ▼
Phase 8 — Analytics                                [Fleet-wide health scoring, trend analysis — builds
        │                                            on §8's telemetry_history/flights read models]
        ▼
Phase 9 — Deployment (this doc's §15)             [Dockerfiles, compose profiles, K8s/Helm, Grafana
        │                                            dashboards-as-code, CI]
        ▼
Phase 10 — Edge Agent (this doc's §5)             [Companion-computer agent: MAVLink/video relay,
                                                     store-and-forward, OTA, diagnostics]
        │
        ▼
Phase 11 — Broker ingestion (strategic, new)      [MQTT ingestion path beside ZMQ, introduced only
                                                     once Edge Agent + 5,000+ drone scale (§14) prove
                                                     the need — explicitly deferred, not speculative]
```

Each phase remains independently shippable and backward-compatible with the single-drone GCS workflow, per the standing rule established in Phase 2 and re-affirmed by the Phase 5 review: legacy unscoped routes and the auto-created "default" session/drone continue to work unchanged through every phase above.

---

## 19. Architecture Decision Records

### ADR-001: Fleet platform evolves via durable-registry + security-first re-sequencing

- **Status:** Accepted (carried forward from `FLEET_PHASE5_PRODUCTION_ARCHITECTURE_REVIEW.md`, restated here as standing platform policy)
- **Context:** Phases 3–4 delivered in-memory multi-drone sessions with full backward compatibility. Review found durable identity, security, and fault-tolerance gaps that every subsequent feature depends on.
- **Decision:** (1) The database becomes the source of truth for drones/orgs/users/flights; runtime sessions are caches rehydrated at boot. (2) AuthN/RBAC/audit land before any new feature surface; new APIs ship under `/api/v1`. (3) Telemetry transport stays ZMQ behind an interface; brokers are deferred to the Edge Agent phase. (4) Scale-out model is drone-to-worker ownership recorded in the DB, not clustering. (5) Video ingest stays GStreamer-per-stream; distribution is pluggable.
- **Consequences:** ~2 phases of foundation work before visible features; every later phase gets identity, persistence, and authz for free; offline deployments stay single-box with `AUTH_MODE=disabled`; a future broker migration is an ingestion-adapter change, not a rewrite.

### ADR-002: Python owns persistence; Node stays stateless

- **Status:** Accepted (Phase 5B, D1 — overriding the earlier Phase 2 assumption of Knex/Node-owned DB)
- **Context:** Phase 2's original design assumed Node (Knex) would own the database. Phase 5B's detailed design found every writer of fleet data already lives in Python.
- **Decision:** SQLAlchemy Core + Alembic in Python is the only DB-aware code in the platform. Node has zero database dependencies.
- **Consequences:** No duplicated business logic across tiers; boot rehydration is a single-process concern; Node's statelessness (and therefore its horizontal scalability, §14.3) is preserved without compromise. Cost: this is a documented divergence from an earlier stated plan (§7's literal text) — flagged explicitly rather than silently changed, per the standard's "ADRs written after the fact" anti-pattern avoidance (this ADR was written *before* any Phase 5B code, at design-review time).

### ADR-003: Repository pattern isolates all SQL/dialect knowledge

- **Status:** Accepted (Phase 5B, §7/§8.7)
- **Context:** The platform must support both SQLite (offline/edge) and PostgreSQL (cloud/scale) from one schema and one migration set (§1.3, §8.8).
- **Decision:** Only the `repositories/` package imports the DB driver; every dialect divergence (JSON type, boolean representation, partitioning strategy) is isolated to a handful of named spots inside that package. Domain code calls typed methods and never constructs SQL.
- **Consequences:** Adding a new dialect-sensitive feature (e.g., a new partitioning strategy) touches one file, not every caller. Testing runs fast against SQLite in-memory; a marked Postgres suite exercises the dual-target claim without slowing default CI.

### ADR-004: SQLite default, PostgreSQL opt-in

- **Status:** Accepted (Phase 5B, D2)
- **Context:** §1.3's deployment models require offline/edge operation with zero external dependencies, and cloud/enterprise operation at scale with regulatory retention.
- **Decision:** `DATABASE_URL` absent → SQLite (zero-ops, file-backed, default). Present with a `postgresql+asyncpg://` scheme → PostgreSQL. No other code changes to switch.
- **Consequences:** Postgres-only was explicitly rejected (would break the offline/field requirement, §1.3); SQLite-only was never viable past ~100 drones (no partitioning primitive, §8.5, §14). Both are required, not a compromise between them.

### ADR-005: Object storage holds blobs; the database holds pointers only

- **Status:** Accepted (Phase 5B, D6)
- **Context:** Recordings, video segments, and exported logs are large and grow unbounded; putting them in the relational database would defeat both SQLite's practicality and PostgreSQL's query performance.
- **Decision:** A driver interface (`objectstore.py`) with `fs` (default, matches today's `recordings/` layout) and `s3`/MinIO (opt-in via `OBJECT_STORE_URL`) drivers. The database stores only `backend`, `uri`, `size_bytes`, `checksum`.
- **Consequences:** Zero data-movement migration for existing on-disk recordings (just a metadata backfill, §8.10); cloud deployments get durable, scalable blob storage without schema change.

### ADR-006: Plugin architecture via the event bus, never via direct data-layer access

- **Status:** Accepted (§6, §9 — extending the previously-unused `eventBus.js` into a formal seam)
- **Context:** Vertical-specific needs (§1.4: agriculture mission templates, defence air-gapping, inspection thermal workflows) and integrations (notification providers, future AI/analytics services) must be extensible without forking Fleet Core.
- **Decision:** Plugins subscribe to bus events (`alert.fired`, `flight.ended`, etc.) and call versioned public APIs; they are never granted direct database or MAVLink-session access.
- **Consequences:** A misbehaving or slow plugin cannot corrupt fleet state or block the real-time telemetry path (§9.2's failure-recovery rule); the boundary also keeps a future swarm-coordinator or AI service (§1.2, §6) architecturally incapable of accidentally taking write control of flight-critical paths.

### ADR-007: Edge Agent is an additive ingestion path, not a replacement

- **Status:** Accepted (§5)
- **Context:** Direct drone-to-Fleet-Core exposure (today's model) does not scale to cellular-constrained, intermittently-connected fleets (§1.4: agriculture, mining, oil & gas) and is the platform's largest strategic gap versus commercial benchmarks (F10).
- **Decision:** The Edge Agent terminates the drone's local link and re-presents it over one authenticated outbound connection; Fleet Core's `DroneSession`/connection-profile abstraction (§8.3) treats an agent-fronted drone identically to a directly-connected one.
- **Consequences:** Deployments without companion hardware (bench SITL, WiFi-range inspection) keep working exactly as today, unchanged; deployments that need it get a well-defined, independently-versioned component rather than a Fleet Core rewrite.

### ADR-008: Multi-transport, capability, mission-template, and per-org policy models added to the 5B schema

- **Status:** Accepted (Phase 5B doc §4A — six additive models locked before any 5B code)
- **Context:** The approved 5B schema modelled one connection string per drone, no hardware description, missions only as arm→disarm `flights`, and global (not per-tenant) persistence-rate/retention constants. Each would force a later migration redesign as the product grows into multi-transport field drones, capability-filtered dashboards, reusable survey missions, and tiered SaaS.
- **Decision:** Add six additive models: (1) `connection_profiles` (many transports per drone, one active; `drones.connection_string` becomes a cached mirror — `DroneSession` unchanged); (2) `drone_capabilities` (open-vocabulary hardware/feature rows); (3) `mission_templates`/`mission_instances`/`mission_runs` (definition vs. bound instance vs. execution history, distinct from `flights`); (4)+(5) `org_settings` (per-org `telemetry_persist_hz` and per-org retention windows, env default as fallback); (6) `organization_feature_flags` (tiers/entitlements as rows). All ship as schema + thin repos in 5B; execution/firing/enforcement logic lands with the phases that consume them.
- **Consequences:** New transports, capabilities, tiers, and per-tenant policies become **data rows, not migrations** (persona rule: reversibility; ethos: search-before-build — the seam is data, mirroring `parameter_metadata.py`). Cost: 6 more tables and their repos now, versus a guaranteed disruptive schema change later. The single-column `connection_string` is retained as a compatibility mirror so no existing reader breaks — zero breaking change, consistent with ADR-001's evolution-not-rewrite posture.

---

## 20. Final Architecture Diagram

```
╔══════════════════════════════════════════════════════════════════════════════════════════╗
║ DRONE LAYER                                                                                 ║
║  [FC: ArduPilot/PX4/INAV] ─MAVLink─  [Companion Computer] ─RTSP/RTP─ [Camera RGB+Thermal]  ║
║  [GPS/RTK]  [Payload]  [Sensors]  [Onboard Storage]                                        ║
╚═══════════════════════════════════════╤══════════════════════════════════════════════════╝
                                         │
╔═══════════════════════════════════════▼══════════════════════════════════════════════════╗
║ EDGE LAYER  (future — Phase 10)                                                            ║
║  Drone Edge Agent: MAVLink relay · Video relay · Reconnect/backoff · Buffer · Store-fwd    ║
║  Compression · Encryption(TLS) · Health/OTA/Diagnostics · Local cache · Mission cache      ║
║  (bypass path, today's reality: drone exposes MAVLink/video endpoints directly) ───────────╫──┐
╚═══════════════════════════════════════╤══════════════════════════════════════════════════╝  │
                                         │                                                       │
╔═══════════════════════════════════════▼══════════════════════════════════════════════════╗  │
║ COMMUNICATION LAYER                                                                        ║  │
║  Transport: Serial · UDP · TCP  (never MAVProxy --out for per-drone attach)                ║  │
║  Network:   WireGuard · ZeroTier · LTE/5G · RF · WiFi · VPN                                ║  │
║  Video:     RTSP · RTP · (RTMP future) · WebRTC(+TURN, future)                              ║  │
╚═══════════════════════════════════════╤══════════════════════════════════════════════════╝◄─┘
                                         │
╔═══════════════════════════════════════▼══════════════════════════════════════════════════╗
║ FLEET CORE                                                                                 ║
║ ┌─────────────────────────────── PYTHON — Drone Gateway (stateful) ──────────────────────┐║
║ │ SessionRegistry [DB-backed, rehydrated at boot — closes F1]                             │║
║ │   └─ N × DroneSession { LinkManager, MissionManager, ParameterSyncManager,              │║
║ │        PreflightManager, CameraManager, VideoRegistry entries }                         │║
║ │ Telemetry Publisher (10Hz wire + 1Hz persisted branch, D3)                              │║
║ │ Command Service (ACK machine + audit hook)     Mission Service                          │║
║ │ Alert rule evaluation source   Flight detector (arm→disarm)                             │║
║ │ Repository Layer ── drones_repo · flights_repo · telemetry_repo · commands_repo ·       │║
║ │   alerts_repo · allowlist_repo · objectstore.py                                         │║
║ │        │                                            │                                  │║
║ │        ▼                                            ▼                                  │║
║ │  Database (SQLite default / PostgreSQL opt-in, §8)   Object Storage (fs / S3, §8.10)    │║
║ └──────────────────────────┬───────────────────────────────────────────────────────────┘║
║                            │ ZMQ PUB (drone_id-tagged) · REST (fleet API)                 ║
║ ┌──────────────────────────▼─────────────────── NODE — Fleet Gateway (stateless) ───────┐║
║ │ Auth (JWT issue/verify, RBAC, org scoping)      Fleet API (versioned /api/v1/*)         │║
║ │ Telemetry Gateway (ZMQ SUB, supervised reconnect, per-client subscription + rate cap)   │║
║ │ Command Gateway (authz passthrough)             Event Bus (Alert/Notification/Plugins)  │║
║ │ Metrics(/metrics) · Health(/healthz,/readyz) · Structured JSON logs w/ correlation IDs   │║
║ └──────────────────────────┬───────────────────────────────────────────────────────────┘║
╚════════════════════════════╪══════════════════════════════════════════════════════════════╝
                             │ REST (JWT) · WebSocket (subscribed, per-drone)
╔════════════════════════════▼══════════════════════════════════════════════════════════════╗
║ APPLICATION LAYER — `/api/v1/*`, OpenAPI-documented, legacy `/api/*` frozen-and-aliased      ║
╚════════════════════════════╤══════════════════════════════════════════════════════════════╝
                             │
╔════════════════════════════▼══════════════════════════════════════════════════════════════╗
║ DASHBOARD                                                                                    ║
║  Fleet Overview · Fleet Map · Fleet Health · Fleet Analytics · Mission Control ·            ║
║  Drone Details (existing GCS, scoped by drone_id) · Video Wall · Alerts · Maintenance ·      ║
║  Settings (orgs/users/rules/allow-list/tokens)                                               ║
╚════════════════════════════╤══════════════════════════════════════════════════════════════╝
                             │
╔════════════════════════════▼══════════════════════════════════════════════════════════════╗
║ EXTERNAL INTEGRATIONS                                                                        ║
║  GIS/Asset Mgmt · Regulatory reporting · SIEM export · Webhook/Email/SMS/Slack providers ·   ║
║  S3/MinIO object storage · IdP/SSO · (future) Swarm coordinator / AI service — read-side only║
╚══════════════════════════════════════════════════════════════════════════════════════════╝
```

---

## Self-grade (`evaluators/architecture.md`)

```
Problem/goals:      [x] pass     — §1 states fleet-vs-GCS-vs-swarm distinction factually; §14 has
                                    quantified targets (10/50/100/250/500/1000/5000/10000 w/ named
                                    bottleneck per tier, grounded in the one measured data point)
Design correctness: [x] pass     — every section traces to code-verified fact (Phases 1-5A), an
                                    approved-not-built design (5B), or is explicitly marked as newly
                                    designed here (Edge Agent, Dashboard, Security, DR, Deployment)
Service boundaries: [x] pass     — §7 restates and extends "producer owns the store"; §6/§9 keep
                                    plugins on the event bus, never direct DB/session access (ADR-006)
Simplicity:         [x] pass     — brokers/SFU/rewrite/MQTT explicitly deferred with stated triggers
                                    (§14.3, §19 ADR-001); no speculative infrastructure introduced
Failure modes:      [x] pass     — §17 covers 8 failure classes with today-vs-required behavior;
                                    §9.2 states the hard rule (event subscribers never back-pressure
                                    the real-time telemetry path)
Scalability:        [x] pass     — §14 names the first bottleneck at each order of magnitude and
                                    distinguishes measured (10) from projected (50-10,000)
Ops readiness:      [~] partial  — §16 metrics/health/logs are shipped and verified; SLOs, Grafana-
                                    as-code, and tracing remain open (stated as such, not glossed over)
Alternatives:       [x] pass     — §19 ADRs carry forward genuine tradeoffs already litigated in the
                                    Phase 5B doc (Postgres-only rejected, mavlink-router-per-process
                                    rejected, Node-owned DB rejected) rather than re-deciding blind
Principles:         [~] partial  — API-first (§7.7), security-by-design (§13, flagged as the top gap),
                                    observability-by-design (§16, mostly shipped) all addressed; the
                                    partial is honest: auth/RBAC/DB do not exist yet, only design does

Overall: APPROVE_TO_PROCEED — as a specification. Per ADR-001/the Phase 5 review, no further feature
work should begin before Phase 5B (persistence) and 5C (security) land in code; this document is the
map for that work and everything after it.
```
