/**
 * Phase 5A production-hardening tests — config validation, structured logging,
 * metrics, health/readiness, supervised ZMQ reconnect, and the slow-client
 * send-queue cap. Run with: npm test (node --test).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateConfig } = require('../lib/config');
const { Logger, runWithContext } = require('../lib/logger');
const { createMetrics } = require('../lib/metrics');
const { HealthState } = require('../lib/health');
const { ZmqTelemetrySubscriber } = require('../ws/zmqSubscriber');
const { createBroadcaster } = require('../ws/broadcaster');

// ── config validation ────────────────────────────────────────────────────────

test('config: defaults are valid with an empty env', () => {
  const { config, errors } = validateConfig({});
  assert.deepEqual(errors, []);
  assert.equal(config.httpPort, 8080);
  assert.equal(config.pythonApiUrl, 'http://127.0.0.1:8000');
  assert.equal(config.zmqPubUrl, 'tcp://127.0.0.1:5556');
  assert.equal(config.metricsEnabled, true);
});

test('config: rejects a non-numeric / out-of-range port', () => {
  assert.ok(validateConfig({ HTTP_PORT: 'abc' }).errors.some((e) => e.includes('HTTP_PORT')));
  assert.ok(validateConfig({ HTTP_PORT: '70000' }).errors.some((e) => e.includes('HTTP_PORT')));
  assert.deepEqual(validateConfig({ HTTP_PORT: '9090' }).errors, []);
});

test('config: rejects malformed PYTHON_API_URL and ZMQ_PUB_URL', () => {
  assert.ok(validateConfig({ PYTHON_API_URL: 'not a url' }).errors.some((e) => e.includes('PYTHON_API_URL')));
  assert.ok(validateConfig({ ZMQ_PUB_URL: 'http://x:1' }).errors.some((e) => e.includes('ZMQ_PUB_URL')));
  assert.deepEqual(validateConfig({ ZMQ_PUB_URL: 'tcp://10.0.0.5:5556' }).errors, []);
});

test('config: rejects bad log level, backoff ordering, and boolean', () => {
  assert.ok(validateConfig({ LOG_LEVEL: 'chatty' }).errors.some((e) => e.includes('LOG_LEVEL')));
  assert.ok(validateConfig({ ZMQ_RECONNECT_MIN_MS: '5000', ZMQ_RECONNECT_MAX_MS: '1000' }).errors.some((e) => e.includes('ZMQ_RECONNECT_MAX_MS')));
  assert.ok(validateConfig({ METRICS_ENABLED: 'maybe' }).errors.some((e) => e.includes('METRICS_ENABLED')));
});

// ── structured logger ─────────────────────────────────────────────────────────

test('logger: emits single-line JSON with level filtering', () => {
  const lines = [];
  const log = new Logger({ level: 'info', sink: (l) => lines.push(l) });
  log.debug('should be filtered');
  log.info('hello', { drone_id: 'scout-1' });
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.level, 'info');
  assert.equal(rec.msg, 'hello');
  assert.equal(rec.drone_id, 'scout-1');
  assert.ok(rec.ts);
});

test('logger: correlation id from async context is injected automatically', () => {
  const lines = [];
  const log = new Logger({ level: 'info', sink: (l) => lines.push(l) });
  runWithContext({ request_id: 'req-42' }, () => {
    log.info('inside request');
  });
  log.info('outside request');
  assert.equal(JSON.parse(lines[0]).request_id, 'req-42');
  assert.equal(JSON.parse(lines[1]).request_id, undefined);
});

test('logger: child binds static fields', () => {
  const lines = [];
  const log = new Logger({ level: 'info', sink: (l) => lines.push(l) }).child({ subsystem: 'zmq' });
  log.warn('reconnecting');
  assert.equal(JSON.parse(lines[0]).subsystem, 'zmq');
});

test('logger: never throws on unserializable fields', () => {
  const lines = [];
  const log = new Logger({ level: 'info', sink: (l) => lines.push(l) });
  const circular = {}; circular.self = circular;
  assert.doesNotThrow(() => log.info('circular', { circular }));
  assert.equal(JSON.parse(lines[0]).log_error, 'unserializable_fields');
});

// ── metrics ───────────────────────────────────────────────────────────────────

test('metrics: exposes Prometheus text with custom + default series', async () => {
  const m = createMetrics({ serviceName: 'test-svc' });
  m.zmqFramesReceived.inc();
  m.wsClients.set(3);
  m.telemetryFramesProcessed.inc({ drone_id: 'scout-1' });
  const text = await m.expose();
  assert.match(text, /zmq_frames_received_total/);
  assert.match(text, /ws_clients\{[^}]*\} 3/);
  assert.match(text, /telemetry_frames_processed_total\{.*drone_id="scout-1".*\}/);
  assert.match(text, /process_cpu_user_seconds_total/); // default metric
  assert.match(text, /service="test-svc"/);
});

// ── health / readiness ────────────────────────────────────────────────────────

test('health: liveness ok until shutdown, then shutting_down', () => {
  let t = 1000;
  const h = new HealthState({ now: () => t, staleMs: 15000, graceMs: 20000 });
  assert.equal(h.liveness().status, 'ok');
  h.markShuttingDown();
  assert.equal(h.liveness().status, 'shutting_down');
});

test('health: readiness needs zmq connected during grace window', () => {
  let t = 0;
  const h = new HealthState({ now: () => t, staleMs: 15000, graceMs: 20000 });
  t = 5000; // within grace
  assert.equal(h.readiness().ready, false); // zmq not connected yet
  h.setZmqConnected(true);
  assert.equal(h.readiness().ready, true); // empty stream tolerated during grace
});

test('health: after grace, a stale telemetry stream is not ready', () => {
  let t = 0;
  const h = new HealthState({ now: () => t, staleMs: 15000, graceMs: 20000 });
  h.setZmqConnected(true);
  h.recordFrame(0);
  t = 25000; // past grace, last frame at t=0 → 25s stale > 15s
  const r = h.readiness();
  assert.equal(r.ready, false);
  assert.equal(r.checks.telemetry_fresh, false);
  h.recordFrame(24000); // fresh frame
  assert.equal(h.readiness().ready, true);
});

test('health: readiness is false while shutting down', () => {
  let t = 0;
  const h = new HealthState({ now: () => t, staleMs: 15000, graceMs: 20000 });
  h.setZmqConnected(true);
  h.recordFrame(0);
  h.markShuttingDown();
  assert.equal(h.readiness().ready, false);
});

// ── supervised ZMQ subscriber (F3) ────────────────────────────────────────────

function fakeSocket(frames, { throwAfter = null } = {}) {
  return {
    closed: false,
    connect() {},
    subscribe() {},
    close() { this.closed = true; },
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < frames.length; i++) {
        if (throwAfter !== null && i === throwAfter) throw new Error('zmq boom');
        yield [Buffer.from(frames[i])];
      }
      // clean end of stream otherwise
    },
  };
}

test('zmq: delivers frames and reconnects after an error (fixes F3)', async () => {
  const received = [];
  let connects = 0;
  let reconnects = 0;
  const connectedStates = [];
  const sockets = [
    fakeSocket(['a', 'b'], { throwAfter: 1 }), // yields 'a' then throws → reconnect
    fakeSocket(['c']),                          // yields 'c' then clean-ends → reconnect
    fakeSocket([]),                             // empty, will be stopped
  ];
  const sub = new ZmqTelemetrySubscriber({
    url: 'tcp://x:1',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    minBackoffMs: 1,
    maxBackoffMs: 2,
    socketFactory: () => sockets[Math.min(connects++, sockets.length - 1)],
    sleep: async () => {}, // no real delay in tests
    onFrame: (p) => {
      received.push(p);
      if (received.length >= 2) sub.stop(); // stop once we've proven reconnect delivered 'c'
    },
    onConnected: (c) => connectedStates.push(c),
    onReconnect: () => { reconnects++; },
  });

  await sub.start();
  assert.deepEqual(received, ['a', 'c']); // 'a' pre-error, 'c' after reconnect → F3 fixed
  assert.ok(reconnects >= 1, 'should have reconnected at least once');
  assert.ok(sockets[0].closed, 'errored socket must be closed');
  assert.ok(connectedStates.includes(true) && connectedStates.includes(false));
});

test('zmq: backoff grows exponentially and is capped', () => {
  const sub = new ZmqTelemetrySubscriber({
    url: 'tcp://x:1',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    minBackoffMs: 100,
    maxBackoffMs: 1000,
    onFrame() {},
  });
  // Full jitter keeps values within [min, cappedExp]; the cap must hold.
  for (let attempt = 1; attempt <= 20; attempt++) {
    const d = sub._backoffMs(attempt);
    assert.ok(d >= 100 && d <= 1000, `attempt ${attempt} backoff ${d} out of range`);
  }
});

test('zmq: a throwing frame handler does not kill the stream', async () => {
  const seen = [];
  let connects = 0;
  const sockets = [fakeSocket(['x', 'y', 'z'])];
  const sub = new ZmqTelemetrySubscriber({
    url: 'tcp://x:1',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    minBackoffMs: 1,
    maxBackoffMs: 1,
    socketFactory: () => sockets[Math.min(connects++, sockets.length - 1)],
    sleep: async () => {},
    onFrame: (p) => {
      seen.push(p);
      if (p === 'x') throw new Error('handler boom'); // must be swallowed
      if (seen.length >= 3) sub.stop();
    },
  });
  await sub.start();
  assert.deepEqual(seen, ['x', 'y', 'z']); // stream survived the handler throw
});

// ── slow-client send-queue cap ────────────────────────────────────────────────

function fakeClient({ buffered = 0 } = {}) {
  return {
    readyState: 1,
    bufferedAmount: buffered,
    sent: [],
    terminated: false,
    send(d) { this.sent.push(d); },
    terminate() { this.terminated = true; },
  };
}

test('broadcast: healthy client receives the frame', () => {
  const m = createMetrics({ collectDefault: false });
  const b = createBroadcaster({ metrics: m, softCapBytes: 1000 });
  const c = fakeClient({ buffered: 0 });
  b([c], 'frame', 'default');
  assert.deepEqual(c.sent, ['frame']);
});

test('broadcast: soft-cap client has the frame shed, not terminated', () => {
  const m = createMetrics({ collectDefault: false });
  const b = createBroadcaster({ metrics: m, softCapBytes: 1000 });
  const c = fakeClient({ buffered: 2000 }); // over soft cap (1000), under hard (4000)
  b([c], 'frame', 'default');
  assert.deepEqual(c.sent, []);
  assert.equal(c.terminated, false);
});

test('broadcast: hard-cap client is terminated with a notice', () => {
  const m = createMetrics({ collectDefault: false });
  const b = createBroadcaster({ metrics: m, softCapBytes: 1000 });
  const c = fakeClient({ buffered: 5000 }); // over hard cap (4*1000)
  b([c], 'frame', 'default');
  assert.equal(c.terminated, true);
  assert.match(c.sent[0], /SLOW_CONSUMER/);
});

test('broadcast: respects subscription filtering', () => {
  const m = createMetrics({ collectDefault: false });
  const subscriptions = { wants: (_c, droneId) => droneId === 'scout-1' };
  const b = createBroadcaster({ metrics: m, softCapBytes: 1000, subscriptions });
  const c = fakeClient();
  b([c], 'frame', 'other-drone');
  assert.deepEqual(c.sent, []);
  b([c], 'frame', 'scout-1');
  assert.deepEqual(c.sent, ['frame']);
});
