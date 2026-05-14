/** @typedef {'2026.1'|string} TelemetrySchemaVersion */

export const DEFAULT_TELEMETRY_SCHEMA_VERSION = '2026.1';

/** WebSocket transport lifecycle (browser client). */
export const WS_SYNC = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  OPEN: 'OPEN',
  RECONNECTING: 'RECONNECTING',
  CLOSED: 'CLOSED',
};
