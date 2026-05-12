import { create } from 'zustand';
import axios from 'axios';
import { deriveOperationalPhase } from '../utils/operationalState';

const API_URL = 'http://localhost:8080';

/** Vehicle snapshot for the backend `primary_sysid`, or first known vehicle. */
export const selectPrimaryVehicle = (state) => {
  const t = state.telemetry;
  const id = state.primarySysId;
  if (id != null && t[id] !== undefined) return t[id];
  const keys = Object.keys(t);
  return keys.length ? t[keys[0]] : undefined;
};

const useTelemetryStore = create((set, get) => ({
  connected: false,
  connectionState: 'DISCONNECTED',
  /** Backend primary vehicle sysid (string key) */
  primarySysId: null,
  /** Vehicles seen on link (from CONNECTION_STATUS) */
  vehiclesRoster: [],
  /** ADS-B tracks from ADSB_VEHICLE (Phase C) */
  adsbTracks: [],
  telemetry: {},
  ws: null,
  connectRequestInFlight: false,
  connectRequestPromise: null,
  operational: { phase: 'DISCONNECTED', label: 'Disconnected', tone: 'muted' },
  operationalHistory: [],
  commandStatus: {},
  commandHistory: [],
  paramSyncStatus: {
    state: 'IDLE',
    received: 0,
    reported: 0,
    missing: 0,
    progress_percent: 0,
    last_error: '',
  },
  connectionConfig: {
    connection_string: 'auto',
    baudrate: 115200,
  },

  connect: () => {
    // Avoid duplicate connections
    const existing = get().ws;
    if (existing && existing.readyState < 2) return;

    const wsUrl = 'ws://localhost:8080';
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      set({ ws });
      console.log('[WS] Connected to telemetry stream');
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'TELEMETRY_UPDATE') {
          const connectionState = payload?.data?.connection_state || get().connectionState;
          const vid =
            payload.vehicle_id != null && payload.vehicle_id !== ''
              ? String(payload.vehicle_id)
              : null;
          set((state) => {
            const nextTelemetry = {
              ...state.telemetry,
              ...(vid ? { [vid]: payload.data } : {}),
            };
            const primaryId = state.primarySysId;
            const primaryVehicle =
              primaryId != null && nextTelemetry[primaryId] !== undefined
                ? nextTelemetry[primaryId]
                : vid
                  ? nextTelemetry[vid]
                  : undefined;
            const nextOperational = deriveOperationalPhase({ connectionState, vehicle: primaryVehicle });
            const samePhase = state.operational?.phase === nextOperational.phase;
            const nextOpHistory = samePhase
              ? state.operationalHistory
              : [
                  ...state.operationalHistory,
                  { at: Date.now(), from: state.operational?.phase || null, to: nextOperational.phase, label: nextOperational.label },
                ].slice(-80);
            return ({
            connected: connectionState === 'CONNECTED' || connectionState === 'ACTIVE',
            connectionState,
            telemetry: nextTelemetry,
            operational: nextOperational,
            operationalHistory: nextOpHistory,
          });
          });
        } else if (payload.type === 'CONNECTION_STATUS') {
          const connectionState = payload?.data?.connection_state || 'DISCONNECTED';
          const ps = payload?.data?.primary_sysid;
          const roster = Array.isArray(payload?.data?.vehicles) ? payload.data.vehicles : [];
          set((state) => {
            const nextOperational = deriveOperationalPhase({
              connectionState,
              vehicle:
                ps != null && ps !== '' ? state.telemetry[String(ps)] : state.telemetry[state.primarySysId],
            });
            const samePhase = state.operational?.phase === nextOperational.phase;
            const nextOpHistory = samePhase
              ? state.operationalHistory
              : [
                  ...state.operationalHistory,
                  { at: Date.now(), from: state.operational?.phase || null, to: nextOperational.phase, label: nextOperational.label },
                ].slice(-80);
            return ({
            connectionState,
            connected: connectionState === 'CONNECTED' || connectionState === 'ACTIVE',
            vehiclesRoster: roster,
            ...(ps != null && ps !== ''
              ? { primarySysId: String(ps) }
              : connectionState === 'DISCONNECTED'
                ? { primarySysId: null, vehiclesRoster: [], telemetry: {}, adsbTracks: [] }
                : {}),
            operational: nextOperational,
            operationalHistory: nextOpHistory,
          });
          });
        } else if (payload.type === 'ADSB_UPDATE') {
          set({
            adsbTracks: Array.isArray(payload.tracks) ? payload.tracks : [],
          });
        } else if (payload.type === 'PARAM_SYNC_STATUS') {
          set({ paramSyncStatus: payload.data || get().paramSyncStatus });
        }
      } catch (err) {
        console.error('[WS] Failed to parse telemetry', err);
      }
    };

    ws.onclose = () => {
      set({
        connected: false,
        ws: null,
        adsbTracks: [],
        vehiclesRoster: [],
        operational: deriveOperationalPhase({ connectionState: 'DISCONNECTED', vehicle: null }),
        operationalHistory: [],
      });
      console.log('[WS] Disconnected. Reconnecting in 2s...');
      setTimeout(() => get().connect(), 2000);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      ws.close();
    };
  },

  // Start MAVLink connection on the backend
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
    const request = axios.post(`${API_URL}/api/connection/start`, payload)
      .then((res) => {
        const backendState = res?.data?.connection_state;
        if (backendState) {
          set((state) => ({
            connectionState: backendState,
            connected: backendState === 'CONNECTED' || backendState === 'ACTIVE',
            operational: deriveOperationalPhase({ connectionState: backendState, vehicle: selectPrimaryVehicle(state) }),
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

  // Stop MAVLink connection on the backend (violent purge)
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
      params: { max_age_s: maxAgeSeconds }
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
      commandHistory: [...state.commandHistory, { at: startedAt, command: `mode:${mode}`, state: 'pending' }].slice(-120),
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
        commandHistory: [...state.commandHistory, { at: Date.now(), command: `mode:${mode}`, state: 'error', error: d?.error || err.message, response: d || null }].slice(-120),
      }));
      throw err;
    }
  },
}));

export default useTelemetryStore;
