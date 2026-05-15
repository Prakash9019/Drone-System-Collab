# Drone GCS - Data Tab Implementation Plan

Based on the `DATA_TAB_GAP_ANALYSIS.md`, the following implementation plan outlines the incremental steps required to achieve near-complete Mission Planner parity in the Data Tab. 

**Core Principle**: We will NOT rewrite the telemetry engine, command engine, or map architecture. We will strictly add the missing frontend integration logic and visualization layers.

---

## Phase 1: PreFlight Engine Integration
**Goal**: Connect the existing backend Preflight engine to the UI.
1. Rewrite `PreFlightTab.jsx` to consume `selectPreflightStatus` from `useTelemetryStore`.
2. Render the 0–100 Readiness Confidence Score prominently.
3. Replace the hardcoded checks with dynamic lists of `blockingChecks`, `warningChecks`, and `infoChecks`.
4. Ensure the UI clearly communicates failures based on the `first_seen` and `last_seen` persistent states.

## Phase 2: Map Mission Overlay Parity
**Goal**: Provide visual context of the vehicle's progress along its programmed mission.
1. Update `MapView.jsx` to subscribe to `useMissionStore(state => state.missionItems)`.
2. Add a MapLibre `geojson` source to draw the waypoints as a polyline (`line` layer).
3. Extract `vehicle.mission.current_seq` from the telemetry stream.
4. Render a distinct highlight or line segment demonstrating the vector to the *active* target waypoint.

## Phase 3: Replay Session Controls
**Goal**: Expose the backend replay engine capabilities to the operator.
1. Create a new `ReplayControls.jsx` component.
2. Add a toggle in the UI (likely near the connection ribbon in `FlightData.jsx`) to switch between `LIVE` and `REPLAY` modes.
3. Build a session selector dropdown that calls `GET /replay/sessions`.
4. Implement a scrubbing timeline that visualizes `replayStatus.progress_s` vs `duration_s` and issues `POST /replay/playback/seek` commands.

## Phase 4: Telemetry Graphing (Tuning View)
**Goal**: Allow operators to analyze vehicle performance mid-flight.
1. Create a `TuningGraph.jsx` component using a lightweight charting library (e.g., Chart.js or uPlot).
2. Hook into `useTelemetryStore` to maintain a rolling window of the last 100-300 data points for selected variables (e.g., altitude, pitch, roll, vibration).
3. Add a "Tuning" toggle in the Data Tab layout to slide open the graphing console beneath the map or beside the Advanced HUD.

## Phase 5: Advanced Payload Actions
**Goal**: Support complex operational commands.
1. Expand `ActionsTab.jsx` to include inputs for Payload operations.
2. Add UI for Camera Triggering (`MAV_CMD_IMAGE_START_CAPTURE`).
3. Add inputs for `DO_SET_SERVO` (allowing the user to specify channel and PWM) and `DO_SET_RELAY`.
4. Route these seamlessly through the existing generic `axios.post('/api/mavlink/command')` structure.
