/**
 * Selectors for extracting MAVLink Command Engine state from the Zustand store.
 * Supports multi-drone readiness by optionally filtering by vehicleId.
 */

/**
 * Returns the currently executing command state for a specific vehicle.
 * @param {Object} state - The complete Zustand store state.
 * @param {number|null} [vehicleId=null] - The system ID to query. If null, queries the primary vehicle.
 * @returns {Object} Command state object
 */
export const selectCommandState = (state, vehicleId = null) => {
  const targetId = vehicleId ?? state.primarySysId;
  const isDisconnected = state.connectionState === 'DISCONNECTED' || !state.connected;

  if (isDisconnected || !targetId) {
    return {
      isExecuting: false,
      command: null,
      progress: 0,
      resultText: 'DISCONNECTED',
      isStale: false,
    };
  }

  const engineState = state.engineCommandStatus || {};
  const vehicleCmdState = engineState[targetId];

  if (!vehicleCmdState) {
    return {
      isExecuting: false,
      command: null,
      progress: 0,
      resultText: 'IDLE',
      isStale: false,
    };
  }

  // Check staleness (if we haven't received an update in 15 seconds while executing)
  const isStale =
    vehicleCmdState.is_executing &&
    Date.now() / 1000 - vehicleCmdState.last_update > 15;

  return {
    isExecuting: vehicleCmdState.is_executing,
    command: vehicleCmdState.command,
    progress: vehicleCmdState.progress,
    resultText: vehicleCmdState.result_text,
    isStale,
  };
};
