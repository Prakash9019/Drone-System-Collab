# Command Engine Migration Notes

This guide outlines the changes made when migrating from the legacy inline command loops to the new centralized `CommandManager` architecture.

## 1. What Changed in the Backend?

Previously, `LinkManager.send_command` used a simple loop and a generic dictionary (`self.pending_commands`). It was vulnerable to:
- Overlapping commands to the same vehicle.
- Ignoring `MAV_RESULT_IN_PROGRESS` (which caused timeouts on long commands like sensor calibration).
- Dropping duplicate ACKs.

The logic is now in `command_manager.py`. `LinkManager.send_command` now acts as a proxy to `self.command_manager.execute_command`.

## 2. Best Practices for Frontend Integration

When building actions panels or UI elements that trigger vehicle commands:

1. **Avoid the Local `commandStatus` Dictionary:**
   - Previously, `sendShortcutCommand` created a local mock-status dict while waiting for the HTTP POST to return.
   - Now, you should rely on the global `engineCommandStatus` synced via WebSocket.

2. **Use the Selector:**
   ```javascript
   import { selectCommandState } from '../telemetry/commandSelectors';
   import useTelemetryStore from '../store/useTelemetryStore';

   function MyActionWidget() {
     // Get command execution state (progress, lock status) for the primary drone
     const { isExecuting, command, progress, resultText, isStale } = 
       useTelemetryStore(state => selectCommandState(state));

     if (isExecuting) {
       return <div>Executing command {command}... {progress}%</div>;
     }

     return <button>Execute</button>;
   }
   ```

3. **Check for Disconnections:**
   The `selectCommandState` selector automatically resolves to `isExecuting: false` and `resultText: 'DISCONNECTED'` if the drone disconnects. This inherently disables command buttons if you rely on the selector.
