/**
 * Multi-vehicle snapshot retention and reconnect hygiene (Node telemetry core).
 *
 * Fleet-aware: state is tracked per drone (the Python session's drone_id) so a
 * disconnect on one drone's link wipes only that drone's vehicles. Pre-fleet
 * messages carry no drone_id and map to DEFAULT_DRONE_ID with unprefixed
 * vehicle keys, keeping the legacy single-drone wire shape intact.
 */

const DEFAULT_DRONE_ID = 'default';

class VehicleStateManager {
  constructor() {
    /** @type {Map<string, { lastData: Record<string, unknown>, lastSnapshotAt: number, groupLastActivity: Record<string, number> }>} */
    this._vehicles = new Map();
    /** @type {Map<string, string>} per-drone connection state */
    this._connStates = new Map();
    /** @type {Map<string, string|null>} per-drone primary sysid */
    this._primaries = new Map();
  }

  /**
   * Composite storage key. The default drone keeps bare sysid keys so the
   * legacy frontend (which keys telemetry by vehicle_id) sees no change.
   */
  vehicleKey(droneId, vehicleId) {
    const d = droneId || DEFAULT_DRONE_ID;
    return d === DEFAULT_DRONE_ID ? String(vehicleId) : `${d}:${vehicleId}`;
  }

  /** Legacy getter — the default drone's connection state. */
  get lastConnectionState() {
    return this._connStates.get(DEFAULT_DRONE_ID) ?? null;
  }

  /** Legacy getter — the default drone's primary sysid. */
  get primarySysId() {
    return this._primaries.get(DEFAULT_DRONE_ID) ?? null;
  }

  connectionStateFor(droneId) {
    return this._connStates.get(droneId || DEFAULT_DRONE_ID) ?? null;
  }

  primarySysIdFor(droneId) {
    return this._primaries.get(droneId || DEFAULT_DRONE_ID) ?? null;
  }

  listDroneIds() {
    return [...this._connStates.keys()];
  }

  /**
   * @param {string} [droneId] restrict to one drone; omit for every key (legacy)
   * @returns {string[]}
   */
  listVehicleIds(droneId) {
    if (droneId === undefined) return [...this._vehicles.keys()];
    const d = droneId || DEFAULT_DRONE_ID;
    if (d === DEFAULT_DRONE_ID) {
      return [...this._vehicles.keys()].filter((k) => !k.includes(':'));
    }
    const prefix = `${d}:`;
    return [...this._vehicles.keys()].filter((k) => k.startsWith(prefix));
  }

  /**
   * @param {string} id composite vehicle key
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
   * Per-drone connection transition; DISCONNECTED/HEARTBEAT_LOST wipes ONLY
   * that drone's vehicles.
   * @param {Record<string, unknown>} data
   * @param {string} [droneId]
   */
  applyConnectionStatus(data, droneId) {
    const d = droneId || DEFAULT_DRONE_ID;
    const prev = this._connStates.get(d) ?? null;
    const cs = typeof data.connection_state === 'string' ? data.connection_state : 'DISCONNECTED';
    this._connStates.set(d, cs);
    const ps = data.primary_sysid;
    this._primaries.set(d, ps != null && ps !== '' ? String(ps) : null);

    if (cs === 'DISCONNECTED' || cs === 'HEARTBEAT_LOST') {
      for (const key of this.listVehicleIds(d)) {
        this._vehicles.delete(key);
      }
    }
    return { from: prev, to: cs };
  }

  /**
   * Snapshot before an in-flight update (for change detection).
   * @param {string} vehicleId composite vehicle key
   */
  getPreviousTelemetry(vehicleId) {
    const v = this._vehicles.get(vehicleId);
    if (!v) return null;
    return { ...v.lastData };
  }

  /**
   * @param {string} vehicleId composite vehicle key
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
   * @param {string} vehicleId composite vehicle key
   * @param {Record<string, number>} groupLastActivity
   */
  commitGroupActivity(vehicleId, groupLastActivity) {
    const v = this._vehicles.get(vehicleId);
    if (!v) return;
    v.groupLastActivity = { ...groupLastActivity };
  }
}

module.exports = { VehicleStateManager, DEFAULT_DRONE_ID };
