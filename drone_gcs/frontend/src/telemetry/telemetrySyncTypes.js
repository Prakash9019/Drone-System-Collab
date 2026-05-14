/**
 * @typedef {Object} TelemetryStoreSnapshot
 * @property {string} connectionState
 * @property {string|null} primarySysId
 * @property {Record<string, Record<string, unknown>>} telemetry
 * @property {{ phase: string, label: string, tone: string }} operational
 * @property {Array<Record<string, unknown>>} operationalHistory
 * @property {Record<string, unknown>} paramSyncStatus
 * @property {Record<string, unknown>} [sync]
 */

export {};
