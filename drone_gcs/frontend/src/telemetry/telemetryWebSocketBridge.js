import { reduceTelemetryWebSocketMessage, snapshotFromGet } from './telemetrySyncReducer';

/**
 * Parse WS frame and apply pure reducer patch to Zustand.
 * @param {() => object} get
 * @param {(fn: (s: object) => object) => void} set
 * @param {string} jsonString
 */
export function applyInboundTelemetryPayload(get, set, jsonString) {
  const payload = JSON.parse(jsonString);
  const prev = snapshotFromGet(get);
  const patch = reduceTelemetryWebSocketMessage(prev, payload);
  if (patch) {
    set((s) => ({ ...s, ...patch }));
  }
}
