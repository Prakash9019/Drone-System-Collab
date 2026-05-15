# Drone GCS - Mission Planner Data Tab Gap Analysis

## 1. COMPLETED FEATURES
The following systems are functionally complete and establish strong Mission Planner parity. **Do not reimplement these.**
- **Advanced HUD**: Includes pitch/roll (artificial horizon), heading ribbon, altitude tapes, groundspeed, mode text, arm state, failsafe detection, and stale telemetry handling (`AdvancedHUD.jsx`).
- **Telemetry Engine Architecture**: The Python ZMQ publisher -> Node WebSocket -> Zustand state pipeline is robust and functioning perfectly.
- **Status Tab**: A searchable, categorized grid displaying all normalized vehicle parameters in real-time (`StatusTab.jsx`).
- **Quick Tab**: Customizable dashboard widgets for high-level telemetry monitoring (`QuickTab.jsx`).
- **Messages Tab**: Real-time console for MAVLink `STATUSTEXT` messages with severity coloring (`MessagesTab.jsx`).
- **Basic Map Tracking**: `MapView.jsx` successfully renders the vehicle marker, rotates it based on heading, draws a flight trail, plots ADS-B tracks, and handles basic right-click context commands (Fly To, Set Home).
- **Core Action Commands**: ARM, DISARM, TAKEOFF, LAND, RTL, LOITER, AUTO, GUIDED, STABILIZE, and FC REBOOT are fully integrated with the backend Command Engine (`ActionsTab.jsx`).
- **Backend Preflight & Replay Engines**: The backend logic for rigorous safety scoring and telemetry recording/playback is complete.

---

## 2. PARTIALLY IMPLEMENTED FEATURES

### A. PreFlight Validation UI
- **What exists**: The `PreFlightTab.jsx` component exists but relies on legacy, hardcoded frontend evaluation logic (e.g., `gpsFix >= 3 && sats >= 6`).
- **What is missing**: It does not consume the newly built backend `PreflightManager`. The UI is missing the 0–100 Readiness Confidence Score, persistent failure tracking (`first_seen`/`last_seen`), and dynamic separation of blocking vs. warning checks.
- **Mission Planner Parity Required**: The Preflight UI must dynamically reflect backend safety gates. If blocking checks exist, the UI should clearly articulate why arming is prevented.

### B. Map Mission Overlays
- **What exists**: The vehicle marker and flight trail are drawn. The `useMissionStore` holds the synchronized mission items.
- **What is missing**: `MapView.jsx` does not render the active mission path. It lacks the waypoints and the polyline connecting them. It also fails to visually highlight the *active* waypoint based on `vehicle.mission.current_seq`.
- **Mission Planner Parity Required**: The map must draw the mission plan as an overlay, updating dynamically as the vehicle progresses through the sequences.

### C. Replay Session Controls
- **What exists**: The backend REST APIs (`/replay/playback/start`) and the frontend Redux strict mode filters (`mode: 'REPLAY'`) are fully implemented.
- **What is missing**: There is no UI in the Data Tab to toggle replay mode, select a session, or scrub the playback timeline. 
- **Mission Planner Parity Required**: An operator needs a timeline playback bar to pause, resume, and seek through historical flight data.

---

## 3. MISSING FEATURES

### A. Telemetry Graphing (Tuning View)
- **Completely Missing**: Mission Planner features a "Tuning" checkbox that opens a live, scrolling line chart allowing operators to plot variables (e.g., roll vs. desired roll, vibration, altitude) over time. This is critical for assessing vehicle performance mid-flight.

### B. Advanced Payload Actions
- **Completely Missing**: The `ActionsTab.jsx` lacks advanced operational commands that are standard in Mission Planner, such as:
  - Camera Trigger (`MAV_CMD_IMAGE_START_CAPTURE`)
  - Mount / Gimbal Control (Do-Mount-Control)
  - `DO_SET_SERVO` / `DO_SET_RELAY`

---

## 4. ARCHITECTURE ANALYSIS

### PreFlight UI Refactor
- **Analysis**: Pure frontend rendering task. `PreFlightTab.jsx` must be rewritten to import `selectPreflightStatus` from `useTelemetryStore`. The layout should be updated to display the readiness score prominently and list failures grouped by severity.

### Map Mission Overlay
- **Analysis**: Frontend orchestration. `MapView.jsx` needs to subscribe to `useMissionStore(s => s.missionItems)`. It must add a new MapLibre `geojson` source and a `line` layer to draw the path, along with a `circle` or `symbol` layer to draw the waypoints. It must react to `vehicle.mission.current_seq` to highlight the active target.

### Replay Controls
- **Analysis**: UI-only logic leveraging existing backend endpoints. A new `ReplayControls.jsx` component should be created and conditionally rendered in `FlightData.jsx` or the Sidebar. It will poll `useTelemetryStore(s => s.replayStatus)` to animate a progress bar and make `axios.post` calls to the seek/pause/resume endpoints.

### Telemetry Graphing (Tuning)
- **Analysis**: Requires implementing a high-performance charting library (e.g., uPlot or Chart.js) in a new `TuningGraph.jsx` component. It will hook into the React effect lifecycle to push `useTelemetryStore` updates into a rolling data buffer. No backend changes are required since the telemetry is already normalized and broadcasting at 10Hz.

### Advanced Actions
- **Analysis**: Protocol and UI logic. `ActionsTab.jsx` needs new inputs for Servo/Relay channels and PWM values. These will route through the existing `axios.post('/api/mavlink/command')` endpoint, which is already generic enough to handle them.
