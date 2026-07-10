/**
 * Liveness/readiness state for the Node API gateway (Phase 5A).
 *
 * Liveness answers "is the event loop alive and not shutting down" — a failing
 * /healthz should trigger a supervisor restart. Readiness answers "should this
 * instance receive traffic" — it goes degraded when the telemetry stream is
 * silent past the stale threshold (outside the cold-start grace window), so a
 * load balancer / orchestrator stops routing to a gateway whose upstream data
 * has dried up while /healthz stays green.
 */
'use strict';

class HealthState {
  /**
   * @param {{ now?: () => number, staleMs: number, graceMs: number }} opts
   */
  constructor(opts) {
    this._now = opts.now || Date.now;
    this.staleMs = opts.staleMs;
    this.graceMs = opts.graceMs;
    this.startedAt = this._now();
    this.shuttingDown = false;
    this.zmqConnected = false;
    this.lastFrameAt = null; // ms epoch of last received ZMQ frame
  }

  markShuttingDown() {
    this.shuttingDown = true;
  }

  setZmqConnected(connected) {
    this.zmqConnected = !!connected;
  }

  recordFrame(atMs) {
    this.lastFrameAt = atMs != null ? atMs : this._now();
  }

  /** @returns {{ status: 'ok'|'shutting_down', uptime_s: number }} */
  liveness() {
    return {
      status: this.shuttingDown ? 'shutting_down' : 'ok',
      uptime_s: Math.round((this._now() - this.startedAt) / 1000),
    };
  }

  /**
   * @returns {{ ready: boolean, status: string, checks: object }}
   */
  readiness() {
    const now = this._now();
    const withinGrace = now - this.startedAt < this.graceMs;
    const frameAgeMs = this.lastFrameAt == null ? null : now - this.lastFrameAt;
    const telemetryFresh = frameAgeMs != null && frameAgeMs <= this.staleMs;

    const checks = {
      zmq_connected: this.zmqConnected,
      telemetry_fresh: telemetryFresh,
      last_frame_age_s: frameAgeMs == null ? null : Math.round(frameAgeMs / 1000),
      within_startup_grace: withinGrace,
      shutting_down: this.shuttingDown,
    };

    // Not ready while shutting down (drain), or when we've lost a previously
    // healthy telemetry stream. During the cold-start grace window an empty
    // stream is tolerated (nothing may be publishing yet).
    let ready;
    if (this.shuttingDown) {
      ready = false;
    } else if (withinGrace) {
      ready = this.zmqConnected;
    } else {
      ready = this.zmqConnected && telemetryFresh;
    }

    return { ready, status: ready ? 'ready' : 'not_ready', checks };
  }
}

module.exports = { HealthState };
