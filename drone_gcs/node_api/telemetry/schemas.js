/**
 * Typed telemetry contracts (JSDoc) for the Node telemetry core.
 * Wire payloads stay JSON-serializable; Python remains source of MAVLink decode.
 */

/** @typedef {'2026.1'} TelemetrySchemaVersion */

/** @typedef {'CONNECTION'|'TELEMETRY'|'PARAM'|'ADSB'|'UNKNOWN'} TelemetryEnvelopeKind */

/**
 * @typedef {Object} TelemetryEnvelopeV1
 * @property {1} v
 * @property {string} ts ISO8601
 * @property {number} monotonic_ms process.hrtime bigint ms (relative, not wall-clock across restarts)
 * @property {TelemetryEnvelopeKind} kind
 * @property {string} [name] original ZMQ `type` string
 * @property {string|null} [vehicle_id]
 * @property {TelemetrySchemaVersion} schema_version
 * @property {Record<string, unknown>} payload
 */

/** @type {TelemetrySchemaVersion} */
const TELEMETRY_SCHEMA_VERSION = '2026.1';

const KNOWN_ZMQ_TYPES = new Set([
  'TELEMETRY_UPDATE',
  'CONNECTION_STATUS',
  'PARAM_SYNC_STATUS',
  'ADSB_UPDATE',
]);

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
function safeJsonParse(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'non_string' };
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'not_object' };
    }
    return { ok: true, value: /** @type {Record<string, unknown>} */ (value) };
  } catch (e) {
    return { ok: false, error: 'json_parse' };
  }
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {obj is { type: string }}
 */
function hasTypeField(obj) {
  return typeof obj.type === 'string' && obj.type.length > 0;
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {boolean}
 */
function isKnownTelemetryMessage(obj) {
  return hasTypeField(obj) && KNOWN_ZMQ_TYPES.has(obj.type);
}

/**
 * @param {Record<string, unknown>} data
 * @returns {{ roll: number, pitch: number, yaw: number }}
 */
function attitudeRadiansFromVehicleData(data) {
  const att = /** @type {Record<string, unknown>|undefined} */ (data.attitude);
  if (!att || typeof att !== 'object') {
    return { roll: 0, pitch: 0, yaw: 0 };
  }
  const roll = Number(att.roll);
  const pitch = Number(att.pitch);
  const yaw = Number(att.yaw);
  return {
    roll: Number.isFinite(roll) ? roll : 0,
    pitch: Number.isFinite(pitch) ? pitch : 0,
    yaw: Number.isFinite(yaw) ? yaw : 0,
  };
}

/**
 * Mission Planner aligns HUD with degrees; Python stores ATTITUDE in radians.
 * @param {{ roll: number, pitch: number, yaw: number }} r
 */
function attitudeRadiansToDegrees(r) {
  const RAD2DEG = 180 / Math.PI;
  let yawDeg = r.yaw * RAD2DEG;
  while (yawDeg < 0) yawDeg += 360;
  while (yawDeg >= 360) yawDeg -= 360;
  return {
    roll_deg: r.roll * RAD2DEG,
    pitch_deg: r.pitch * RAD2DEG,
    yaw_deg: yawDeg,
  };
}

/**
 * EKF aggregate score (max variance) — mirrors Mission Planner `CurrentState` EKF scalar idea.
 * @param {Record<string, unknown>} data
 */
function ekfAggregateFromVehicleData(data) {
  const ekf = /** @type {Record<string, unknown>|undefined} */ (data.ekf_status);
  if (!ekf || typeof ekf !== 'object') {
    return { aggregate_score: 0, health: 'OK' };
  }
  const nums = [
    Number(ekf.velocity_variance),
    Number(ekf.pos_horiz_variance),
    Number(ekf.pos_vert_variance),
    Number(ekf.compass_variance),
    Number(ekf.terrain_alt_variance),
  ].filter((n) => Number.isFinite(n));
  const aggregate = nums.length ? Math.max(...nums.map((n) => Math.max(0, n))) : 0;
  let health = 'OK';
  if (aggregate > 0.8) health = 'BAD';
  else if (aggregate > 0.5) health = 'WARN';
  return { aggregate_score: aggregate, health };
}

module.exports = {
  TELEMETRY_SCHEMA_VERSION,
  KNOWN_ZMQ_TYPES,
  safeJsonParse,
  hasTypeField,
  isKnownTelemetryMessage,
  attitudeRadiansFromVehicleData,
  attitudeRadiansToDegrees,
  ekfAggregateFromVehicleData,
};
