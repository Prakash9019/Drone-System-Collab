# Operational Workflow (Mission Planner Style)

This runbook defines the intended end-to-end operator flow in `drone_gcs`.

## 1) Preflight

- Open `Flight Data`.
- Verify map center:
  - browser location is requested at startup
  - fallback is last saved center if denied
  - use `My location` and `Go to vehicle` controls as needed
- Verify link state in top ribbon:
  - `DISCONNECTED` -> `CONNECTING` -> `CONNECTED`
- Verify operational phase label:
  - `Disconnected`, `Connecting`, `Disarmed`, `Armed`, `Takeoff`, `Flying`, `RTL`, `Landing`

## 2) Connect

- Choose connection (`AUTO`, serial port, SITL UDP/TCP, custom).
- Click `CONNECT`.
- Confirm:
  - telemetry values are updating
  - vehicle marker is moving
  - flight trail is rendering
  - home marker appears after `HOME_POSITION`

## 3) Commanding

- Use quick actions:
  - `ARM` / `DISARM`
  - `TAKEOFF` (+ altitude)
  - `RTL`
  - `LAND`
- Buttons show pending state while command ACK is in progress.
- Failures surface in banner text; no silent command failure is expected.

## 4) Map Actions

Right-click on map for context operations:

- Mission: add/insert waypoint, guided target, set home, RTL, ROI, survey handoff
- Fence: add fence point
- Rally: add rally point

Notes:
- Survey opens `Flight Planner` with context center pre-seeded.
- Delete waypoint acts on planner-selected waypoint.

## 5) Planning

- Open `Flight Planner`.
- Choose mission type (`MISSION`, `FENCE`, `RALLY`).
- Read / edit / write mission.
- Use Survey Grid generator for lawnmower plans.
- For fence mode, apply fence config after edits.

## 6) In-flight Monitoring

- Keep `Auto-follow vehicle` enabled unless manual map investigation is needed.
- If user pans map manually, follow pauses; use `Resume follow`.
- Monitor:
  - GPS fix/sats
  - heartbeat age
  - packet loss
  - mode / operational phase

## 7) Recovery / Abnormal Cases

- If heartbeat is lost:
  - expected state: `HEARTBEAT_LOST`
  - check link and connection string
  - reconnect if needed
- If a command is rejected:
  - verify mode/arming prerequisites
  - retry from valid state
- If geolocation is denied:
  - map uses saved center
  - use `My location` after granting permission

## 8) Current Known Limits

- Operational phase is inferred from telemetry, not a full autopilot authority state machine.
- Map context menu is mode-aware but still simplified vs full Mission Planner.
- Advanced mission tools (terrain analysis/corridor/structure scan) remain pending.

