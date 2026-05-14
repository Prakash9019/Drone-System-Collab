export const PARAMETER_CATEGORIES = {
  Favorites: [],
  PID: ['ATC_', 'PSC_', 'RATE_', 'Q_A_RAT'],
  EKF: ['EK', 'AHRS_'],
  GPS: ['GPS_', 'GPS'],
  Battery: ['BATT', 'BAT_'],
  RTL: ['RTL_', 'WP_YAW_BEHAVIOR'],
  Fence: ['FENCE_', 'FNC_'],
  Logging: ['LOG_', 'LOG'],
  Sensors: ['INS_', 'COMPASS_', 'BARO_'],
  FlightModes: ['FLTMODE', 'MODE'],
  Navigation: ['WPNAV_', 'NAVL1_', 'MIS_'],
  ATC: ['ATC_'],
  OSD: ['OSD_'],
  RC: ['RC', 'SERVO', 'CH'],
  Power: ['PWR', 'BATT'],
  Failsafe: ['FS_', 'FAILSAFE'],
};

/**
 * Extracts the parameter sync state from the telemetry store.
 * Supports stale state and disconnected status.
 *
 * @param {object} state - Full Zustand state
 * @returns {object} { isLoading, isStale, isDisconnected, syncState, received, reported, missing, progress_percent }
 */
export function selectParameterSyncState(state) {
  const syncStatus = state.paramSyncStatus || {};
  const isDisconnected = state.connectionState === 'DISCONNECTED';
  
  // Consider parameters stale if we haven't received an update in > 15s and we are connected
  const now = Date.now();
  const lastUpdate = (syncStatus.last_update || 0) * 1000;
  const isStale = !isDisconnected && (now - lastUpdate > 15000) && syncStatus.state === 'COMPLETE';
  
  return {
    isDisconnected,
    isStale,
    isLoading: syncStatus.state === 'SYNCING' || syncStatus.state === 'RECOVERING_MISSING',
    syncState: isDisconnected ? 'DISCONNECTED' : (syncStatus.state || 'UNKNOWN'),
    received: syncStatus.received || 0,
    reported: syncStatus.reported || 0,
    missing: syncStatus.missing || 0,
    progressPercent: syncStatus.progress_percent || 0,
    cacheLoaded: syncStatus.cache_loaded || false,
    cacheSource: syncStatus.cache_source || null,
  };
}

/**
 * Normalizes and groups raw parameters from the vehicle state.
 *
 * @param {object} state - Full Zustand state
 * @param {object} paramMeta - The fetched metadata map
 * @param {Set<string>} favorites - Set of favorited parameter keys
 * @param {string} [vehicleId] - Optional specific vehicle ID, defaults to primary
 * @returns {Array} List of [key, value, meta] grouped and filtered
 */
export function selectGroupedParameters(state, paramMeta, favorites, vehicleId) {
  const targetId = vehicleId || state.primarySysId;
  const vehicle = targetId && state.telemetry ? state.telemetry[targetId] : null;
  const parameters = vehicle?.parameters || {};

  const paramEntries = Object.entries(parameters).map(([key, val]) => {
    const meta = paramMeta[key] || paramMeta[String(key).toUpperCase()] || {};
    return [key, val, meta];
  });

  return paramEntries;
}

export function filterParameters(paramEntries, category, searchTerm, favorites, sortBy) {
  const inCategory = (key) => {
    if (category === 'ALL') return true;
    if (category === 'Favorites') return favorites.has(key);
    const prefixes = PARAMETER_CATEGORIES[category] || [];
    return prefixes.some((p) => key.startsWith(p));
  };

  return paramEntries
    .filter(([key]) => key.toLowerCase().includes(searchTerm.toLowerCase()))
    .filter(([key]) => inCategory(key))
    .sort((a, b) => {
      if (sortBy === 'value') return Number(a[1]) - Number(b[1]);
      return a[0].localeCompare(b[0]);
    });
}
