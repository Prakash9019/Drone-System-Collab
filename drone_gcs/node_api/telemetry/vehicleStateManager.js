/**
 * Multi-vehicle snapshot retention and reconnect hygiene (Node telemetry core).
 */

class VehicleStateManager {
  constructor() {
    /** @type {Map<string, { lastData: Record<string, unknown>, lastSnapshotAt: number, groupLastActivity: Record<string, number> }>} */
    this._vehicles = new Map();
    /** @type {string|null} */
    this._lastConnectionState = null;
    /** @type {string|null} */
    this._primarySysId = null;
  }

  get lastConnectionState() {
    return this._lastConnectionState;
  }

  get primarySysId() {
    return this._primarySysId;
  }

  /**
   * @returns {string[]}
   */
  listVehicleIds() {
    return [...this._vehicles.keys()];
  }

  /**
   * @param {string} id
   */
  getVehicleSnapshot(id) {
    const v = this._vehicles.get(id);
    if (!v) return null;
    return {
      ...v.lastData,
      _engine: { lastSnapshotAt: v.lastSnapshotAt, groupLastActivity: { ...v.groupLastActivity } },
    };
  }

  /**
   * @param {Record<string, unknown>} data
   */
  applyConnectionStatus(data) {
    const prev = this._lastConnectionState;
    const cs = typeof data.connection_state === 'string' ? data.connection_state : 'DISCONNECTED';
    this._lastConnectionState = cs;
    const ps = data.primary_sysid;
    this._primarySysId = ps != null && ps !== '' ? String(ps) : null;

    if (cs === 'DISCONNECTED' || cs === 'HEARTBEAT_LOST') {
      this._vehicles.clear();
    }
    return { from: prev, to: cs };
  }

  /**
   * Snapshot before an in-flight update (for change detection).
   * @param {string} vehicleId
   */
  getPreviousTelemetry(vehicleId) {
    const v = this._vehicles.get(vehicleId);
    if (!v) return null;
    return { ...v.lastData };
  }

  /**
   * @param {string} vehicleId
   * @param {Record<string, unknown>} data
   * @param {number} nowMs
   * @returns {{ previousSnapshotAt: number|null, groupLastActivity: Record<string, number> }}
   */
  recordTelemetrySnapshot(vehicleId, data, nowMs) {
    const existing = this._vehicles.get(vehicleId);
    const previousSnapshotAt = existing?.lastSnapshotAt ?? null;
    const groupLastActivity = existing?.groupLastActivity ?? {
      attitude: 0,
      position: 0,
      battery: 0,
      velocity: 0,
      status: 0,
    };

    const next = {
      lastData: { ...data },
      lastSnapshotAt: nowMs,
      groupLastActivity: { ...groupLastActivity },
    };
    this._vehicles.set(vehicleId, next);
    return { previousSnapshotAt, groupLastActivity: next.groupLastActivity };
  }

  /**
   * @param {string} vehicleId
   * @param {Record<string, number>} groupLastActivity
   */
  commitGroupActivity(vehicleId, groupLastActivity) {
    const v = this._vehicles.get(vehicleId);
    if (!v) return;
    v.groupLastActivity = { ...groupLastActivity };
  }
}

module.exports = { VehicleStateManager };
