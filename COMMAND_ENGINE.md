# MAVLink Command Engine

The Drone-System-Collab MAVLink Command Engine is responsible for robustly transmitting, tracking, and verifying commands sent to MAVLink vehicles.

## Architecture

The engine is split across the Python Backend (`CommandManager`) and the Frontend UI (`commandSelectors.js`).

### 1. Backend (`CommandManager`)
Located in `drone_gcs/python_service/command_manager.py`.

- **Per-Vehicle Locks**: Commands sent to a specific vehicle (sysid, compid) are processed sequentially via an `asyncio.Lock`. This prevents a new command from clashing with a command that is currently `IN_PROGRESS` (e.g., a long-running sensor calibration).
- **Execution Workflow**:
  - Encodes the command via `command_long_send` or `command_int_send`.
  - Begins polling a `_pending_acks` dictionary for an acknowledgment.
  - If a `COMMAND_ACK` arrives with `MAV_RESULT_IN_PROGRESS`, the internal deadline is automatically extended.
  - If the timeout expires before any ACK, the command is retried up to `max_retries`.
- **Event Bus Broadcasting**: The engine state (active command, progress percent, result) is broadcasted at 10Hz via ZeroMQ to the Node.js gateway.

### 2. Frontend (`commandSelectors.js`)
Located in `drone_gcs/frontend/src/telemetry/commandSelectors.js`.

- Normalizes the `engineCommandStatus` payload.
- Injects a strict `isStale` flag: if the backend reports a command is executing but the `last_update` timestamp is older than 15 seconds, the state is considered stale (e.g., backend crashed or link died without firing a disconnect event).
- Protects against commands during a `DISCONNECTED` state.
