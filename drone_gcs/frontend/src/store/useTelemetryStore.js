import { create } from 'zustand';

const useTelemetryStore = create((set, get) => ({
  connected: false,
  telemetry: {},

  connect: () => {
    const wsUrl = 'ws://localhost:8080';
    console.log(`Connecting to WebSocket: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      set({ connected: true });
      console.log('Connected to Telemetry Stream');
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'TELEMETRY_UPDATE') {
          set((state) => ({
            telemetry: {
              ...state.telemetry,
              [payload.vehicle_id]: payload.data
            }
          }));
        }
      } catch (err) {
        console.error('Failed to parse telemetry', err);
      }
    };

    ws.onclose = () => {
      set({ connected: false });
      console.log('Disconnected from Telemetry Stream. Reconnecting in 2s...');
      setTimeout(() => get().connect(), 2000);
    };

    ws.onerror = (err) => {
      console.error('WebSocket Error:', err);
      ws.close();
    };
  }
}));

export default useTelemetryStore;
