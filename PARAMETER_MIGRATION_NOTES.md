# Parameter Subsystem Migration Notes

This guide outlines the migration from the inline parameter state management to the new selector-based parameter architecture.

## 1. What Changed?

Previously, `Params.jsx` directly read `vehicle.parameters` and performed inline filtering and sorting. Now, the logic has been extracted into `parameterSelectors.js`.

### Key Additions:
- **Centralized Grouping**: The `CATEGORIES` dictionary is now managed centrally.
- **Disconnected States**: Parameters will now gray out if the vehicle connection drops. The selector returns `isDisconnected = true`.
- **Stale Data Monitoring**: If the sync state halts but the connection remains, the UI marks the data as `isStale`.
- **Multi-Drone Readiness**: The new selectors accept an optional `vehicleId` to query parameters for drones other than the `primarySysId`.

## 2. Developer Best Practices

When building new UI components that require parameters:
1. **Never read `vehicle.parameters` directly.**
   - **Why?**: Reading the raw object bypasses metadata (types, units) and stale state detection.
   - **Do this instead**: Use `selectGroupedParameters` to get normalized entries.

2. **Always respect `isDisconnected` and `isStale`.**
   - **Why?**: A drone might disconnect abruptly. We must prevent users from sending `PARAM_SET` commands into the void. Disable input fields if `isDisconnected` is true.

3. **Check `syncStateInfo.isLoading` during writes.**
   - Disable input fields globally during a bulk `refresh` to prevent race conditions while the param cache is overwritten.

## 3. Example Implementation

```javascript
import useTelemetryStore from '../store/useTelemetryStore';
import { selectParameterSyncState, selectGroupedParameters } from '../telemetry/parameterSelectors';

function MyParamWidget() {
  const syncStateInfo = useTelemetryStore(selectParameterSyncState);
  // Get params for primary vehicle
  const params = useTelemetryStore((state) => selectGroupedParameters(state, paramMeta, favorites));
  
  if (syncStateInfo.isDisconnected) {
    return <div>Disconnected from drone.</div>;
  }
  
  // Render params securely
}
```
