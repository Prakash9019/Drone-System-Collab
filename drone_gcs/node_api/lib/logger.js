/**
 * Structured JSON logging with correlation IDs (Phase 5A).
 *
 * Every log line is one JSON object: {ts, level, service, msg, ...fields}. When a
 * request is in flight, `request_id` (and any other bound context) is injected
 * automatically via AsyncLocalStorage, so handlers just call `log.info('...')`
 * and correlation travels with the async context — no manual threading.
 */
'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const als = new AsyncLocalStorage();

class Logger {
  /**
   * @param {{ level?: string, service?: string, sink?: (line: string) => void, base?: object }} [opts]
   */
  constructor(opts = {}) {
    this.level = opts.level || 'info';
    this.service = opts.service || 'node-api';
    this.sink = opts.sink || ((line) => process.stdout.write(line + '\n'));
    this.base = opts.base || {};
  }

  _enabled(level) {
    return (LEVELS[level] || 0) >= (LEVELS[this.level] || 0);
  }

  _emit(level, msg, fields) {
    if (!this._enabled(level)) return;
    const ctx = als.getStore() || {};
    const record = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      msg: String(msg),
      ...this.base,
      ...ctx,
      ...(fields || {}),
    };
    let line;
    try {
      line = JSON.stringify(record);
    } catch {
      // Circular or non-serializable field — degrade rather than throw in a log call.
      line = JSON.stringify({ ts: record.ts, level, service: this.service, msg: String(msg), log_error: 'unserializable_fields' });
    }
    this.sink(line);
  }

  debug(msg, fields) { this._emit('debug', msg, fields); }
  info(msg, fields) { this._emit('info', msg, fields); }
  warn(msg, fields) { this._emit('warn', msg, fields); }
  error(msg, fields) { this._emit('error', msg, fields); }

  /** Bind static fields onto a derived logger (e.g. per-subsystem drone_id). */
  child(fields) {
    return new Logger({
      level: this.level,
      service: this.service,
      sink: this.sink,
      base: { ...this.base, ...fields },
    });
  }
}

/**
 * Run `fn` with the given correlation context bound to the async scope. Any log
 * call inside (including in awaited callbacks) inherits `context`.
 */
function runWithContext(context, fn) {
  return als.run({ ...(als.getStore() || {}), ...context }, fn);
}

/** Merge fields into the current async context (if any). */
function bindContext(fields) {
  const store = als.getStore();
  if (store) Object.assign(store, fields);
}

function currentContext() {
  return als.getStore() || {};
}

module.exports = { Logger, runWithContext, bindContext, currentContext, LEVELS };
