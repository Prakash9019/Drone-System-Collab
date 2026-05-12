# Geofence System Architecture

## Current State

- Mission/fence map editor parity is partial.
- Dedicated fence protocol flows are not implemented.

## Target System

## 1) Fence Domain Model
- Fence mode: enabled/disabled
- Fence type: circular, polygon inclusion, polygon exclusion
- Limits: min/max altitude, radius
- Action on breach: RTL, BRAKE, LAND, WARN

## 2) Backend
- Fence manager service:
  - synchronize fence params and fence points
  - upload/download/clear fence geometries
- MAVLink support:
  - `FENCE_POINT`
  - `FENCE_FETCH_POINT`
  - associated fence params (`FENCE_*`)

## 3) Frontend
- map fence editor:
  - drag handles
  - polygon create/edit
  - inclusion/exclusion toggle
- live status indicators:
  - fence enabled
  - breach action
  - current breach state

## 4) Telemetry + State Sync
- continuous fence state from params + status messages
- reconnect-safe restoration of local editing session

## Mission Planner Parity Gaps

- no full fence upload/download protocol path yet
- no dedicated fence UI or breach-state view

## Day-2 Followup

- implement backend fence manager + endpoints
- add fence layer and editor UI in planner map
