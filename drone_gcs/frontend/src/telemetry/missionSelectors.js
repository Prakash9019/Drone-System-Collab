/**
 * Selectors for extracting MAVLink Mission Engine state from the Zustand store.
 */

/**
 * Returns the current mission synchronization state.
 * @param {Object} state - The complete Zustand store state.
 * @returns {Object} Mission sync state object
 */
export const selectMissionSyncState = (state) => {
  const isDisconnected = state.connectionState === 'DISCONNECTED' || !state.connected;

  const rawStatus = state.missionSyncStatus || {
    session_id: null,
    phase: 'IDLE',
    mission_type: 'MISSION',
    direction: null,
    total: 0,
    current: 0,
    ok: null,
    last_ack: null,
    error: '',
    updated_at: 0.0,
    mission_version: null,
    duration_s: 0.0,
    retries: 0,
  };

  if (isDisconnected) {
    return {
      sessionId: null,
      phase: 'IDLE',
      direction: null,
      total: 0,
      current: 0,
      progress: 0,
      isExecuting: false,
      isStale: false,
      error: 'DISCONNECTED',
      missionVersion: null,
      durationS: 0.0,
      retries: 0,
    };
  }

  // Calculate progress safely
  let progress = 0;
  if (rawStatus.total > 0) {
    progress = Math.min(100, Math.max(0, (rawStatus.current / rawStatus.total) * 100));
  } else if (rawStatus.direction === 'upload') {
     // If we are uploading and we don't have total for some reason, just base it on 0.
     // Normally total is set to len(items)
     progress = 0;
  }

  const isExecuting =
    rawStatus.phase !== 'IDLE' && rawStatus.phase !== 'DONE' && rawStatus.phase !== 'FAILED';

  // Check staleness (if we haven't received an update in 15 seconds while executing)
  const isStale =
    isExecuting &&
    Date.now() / 1000 - rawStatus.updated_at > 15;

  return {
    sessionId: rawStatus.session_id,
    phase: rawStatus.phase,
    direction: rawStatus.direction,
    total: rawStatus.total,
    current: rawStatus.current,
    progress: Math.round(progress),
    isExecuting,
    isStale,
    error: rawStatus.error,
    missionVersion: rawStatus.mission_version,
    durationS: rawStatus.duration_s,
    retries: rawStatus.retries,
  };
};
