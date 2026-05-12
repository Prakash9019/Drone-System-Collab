const express = require('express');
const { WebSocketServer } = require('ws');
const zmq = require('zeromq');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');

const HTTP_PORT = 8080;
const PYTHON_API_URL = 'http://127.0.0.1:8000';
const ZMQ_PUB_URL = 'tcp://127.0.0.1:5556';

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 52 * 1024 * 1024 } });

// Set up WebSocket server attached to Express HTTP server
const server = app.listen(HTTP_PORT, () => {
  console.log(`Node.js API Gateway running on port ${HTTP_PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected to WebSocket telemetry stream');
  ws.on('close', () => console.log('Client disconnected'));
});

// Broadcast helper
function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(data);
    }
  });
}

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

// ZeroMQ Subscriber logic
async function runZmqSubscriber() {
  const sock = new zmq.Subscriber();

  sock.connect(ZMQ_PUB_URL);
  sock.subscribe(''); // Subscribe to all topics

  console.log(`ZeroMQ Subscriber connected to ${ZMQ_PUB_URL}`);

  try {
    for await (const [msg] of sock) {
      // The Python backend sends JSON strings
      const payload = msg.toString();
      // Broadcast directly to WS clients
      broadcast(payload);
    }
  } catch (err) {
    console.error("ZeroMQ Error:", err);
  }
}

// Start ZMQ
runZmqSubscriber();

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
