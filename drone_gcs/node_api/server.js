const express = require('express');
const { WebSocketServer } = require('ws');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ─── Phase 5A production hardening: config, logging, metrics, health ──────────
const { loadConfigOrExit } = require('./lib/config');
const { Logger, runWithContext } = require('./lib/logger');
const { createMetrics } = require('./lib/metrics');
const { HealthState } = require('./lib/health');
const { ZmqTelemetrySubscriber } = require('./ws/zmqSubscriber');
const { createBroadcaster } = require('./ws/broadcaster');

// Fail fast on misconfiguration BEFORE binding any port or socket.
const config = loadConfigOrExit(process.env);

const log = new Logger({ level: config.logLevel, service: config.serviceName });
const metrics = createMetrics({ serviceName: config.serviceName });
const health = new HealthState({ staleMs: config.zmqStaleMs, graceMs: config.readinessGraceMs });

const HTTP_PORT = config.httpPort;
const PYTHON_API_URL = config.pythonApiUrl;
const ZMQ_PUB_URL = config.zmqPubUrl;

const app = express();
app.use(cors());
app.use(express.json());

// Correlation-id + request-scoped logging/metrics. Runs first so every handler
// (and its async continuations) inherits `request_id` via AsyncLocalStorage.
app.use((req, res, next) => {
  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID());
  res.setHeader('x-request-id', requestId);
  const startNs = process.hrtime.bigint();
  res.on('finish', () => {
    const route = (req.route && req.route.path) || req.path || 'unmatched';
    const labels = { method: req.method, route, status: String(res.statusCode) };
    const durationS = Number(process.hrtime.bigint() - startNs) / 1e9;
    try {
      metrics.httpRequests.inc(labels);
      metrics.httpDuration.observe(labels, durationS);
    } catch { /* metrics must never break a response */ }
    log.info('http_request', { request_id: requestId, method: req.method, route, status: res.statusCode, duration_ms: Math.round(durationS * 1000) });
  });
  runWithContext({ request_id: requestId }, next);
});

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 52 * 1024 * 1024 } });

const { TelemetryCoreEngine, TelemetryEventBus } = require('./telemetry');
const { SubscriptionManager } = require('./ws/subscriptionManager');

// Set up WebSocket server attached to Express HTTP server
const server = app.listen(HTTP_PORT, () => {
  log.info('gateway_listening', { port: HTTP_PORT, python_api: PYTHON_API_URL, zmq: ZMQ_PUB_URL });
});

const wss = new WebSocketServer({ server });
const subscriptions = new SubscriptionManager();

wss.on('connection', (ws) => {
  metrics.wsClients.inc();
  log.info('ws_client_connected', { clients: wss.clients.size });
  subscriptions.addClient(ws);
  ws.on('close', () => {
    metrics.wsClients.dec();
    log.info('ws_client_disconnected', { clients: wss.clients.size });
  });
  ws.on('error', (err) => log.warn('ws_client_error', { error: String(err && err.message || err) }));
});

// Broadcast helper — droneId-aware subscription filtering + slow-client
// send-queue cap (see ws/broadcaster.js). Per-drone last-seen is tracked for
// the drone_last_seen_age metric exposed at /metrics.
const _sendFrame = createBroadcaster({ metrics, softCapBytes: config.wsMaxSendQueueBytes, subscriptions, logger: log });
const droneLastSeen = new Map();
function broadcast(data, droneId) {
  if (droneId != null) {
    droneLastSeen.set(String(droneId), Date.now());
    try { metrics.telemetryFramesProcessed.inc({ drone_id: String(droneId) }); } catch { /* ignore */ }
  }
  _sendFrame(wss.clients, data, droneId);
}

const telemetryBus = new TelemetryEventBus();
const telemetryEngine = new TelemetryCoreEngine({ broadcast, bus: telemetryBus });

// ─── Operational endpoints: health, readiness, metrics ───────────────────────
app.get('/healthz', (req, res) => {
  const l = health.liveness();
  res.status(l.status === 'shutting_down' ? 503 : 200).json(l);
});

app.get('/readyz', (req, res) => {
  const r = health.readiness();
  res.status(r.ready ? 200 : 503).json(r);
});

app.get('/metrics', async (req, res) => {
  if (!config.metricsEnabled) return res.status(404).end();
  try {
    // Refresh age gauges at scrape time.
    const now = Date.now();
    metrics.zmqConnected.set(health.zmqConnected ? 1 : 0);
    metrics.zmqLastFrameAge.set(health.lastFrameAt == null ? -1 : (now - health.lastFrameAt) / 1000);
    for (const [droneId, seenAt] of droneLastSeen) {
      metrics.droneLastSeenAge.set({ drone_id: droneId }, (now - seenAt) / 1000);
    }
    res.setHeader('Content-Type', metrics.contentType);
    res.end(await metrics.expose());
  } catch (err) {
    log.error('metrics_scrape_failed', { error: String(err && err.message || err) });
    res.status(500).end();
  }
});

// Connection lifecycle proxies
app.post('/api/connection/start', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/connection/start`, req.body || {});
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to start connection', details: err.message });
  }
});

app.post('/api/connection/stop', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/connection/stop`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop connection', details: err.message });
  }
});

app.get('/api/connection/status', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/connection/status`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch connection status', details: err.message });
  }
});

app.get('/api/connection/ports', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/connection/ports`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list serial ports', details: err.message });
  }
});

// Telemetry replay — record / playback proxies.
// The Python service exposes /replay/* directly; the frontend talks to the Node gateway only,
// so we forward verbatim. State lives in replay_manager.py (one recorder + one player per process).
app.post('/api/replay/record/start', async (req, res) => {
  try {
    const r = await axios.post(`${PYTHON_API_URL}/replay/record/start`);
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to start recording', details: err.message });
  }
});

app.post('/api/replay/record/stop', async (req, res) => {
  try {
    const r = await axios.post(`${PYTHON_API_URL}/replay/record/stop`);
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop recording', details: err.message });
  }
});

app.get('/api/replay/sessions', async (req, res) => {
  try {
    const r = await axios.get(`${PYTHON_API_URL}/replay/sessions`);
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list replay sessions', details: err.message });
  }
});

app.post('/api/replay/playback/start', async (req, res) => {
  try {
    const r = await axios.post(`${PYTHON_API_URL}/replay/playback/start`, req.body || {});
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to start playback', details: err.message });
  }
});

app.post('/api/replay/playback/stop', async (req, res) => {
  try {
    const r = await axios.post(`${PYTHON_API_URL}/replay/playback/stop`);
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop playback', details: err.message });
  }
});

app.post('/api/replay/playback/pause', async (req, res) => {
  try {
    const r = await axios.post(`${PYTHON_API_URL}/replay/playback/pause`);
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to pause playback', details: err.message });
  }
});

app.post('/api/replay/playback/resume', async (req, res) => {
  try {
    const r = await axios.post(`${PYTHON_API_URL}/replay/playback/resume`);
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to resume playback', details: err.message });
  }
});

app.post('/api/replay/playback/seek', async (req, res) => {
  try {
    const r = await axios.post(`${PYTHON_API_URL}/replay/playback/seek`, req.body || {});
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to seek playback', details: err.message });
  }
});

// ZeroMQ Subscriber — supervised with reconnect + backoff (Phase 5A, fixes F3).
// A ZMQ error or clean stream end no longer silently kills telemetry forever;
// it reconnects with exponential backoff and the state is visible in /readyz +
// /metrics.
const zmqSubscriber = new ZmqTelemetrySubscriber({
  url: ZMQ_PUB_URL,
  logger: log.child({ subsystem: 'zmq' }),
  minBackoffMs: config.zmqReconnectMinMs,
  maxBackoffMs: config.zmqReconnectMaxMs,
  onConnected: (connected) => health.setZmqConnected(connected),
  onReconnect: () => { try { metrics.zmqReconnects.inc(); } catch { /* ignore */ } },
  onFrame: (payload) => {
    health.recordFrame();
    try { metrics.zmqFramesReceived.inc(); } catch { /* ignore */ }
    telemetryEngine.processZmqFrameString(payload);
  },
});

// Start ZMQ
zmqSubscriber.start();

// Telemetry engine (read-only debug)
app.get('/api/telemetry/engine/snapshot', (req, res) => {
  try {
    res.json(telemetryEngine.getDebugSnapshot());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// REST Proxy Routes
app.get('/api/state', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/state`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reach Python backend' });
  }
});

app.get('/api/mission', async (req, res) => {
  try {
    const missionType = req.query.mission_type || 'MISSION';
    const response = await axios.get(`${PYTHON_API_URL}/mission`, {
      params: { mission_type: missionType }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch mission', details: err.message });
  }
});

app.get('/api/mission/transfer/status', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/mission/transfer/status`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch mission transfer status', details: err.message });
  }
});

app.post('/api/mission/upload', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/mission/upload`, req.body);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload mission', details: err.message });
  }
});

app.get('/api/fence', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/fence`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch fence', details: err.message });
  }
});

app.post('/api/fence/upload', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/fence/upload`, req.body);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload fence', details: err.message });
  }
});

app.get('/api/fence/status', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/fence/status`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch fence status', details: err.message });
  }
});

app.post('/api/fence/config', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/fence/config`, req.body);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to apply fence config', details: err.message });
  }
});

app.get('/api/rally', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/rally`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch rally', details: err.message });
  }
});

app.post('/api/rally/upload', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/rally/upload`, req.body);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload rally', details: err.message });
  }
});

// Command route mapping common text commands to MAVLink COMMAND_LONG ids
const COMMAND_MAP = {
  'arm': { command: 400, p1: 1 }, // MAV_CMD_COMPONENT_ARM_DISARM
  'force_arm': { command: 400, p1: 1, p2: 21196 }, // Force arm — bypasses ArduPilot pre-arm checks (SITL / debug only)
  'disarm': { command: 400, p1: 0 },
  'rtl': { command: 20 }, // MAV_CMD_NAV_RETURN_TO_LAUNCH
  'land': { command: 21 }, // MAV_CMD_NAV_LAND
  'takeoff': { command: 22, p7: 10 }, // MAV_CMD_NAV_TAKEOFF (default 10m alt)
  'mission_start': { command: 300 }, // MAV_CMD_MISSION_START
  'pause': { command: 193, p1: 0 }, // MAV_CMD_DO_PAUSE_CONTINUE — pause
  'continue': { command: 193, p1: 1 }, // resume
};

app.get('/api/vehicle/flight_modes', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/vehicle/flight_modes`);
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({
      error: 'Failed to load flight modes',
      details: err.response?.data || err.message,
    });
  }
});

app.post('/api/command/:cmd', async (req, res) => {
  const cmdStr = req.params.cmd.toLowerCase();

  if (COMMAND_MAP[cmdStr]) {
    try {
      const base = COMMAND_MAP[cmdStr];
      const payload = {
        command: base.command,
        p1: base.p1 ?? 0,
        p2: base.p2 ?? 0,
        p3: base.p3 ?? 0,
        p4: base.p4 ?? 0,
        p5: base.p5 ?? 0,
        p6: base.p6 ?? 0,
        p7: base.p7 ?? 0,
      };
      if (cmdStr === 'takeoff' && req.body && req.body.altitude_m != null && !Number.isNaN(Number(req.body.altitude_m))) {
        payload.p7 = Number(req.body.altitude_m);
      }
      const response = await axios.post(`${PYTHON_API_URL}/command`, payload);
      res.json(response.data);
    } catch (err) {
      const status = err.response?.status || 500;
      res.status(status).json({
        error: 'Command failed in python backend',
        details: err.response?.data || err.message,
      });
    }
  } else {
    res.status(400).json({ error: 'Unknown command shortcut' });
  }
});

// ─── Fleet routes ─────────────────────────────────────────────────────────────
// Per-drone command shortcut — same COMMAND_MAP, addressed to one fleet drone.
// Registered BEFORE the generic /api/drones forwarder so it wins the match.
app.post('/api/drones/:droneId/command/:cmd', async (req, res) => {
  const cmdStr = req.params.cmd.toLowerCase();
  if (!COMMAND_MAP[cmdStr]) {
    return res.status(400).json({ error: 'Unknown command shortcut' });
  }
  try {
    const base = COMMAND_MAP[cmdStr];
    const payload = {
      command: base.command,
      p1: base.p1 ?? 0,
      p2: base.p2 ?? 0,
      p3: base.p3 ?? 0,
      p4: base.p4 ?? 0,
      p5: base.p5 ?? 0,
      p6: base.p6 ?? 0,
      p7: base.p7 ?? 0,
    };
    if (cmdStr === 'takeoff' && req.body && req.body.altitude_m != null && !Number.isNaN(Number(req.body.altitude_m))) {
      payload.p7 = Number(req.body.altitude_m);
    }
    const response = await axios.post(
      `${PYTHON_API_URL}/fleet/drones/${encodeURIComponent(req.params.droneId)}/command`,
      payload
    );
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({
      error: 'Command failed in python backend',
      details: err.response?.data || err.message,
    });
  }
});

// Generic fleet forwarder: /api/fleet/*  → python /fleet/*
//                          /api/drones/* → python /fleet/drones/*
// The Python fleet API mirrors these paths 1:1 (see python_service/fleet/routes.py),
// so one verbatim forwarder covers registration, connection, state, missions,
// parameters, and everything Phase 4+ adds — no per-route boilerplate.
async function forwardToFleet(req, res, pythonPath) {
  try {
    const response = await axios.request({
      method: req.method,
      url: `${PYTHON_API_URL}${pythonPath}`,
      data: ['POST', 'PUT', 'PATCH'].includes(req.method) ? (req.body || {}) : undefined,
      params: req.query,
      validateStatus: () => true, // pass python's status codes through (404, 409, …)
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(502).json({ error: 'Fleet backend unreachable', details: err.message });
  }
}

app.all('/api/fleet', (req, res) => forwardToFleet(req, res, '/fleet'));
app.all('/api/fleet/*', (req, res) =>
  forwardToFleet(req, res, req.originalUrl.replace(/^\/api\/fleet/, '/fleet').split('?')[0])
);
app.all('/api/drones', (req, res) => forwardToFleet(req, res, '/fleet/drones'));
app.all('/api/drones/*', (req, res) =>
  forwardToFleet(req, res, req.originalUrl.replace(/^\/api\/drones/, '/fleet/drones').split('?')[0])
);

app.post('/api/mode', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/mode`, req.body);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to set mode', details: err.message });
  }
});

app.post('/api/parameters/refresh', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/parameters/refresh`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to request parameters', details: err.message });
  }
});

app.get('/api/parameters/status', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/parameters/status`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch parameter status', details: err.message });
  }
});

app.post('/api/parameters/cache/load', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/parameters/cache/load`, null, {
      params: { max_age_s: req.query.max_age_s || 3600 }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load parameter cache', details: err.message });
  }
});

app.post('/api/parameters/set', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/parameters/set`, req.body);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to set parameter', details: err.message });
  }
});

app.get('/api/parameters/export', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/parameters/export`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export parameters', details: err.message });
  }
});

app.post('/api/parameters/import', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/parameters/import`, req.body || {});
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to import parameters', details: err.message });
  }
});

app.post('/api/parameters/compare', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/parameters/compare`, req.body || {});
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to compare parameters', details: err.message });
  }
});

app.get('/api/parameters/export.param', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/parameters/export/param`, {
      responseType: 'arraybuffer',
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="parameters.param"');
    res.send(Buffer.from(response.data));
  } catch (err) {
    res.status(500).json({ error: 'Failed to export .param', details: err.message });
  }
});

app.post('/api/parameters/import/param', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/parameters/import/param`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({
      error: 'Failed to import .param',
      details: err.response?.data || err.message,
    });
  }
});

app.post('/api/parameters/compare/param', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/parameters/compare/param`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({
      error: 'Failed to compare .param',
      details: err.response?.data || err.message,
    });
  }
});

app.post('/api/parameters/diff/two-param', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/parameters/diff/two-param`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({
      error: 'Failed to diff two .param files',
      details: err.response?.data || err.message,
    });
  }
});

app.post('/api/calibration/run', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/calibration/run`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({
      error: 'Calibration command failed',
      details: err.response?.data || err.message,
    });
  }
});

app.get('/api/mavlink/inspector', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/mavlink/inspector`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch MAVLink inspector', details: err.message });
  }
});

app.post('/api/logs/analyze', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'file field is required' });
  }
  const form = new FormData();
  form.append('file', fs.createReadStream(req.file.path), req.file.originalname || 'upload.tlog');
  try {
    const response = await axios.post(`${PYTHON_API_URL}/logs/analyze`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({
      error: 'Log analysis failed',
      details: err.response?.data || err.message,
    });
  } finally {
    try {
      fs.unlinkSync(req.file.path);
    } catch (_) {
      /* ignore */
    }
  }
});

app.get('/api/vehicles', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/vehicles`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list vehicles', details: err.message });
  }
});

app.post('/api/vehicles/select', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/vehicles/select`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({
      error: 'Failed to select vehicle',
      details: err.response?.data || err.message,
    });
  }
});

app.get('/api/adsb/traffic', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/adsb/traffic`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch ADS-B traffic', details: err.message });
  }
});

// ─── Video subsystem proxies ─────────────────────────────────────────────
// (The /ws/video/signaling WebSocket is intentionally NOT proxied here —
//  the browser connects directly to the Python service for SDP/ICE.)
app.get('/api/video/state', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/video/state`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch video state', details: err.message });
  }
});

app.get('/api/video/settings', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/video/settings`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch video settings', details: err.message });
  }
});

app.put('/api/video/settings', async (req, res) => {
  try {
    const response = await axios.put(`${PYTHON_API_URL}/video/settings`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to update video settings', details: err.response?.data || err.message });
  }
});

app.post('/api/video/start', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/video/start`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to start video', details: err.message });
  }
});

app.post('/api/video/stop', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/video/stop`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop video', details: err.message });
  }
});

app.post('/api/video/record/start', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/video/record/start`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to start recording', details: err.response?.data || err.message });
  }
});

app.post('/api/video/record/stop', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/video/record/stop`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop recording', details: err.message });
  }
});

app.post('/api/video/snapshot', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/video/snapshot`, {}, { responseType: 'arraybuffer' });
    res.set('Content-Type', 'image/png');
    res.send(Buffer.from(response.data));
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to take snapshot', details: err.message });
  }
});

app.get('/api/cameras', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/cameras`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch cameras', details: err.message });
  }
});

app.post('/api/cameras/:sysid/:compid/:streamId/select', async (req, res) => {
  try {
    const { sysid, compid, streamId } = req.params;
    const response = await axios.post(`${PYTHON_API_URL}/cameras/${sysid}/${compid}/${streamId}/select`);
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to select camera stream', details: err.response?.data || err.message });
  }
});

app.get('/api/parameters/metadata', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/parameters/metadata`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch parameter metadata', details: err.message });
  }
});

app.post('/api/flyto', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/flyto`, req.body);
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to execute flyto', details: err.response?.data || err.message });
  }
});

app.post('/api/vehicle/set_home', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/vehicle/set_home`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Set home failed', details: err.response?.data || err.message });
  }
});

app.post('/api/vehicle/roi', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/vehicle/roi`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Set ROI failed', details: err.response?.data || err.message });
  }
});

app.post('/api/vehicle/roi/clear', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/vehicle/roi/clear`);
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Clear ROI failed', details: err.response?.data || err.message });
  }
});

app.post('/api/mavlink/command', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/command`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'MAVLink command failed', details: err.response?.data || err.message });
  }
});

app.post('/api/simulation/start', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/simulation/start`, req.body || {});
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to start simulation', details: err.message });
  }
});

app.post('/api/simulation/stop', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/simulation/stop`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop simulation', details: err.message });
  }
});

app.post('/api/simulation/reset', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/simulation/reset`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset simulation', details: err.message });
  }
});

app.get('/api/simulation/status', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/simulation/status`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch simulation status', details: err.message });
  }
});

app.get('/api/simulation/logs', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/simulation/logs`, { params: { limit: req.query.limit || 200 } });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch simulation logs', details: err.message });
  }
});

app.get('/api/simulation/sim_vehicle', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/simulation/sim_vehicle`, {
      params: { sitl_cmd: req.query.sitl_cmd || '' },
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to probe sim_vehicle.py', details: err.message });
  }
});

app.get('/api/simulation/capabilities', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/simulation/capabilities`, {
      params: { sitl_cmd: req.query.sitl_cmd || '' },
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch simulation capabilities', details: err.message });
  }
});

app.get('/api/simulation/profiles', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/simulation/profiles`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch simulation profiles', details: err.message });
  }
});

app.post('/api/simulation/profiles', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/simulation/profiles`, req.body);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save simulation profile', details: err.message });
  }
});

app.delete('/api/simulation/profiles/:name', async (req, res) => {
  try {
    const response = await axios.delete(`${PYTHON_API_URL}/simulation/profiles/${encodeURIComponent(req.params.name)}`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete simulation profile', details: err.message });
  }
});

app.get('/api/osd/profiles', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/osd/profiles`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch OSD profiles', details: err.message });
  }
});

app.post('/api/osd/profiles', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/osd/profiles`, req.body);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save OSD profile', details: err.message });
  }
});

app.delete('/api/osd/profiles/:profileId', async (req, res) => {
  try {
    const response = await axios.delete(`${PYTHON_API_URL}/osd/profiles/${encodeURIComponent(req.params.profileId)}`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete OSD profile', details: err.message });
  }
});

// ─── Setup Tab Routes ─────────────────────────────────────────────────────────

// Calibration status (STATUSTEXT + compass progress + accel requested pos)
app.get('/api/calibration/status', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/calibration/status`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get calibration status', details: err.message });
  }
});

// Accel cal step confirmation (sends MAV_CMD_ACCELCAL_VEHICLE_POS 42429 back to FC)
app.post('/api/calibration/accel_confirm', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/calibration/accel_confirm`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Accel confirm failed', details: err.response?.data || err.message });
  }
});

// Compass cancel (sends DO_CANCEL_MAG_CAL 42426 to FC)
app.post('/api/calibration/compass_cancel', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/calibration/compass_cancel`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Compass cancel failed', details: err.response?.data || err.message });
  }
});

// Motor test
app.post('/api/motor_test', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/motor_test`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Motor test failed', details: err.response?.data || err.message });
  }
});

// Flight modes
app.get('/api/setup/flight_modes', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/setup/flight_modes`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get flight modes', details: err.message });
  }
});

app.post('/api/setup/flight_modes', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/setup/flight_modes`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to set flight modes', details: err.response?.data || err.message });
  }
});

// Failsafe
app.get('/api/setup/failsafe', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/setup/failsafe`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get failsafe config', details: err.message });
  }
});

app.post('/api/setup/failsafe', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/setup/failsafe`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to set failsafe config', details: err.response?.data || err.message });
  }
});

// Battery monitor
app.get('/api/setup/battery', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/setup/battery`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get battery config', details: err.message });
  }
});

app.post('/api/setup/battery', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/setup/battery`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to set battery config', details: err.response?.data || err.message });
  }
});

// Radio calibration
app.get('/api/setup/radio', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_API_URL}/setup/radio`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get radio config', details: err.message });
  }
});

app.post('/api/setup/radio', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/setup/radio`, req.body || {});
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to set radio config', details: err.response?.data || err.message });
  }
});

// ─── Error handling backstops (Phase 5A) ─────────────────────────────────────
// 404 for anything unmatched, then a final error middleware so a thrown/rejected
// handler returns clean JSON (with the correlation id) instead of an HTML stack
// or a hung socket.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity (4 args)
app.use((err, req, res, next) => {
  const requestId = res.getHeader('x-request-id');
  log.error('unhandled_route_error', { error: String(err && err.message || err), stack: err && err.stack, request_id: requestId });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error', request_id: requestId });
});

// ─── Graceful shutdown + panic recovery (Phase 5A) ───────────────────────────
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  health.markShuttingDown(); // /readyz → 503 so the LB drains us first
  log.info('shutdown_initiated', { signal });

  const forceTimer = setTimeout(() => {
    log.error('shutdown_timeout_forcing_exit', { timeout_ms: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceTimer.unref();

  try {
    await zmqSubscriber.stop();
    for (const client of wss.clients) {
      try { client.close(1001, 'server shutting down'); } catch { /* ignore */ }
    }
    await new Promise((resolve) => wss.close(() => resolve()));
    await new Promise((resolve) => server.close(() => resolve()));
    log.info('shutdown_complete');
    clearTimeout(forceTimer);
    process.exit(0);
  } catch (err) {
    log.error('shutdown_error', { error: String(err && err.message || err) });
    clearTimeout(forceTimer);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Panic recovery: log the crash with full context, then drain and exit so a
// supervisor (systemd/K8s/compose) restarts us cleanly. Never swallow silently.
process.on('uncaughtException', (err) => {
  log.error('uncaught_exception', { error: String(err && err.message || err), stack: err && err.stack });
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { reason: String(reason && reason.message || reason), stack: reason && reason.stack });
});
