/**
 * Supervised ZMQ telemetry subscriber (Phase 5A — fixes F3).
 *
 * The original `runZmqSubscriber()` exited into a catch-and-return on the first
 * ZMQ error, silently killing telemetry for every client until a manual Node
 * restart (F3, SEV-CRITICAL). This subscriber instead runs a supervised loop:
 * on any error OR clean stream end it reconnects with exponential backoff +
 * jitter, forever, until `stop()` is called. Connection state, frame receipt,
 * and reconnects are surfaced to health + metrics so the failure is visible.
 *
 * The socket factory and sleep function are injectable so the reconnect/backoff
 * behaviour can be unit-tested with a fake socket and no real broker.
 */
'use strict';

const defaultSleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    }
  });

class ZmqTelemetrySubscriber {
  /**
   * @param {{
   *   url: string,
   *   onFrame: (payload: string) => void,
   *   logger: { info: Function, warn: Function, error: Function, debug: Function },
   *   minBackoffMs?: number,
   *   maxBackoffMs?: number,
   *   socketFactory?: () => object,   // returns a zmq.Subscriber-like object
   *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
   *   onConnected?: (connected: boolean) => void,
   *   onReconnect?: () => void,
   *   now?: () => number,
   * }} opts
   */
  constructor(opts) {
    this.url = opts.url;
    this.onFrame = opts.onFrame;
    this.logger = opts.logger;
    this.minBackoffMs = opts.minBackoffMs ?? 250;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10000;
    this.socketFactory =
      opts.socketFactory ||
      (() => {
        const zmq = require('zeromq');
        return new zmq.Subscriber();
      });
    this.sleep = opts.sleep || defaultSleep;
    this.onConnected = opts.onConnected || (() => {});
    this.onReconnect = opts.onReconnect || (() => {});
    this.now = opts.now || Date.now;

    this._running = false;
    this._attempt = 0;
    this._sock = null;
    this._abort = null;
    this._loopPromise = null;
  }

  /** Exponential backoff with full jitter, capped at maxBackoffMs. */
  _backoffMs(attempt) {
    const exp = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** Math.max(0, attempt - 1));
    // Full jitter: pick uniformly in [min, exp] to avoid thundering-herd reconnects.
    const jittered = this.minBackoffMs + Math.random() * (exp - this.minBackoffMs);
    return Math.round(jittered);
  }

  start() {
    if (this._running) return this._loopPromise;
    this._running = true;
    this._abort = new AbortController();
    this._loopPromise = this._superviseLoop();
    return this._loopPromise;
  }

  async _superviseLoop() {
    while (this._running) {
      let sock;
      try {
        sock = this.socketFactory();
        this._sock = sock;
        sock.connect(this.url);
        sock.subscribe('');
        this._attempt = 0;
        this.onConnected(true);
        this.logger.info('zmq subscriber connected', { url: this.url });

        for await (const [msg] of sock) {
          if (!this._running) break;
          try {
            this.onFrame(msg.toString());
          } catch (err) {
            // A single malformed/handler error must never kill the stream.
            this.logger.error('zmq frame handler threw', { error: String(err && err.message || err) });
          }
        }
        // Clean end of the async iterator (socket closed by us or peer).
        this.onConnected(false);
        if (!this._running) break;
        this.logger.warn('zmq stream ended unexpectedly — will reconnect', { url: this.url });
      } catch (err) {
        this.onConnected(false);
        if (!this._running) break;
        this.logger.error('zmq subscriber error — will reconnect', {
          url: this.url,
          error: String(err && err.message || err),
          attempt: this._attempt + 1,
        });
      } finally {
        try { if (sock && !sock.closed) sock.close(); } catch { /* already closed */ }
        if (this._sock === sock) this._sock = null;
      }

      if (!this._running) break;

      this._attempt += 1;
      this.onReconnect();
      const delay = this._backoffMs(this._attempt);
      this.logger.info('zmq reconnect scheduled', { delay_ms: delay, attempt: this._attempt });
      await this.sleep(delay, this._abort.signal);
    }
    this.onConnected(false);
    this.logger.info('zmq subscriber stopped');
  }

  async stop() {
    if (!this._running) return;
    this._running = false;
    if (this._abort) this._abort.abort();
    try { if (this._sock && !this._sock.closed) this._sock.close(); } catch { /* ignore */ }
    try { await this._loopPromise; } catch { /* ignore */ }
  }
}

module.exports = { ZmqTelemetrySubscriber, defaultSleep };
