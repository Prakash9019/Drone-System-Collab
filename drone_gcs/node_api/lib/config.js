/**
 * Configuration loading + validation for the Node API gateway (Phase 5A).
 *
 * Every tunable is an environment variable with a safe default. `validateConfig`
 * is pure (takes an env-like object, returns {config, errors}) so it can be unit
 * tested and so the process can fail fast at boot on a misconfiguration instead
 * of limping along with, say, a port of "abc" silently coerced to NaN.
 */
'use strict';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function toInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function toBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return null; // signals invalid
}

/**
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} env
 * @returns {{ config: object, errors: string[] }}
 */
function validateConfig(env = {}) {
  const errors = [];

  const port = toInt(env.HTTP_PORT ?? env.PORT, 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`HTTP_PORT must be an integer in 1..65535 (got "${env.HTTP_PORT ?? env.PORT}")`);
  }

  const pythonApiUrl = env.PYTHON_API_URL || 'http://127.0.0.1:8000';
  try {
    const u = new URL(pythonApiUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
  } catch {
    errors.push(`PYTHON_API_URL must be a valid http(s) URL (got "${pythonApiUrl}")`);
  }

  const zmqPubUrl = env.ZMQ_PUB_URL || 'tcp://127.0.0.1:5556';
  if (!/^tcp:\/\/[^\s]+:\d+$/.test(zmqPubUrl)) {
    errors.push(`ZMQ_PUB_URL must look like tcp://host:port (got "${zmqPubUrl}")`);
  }

  const logLevel = (env.LOG_LEVEL || 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) {
    errors.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join('|')} (got "${env.LOG_LEVEL}")`);
  }

  const wsMaxSendQueueBytes = toInt(env.WS_MAX_SEND_QUEUE_BYTES, 8 * 1024 * 1024);
  if (!Number.isInteger(wsMaxSendQueueBytes) || wsMaxSendQueueBytes < 64 * 1024) {
    errors.push(`WS_MAX_SEND_QUEUE_BYTES must be an integer >= 65536 (got "${env.WS_MAX_SEND_QUEUE_BYTES}")`);
  }

  const zmqReconnectMinMs = toInt(env.ZMQ_RECONNECT_MIN_MS, 250);
  const zmqReconnectMaxMs = toInt(env.ZMQ_RECONNECT_MAX_MS, 10000);
  if (!Number.isInteger(zmqReconnectMinMs) || zmqReconnectMinMs < 10) {
    errors.push(`ZMQ_RECONNECT_MIN_MS must be an integer >= 10 (got "${env.ZMQ_RECONNECT_MIN_MS}")`);
  }
  if (!Number.isInteger(zmqReconnectMaxMs) || zmqReconnectMaxMs < zmqReconnectMinMs) {
    errors.push(`ZMQ_RECONNECT_MAX_MS must be an integer >= ZMQ_RECONNECT_MIN_MS (got "${env.ZMQ_RECONNECT_MAX_MS}")`);
  }

  // How long the telemetry stream may be silent before /readyz reports degraded.
  const zmqStaleMs = toInt(env.ZMQ_STALE_MS, 15000);
  if (!Number.isInteger(zmqStaleMs) || zmqStaleMs < 1000) {
    errors.push(`ZMQ_STALE_MS must be an integer >= 1000 (got "${env.ZMQ_STALE_MS}")`);
  }

  // Grace window after boot during which an empty telemetry stream is still "ready"
  // (nothing may be publishing yet). Prevents readiness flapping on a cold start.
  const readinessGraceMs = toInt(env.READINESS_GRACE_MS, 20000);
  if (!Number.isInteger(readinessGraceMs) || readinessGraceMs < 0) {
    errors.push(`READINESS_GRACE_MS must be an integer >= 0 (got "${env.READINESS_GRACE_MS}")`);
  }

  const shutdownTimeoutMs = toInt(env.SHUTDOWN_TIMEOUT_MS, 10000);
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 100) {
    errors.push(`SHUTDOWN_TIMEOUT_MS must be an integer >= 100 (got "${env.SHUTDOWN_TIMEOUT_MS}")`);
  }

  const metricsEnabled = toBool(env.METRICS_ENABLED, true);
  if (metricsEnabled === null) {
    errors.push(`METRICS_ENABLED must be a boolean (got "${env.METRICS_ENABLED}")`);
  }

  const config = Object.freeze({
    httpPort: port,
    pythonApiUrl,
    zmqPubUrl,
    logLevel,
    wsMaxSendQueueBytes,
    zmqReconnectMinMs,
    zmqReconnectMaxMs,
    zmqStaleMs,
    readinessGraceMs,
    shutdownTimeoutMs,
    metricsEnabled: metricsEnabled === null ? true : metricsEnabled,
    serviceName: env.SERVICE_NAME || 'drone-gcs-node-api',
  });

  return { config, errors };
}

/**
 * Validate the current process env and exit(1) on any error. Called once at boot.
 * @param {(msg: string, fields?: object) => void} [logFatal]
 */
function loadConfigOrExit(env = process.env, logFatal) {
  const { config, errors } = validateConfig(env);
  if (errors.length > 0) {
    const emit =
      logFatal ||
      ((msg, fields) => console.error(JSON.stringify({ level: 'error', msg, ...fields })));
    emit('configuration invalid — refusing to start', { errors });
    process.exit(1);
  }
  return config;
}

module.exports = { validateConfig, loadConfigOrExit, LOG_LEVELS };
