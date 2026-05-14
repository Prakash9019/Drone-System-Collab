# Preflight UI Migration Notes

When building the final HUD or flight readiness dashboards, UI engineers should strictly avoid duplicating sensor logic on the client. 

## Legacy Anti-Pattern
Do not manually check telemetry state on the frontend:
```javascript
// DO NOT DO THIS
const { battery, status } = useTelemetryStore(state => state.telemetry[state.primarySysId]);
const isReadyToArm = battery.remaining > 20 && status.gps_fix >= 3 && status.armed === false;
```
This forces the frontend to understand complex MAVLink schemas like `EKF_STATUS_FLAGS` bitmasks and spreads safety logic across multiple React components.

## Modern Pattern
Use the `selectPreflightStatus` hook to pull the pre-aggregated backend evaluation, which now includes advanced scoring, temporal tracking (`first_seen`/`last_seen`), and cleanly segregated lists of blocking vs warning checks:

```javascript
import useTelemetryStore from '../store/useTelemetryStore';
import { selectPreflightStatus } from '../telemetry/preflightSelectors';

function PreflightChecklist() {
  const { 
    isReadyToArm, 
    score, 
    blockingChecks, 
    warningChecks, 
    statusTexts 
  } = useTelemetryStore(selectPreflightStatus);

  return (
    <div className="checklist-panel">
      <h2>Readiness: {score}/100 ({isReadyToArm ? "Ready" : "Not Ready"})</h2>
      
      {blockingChecks.length > 0 && (
        <div className="blocks">
          <h3>Critical Blocks</h3>
          <ul>
            {blockingChecks.map(check => (
              <li key={check.id}>
                <strong>{check.category}:</strong> {check.message} 
                <small>(Active since: {new Date(check.first_seen * 1000).toLocaleTimeString()})</small>
              </li>
            ))}
          </ul>
        </div>
      )}

      {statusTexts.length > 0 && (
        <div className="vehicle-messages">
          <h3>Vehicle Logs</h3>
          <ul>
            {statusTexts.map((msg, i) => (
              <li key={i} className={`log-${msg.status.toLowerCase()}`}>
                {msg.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

By relying on this selector, the UI will automatically respond to new safety conditions (like vibration thresholds or compass calibration checks) as they are added to the Python engine in the future, without requiring frontend updates.
