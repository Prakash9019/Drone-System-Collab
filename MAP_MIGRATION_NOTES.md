# Map Component Migration Notes

When building the final map visualizations (e.g. Leaflet overlays), please follow these architectural guidelines to integrate with the new normalization layer.

## 1. Avoid Direct Store Dependencies
**Do not** read `state.telemetry[id]` or raw coordinate math directly inside your Leaflet components. Instead, pipe the Zustand state through the exported `mapSelectors.js`.

**Legacy Anti-Pattern:**
```javascript
const raw = useTelemetryStore(state => state.telemetry[state.primarySysId]);
const position = [raw.position.lat, raw.position.lng]; // Crashing if position is null!
```

**New Modernized Pattern:**
```javascript
import useTelemetryStore, { selectMapVehicle } from '../store/useTelemetryStore';

const vehicle = useTelemetryStore(selectMapVehicle);
if (!vehicle?.position) return <MapLoadingState />;
```

## 2. Using the Mission Overlay
The `selectMapMissionOverlay` selector accepts both the mission state and telemetry state so that it can correctly merge the static uploaded waypoints with the real-time execution telemetry (e.g. tracking `activeSeq`).

```javascript
import useMissionStore, { selectMapMissionOverlay } from '../store/useMissionStore';
import useTelemetryStore from '../store/useTelemetryStore';

function MissionOverlay() {
  const missionState = useMissionStore();
  const telemetryState = useTelemetryStore();
  
  // Normalized mission data
  const { waypoints, activeSeq, isSyncing, isStale } = selectMapMissionOverlay(missionState, telemetryState);

  return (
     <div className={isSyncing ? 'map-dimmed' : ''}>
         {waypoints.filter(wp => wp.isValid).map(wp => (
            <WaypointMarker 
                key={wp.seq} 
                lat={wp.lat} 
                lng={wp.lng} 
                isActive={wp.isActive} 
            />
         ))}
     </div>
  );
}
```

## 3. Handling "Null Island"
If your map is randomly jumping to coordinates `(0, 0)` off the coast of Africa when the drone boots up, ensure you are utilizing `selectMapVehicle`. The modernized selector will automatically suppress `(0,0)` coordinate broadcasts unless the telemetry specifically confirms a 3D GPS lock is held.
