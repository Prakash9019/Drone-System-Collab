# Replay UI Migration Notes

The backend replay engine supports full capture of vehicle telemetry, commands, preflight state, and mission synchronization. 

## 1. Connecting the UI to the Replay APIs

Frontend developers can now build playback controls using the exposed REST API in `main.py`:

```javascript
// Start a replay session
await fetch('/replay/playback/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session_id: '123e4567-e89b-12d3-a456-426614174000' })
});

// Playback controls
await fetch('/replay/playback/pause', { method: 'POST' });
await fetch('/replay/playback/resume', { method: 'POST' });

// Seek to exactly 30 seconds into the flight
await fetch('/replay/playback/seek', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ time_s: 30.0 })
});
```

## 2. Managing Frontend Mode

By default, the React frontend ignores replay packets if the UI is in `LIVE` mode. When building the replay viewer, you **must** explicitly switch the store mode to `REPLAY` to view the historical data.

```javascript
import useTelemetryStore from '../store/useTelemetryStore';

// In your ReplayViewer.jsx component
useEffect(() => {
  useTelemetryStore.setState({ mode: 'REPLAY' });
  
  return () => {
    useTelemetryStore.setState({ mode: 'LIVE' });
  };
}, []);
```

## 3. Reading Playback Status

You can monitor the exact timeline status of the replay directly from Zustand without making REST calls. This is useful for building progress bars or scrubbing timelines.

```javascript
const replayStatus = useTelemetryStore(state => state.replayStatus);

function ReplayProgressBar() {
  if (!replayStatus.is_playing) return null;
  
  const pct = (replayStatus.progress_s / replayStatus.duration_s) * 100;
  
  return (
    <div>
      <span>{replayStatus.progress_s.toFixed(1)}s / {replayStatus.duration_s.toFixed(1)}s</span>
      <div className="progress-bar-bg">
        <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
```
