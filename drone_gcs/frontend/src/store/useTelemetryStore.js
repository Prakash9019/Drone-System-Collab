import { create } from 'zustand';
import axios from 'axios';

const API_URL = 'http://localhost:8080';

const useTelemetryStore = create((set, get) => ({
  connected: false,
  connectionState: 'DISCONNECTED',
  telemetry: {},
  ws: null,
  connectRequestInFlight: false,
  connectRequestPromise: null,

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
          set((state) => ({
            connected: connectionState === 'CONNECTED' || connectionState === 'ACTIVE',
            connectionState,
            telemetry: {
              ...state.telemetry,
              [payload.vehicle_id]: payload.data
            }
          }));
        } else if (payload.type === 'CONNECTION_STATUS') {
          const connectionState = payload?.data?.connection_state || 'DISCONNECTED';
          set({
            connectionState,
            connected: connectionState === 'CONNECTED' || connectionState === 'ACTIVE',
          });
        }
      } catch (err) {
        console.error('[WS] Failed to parse telemetry', err);
      }
    };

    ws.onclose = () => {
      set({ connected: false, ws: null });
      console.log('[WS] Disconnected. Reconnecting in 2s...');
      setTimeout(() => get().connect(), 2000);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      ws.close();
    };
  },

  // Start MAVLink connection on the backend
  startConnection: async () => {
    const inFlight = get().connectRequestPromise;
    if (inFlight) {
      return inFlight;
    }

    set({ connectRequestInFlight: true, connectionState: 'CONNECTING' });

    const request = axios.post(`${API_URL}/api/connection/start`)
      .then((res) => {
        const backendState = res?.data?.connection_state;
        if (backendState) {
          set({
            connectionState: backendState,
            connected: backendState === 'CONNECTED' || backendState === 'ACTIVE',
          });
        }
        console.log('[API] Connection start:', res.data);
        return res.data;
      })
      .catch((err) => {
        set({ connectionState: 'DISCONNECTED', connected: false });
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
      set({ connected: false, connectionState: 'DISCONNECTED' });
      return res.data;
    } catch (err) {
      console.error('[API] Failed to stop connection:', err.message);
      throw err;
    }
  },

  sendShortcutCommand: async (cmd) => {
    try {
      const res = await axios.post(`${API_URL}/api/command/${cmd}`);
      return res.data;
    } catch (err) {
      console.error(`[API] Failed to send command ${cmd}:`, err.message);
      throw err;
    }
  },
}));

export default useTelemetryStore;
