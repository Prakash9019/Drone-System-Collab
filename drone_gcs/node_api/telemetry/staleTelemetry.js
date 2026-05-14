/**
 * Staleness heuristics for vehicle telemetry snapshots (Node-side).
 * Python does not tag per-field RX time; we infer from snapshot cadence and field change detection.
 */

const DEFAULT_SNAPSHOT_STALE_MS = 2500;
const DEFAULT_GROUP_STALE_MS = 4000;

class StaleTelemetryDetector {
  /**
   * @param {{ snapshotStaleMs?: number, groupStaleMs?: number }} [opts]
   */
  constructor(opts = {}) {
    this.snapshotStaleMs = opts.snapshotStaleMs ?? DEFAULT_SNAPSHOT_STALE_MS;
    this.groupStaleMs = opts.groupStaleMs ?? DEFAULT_GROUP_STALE_MS;
  }

  /**
   * @param {string} connectionState
   */
  isLinkLive(connectionState) {
    return connectionState === 'CONNECTED' || connectionState === 'ACTIVE';
  }

  /**
   * @param {Record<string, unknown>} prev
   * @param {Record<string, unknown>} next
   */
  _attitudeChanged(prev, next) {
    const a = prev?.attitude;
    const b = next?.attitude;
    if (!a || !b) return true;
    const eps = 1e-7;
    return (
      Math.abs(Number(a.roll) - Number(b.roll)) > eps ||
      Math.abs(Number(a.pitch) - Number(b.pitch)) > eps ||
      Math.abs(Number(a.yaw) - Number(b.yaw)) > eps
    );
  }

  /**
   * @param {Record<string, unknown>} prev
   * @param {Record<string, unknown>} next
   */
  _positionChanged(prev, next) {
    const a = prev?.position;
    const b = next?.position;
    if (!a || !b) return true;
    const eps = 1e-9;
    return (
      Math.abs(Number(a.lat) - Number(b.lat)) > eps ||
      Math.abs(Number(a.lng) - Number(b.lng)) > eps ||
      Math.abs(Number(a.alt_rel) - Number(b.alt_rel)) > 1e-3
    );
  }

  /**
   * @param {Record<string, unknown>} prev
   * @param {Record<string, unknown>} next
   */
  _batteryChanged(prev, next) {
    const a = prev?.battery;
    const b = next?.battery;
    if (!a || !b) return true;
    return (
      Math.abs(Number(a.voltage) - Number(b.voltage)) > 1e-3 ||
      Math.abs(Number(a.current) - Number(b.current)) > 1e-3 ||
      Number(a.remaining) !== Number(b.remaining)
    );
  }

  /**
   * Build telemetry_engine.stale + freshness metadata.
   * @param {{
   *   vehicleId: string,
   *   connectionState: string,
   *   nowMs: number,
   *   lastSnapshotAt: number|null,
   *   prevData: Record<string, unknown>|null,
   *   nextData: Record<string, unknown>,
   *   groupLastActivity: Record<string, number>,
   * }} p
   */
  buildMeta(p) {
    const { connectionState, nowMs, lastSnapshotAt, prevData, nextData, groupLastActivity } = p;

    const linkLive = this.isLinkLive(connectionState);
    const snapshotAgeMs =
      lastSnapshotAt != null && Number.isFinite(lastSnapshotAt) ? Math.max(0, nowMs - lastSnapshotAt) : null;

    const snapshotStale =
      linkLive && snapshotAgeMs != null && snapshotAgeMs > this.snapshotStaleMs;

    const groups = ['attitude', 'position', 'battery', 'velocity', 'status'];
    /** @type {Record<string, { last_change_ms: number, stale: boolean, age_ms: number }>} */
    const out = {};

    for (const g of groups) {
      const last = groupLastActivity[g] ?? 0;
      const age = nowMs - last;
      const stale = linkLive && last > 0 && age > this.groupStaleMs;
      out[g] = { last_change_ms: last, age_ms: age, stale };
    }

    return {
      snapshot_age_ms: snapshotAgeMs,
      snapshot_stale: snapshotStale,
      link_live: linkLive,
      groups: out,
    };
  }

  /**
   * Update activity timestamps when fields change.
   * @param {Record<string, number>} groupLastActivity mut
   * @param {Record<string, unknown>|null} prev
   * @param {Record<string, unknown>} next
   * @param {number} nowMs
   */
  touchGroupsOnChange(groupLastActivity, prev, next, nowMs) {
    if (!prev) {
      groupLastActivity.attitude = nowMs;
      groupLastActivity.position = nowMs;
      groupLastActivity.battery = nowMs;
      groupLastActivity.velocity = nowMs;
      groupLastActivity.status = nowMs;
      return;
    }
    if (this._attitudeChanged(prev, next)) groupLastActivity.attitude = nowMs;
    if (this._positionChanged(prev, next)) groupLastActivity.position = nowMs;
    if (this._batteryChanged(prev, next)) groupLastActivity.battery = nowMs;
    if (this._velocityChanged(prev, next)) groupLastActivity.velocity = nowMs;
    if (this._statusChanged(prev, next)) groupLastActivity.status = nowMs;
  }

  /**
   * @param {Record<string, unknown>} prev
   * @param {Record<string, unknown>} next
   */
  _velocityChanged(prev, next) {
    const a = prev?.velocity;
    const b = next?.velocity;
    if (!a || !b) return true;
    return (
      Math.abs(Number(a.groundspeed) - Number(b.groundspeed)) > 1e-3 ||
      Math.abs(Number(a.airspeed) - Number(b.airspeed)) > 1e-3 ||
      Math.abs(Number(a.climb) - Number(b.climb)) > 1e-3
    );
  }

  /**
   * @param {Record<string, unknown>} prev
   * @param {Record<string, unknown>} next
   */
  _statusChanged(prev, next) {
    const a = prev?.status;
    const b = next?.status;
    if (!a || !b) return true;
    return (
      String(a.mode) !== String(b.mode) ||
      Boolean(a.armed) !== Boolean(b.armed) ||
      Number(a.gps_fix) !== Number(b.gps_fix)
    );
  }
}

module.exports = { StaleTelemetryDetector };
