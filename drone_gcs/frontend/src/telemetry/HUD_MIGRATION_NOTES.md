# HUD Telemetry Integration Modernization

This document outlines the changes made to the `AdvancedHUD.jsx` component to modernize its telemetry integration and synchronize it with the Node.js `telemetry_engine` backend.

## 1. Overview of Changes

The `AdvancedHUD` component has been refactored to consume the new `telemetrySelectors.js` interface instead of relying purely on raw `vehicleState` data. 

**Goals Achieved:**
- **Normalized Telemetry:** Replaced inline math (e.g., radians to degrees) with `selectAttitudeDisplay`, which prefers pre-computed `attitude_deg` from the Node engine when available.
- **Stale Telemetry Handling:** Implemented `selectStaleTelemetry` to monitor link health and snapshot staleness. The HUD now displays "LINK DEAD" or "STALE TELEMETRY" indicators without unmounting or crashing.
- **Disconnected States:** When `vehicleState` is completely missing (e.g., initial load or full disconnect), the HUD remains visible but dims its subcomponents to 50% opacity and shows "DISCONNECTED" and placeholder strings instead of a blank screen.
- **EKF & Failsafe Normalization:** Integrated `selectNormalizedTelemetry` to display simplified EKF status (OK/WARN/BAD). Handled failsafe text directly from status flags.
- **Visual Stability & Transitions:** CSS `transform` interpolation (`0.1s linear`) was added to the HUD horizon and compass ribbons. This smooths out the 10Hz tick rate, providing a fluid rendering experience.

## 2. Component Layout & Styling

We have strictly preserved the existing CSS classes and DOM layout (`hud-compass-container`, `hud-horizon-clip`, `hud-overlay`, etc.).

The only rendering changes are dynamically injected inline styles for:
- **Opacity**: Drops to `0.5` when disconnected.
- **Transitions**: Added `transition: transform 0.1s linear` for smooth attitude updates.
- **Colorized Text**: Added standard danger/warning colors for STALE and LINK DEAD states.

## 3. Selector Usage Guide

For future frontend components needing telemetry data, adhere to the pattern established in `AdvancedHUD.jsx`:

1. **Avoid raw math:** Use `selectAttitudeDisplay(vehicleState)` rather than `attitude.roll * 180 / Math.PI`.
2. **Handle connection states gracefully:**
   ```javascript
   const staleData = selectStaleTelemetry(vehicleState);
   if (!staleData.link_live) { /* Show offline indicator */ }
   ```
3. **Use normalized safety data:**
   ```javascript
   const normalizedData = selectNormalizedTelemetry(vehicleState);
   const ekfHealth = normalizedData?.ekf?.health; // 'OK', 'WARN', 'BAD'
   ```

## 4. Multi-Drone Readiness

Because `AdvancedHUD.jsx` now strictly relies on the selectors operating on the specific `vehicleState` blob passed to it as a prop, it is fully agnostic of the global state structure. If the fleet roster changes or multiple HUDs are instantiated for different drones, it simply requires passing the specific drone's `vehicleState` snippet via `useTelemetryStore` selectors (`selectPrimaryVehicleRaw` or mapping over `telemetry`).
