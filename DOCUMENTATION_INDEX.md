# DOCUMENTATION INDEX
**Last updated**: 2026-05-27
**Purpose**: Master index of all authoritative documentation. Start here.

---

## MASTER DOCUMENTS (Start Here)

| File | Scope | Use When |
|------|-------|----------|
| **[MASTER_FLIGHT_PLANNER.md](MASTER_FLIGHT_PLANNER.md)** | Mission, Fence, Survey Grid, Map/AutoPan, mission execution debugging, settled root-cause analyses (premature RTL, WP counter 0→1) | Debugging any flight planner behavior, mission execution, fence, premature RTL |
| **[MASTER_GCS_ARCHITECTURE.md](MASTER_GCS_ARCHITECTURE.md)** | Full system architecture: Python/Node/React layers, telemetry pipeline, vehicle state schema, connection system, command pipeline, MP parity | Understanding system internals, adding new features, debugging telemetry |
| **[MASTER_DATA_TAB.md](MASTER_DATA_TAB.md)** | Data Tab (Flight Data screen): HUD, map, actions, modes, parameters, tabs, MissionExecutionPanel | Working on HUD, map, actions, tabs, or parity with MP data screen |
| **[MASTER_OPERATIONS_AND_DEBUGGING.md](MASTER_OPERATIONS_AND_DEBUGGING.md)** | Setup, SITL, nominal flight workflow, all debugging playbooks, calibration, parameter reference | Running the system, flying a mission, debugging any failure |

---

## SETTLED ROOT CAUSE DOCUMENTS

These are preserved as standalone docs because they document confirmed investigations with evidence.

| File | Issue | Status |
|------|-------|--------|
| **[PREMATURE_RTL_ROOT_CAUSE.md](PREMATURE_RTL_ROOT_CAUSE.md)** | Premature RTL during AUTO mission — root cause: polygon fence breach hidden by NOTICE severity filter + EEPROM persistence | SETTLED. Video + autopilot STATUSTEXT log confirmed. 2026-05-27. |
| **[MISSION_AUTO_START_ROOT_CAUSE.md](MISSION_AUTO_START_ROOT_CAUSE.md)** | WP counter jumps 0/4 → 1/4 on "Set AUTO" before clicking Start Mission — root cause: firmware behavior, not GCS bug | SETTLED. Verified across all 4 layers. Mission Planner parity confirmed. 2026-05-27. |

---

## PROJECT REFERENCE DOCS (Keep, Don't Delete)

| File | Purpose |
|------|---------|
| **README.md** | Project overview |
| **MASTER_GCS_REQUIREMENTS.md** | Original MP parity requirements (historical context) |
| **MISSION_PLANNER_PARITY_BOARD_REPORT.md** | Phase A/B/C parity roadmap status (as of 2026-05-11) |
| **drone_gcs/SETUP.md** | Hardware setup notes |
| **drone_gcs/DIRECT_SERIAL.md** | Serial connection specifics |
| **MissionPlanner/** | Vendored MP source (C# reference only) |

---

## AUDIT TABLES (Companion to Master Docs)

These contain detailed line-by-line audit tables. The master docs reference them for completeness.

| File | Content |
|------|---------|
| **DATA_TAB_AUDIT_TABLE.md** | Row-by-row feature matrix for Data Tab |
| **FLIGHT_PLANNER_AUDIT_TABLE.md** | Row-by-row feature matrix for Flight Planner |
| **FLIGHT_PLANNER_MISSION_AUDIT_TABLE.md** | Mission-specific audit table |
| **LEVEL_CALIBRATION_AUDIT.md** | Level calibration behavior audit |

---

## SAFE TO DELETE

See [REMOVE_THESE_FILES.md](REMOVE_THESE_FILES.md) for the complete list with reasons.

---

## QUICK REFERENCE: WHERE TO LOOK

| Symptom | Read |
|---------|------|
| Vehicle RTLs before reaching waypoints | `MASTER_FLIGHT_PLANNER.md §10` and `PREMATURE_RTL_ROOT_CAUSE.md` |
| WP counter shows 1/N right after Set AUTO | `MASTER_FLIGHT_PLANNER.md §9` and `MISSION_AUTO_START_ROOT_CAUSE.md` |
| Mission won't start / Start Mission greyed out | `MASTER_OPERATIONS_AND_DEBUGGING.md §6` |
| Upload fails / XFER shows FAILED | `MASTER_OPERATIONS_AND_DEBUGGING.md §7` |
| Fence behavior or breach | `MASTER_FLIGHT_PLANNER.md §5-6` and `MASTER_OPERATIONS_AND_DEBUGGING.md §8` |
| HUD missing data / telemetry not showing | `MASTER_DATA_TAB.md §2` |
| How to fly a mission step-by-step | `MASTER_OPERATIONS_AND_DEBUGGING.md §4` |
| System architecture (internals) | `MASTER_GCS_ARCHITECTURE.md` |
| API endpoints | `MASTER_GCS_ARCHITECTURE.md §6.2` |
| Adding a new MAVLink message handler | `MASTER_GCS_ARCHITECTURE.md §3` |
