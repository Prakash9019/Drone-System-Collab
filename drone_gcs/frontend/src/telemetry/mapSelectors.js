import { selectPrimaryVehicleDerived, selectPrimaryVehicleRaw } from './telemetrySelectors';
import { selectMissionSyncState } from './missionSelectors';

/**
 * Normalizes vehicle telemetry specifically for map rendering engines (Leaflet, Mapbox).
 * Filters out "Null Island" (0,0) when GPS fix is missing, extracting heading and home.
 * 
 * @param {Object} state - The Zustand telemetry store state
 * @returns {Object|null} Normalized vehicle map state or null if disconnected/invalid
 */
export const selectMapVehicle = (state) => {
  const isDisconnected = state.connectionState === 'DISCONNECTED' || !state.connected;
  if (isDisconnected) return null;

  const derived = selectPrimaryVehicleDerived(state);
  const raw = derived.raw;
  if (!raw) return null;

  const pos = raw.position || {};
  const status = raw.status || {};
  const isNullIsland = pos.lat === 0.0 && pos.lng === 0.0;
  
  // Reject (0,0) if there's no 3D GPS fix (usually fix > 2 is 3D, some systems use 3)
  // Or simply reject exact (0,0) as an anomaly unless specifically overriden
  const hasValidGps = !isNullIsland || status.gps_fix >= 3;
  
  const heading = raw.velocity?.heading ?? null;
  const attitudeYaw = raw.attitude?.yaw != null ? (raw.attitude.yaw * 180 / Math.PI) : 0;
  
  let finalHeading = heading;
  if (finalHeading == null || finalHeading < 0) {
    let yawDeg = attitudeYaw;
    while (yawDeg < 0) yawDeg += 360;
    while (yawDeg >= 360) yawDeg -= 360;
    finalHeading = yawDeg;
  }

  const home = raw.home?.valid ? {
    lat: raw.home.lat,
    lng: raw.home.lng,
    alt: raw.home.alt_m,
  } : null;

  return {
    position: hasValidGps ? { lat: pos.lat, lng: pos.lng, alt: pos.alt_rel || pos.alt_amsl || 0 } : null,
    heading: finalHeading,
    home,
    isStale: derived.stale?.any_stale || false,
    isDisconnected: false,
    mode: status.mode || 'UNKNOWN',
    armed: !!status.armed,
  };
};

/**
 * Normalizes the active mission plan and overlays it with real-time progress.
 * 
 * @param {Object} missionState - The Zustand mission store state (useMissionStore)
 * @param {Object} telemetryState - The Zustand telemetry store state (useTelemetryStore)
 * @returns {Object} Normalized mission overlay state
 */
export const selectMapMissionOverlay = (missionState, telemetryState) => {
  const waypoints = missionState.waypoints || [];
  
  const rawVehicle = selectPrimaryVehicleRaw(telemetryState);
  let activeSeq = missionState.missionCurrentSeq;
  
  // If telemetry tells us the active sequence, prefer that over the local store
  if (rawVehicle?.mission?.current_seq != null && rawVehicle.mission.current_seq >= 0) {
    activeSeq = rawVehicle.mission.current_seq;
  }

  const syncState = selectMissionSyncState(telemetryState);
  const isSyncing = syncState.isExecuting;
  const isStale = syncState.isStale;

  // Map-safe coordinate validation
  const validWaypoints = waypoints.map(wp => ({
    ...wp,
    isActive: wp.seq === activeSeq,
    isValid: wp.lat >= -90 && wp.lat <= 90 && wp.lng >= -180 && wp.lng <= 180 && !(wp.lat === 0 && wp.lng === 0),
  }));

  return {
    waypoints: validWaypoints,
    activeSeq,
    isSyncing,
    syncProgress: syncState.progress,
    isStale,
  };
};
