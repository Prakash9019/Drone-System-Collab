/**
 * Derived telemetry selectors — read raw `telemetry[vehicleId]` plus `telemetry_engine` from Node.
 * HUD/map keep using raw `vehicle`; use these for freshness / normalized attitude / fleet views.
 */

import { deriveOperationalPhase } from '../utils/operationalState';

/** @param {Record<string, unknown>|undefined|null} v */
export function getTelemetryEngine(v) {
  if (!v || typeof v !== 'object') return null;
  const te = /** @type {Record<string, unknown>|undefined} */ (v.telemetry_engine);
  return te && typeof te === 'object' ? te : null;
}

/** @param {Record<string, unknown>|undefined|null} v */
export function getSchemaVersion(v) {
  if (!v || typeof v !== 'object') return null;
  const s = v.schema_version;
  return typeof s === 'string' ? s : null;
}

/**
 * Normalized slice from Node engine (degrees, EKF aggregate) when present.
 * @param {Record<string, unknown>|undefined|null} v
 */
export function selectNormalizedTelemetry(v) {
  const te = getTelemetryEngine(v);
  const n = te && typeof te.normalized === 'object' ? te.normalized : null;
  if (!n) return null;
  return {
    attitude_deg: /** @type {Record<string, number>|undefined} */ (n.attitude_deg) || null,
    attitude_rad: /** @type {Record<string, number>|undefined} */ (n.attitude_rad) || null,
    ekf:
      n.ekf && typeof n.ekf === 'object'
        ? {
            aggregate_score: Number(n.ekf.aggregate_score) || 0,
            health: String(n.ekf.health || 'OK'),
          }
        : null,
  };
}

/**
 * @param {Record<string, unknown>|undefined|null} v
 */
export function selectStaleTelemetry(v) {
  const te = getTelemetryEngine(v);
  const st = te && typeof te.stale === 'object' ? te.stale : null;
  if (!st) {
    return {
      snapshot_stale: false,
      snapshot_age_ms: null,
      link_live: false,
      groups: {},
      any_group_stale: false,
    };
  }
  const groups = /** @type {Record<string, { stale?: boolean }>} */ (st.groups || {});
  const any_group_stale = Object.values(groups).some((g) => g && g.stale);
  return {
    snapshot_stale: !!st.snapshot_stale,
    snapshot_age_ms: st.snapshot_age_ms == null ? null : Number(st.snapshot_age_ms),
    link_live: !!st.link_live,
    groups,
    any_group_stale,
    any_stale: !!st.snapshot_stale || any_group_stale,
  };
}

/**
 * @param {{ telemetry: Record<string, unknown>, primarySysId: string|null }} state
 */
export function selectPrimaryVehicleRaw(state) {
  const t = state.telemetry;
  const id = state.primarySysId;
  if (id != null && t[id] !== undefined) return t[id];
  const keys = Object.keys(t);
  return keys.length ? t[keys[0]] : undefined;
}

/**
 * Back-compat: same as `selectPrimaryVehicleRaw` (primary or first vehicle blob).
 * @param {{ telemetry: Record<string, unknown>, primarySysId: string|null }} state
 */
export function selectPrimaryVehicle(state) {
  return selectPrimaryVehicleRaw(state);
}

/**
 * @param {{ telemetry: Record<string, unknown>, primarySysId: string|null }} state
 */
export function selectPrimaryVehicleDerived(state) {
  const raw = selectPrimaryVehicleRaw(state);
  if (!raw) {
    return {
      raw: undefined,
      normalized: null,
      stale: selectStaleTelemetry(undefined),
      schema_version: null,
    };
  }
  return {
    raw,
    normalized: selectNormalizedTelemetry(raw),
    stale: selectStaleTelemetry(raw),
    schema_version: getSchemaVersion(raw),
  };
}

/**
 * @param {{ telemetry: Record<string, unknown> }} state
 */
export function selectAllVehicleIds(state) {
  return Object.keys(state.telemetry || {}).sort();
}

/**
 * @param {{ telemetry: Record<string, unknown> }} state
 */
export function selectFleetTelemetrySummary(state) {
  const ids = selectAllVehicleIds(state);
  return ids.map((id) => {
    const v = state.telemetry[id];
    return {
      id,
      schema_version: getSchemaVersion(v),
      stale: selectStaleTelemetry(v),
      has_normalized: !!selectNormalizedTelemetry(v),
    };
  });
}

/**
 * Attitude for display: prefer Node `attitude_deg`, else convert raw radians (Python).
 * @param {Record<string, unknown>|undefined|null} vehicle
 */
export function selectAttitudeDisplay(vehicle) {
  const n = selectNormalizedTelemetry(vehicle);
  if (n?.attitude_deg) {
    return {
      roll_deg: Number(n.attitude_deg.roll_deg),
      pitch_deg: Number(n.attitude_deg.pitch_deg),
      yaw_deg: Number(n.attitude_deg.yaw_deg),
      source: 'engine',
    };
  }
  const a = vehicle?.attitude;
  if (!a || typeof a !== 'object') {
    return { roll_deg: 0, pitch_deg: 0, yaw_deg: 0, source: 'none' };
  }
  const RAD2DEG = 180 / Math.PI;
  let yawDeg = Number(a.yaw) * RAD2DEG;
  while (yawDeg < 0) yawDeg += 360;
  while (yawDeg >= 360) yawDeg -= 360;
  return {
    roll_deg: Number(a.roll) * RAD2DEG,
    pitch_deg: Number(a.pitch) * RAD2DEG,
    yaw_deg: yawDeg,
    source: 'raw_rad',
  };
}

/**
 * @param {{ connectionState: string, telemetry: Record<string, unknown>, primarySysId: string|null }} state
 */
export function selectOperationalFromStore(state) {
  const vehicle = selectPrimaryVehicleRaw(state);
  return deriveOperationalPhase({
    connectionState: state.connectionState,
    vehicle,
  });
}

/**
 * @param {{ sync?: Record<string, unknown> }} state
 */
export function selectSyncTransport(state) {
  const s = state.sync || {};
  return {
    wsTransport: s.wsTransport || 'CLOSED',
    lastInboundAt: typeof s.lastInboundAt === 'number' ? s.lastInboundAt : null,
    inboundSeq: typeof s.inboundSeq === 'number' ? s.inboundSeq : 0,
    reconnectAttempts: typeof s.reconnectAttempts === 'number' ? s.reconnectAttempts : 0,
    lastEngineEnvelope: s.lastEngineEnvelope || null,
  };
}
