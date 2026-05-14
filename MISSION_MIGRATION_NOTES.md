# Mission Engine Migration Notes

This guide explains how to properly interact with the new mission engine from the frontend. 

## 1. Do Not Block the UI on API Calls

Previously, if you triggered a mission download (`GET /api/mission`), you had to show a local spinner while the HTTP request hung for 5+ seconds waiting for the Python backend to negotiate the download. 

**What Changed:**
While the HTTP request still blocks until completion, you should no longer rely purely on local React state to render progress. The backend now streams `MISSION_SYNC_STATUS` natively.

## 2. Reading Mission Progress

Use the new selector in your map or mission planner components to read the live state of any upload/download operation:

```javascript
import useTelemetryStore from '../store/useTelemetryStore';
import { selectMissionSyncState } from '../telemetry/missionSelectors';

function MissionProgressOverlay() {
  const { isExecuting, progress, direction, error, isStale } = useTelemetryStore(selectMissionSyncState);

  if (!isExecuting) return null;
  
  if (isStale) {
    return <div className="warning">Mission sync stalled!</div>;
  }

  return (
    <div className="overlay">
      {direction === 'upload' ? 'Uploading Mission' : 'Downloading Mission'}...
      <progress value={progress} max={100} />
      {error && <span className="error">{error}</span>}
    </div>
  );
}
```

## 3. Mission Versioning
Instead of deep-comparing arrays of mission items to see if the mission has changed, you can now monitor the `missionVersion` string. 

```javascript
const missionVersion = useTelemetryStore(state => selectMissionSyncState(state).missionVersion);

useEffect(() => {
    if (missionVersion) {
        // Fetch new mission items or invalidate local cache
        fetchMissionItems();
    }
}, [missionVersion]);
```
This UUID hash rotates every time a successful upload, download, or clear operation occurs.
