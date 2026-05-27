# DOCUMENTATION MERGE REPORT
**Date**: 2026-05-27
**Action**: Consolidated ~55 fragmented markdown files into 4 master documents + 2 index files.
**No files were deleted** — see `REMOVE_THESE_FILES.md` for the safe-to-delete list.

---

## MERGE TABLE

| Old File | Action | Merged Into | Reason |
|----------|--------|-------------|--------|
| `FLIGHT_PLANNER_CENTRALIZED.md` | Merged | `MASTER_FLIGHT_PLANNER.md` | Primary source for planner; content fully captured |
| `FLIGHT_PLANNER_MISSION_CENTRALIZED.md` | Merged | `MASTER_FLIGHT_PLANNER.md` | Mission-core deep-dive; content captured in §2-4, §11-12 |
| `FLIGHT_PLANNER_AUDIT_TABLE.md` | Kept as companion | `MASTER_FLIGHT_PLANNER.md` references it | Detailed audit tables preserved as reference |
| `FLIGHT_PLANNER_MISSION_AUDIT_TABLE.md` | Kept as companion | `MASTER_FLIGHT_PLANNER.md` references it | Detailed audit tables preserved as reference |
| `FLIGHT_PLANNER_USER_GUIDE.md` | Merged | `MASTER_FLIGHT_PLANNER.md §14` + `MASTER_OPERATIONS_AND_DEBUGGING.md §4` | User instructions absorbed |
| `try.md` | Merged | `MASTER_OPERATIONS_AND_DEBUGGING.md §5,8` + `MASTER_FLIGHT_PLANNER.md §14` | Debug playbook + user error checklist absorbed; now superseded by PREMATURE_RTL doc |
| `MISSION_AUTO_START_ROOT_CAUSE.md` | **Preserved** | Referenced from `MASTER_FLIGHT_PLANNER.md §9` | Confirmed root-cause doc with evidence; keep standalone |
| `PREMATURE_RTL_ROOT_CAUSE.md` | **Preserved** | Referenced from `MASTER_FLIGHT_PLANNER.md §10` | Confirmed root-cause doc with evidence; keep standalone |
| `DATA_TAB_CENTRALIZED.md` | Merged | `MASTER_DATA_TAB.md` | Primary Data Tab source |
| `DATA_TAB_AUDIT_TABLE.md` | Kept as companion | `MASTER_DATA_TAB.md` references it | Audit tables preserved |
| `DATA_TAB_AUDIT_PROGRESS.md` | Merged | `MASTER_DATA_TAB.md §10` | Parity scorecard absorbed |
| `DATA_TAB_GAP_ANALYSIS.md` | Superseded | `MASTER_DATA_TAB.md §11` | Stale — many items it listed as "missing" now exist; absorbed corrected list |
| `DATA_TAB_IMP.md` | Merged | `MASTER_DATA_TAB.md` | High-level intent absorbed |
| `DATA_TAB_IMPLEMENTATION_PLAN.md` | Superseded | `MASTER_DATA_TAB.md §11` | Stale — click-to-fly-to, DO_REPOSITION now exist |
| `DATA_TAB_GPS_ALTITUDE_AUDIT.md` | Merged | `MASTER_DATA_TAB.md §2.2` | GPS/altitude telemetry path captured |
| `MODERN_GCS_ARCHITECTURE.md` | Merged | `MASTER_GCS_ARCHITECTURE.md` | Architecture vision absorbed |
| `GCS_DOCUMENTATION.md` | Merged | `MASTER_GCS_ARCHITECTURE.md` + `MASTER_OPERATIONS_AND_DEBUGGING.md §1-3` | Setup, API reference, fence protocol absorbed |
| `telemetry-engine-design.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §3, §8` | Telemetry design captured |
| `vehicle-state-schema.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §4` | Schema documented |
| `mavlink-ingestion.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §2.1, §3` | MAVLink ingestion layer captured |
| `vehicle-state-model.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §4` | State model captured |
| `currentstate-architecture.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §7` | MP parity comparison absorbed |
| `telemetry-flow.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §3` | Telemetry flow captured |
| `telemetry-state-flow.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §3` | State flow captured |
| `hud-architecture.md` | Merged | `MASTER_DATA_TAB.md §2` (parity reference only) | Describes MP C# HUD; kept as parity reference note |
| `event-bus-design.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §8.2` | Event bus design captured in target architecture section |
| `migration-roadmap.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §8.2` | Migration phases absorbed |
| `mission-map-flow.md` | Merged | `MASTER_FLIGHT_PLANNER.md §2` | Mission flow captured |
| `mission-sync-flow.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §3.1` | Sync flow captured |
| `parameter-sync-flow.md` | Merged | `MASTER_DATA_TAB.md §6` | Param sync captured |
| `preflight-validation-flow.md` | Merged | `MASTER_DATA_TAB.md §7` (PreFlight tab) | Preflight flow captured |
| `replay-event-flow.md` | Merged | `MASTER_DATA_TAB.md §11 M7` | Replay noted as missing UI |
| `MISSION_ENGINE.md` | Merged | `MASTER_FLIGHT_PLANNER.md §3` | Mission protocol absorbed |
| `MISSION_MIGRATION_NOTES.md` | Merged | `MASTER_FLIGHT_PLANNER.md §3` | Migration notes absorbed |
| `PARAMETER_ENGINE.md` | Merged | `MASTER_DATA_TAB.md §6` | Parameter engine absorbed |
| `PARAMETER_MIGRATION_NOTES.md` | Merged | `MASTER_DATA_TAB.md §6` | Migration notes absorbed |
| `PREFLIGHT_ENGINE.md` | Merged | `MASTER_DATA_TAB.md §7` | Preflight engine absorbed |
| `PREFLIGHT_MIGRATION_NOTES.md` | Merged | `MASTER_DATA_TAB.md §7` | Migration notes absorbed |
| `TELEMETRY_REPLAY_ENGINE.md` | Merged | `MASTER_DATA_TAB.md §11 M7` | Replay noted as missing UI |
| `REPLAY_MIGRATION_NOTES.md` | Merged | `MASTER_DATA_TAB.md §11 M7` | Migration notes absorbed |
| `MAP_INTEGRATION.md` | Merged | `MASTER_DATA_TAB.md §3` + `MASTER_FLIGHT_PLANNER.md §8` | Map features captured |
| `MAP_MIGRATION_NOTES.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §7` | Migration notes absorbed |
| `PLAN_TAB_IMP.md` | Merged | `MASTER_FLIGHT_PLANNER.md` | Implementation tracker absorbed |
| `SETUP_TAB_IMP.md` | Merged | `MASTER_OPERATIONS_AND_DEBUGGING.md §10` | Calibration procedures absorbed |
| `VIDEO_SUBSYSTEM_PLAN.md` | No equivalent master | — | Video subsystem not yet implemented; retain for future reference |
| `FEATURE_AUDIT_REPORT.md` | Merged | `MASTER_DATA_TAB.md §10` | Feature audit absorbed |
| `FINAL_FEATURE_VERIFICATION_REPORT.md` | Merged | `MASTER_DATA_TAB.md §10` | Verification results absorbed |
| `MISSION_PLANNER_PARITY_BOARD_REPORT.md` | **Preserved** | Referenced from `DOCUMENTATION_INDEX.md` | Board-level status report; keep for historical context |
| `MASTER_GCS_REQUIREMENTS.md` | **Preserved** | Referenced from `DOCUMENTATION_INDEX.md` | Original requirements doc; keep for historical context |
| `walkthrough.md` | Merged | `MASTER_OPERATIONS_AND_DEBUGGING.md §4` | Walkthrough absorbed |
| `drone_gcs/imp.md` | Merged | `MASTER_FLIGHT_PLANNER.md §14` | Working notes absorbed |
| `drone_gcs/SETUP.md` | **Preserved** | Referenced from `DOCUMENTATION_INDEX.md` | Hardware setup notes |
| `drone_gcs/TROUBLESHOOTING.md` | Merged | `MASTER_OPERATIONS_AND_DEBUGGING.md §5-8` | Troubleshooting absorbed |
| `drone_gcs/DIRECT_SERIAL.md` | **Preserved** | Referenced from `DOCUMENTATION_INDEX.md` | Serial connection specifics |
| `docs/audit/data_screen_audit.md` | Superseded | `MASTER_DATA_TAB.md` | Stale — items listed as missing now exist |
| `docs/audit/plan_screen_audit.md` | Merged | `MASTER_FLIGHT_PLANNER.md §12` | Audit content absorbed |
| `docs/audit/connect_module_audit.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §5` | Connection audit absorbed |
| `docs/audit/simulation_screen_audit.md` | Merged | `MASTER_OPERATIONS_AND_DEBUGGING.md §3` | SITL audit absorbed |
| `docs/audit/config_tuning_audit.md` | Merged | `MASTER_DATA_TAB.md §6` | Config/tuning absorbed |
| `docs/operations/mission_planner_operational_workflow.md` | Merged | `MASTER_OPERATIONS_AND_DEBUGGING.md §4` | Operational workflow absorbed |
| `docs/operations/complete_frontend_developer_user_guide.md` | Merged | `MASTER_GCS_ARCHITECTURE.md §9` | Developer guide absorbed |
| `docs/operations/frontend_testing_workflow_guide.md` | Merged | `MASTER_OPERATIONS_AND_DEBUGGING.md §11` | Testing workflow absorbed |
| `docs/operations/phase7_system_stability.md` | Merged | `MASTER_OPERATIONS_AND_DEBUGGING.md §11` | Stability checklist absorbed |
| `LEVEL_CALIBRATION_AUDIT.md` | **Kept as companion** | Referenced from `MASTER_OPERATIONS_AND_DEBUGGING.md §10` | Specific calibration findings; keep |
| `drone_gcs/frontend/README.md` | **Preserved** | — | Frontend README |

---

## IMPORTANT IMPLEMENTATION DETAILS PRESERVED

The following hard-won findings were explicitly preserved and are critical — do NOT lose them:

### 1. Premature RTL Root Cause (2026-05-27)
- Root cause: polygon fence breach, hidden by NOTICE severity filter + EEPROM persistence
- **Two GCS bugs fixed**: (1) STATUSTEXT toast filtered severity ≤4, silently dropping NOTICE (5) fence messages; (2) clearing drawn polygon ≠ clearing onboard fence
- Evidence: video frame analysis + autopilot STATUSTEXT log: `Polygon fence breached`
- Fixes: `AdvancedHUD.jsx` (fence keyword toast), `MissionExecutionPanel.jsx` (UNPLANNED RETURN banner), `FlightData.jsx` (passes status_messages)
- See: `PREMATURE_RTL_ROOT_CAUSE.md` and `MASTER_FLIGHT_PLANNER.md §10`

### 2. WP Counter 0→1 on Set AUTO (2026-05-27)
- Root cause: firmware behavior (ArduCopter advances MISSION_CURRENT to TAKEOFF cursor on AUTO entry)
- Confirmed NOT a GCS bug — verified across all 4 layers; Mission Planner does the same
- Fix: UI run-state labels (HOLDING / RUNNING / DISARMED / ARMED) based on airborne detection
- See: `MISSION_AUTO_START_ROOT_CAUSE.md` and `MASTER_FLIGHT_PLANNER.md §9`

### 3. Merge-Conflict Regression (2026-05-25)
- Commit `429705f` introduced 4 duplicate-symbol artifacts crashing FlightPlanner.jsx
- All 4 fixed; commit message drafted in `MASTER_FLIGHT_PLANNER.md §11`

### 4. Mission Protocol Parity
- Full parity with Mission Planner at the wire level confirmed
- HOME injection, MISSION_ITEM_INT ×1e7 scaling, MISSION_START params, mode set — all match MP
- See: `MASTER_FLIGHT_PLANNER.md §12`

---

## WHAT WAS NOT MERGED

Files excluded from consolidation (kept as-is):
- `MissionPlanner/` — vendored C# source (reference only)
- `qgroundcontrol/` — vendored QGC source (reference only)
- All `.json`, `.jsx`, `.py`, `.js`, `.ts` code files — these are the actual implementation
