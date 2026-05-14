# Map Integration Architecture

The Drone-System-Collab mapping integration normalizes raw MAVLink telemetry and mission data into map-safe overlays. This layer ensures robust rendering during dropped connections, stale telemetry updates, and invalid GPS states.

## Core Map Selectors (`frontend/src/telemetry/mapSelectors.js`)

We use two primary normalization functions:

### 1. `selectMapVehicle`
Extracts the live vehicle's footprint from `useTelemetryStore`.
- **Null Island Filtering**: Automatically strips exact `(0,0)` coordinate pairs unless the vehicle has a 3D GPS fix, preventing rendering engines from incorrectly jumping to the coast of Africa on boot.
- **Heading Extraction**: Prefers `velocity.heading`. If unavailable or invalid, dynamically derives the map rotation from `attitude.yaw`.
- **Home Position**: Exposes the `home` lat/lng if the drone has formally locked its origin.
- **Stale Detection**: Maps the `stale` telemetry flag to an `isStale` boolean, allowing map icons to become semi-transparent when the link drops.

### 2. `selectMapMissionOverlay`
Combines data from both `useMissionStore` and `useTelemetryStore` to output a fully contextualized mission path.
- **Coordinate Validation**: Ensures all loaded waypoints are within `-90/90` latitude and `-180/180` longitude bounds.
- **Active Waypoint Tracking**: Compares the local `missionCurrentSeq` with the vehicle's `mission.current_seq` from telemetry, identifying exactly which waypoint the drone is actively navigating toward.
- **Sync Status**: Exposes `isSyncing` and `syncProgress`, allowing the map UI to dim the mission path while a MAVLink upload or download operation is in progress.

## Best Practices for UI Development
When implementing Leaflet, React-Leaflet, or Mapbox, **do not** subscribe directly to `telemetry[vehicle_id]`. Always use the selectors:

```javascript
import useTelemetryStore from '../store/useTelemetryStore';
import { selectMapVehicle } from '../store/useTelemetryStore';

function DroneMarker() {
  const vehicle = useTelemetryStore(selectMapVehicle);
  if (!vehicle || !vehicle.position) return null;
  
  return <Marker position={vehicle.position} rotation={vehicle.heading} />;
}
```
