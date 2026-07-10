const {
  TELEMETRY_SCHEMA_VERSION,
  safeJsonParse,
  isKnownTelemetryMessage,
  attitudeRadiansFromVehicleData,
  attitudeRadiansToDegrees,
  ekfAggregateFromVehicleData,
} = require('./schemas');
const { StaleTelemetryDetector } = require('./staleTelemetry');
const { VehicleStateManager } = require('./vehicleStateManager');
const { TelemetryEventBus } = require('./eventBus');

/**
 * Telemetry core: ZMQ string in → validated → dispatched → enriched → JSON string out.
 * Preserves original `type` / `vehicle_id` / `data` shapes for existing React store.
 */
class TelemetryCoreEngine {
  /**
   * @param {{
   *   broadcast: (jsonString: string) => void,
   *   bus?: TelemetryEventBus|null,
   *   stale?: StaleTelemetryDetector|null,
   *   vehicles?: VehicleStateManager|null,
   * }} opts
   */
  constructor(opts) {
    this.broadcast = opts.broadcast;
    this.bus = opts.bus ?? new TelemetryEventBus();
    this.stale = opts.stale ?? new StaleTelemetryDetector();
    this.vehicles = opts.vehicles ?? new VehicleStateManager();
    this._seq = 0;
  }

  _nextMonotonicMs() {
    this._seq += 1;
    return this._seq;
  }

  /**
   * @param {Record<string, unknown>} msg
   */
  _droneIdOf(msg) {
    return msg.drone_id != null && msg.drone_id !== '' ? String(msg.drone_id) : 'default';
  }

  /**
   * @param {Record<string, unknown>} msg
   */
  _wrapEngineEnvelope(msg) {
    const now = new Date().toISOString();
    return {
      v: 1,
      ts: now,
      monotonic_ms: this._nextMonotonicMs(),
      drone_id: this._droneIdOf(msg),
      kind:
        msg.type === 'CONNECTION_STATUS'
          ? 'CONNECTION'
          : msg.type === 'PARAM_SYNC_STATUS'
            ? 'PARAM'
            : msg.type === 'COMMAND_STATUS'
              ? 'COMMAND'
              : msg.type === 'MISSION_SYNC_STATUS'
                ? 'MISSION'
                : msg.type === 'ADSB_UPDATE'
                  ? 'ADSB'
                  : msg.type === 'PREFLIGHT_STATUS'
                    ? 'PREFLIGHT'
                    : msg.type === 'REPLAY_STATUS'
                      ? 'REPLAY'
                      : 'TELEMETRY',
      name: String(msg.type),
      vehicle_id:
        msg.vehicle_id != null && msg.vehicle_id !== ''
          ? String(msg.vehicle_id)
          : null,
      schema_version: TELEMETRY_SCHEMA_VERSION,
      is_replay: msg.is_replay === true,
    };
  }

  /**
   * @param {Record<string, unknown>} data
   */
  _cloneData(data) {
    return /** @type {Record<string, unknown>} */ (JSON.parse(JSON.stringify(data)));
  }

  /**
   * @param {Record<string, unknown>} msg
   */
  processZmqFrameString(raw) {
    this.bus.emitZmqFrame(raw);
    const parsed = safeJsonParse(raw);
    if (!parsed.ok) {
      return null;
    }
    const msg = parsed.value;
    if (!isKnownTelemetryMessage(msg)) {
      this.bus.emitZmqParsed(msg);
      const rawDrone = msg && typeof msg === 'object' && msg.drone_id != null ? String(msg.drone_id) : null;
      this.broadcast(raw, rawDrone);
      this.bus.emitOutbound(raw);
      return raw;
    }

    this.bus.emitZmqParsed(msg);

    const droneId = this._droneIdOf(msg);
    const type = String(msg.type);
    if (type === 'CONNECTION_STATUS') {
      const out = this._processConnectionStatus(msg);
      const s = JSON.stringify(out);
      this.broadcast(s, droneId);
      this.bus.emitOutbound(s);
      return s;
    }

    if (type === 'TELEMETRY_UPDATE') {
      const out = this._processTelemetryUpdate(msg);
      const s = JSON.stringify(out);
      this.broadcast(s, droneId);
      this.bus.emitOutbound(s);
      return s;
    }

    const envelope = this._wrapEngineEnvelope(msg);
    const out = { ...msg, engine_envelope: envelope };
    const s = JSON.stringify(out);
    this.broadcast(s, droneId);
    this.bus.emitOutbound(s);
    return s;
  }

  /**
   * @param {Record<string, unknown>} msg
   */
  _processConnectionStatus(msg) {
    const data = /** @type {Record<string, unknown>} */ (
      typeof msg.data === 'object' && msg.data !== null && !Array.isArray(msg.data) ? msg.data : {}
    );
    const droneId = this._droneIdOf(msg);
    const dataClone = this._cloneData(data);
    const transition = this.vehicles.applyConnectionStatus(dataClone, droneId);

    if (transition.from !== transition.to) {
      this.bus.emitConnectionTransition({ from: transition.from, to: transition.to, drone_id: droneId });
    }

    const nowMs = Date.now();
    const staleMeta = this.stale.buildMeta({
      vehicleId: droneId === 'default' ? '__fleet__' : `${droneId}:__fleet__`,
      connectionState: String(dataClone.connection_state ?? 'DISCONNECTED'),
      nowMs,
      lastSnapshotAt: null,
      prevData: null,
      nextData: dataClone,
      groupLastActivity: {},
    });

    dataClone.schema_version = TELEMETRY_SCHEMA_VERSION;
    dataClone.telemetry_engine = {
      connection_transition: transition,
      fleet: {
        drone_id: droneId,
        vehicle_ids: this.vehicles.listVehicleIds(droneId),
        drone_ids: this.vehicles.listDroneIds(),
      },
      stale: staleMeta,
    };

    return {
      ...msg,
      data: dataClone,
      engine_envelope: this._wrapEngineEnvelope({ ...msg, type: 'CONNECTION_STATUS' }),
    };
  }

  /**
   * @param {Record<string, unknown>} msg
   */
  _processTelemetryUpdate(msg) {
    const data = /** @type {Record<string, unknown>} */ (
      typeof msg.data === 'object' && msg.data !== null && !Array.isArray(msg.data) ? msg.data : {}
    );
    const dataClone = this._cloneData(data);
    const droneId = this._droneIdOf(msg);
    const vehicleId =
      msg.vehicle_id != null && msg.vehicle_id !== '' ? String(msg.vehicle_id) : 'unknown';
    const vehicleKey = this.vehicles.vehicleKey(droneId, vehicleId);

    const connectionState =
      typeof dataClone.connection_state === 'string'
        ? dataClone.connection_state
        : this.vehicles.connectionStateFor(droneId) ?? 'DISCONNECTED';

    const nowMs = Date.now();
    const prevStored = this.vehicles.getPreviousTelemetry(vehicleKey);
    const { previousSnapshotAt, groupLastActivity } = this.vehicles.recordTelemetrySnapshot(
      vehicleKey,
      dataClone,
      nowMs
    );

    this.stale.touchGroupsOnChange(groupLastActivity, prevStored, dataClone, nowMs);
    this.vehicles.commitGroupActivity(vehicleKey, groupLastActivity);

    const staleMeta = this.stale.buildMeta({
      vehicleId: vehicleKey,
      connectionState,
      nowMs,
      lastSnapshotAt: previousSnapshotAt,
      prevData: prevStored,
      nextData: dataClone,
      groupLastActivity,
    });

    const r = attitudeRadiansFromVehicleData(dataClone);
    const deg = attitudeRadiansToDegrees(r);
    const ekf = ekfAggregateFromVehicleData(dataClone);

    dataClone.schema_version = TELEMETRY_SCHEMA_VERSION;
    dataClone.telemetry_engine = {
      stale: staleMeta,
      normalized: {
        attitude_deg: deg,
        attitude_rad: { roll: r.roll, pitch: r.pitch, yaw: r.yaw },
        ekf: {
          aggregate_score: ekf.aggregate_score,
          health: ekf.health,
        },
      },
      fleet: {
        drone_id: droneId,
        vehicle_id: vehicleId,
        known_vehicle_ids: this.vehicles.listVehicleIds(droneId),
        primary_sysid: this.vehicles.primarySysIdFor(droneId),
      },
    };

    return {
      ...msg,
      vehicle_id: vehicleId,
      data: dataClone,
      engine_envelope: this._wrapEngineEnvelope({ ...msg, vehicle_id: vehicleId }),
    };
  }

  /**
   * Debug snapshot for HTTP (no secrets).
   */
  getDebugSnapshot() {
    return {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      connection_state: this.vehicles.lastConnectionState,
      primary_sysid: this.vehicles.primarySysId,
      vehicles: this.vehicles.listVehicleIds(),
      drones: this.vehicles.listDroneIds().map((d) => ({
        drone_id: d,
        connection_state: this.vehicles.connectionStateFor(d),
        primary_sysid: this.vehicles.primarySysIdFor(d),
        vehicles: this.vehicles.listVehicleIds(d),
      })),
    };
  }
}

module.exports = {
  TelemetryCoreEngine,
  TelemetryEventBus,
  StaleTelemetryDetector,
  VehicleStateManager,
  ...require('./schemas'),
};
