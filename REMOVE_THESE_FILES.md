# REMOVE THESE FILES
**Date**: 2026-05-27
**Purpose**: Files that are safe to delete because their content has been fully absorbed into master documents. Do not delete files marked "KEEP".

**Before deleting**: verify no code file imports or references these by running:
```bash
grep -r "FLIGHT_PLANNER_CENTRALIZED\|DATA_TAB_CENTRALIZED\|MODERN_GCS" . --include="*.jsx" --include="*.js" --include="*.py" --include="*.ts"
```

---

## SAFE TO DELETE (content fully absorbed into master docs)

### Design / Architecture Docs (→ MASTER_GCS_ARCHITECTURE.md)

```
telemetry-engine-design.md
vehicle-state-schema.md
mavlink-ingestion.md
vehicle-state-model.md
currentstate-architecture.md
telemetry-flow.md
telemetry-state-flow.md
hud-architecture.md
event-bus-design.md
migration-roadmap.md
```

### Data Flow Diagrams (→ MASTER_GCS_ARCHITECTURE.md + MASTER_FLIGHT_PLANNER.md)

```
mission-map-flow.md
mission-sync-flow.md
parameter-sync-flow.md
preflight-validation-flow.md
replay-event-flow.md
```

### Engine / Migration Notes (→ master docs)

```
MISSION_ENGINE.md
MISSION_MIGRATION_NOTES.md
PARAMETER_ENGINE.md
PARAMETER_MIGRATION_NOTES.md
PREFLIGHT_ENGINE.md
PREFLIGHT_MIGRATION_NOTES.md
TELEMETRY_REPLAY_ENGINE.md
REPLAY_MIGRATION_NOTES.md
MAP_INTEGRATION.md
MAP_MIGRATION_NOTES.md
```

### Stale Audit Docs (superseded by master docs; claims contradicted by current code)

```
DATA_TAB_GAP_ANALYSIS.md           ← stale: map waypoints/home/click-to-fly marked "missing" but exist
DATA_TAB_IMPLEMENTATION_PLAN.md    ← stale: DO_REPOSITION marked "missing" but exists at MapView.jsx:769
DATA_TAB_IMP.md                    ← high-level intent; absorbed
DATA_TAB_AUDIT_PROGRESS.md         ← absorbed into MASTER_DATA_TAB.md §10
docs/audit/data_screen_audit.md    ← stale: home marker/trail/overlays marked missing but all exist
docs/audit/simulation_screen_audit.md  ← absorbed
```

### Old Centralized Docs (replaced by master docs)

```
FLIGHT_PLANNER_CENTRALIZED.md      ← replaced by MASTER_FLIGHT_PLANNER.md
FLIGHT_PLANNER_MISSION_CENTRALIZED.md  ← replaced by MASTER_FLIGHT_PLANNER.md
DATA_TAB_CENTRALIZED.md             ← replaced by MASTER_DATA_TAB.md
MODERN_GCS_ARCHITECTURE.md          ← replaced by MASTER_GCS_ARCHITECTURE.md
```

### Absorbed Operational Docs (→ MASTER_OPERATIONS_AND_DEBUGGING.md)

```
FLIGHT_PLANNER_USER_GUIDE.md
try.md                              ← absorbed; superseded by PREMATURE_RTL_ROOT_CAUSE.md
walkthrough.md
drone_gcs/TROUBLESHOOTING.md
docs/operations/mission_planner_operational_workflow.md
docs/operations/complete_frontend_developer_user_guide.md
docs/operations/frontend_testing_workflow_guide.md
docs/operations/phase7_system_stability.md
```

### Other Absorbed Docs

```
FEATURE_AUDIT_REPORT.md
FINAL_FEATURE_VERIFICATION_REPORT.md
PLAN_TAB_IMP.md
SETUP_TAB_IMP.md
VIDEO_SUBSYSTEM_PLAN.md             ← delete only if video subsystem is permanently deprioritized
GCS_DOCUMENTATION.md                ← replaced by MASTER_GCS_ARCHITECTURE.md + MASTER_OPERATIONS docs
drone_gcs/imp.md
docs/audit/plan_screen_audit.md
docs/audit/connect_module_audit.md
docs/audit/config_tuning_audit.md
```

---

## DO NOT DELETE — KEEP THESE

| File | Why |
|------|-----|
| `MASTER_FLIGHT_PLANNER.md` | Master doc — primary |
| `MASTER_GCS_ARCHITECTURE.md` | Master doc — primary |
| `MASTER_DATA_TAB.md` | Master doc — primary |
| `MASTER_OPERATIONS_AND_DEBUGGING.md` | Master doc — primary |
| `DOCUMENTATION_INDEX.md` | Navigation hub |
| `DOCUMENTATION_MERGE_REPORT.md` | Audit trail |
| `REMOVE_THESE_FILES.md` | This file |
| `PREMATURE_RTL_ROOT_CAUSE.md` | Confirmed root-cause with evidence; standalone reference |
| `MISSION_AUTO_START_ROOT_CAUSE.md` | Confirmed root-cause with evidence; standalone reference |
| `MISSION_PLANNER_PARITY_BOARD_REPORT.md` | Board-level status report; historical context |
| `MASTER_GCS_REQUIREMENTS.md` | Original requirements; historical context |
| `FLIGHT_PLANNER_AUDIT_TABLE.md` | Detailed audit tables; companion to master doc |
| `FLIGHT_PLANNER_MISSION_AUDIT_TABLE.md` | Detailed audit tables; companion to master doc |
| `DATA_TAB_AUDIT_TABLE.md` | Detailed audit tables; companion to master doc |
| `LEVEL_CALIBRATION_AUDIT.md` | Specific calibration findings |
| `DATA_TAB_GPS_ALTITUDE_AUDIT.md` | GPS/altitude audit |
| `README.md` | Project README |
| `drone_gcs/SETUP.md` | Hardware setup |
| `drone_gcs/DIRECT_SERIAL.md` | Serial connection |
| `drone_gcs/frontend/README.md` | Frontend README |
| `drone_gcs/docs/plan.md` | Internal planning doc |
| All `*.jsx`, `*.js`, `*.py`, `*.ts` | Code — obviously don't delete |
| `MissionPlanner/` | Vendored reference |
| `qgroundcontrol/` | Vendored reference |

---

## DELETION COMMANDS

When ready to delete, run from the repo root:

```bash
# Design / flow docs
rm telemetry-engine-design.md vehicle-state-schema.md mavlink-ingestion.md vehicle-state-model.md
rm currentstate-architecture.md telemetry-flow.md telemetry-state-flow.md hud-architecture.md
rm event-bus-design.md migration-roadmap.md
rm mission-map-flow.md mission-sync-flow.md parameter-sync-flow.md preflight-validation-flow.md replay-event-flow.md

# Engine / migration notes
rm MISSION_ENGINE.md MISSION_MIGRATION_NOTES.md PARAMETER_ENGINE.md PARAMETER_MIGRATION_NOTES.md
rm PREFLIGHT_ENGINE.md PREFLIGHT_MIGRATION_NOTES.md TELEMETRY_REPLAY_ENGINE.md REPLAY_MIGRATION_NOTES.md
rm MAP_INTEGRATION.md MAP_MIGRATION_NOTES.md

# Stale audit docs
rm DATA_TAB_GAP_ANALYSIS.md DATA_TAB_IMPLEMENTATION_PLAN.md DATA_TAB_IMP.md DATA_TAB_AUDIT_PROGRESS.md
rm docs/audit/data_screen_audit.md docs/audit/simulation_screen_audit.md

# Old centralized docs (replaced by master)
rm FLIGHT_PLANNER_CENTRALIZED.md FLIGHT_PLANNER_MISSION_CENTRALIZED.md
rm DATA_TAB_CENTRALIZED.md MODERN_GCS_ARCHITECTURE.md

# Absorbed operational docs
rm FLIGHT_PLANNER_USER_GUIDE.md try.md walkthrough.md
rm drone_gcs/TROUBLESHOOTING.md
rm "docs/operations/mission_planner_operational_workflow.md"
rm "docs/operations/complete_frontend_developer_user_guide.md"
rm "docs/operations/frontend_testing_workflow_guide.md"
rm "docs/operations/phase7_system_stability.md"

# Other absorbed docs
rm FEATURE_AUDIT_REPORT.md FINAL_FEATURE_VERIFICATION_REPORT.md
rm PLAN_TAB_IMP.md SETUP_TAB_IMP.md GCS_DOCUMENTATION.md
rm drone_gcs/imp.md
rm docs/audit/plan_screen_audit.md docs/audit/connect_module_audit.md docs/audit/config_tuning_audit.md
```

**Do NOT run these without reviewing the list above first.**
