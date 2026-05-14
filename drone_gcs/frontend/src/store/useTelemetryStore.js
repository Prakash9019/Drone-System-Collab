import { create } from 'zustand';
import axios from 'axios';
import { deriveOperationalPhase } from '../utils/operationalState';
import { applyInboundTelemetryPayload } from '../telemetry/telemetryWebSocketBridge';
import { selectPrimaryVehicle } from '../telemetry/telemetrySelectors';

const API_URL = 'http://localhost:8080';

export {
  selectPrimaryVehicle,
  selectPrimaryVehicleRaw,
  selectPrimaryVehicleDerived,
  selectStaleTelemetry,
  selectNormalizedTelemetry,
  getSchemaVersion,
  getTelemetryEngine,
  selectFleetTelemetrySummary,
  selectAllVehicleIds,
  selectAttitudeDisplay,
  selectOperationalFromStore,
  selectSyncTransport,
} from '../telemetry/telemetrySelectors';

export { reduceTelemetryWebSocketMessage, snapshotFromGet, patchSyncTransport } from '../telemetry/telemetrySyncReducer';
export { selectCommandState } from '../telemetry/commandSelectors';
export { selectMissionSyncState } from '../telemetry/missionSelectors';
export { selectMapVehicle } from '../telemetry/mapSelectors';
export { selectPreflightStatus } from '../telemetry/preflightSelectors';

const useTelemetryStore = create((set, get) => ({
  connected: false,
  mode: 'LIVE', // 'LIVE' | 'REPLAY'
  replayStatus: {
    is_recording: false,
    recording_session_id: null,
    is_playing: false,
    is_paused: false,
    playback_session_id: null,
    progress_s: 0,
    duration_s: 0,
    speed: 1.0,
  },
  connectionState: 'DISCONNECTED',
  primarySysId: null,
  vehiclesRoster: [],
  adsbTracks: [],
  /** Raw per-vehicle payloads from backend (includes `telemetry_engine` when Node engine enabled). */
  telemetry: {},
  /**
   * Transport + freshness meta (browser client). Not MAVLink link state — see `connectionState`.
   */
  sync: {
    wsTransport: 'IDLE',
    lastInboundAt: null,
    inboundSeq: 0,
    reconnectAttempts: 0,
    lastEngineEnvelope: null,
  },
  ws: null,
  connectRequestInFlight: false,
  connectRequestPromise: null,
  operational: { phase: 'DISCONNECTED', label: 'Disconnected', tone: 'muted' },
  operationalHistory: [],
  commandStatus: {},
  engineCommandStatus: {},
  commandHistory: [],
  paramSyncStatus: {
    state: 'IDLE',
    received: 0,
    reported: 0,
    missing: 0,
    progress_percent: 0,
    last_error: '',
  },
  missionSyncStatus: {
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
  },
  preflightStatus: {
    ready_to_arm: false,
    checks: [],
    timestamp: 0,
  },
  connectionConfig: {
    connection_string: 'auto',
    baudrate: 115200,
  },

  connect: () => {
    const existing = get().ws;
    if (existing && existing.readyState < 2) return;

    const wsUrl = 'ws://localhost:8080';
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      set((s) => ({
        ws,
        sync: {
          ...(s.sync || {}),
          wsTransport: 'OPEN',
        },
      }));
      console.log('[WS] Connected to telemetry stream');
    };

    ws.onmessage = (event) => {
      try {
        applyInboundTelemetryPayload(get, set, event.data);
      } catch (err) {
        console.error('[WS] Failed to parse telemetry', err);
      }
    };

    ws.onclose = () => {
      set((s) => ({
        connected: false,
        ws: null,
        adsbTracks: [],
        vehiclesRoster: [],
        operational: deriveOperationalPhase({ connectionState: 'DISCONNECTED', vehicle: null }),
        operationalHistory: [],
        sync: {
          ...(s.sync || {}),
          wsTransport: 'CLOSED',
          reconnectAttempts: ((s.sync && s.sync.reconnectAttempts) || 0) + 1,
        },
      }));
      console.log('[WS] Disconnected. Reconnecting in 2s...');
      setTimeout(() => get().connect(), 2000);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      ws.close();
    };
  },

  setConnectionConfig: (config) => {
    set((state) => ({ connectionConfig: { ...state.connectionConfig, ...config } }));
  },

  startConnection: async () => {
    const inFlight = get().connectRequestPromise;
    if (inFlight) {
      return inFlight;
    }

    set({ connectRequestInFlight: true, connectionState: 'CONNECTING' });

    const payload = get().connectionConfig;
    const request = axios
      .post(`${API_URL}/api/connection/start`, payload)
      .then((res) => {
        const backendState = res?.data?.connection_state;
        if (backendState) {
          set((state) => ({
            connectionState: backendState,
            connected: backendState === 'CONNECTED' || backendState === 'ACTIVE',
            operational: deriveOperationalPhase({
              connectionState: backendState,
              vehicle: selectPrimaryVehicle(state),
            }),
          }));
        }
        console.log('[API] Connection start:', res.data);
        return res.data;
      })
      .catch((err) => {
        set({
          connectionState: 'DISCONNECTED',
          connected: false,
          operational: deriveOperationalPhase({ connectionState: 'DISCONNECTED', vehicle: null }),
        });
        console.error('[API] Failed to start connection:', err.message);
        throw err;
      })
      .finally(() => {
        set({ connectRequestInFlight: false, connectRequestPromise: null });
      });

    set({ connectRequestPromise: request });
    return request;
  },

  stopConnection: async () => {
    try {
      const res = await axios.post(`${API_URL}/api/connection/stop`);
      console.log('[API] Connection stop:', res.data);
      set({
        connected: false,
        connectionState: 'DISCONNECTED',
        operational: deriveOperationalPhase({ connectionState: 'DISCONNECTED', vehicle: null }),
      });
      return res.data;
    } catch (err) {
      console.error('[API] Failed to stop connection:', err.message);
      throw err;
    }
  },

  sendShortcutCommand: async (cmd, body = null) => {
    const key = String(cmd || '').toLowerCase();
    const startedAt = Date.now();
    const appendHistory = (entry) =>
      set((state) => ({
        commandHistory: [...state.commandHistory, entry].slice(-120),
      }));
    set((state) => ({
      commandStatus: {
        ...state.commandStatus,
        [key]: { state: 'pending', at: Date.now(), error: null },
      },
    }));
    appendHistory({ at: startedAt, command: key, state: 'pending', request: body || {} });
    try {
      const res = await axios.post(`${API_URL}/api/command/${cmd}`, body || {});
      set((state) => ({
        commandStatus: {
          ...state.commandStatus,
          [key]: {
            state: res?.data?.accepted === false ? 'rejected' : 'ok',
            at: Date.now(),
            error: res?.data?.accepted === false ? res?.data?.mav_result_text || 'rejected' : null,
          },
        },
      }));
      appendHistory({
        at: Date.now(),
        command: key,
        state: res?.data?.accepted === false ? 'rejected' : 'ok',
        response: res?.data || {},
      });
      return res.data;
    } catch (err) {
      console.error(`[API] Failed to send command ${cmd}:`, err.message);
      const d = err.response?.data;
      set((state) => ({
        commandStatus: {
          ...state.commandStatus,
          [key]: { state: 'error', at: Date.now(), error: d?.error || err.message || 'failed' },
        },
      }));
      appendHistory({
        at: Date.now(),
        command: key,
        state: 'error',
        error: d?.error || err.message || 'failed',
        response: d || null,
      });
      const e = new Error(d?.error || d?.detail || err.message || 'Command failed');
      e.response = err.response;
      e.details = d?.details ?? d;
      throw e;
    }
  },

  refreshParameterStatus: async () => {
    const res = await axios.get(`${API_URL}/api/parameters/status`);
    set({ paramSyncStatus: res.data });
    return res.data;
  },

  loadParameterCache: async (maxAgeSeconds = 3600) => {
    const res = await axios.post(`${API_URL}/api/parameters/cache/load`, null, {
      params: { max_age_s: maxAgeSeconds },
    });
    if (res?.data?.sync_status) {
      set({ paramSyncStatus: res.data.sync_status });
    }
    return res.data;
  },

  selectPrimaryVehicleSysId: async (sysid) => {
    const n = Number(sysid);
    if (Number.isNaN(n)) return null;
    const res = await axios.post(`${API_URL}/api/vehicles/select`, { sysid: n });
    return res.data;
  },

  setFlightMode: async (mode) => {
    const startedAt = Date.now();
    set((state) => ({
      commandHistory: [...state.commandHistory, { at: startedAt, command: `mode:${mode}`, state: 'pending' }].slice(
        -120
      ),
    }));
    try {
      const res = await axios.post(`${API_URL}/api/mode`, { mode });
      set((state) => ({
        commandHistory: [...state.commandHistory, { at: Date.now(), command: `mode:${mode}`, state: 'ok', response: res.data }].slice(-120),
      }));
      return res.data;
    } catch (err) {
      const d = err.response?.data;
      set((state) => ({
        commandHistory: [...state.commandHistory, {
          at: Date.now(),
          command: `mode:${mode}`,
          state: 'error',
          error: d?.error || err.message,
          response: d || null,
        }].slice(-120),
      }));
      throw err;
    }
  },
}));

export default useTelemetryStore;
