import { deriveOperationalPhase } from '../utils/operationalState';

/**
 * Pure reducer: WebSocket JSON payload → partial Zustand patch.
 * Keeps parsing out of the store implementation.
 *
 * @param {import('./telemetrySyncTypes').TelemetryStoreSnapshot} prev
 * @param {unknown} payload
 * @returns {Partial<import('./telemetrySyncTypes').TelemetryStoreSnapshot>|null}
 */
export function reduceTelemetryWebSocketMessage(prev, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const p = /** @type {Record<string, unknown>} */ (payload);

  const now = Date.now();
  const syncBase = {
    ...(prev.sync || {}),
    lastInboundAt: now,
    inboundSeq: ((prev.sync && prev.sync.inboundSeq) || 0) + 1,
    lastEngineEnvelope: p.engine_envelope || (prev.sync && prev.sync.lastEngineEnvelope) || null,
  };

  if (p.type === 'REPLAY_STATUS') {
    return {
      sync: { ...syncBase, wsTransport: 'OPEN' },
      replayStatus: /** @type {Record<string, unknown>} */ (p.data) || prev.replayStatus || {},
    };
  }

  const isReplayMode = prev.mode === 'REPLAY';
  const msgIsReplay = p.engine_envelope ? p.engine_envelope.is_replay === true : p.is_replay === true;
  
  // Strict mode filter: ignore live data in replay mode, ignore replay data in live mode
  if (isReplayMode && !msgIsReplay) return null;
  if (!isReplayMode && msgIsReplay) return null;

  if (p.type === 'TELEMETRY_UPDATE') {
    const connectionState =
      (typeof p.data === 'object' &&
        p.data &&
        /** @type {Record<string, unknown>} */ (p.data).connection_state) ||
      prev.connectionState;
    const cs = typeof connectionState === 'string' ? connectionState : prev.connectionState;
    const vid =
      p.vehicle_id != null && p.vehicle_id !== ''
        ? String(p.vehicle_id)
        : null;
    if (!vid || typeof p.data !== 'object' || !p.data) {
      return { sync: { ...syncBase, wsTransport: prev.sync?.wsTransport || 'OPEN' } };
    }
    const data = /** @type {Record<string, unknown>} */ (p.data);
    const nextTelemetry = {
      ...prev.telemetry,
      [vid]: data,
    };
    const primaryId = prev.primarySysId;
    const primaryVehicle =
      primaryId != null && nextTelemetry[primaryId] !== undefined
        ? nextTelemetry[primaryId]
        : nextTelemetry[vid];
    const nextOperational = deriveOperationalPhase({ connectionState: cs, vehicle: primaryVehicle });
    const samePhase = prev.operational?.phase === nextOperational.phase;
    const nextOpHistory = samePhase
      ? prev.operationalHistory
      : [
          ...prev.operationalHistory,
          {
            at: Date.now(),
            from: prev.operational?.phase || null,
            to: nextOperational.phase,
            label: nextOperational.label,
          },
        ].slice(-80);
    return {
      sync: { ...syncBase, wsTransport: 'OPEN' },
      connected: cs === 'CONNECTED' || cs === 'ACTIVE',
      connectionState: cs,
      telemetry: nextTelemetry,
      operational: nextOperational,
      operationalHistory: nextOpHistory,
    };
  }

  if (p.type === 'CONNECTION_STATUS') {
    const data =
      typeof p.data === 'object' && p.data !== null
        ? /** @type {Record<string, unknown>} */ (p.data)
        : {};
    const connectionState = typeof data.connection_state === 'string' ? data.connection_state : 'DISCONNECTED';
    const ps = data.primary_sysid;
    const roster = Array.isArray(data.vehicles) ? data.vehicles : [];
    const nextTelemetry =
      connectionState === 'DISCONNECTED' ? {} : { ...prev.telemetry };
    const nextPrimary =
      ps != null && ps !== ''
        ? String(ps)
        : connectionState === 'DISCONNECTED'
          ? null
          : prev.primarySysId;
    const primaryVehicle =
      nextPrimary != null && nextTelemetry[nextPrimary] !== undefined
        ? nextTelemetry[nextPrimary]
        : undefined;
    const nextOperational = deriveOperationalPhase({
      connectionState,
      vehicle: primaryVehicle,
    });
    const samePhase = prev.operational?.phase === nextOperational.phase;
    const nextOpHistory = samePhase
      ? prev.operationalHistory
      : [
          ...prev.operationalHistory,
          {
            at: Date.now(),
            from: prev.operational?.phase || null,
            to: nextOperational.phase,
            label: nextOperational.label,
          },
        ].slice(-80);

    const patch = {
      sync: { ...syncBase, wsTransport: 'OPEN' },
      connectionState,
      connected: connectionState === 'CONNECTED' || connectionState === 'ACTIVE',
      vehiclesRoster: roster,
      operational: nextOperational,
      operationalHistory: nextOpHistory,
      telemetry: nextTelemetry,
    };
    if (ps != null && ps !== '') {
      patch.primarySysId = String(ps);
    } else if (connectionState === 'DISCONNECTED') {
      patch.primarySysId = null;
      patch.vehiclesRoster = [];
      patch.adsbTracks = [];
    }
    return /** @type {Partial<import('./telemetrySyncTypes').TelemetryStoreSnapshot>} */ (patch);
  }

  if (p.type === 'ADSB_UPDATE') {
    return {
      sync: { ...syncBase, wsTransport: 'OPEN' },
      adsbTracks: Array.isArray(p.tracks) ? p.tracks : [],
    };
  }

  if (p.type === 'PARAM_SYNC_STATUS') {
    return {
      sync: { ...syncBase, wsTransport: 'OPEN' },
      paramSyncStatus: /** @type {Record<string, unknown>} */ (p.data) || prev.paramSyncStatus,
    };
  }

  if (p.type === 'COMMAND_STATUS') {
    return {
      sync: { ...syncBase, wsTransport: 'OPEN' },
      engineCommandStatus: /** @type {Record<string, unknown>} */ (p.data) || prev.engineCommandStatus || {},
    };
  }

  if (p.type === 'MISSION_SYNC_STATUS') {
    return {
      sync: { ...syncBase, wsTransport: 'OPEN' },
      missionSyncStatus: /** @type {Record<string, unknown>} */ (p.data) || prev.missionSyncStatus || {},
    };
  }

  if (p.type === 'PREFLIGHT_STATUS') {
    return {
      sync: { ...syncBase, wsTransport: 'OPEN' },
      preflightStatus: /** @type {Record<string, unknown>} */ (p.data) || prev.preflightStatus || {},
    };
  }

  return { sync: { ...syncBase, wsTransport: 'OPEN' } };
}

/**
 * Build snapshot slice the reducer needs from full store (for typing / tests).
 * @param {object} get
 */
export function snapshotFromGet(get) {
  const s = get();
  return {
    connectionState: s.connectionState,
    primarySysId: s.primarySysId,
    telemetry: s.telemetry,
    operational: s.operational,
    operationalHistory: s.operationalHistory,
    paramSyncStatus: s.paramSyncStatus,
    engineCommandStatus: s.engineCommandStatus,
    missionSyncStatus: s.missionSyncStatus,
    sync: s.sync || {},
  };
}

/**
 * @param {import('./telemetrySyncTypes').TelemetryStoreSnapshot} snap
 * @param {string} transport
 */
export function patchSyncTransport(snap, transport) {
  return {
    sync: {
      ...(snap.sync || {}),
      wsTransport: transport,
    },
  };
}
