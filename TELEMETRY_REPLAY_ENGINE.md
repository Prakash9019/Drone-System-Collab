# Telemetry Replay Engine Architecture

The Telemetry Replay Engine enables recording of live flight data (telemetry, commands, preflight evaluation, and missions) and powers post-flight playback directly within the GCS interface. 

## 1. Backend Architecture (`replay_manager.py`)
The system intercepts ZMQ traffic inside the `telemetry_pub` pipeline:
- **Recording**: Captures outbound ZMQ JSON payloads. It assigns a precise relative timestamp to each event (offset from recording start `t=0.0`) and saves the stream as JSON Lines (`.jsonl`) to a `recordings/` directory.
- **Playback**: Operates an `asyncio` timeline task. It reads the `.jsonl` file, computes the time delta between recorded events, and utilizes `asyncio.sleep()` to recreate the original sequencing and temporal spacing.

## 2. Replay Safety & State Management
To ensure replay traffic does not corrupt the live telemetry views of other connected clients, the Replay Engine forces an `"is_replay": true` flag into the payload dictionary before transmitting over the ZMQ socket. 

The Node.js Gateway parses this flag and lifts it to the envelope (`envelope.is_replay = true`).

The React Frontend implements a strict **Mode Filter** in `telemetrySyncReducer.js`:
- If `mode === 'LIVE'`, it drops all incoming packets marked as replay.
- If `mode === 'REPLAY'`, it drops all incoming packets originating from the live vehicle.

## 3. Playback API Endpoints (`main.py`)
- `POST /replay/record/start` -> Returns `session_id`
- `POST /replay/record/stop`
- `GET /replay/sessions`
- `POST /replay/playback/start` -> Requires `{ session_id }`
- `POST /replay/playback/pause`
- `POST /replay/playback/resume`
- `POST /replay/playback/seek` -> Requires `{ time_s }`

## 4. Replay Status Broadcasts
During playback, the engine continually broadcasts a `REPLAY_STATUS` packet:
```json
{
  "type": "REPLAY_STATUS",
  "data": {
    "is_playing": true,
    "is_paused": false,
    "playback_session_id": "uuid",
    "progress_s": 15.2,
    "duration_s": 120.5,
    "speed": 1.0
  }
}
```
This payload bypasses the frontend mode filter, ensuring the UI always knows the status of the playback engine regardless of whether the user is viewing the live or replay stream.
