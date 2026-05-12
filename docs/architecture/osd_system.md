# OSD System Architecture

## Current State

- No full Mission Planner OSD layout editor exists yet in `drone_gcs`.
- Telemetry primitives needed for OSD widgets are partially available.

## Target Architecture

## 1) OSD Layout Model
- Layout profile:
  - `profile_id`, `name`, `grid_cols`, `grid_rows`
  - widget placements (`widget_type`, `x`, `y`, `size`, `visible`)

## 2) Backend Services
- OSD profile persistence service (JSON profiles).
- MAVLink bridge for OSD-related params/messages where applicable.
- Stream adapter to expose derived values for overlay widgets.

## 3) Frontend
- drag/drop grid editor
- live preview with telemetry-bound widgets
- per-profile save/load/clone

## 4) Telemetry Bindings
- Battery (`SYS_STATUS`/`BATTERY_STATUS`)
- GPS (`GPS_RAW_INT`, `GLOBAL_POSITION_INT`)
- attitude (`ATTITUDE`)
- speed/altitude (`VFR_HUD`, `GLOBAL_POSITION_INT`)
- warning feed (synthesized alert stream)

## 5) Mission Planner Parity Gaps

- No slot-level OSD config protocol handling yet.
- No widget editor, profile manager, or FPV overlay compositor.

## Day-2 Followup

- implement OSD profile backend + UI editor shell
- add overlay render layer atop map/video panels
