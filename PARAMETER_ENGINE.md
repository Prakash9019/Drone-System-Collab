# MAVLink Parameter Engine Architecture

This document describes the backend and frontend parameter management subsystem implemented for the Drone-System-Collab GCS.

## 1. Backend Engine (Python)

The core MAVLink parameter synchronization logic resides in `drone_gcs/python_service/parameter_manager.py`. It is responsible for orchestrating the `PARAM_REQUEST_LIST` flow, managing parameter caches, and providing verification for `PARAM_SET` operations.

### Key Responsibilities:
- **`PARAM_REQUEST_LIST` Handling**: Initiates the bulk parameter download. The engine uses a timeout-based recovery loop (`param_request_read_send`) to fetch any parameters that are missing from the initial stream.
- **`PARAM_VALUE` Synchronization**: Ingests incoming parameters, updates the `parameters` dictionary, and tracks synchronization progress (received vs reported total).
- **`PARAM_SET` with Verification**: Modifying a parameter involves sending the `PARAM_SET` command and awaiting a subsequent `PARAM_VALUE` acknowledgment matching the requested value. If the ACK times out, the command is considered failed and is automatically rolled back.
- **Cache Management**: To reduce bandwidth on connection, parameters can be cached to disk. The engine can load this cache if it is within a specified maximum age.

## 2. Telemetry Ingestion & API Layer (Node.js)

The Python service broadcasts periodic telemetry over a ZeroMQ PUB socket. The Node.js gateway subscribes to these updates and bridges them to the frontend via WebSockets.
- The `PARAM_SYNC_STATUS` message contains metadata about the sync progress (`state`, `received`, `reported`, `missing`, etc.).
- The frontend fetches the actual normalized parameter payload via the REST API (`/api/parameters/export`).

## 3. Frontend Selectors & Normalization (React)

To keep the UI decoupled from raw backend schemas, the frontend uses `parameterSelectors.js`.

### Features:
- **`selectParameterSyncState`**: Normalizes the connection and sync status. It calculates staleness (e.g. if connected but no updates within 15 seconds) and translates disconnected events into safe UI states.
- **`selectGroupedParameters`**: Maps the raw dictionary from the vehicle state into an array of entries `[key, value, metadata]`. It uses `param_metadata_common.json` to attach types, units, and descriptions to raw keys.
- **Multi-Drone Readiness**: The selectors are designed to accept an explicit `vehicleId`, allowing multiple drones to maintain isolated parameter caches within the central `useTelemetryStore`.

## 4. Disconnected and Stale States

The frontend engine enforces strict visibility of stale data:
- If a vehicle disconnects, the UI immediately grays out parameter inputs and disables `Fetch` and `Save` buttons.
- If a parameter sync fails or halts midway, the `isStale` boolean is triggered, visually warning the user that the displayed values may not match the actual vehicle state.
