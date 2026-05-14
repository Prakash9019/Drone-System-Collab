# MAVLink Mission Engine Architecture

The Drone-System-Collab MAVLink Mission Engine manages the complex, multi-step state machine required to upload, download, and clear vehicle missions (Waypoints, Fences, Rally Points) over MAVLink.

## Architecture Components

### 1. Backend Engine (`mission_manager.py`)
The backend service processes mission synchronization using a stateful `transfer_status` tracker and an `asyncio.Queue` listener hooked directly into the primary telemetry `read_loop`.

**Key Capabilities:**
- **Waypoint Validation**: Before an upload begins, `validate_mission` checks that all latitude/longitude pairs are within valid geographical constraints (-90 to 90, -180 to 180), preventing drone lockups from malformed coordinates.
- **Duplicate Packet Resilience**: The download sequence explicitly guards against processing identical `MISSION_ITEM_INT` messages, a common issue on noisy telemetry links.
- **Mission Versioning**: On successful completion of an upload, download, or clear, the engine generates a local `mission_version` (an 8-character UUID hash). The frontend can track this hash to know exactly when the drone's mission state has changed.
- **Clear Handling**: Uses `MAV_CMD_DO_CLEAR_ALL` via the native `mission_clear_all_send` wrapper to wipe memory reliably.

### 2. Telemetry Middleware (`telemetry_pub.py` & `telemetryEngine.js`)
- The Python engine broadcasts the active `transfer_status` (including total item count, currently transmitted item, phase, and errors) at 10Hz to the Node.js API Gateway via ZMQ.
- The Node.js gateway forwards this payload natively down the WebSocket pipe using the `MISSION_SYNC_STATUS` type.

### 3. Frontend Normalization (`missionSelectors.js`)
To decouple UI components from the raw state machine phases (`REQUESTING_LIST`, `UPLOADING_ITEMS`, etc.), the frontend uses `selectMissionSyncState`.

**Features:**
- Translates `current` and `total` counters into a stable `0-100` progress percentage.
- Resolves abruptly dropped connections by forcing the execution state to `IDLE` and clearing errors.
- Provides **Stale State Detection**: If an upload or download halts (e.g., the telemetry link drops 90% of packets but remains technically "connected"), the selector triggers an `isStale` boolean after 15 seconds of inactivity.
