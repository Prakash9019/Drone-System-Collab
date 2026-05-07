const express = require('express');
const { WebSocketServer } = require('ws');
const zmq = require('zeromq');
const axios = require('axios');
const cors = require('cors');

const HTTP_PORT = 8080;
const PYTHON_API_URL = 'http://127.0.0.1:8000';
const ZMQ_PUB_URL = 'tcp://127.0.0.1:5556';

const app = express();
app.use(cors());
app.use(express.json());

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
    const response = await axios.post(`${PYTHON_API_URL}/connection/start`);
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
    const response = await axios.get(`${PYTHON_API_URL}/mission`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch mission', details: err.message });
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

// Command route mapping common text commands to MAVLink COMMAND_LONG ids
const COMMAND_MAP = {
  'arm': { command: 400, p1: 1 }, // MAV_CMD_COMPONENT_ARM_DISARM
  'disarm': { command: 400, p1: 0 },
  'rtl': { command: 20 }, // MAV_CMD_NAV_RETURN_TO_LAUNCH
  'takeoff': { command: 22, p7: 10 } // MAV_CMD_NAV_TAKEOFF (default 10m alt)
};

app.post('/api/command/:cmd', async (req, res) => {
  const cmdStr = req.params.cmd.toLowerCase();
  
  if (COMMAND_MAP[cmdStr]) {
    try {
      const payload = {
        command: COMMAND_MAP[cmdStr].command,
        p1: COMMAND_MAP[cmdStr].p1 || 0,
        p2: COMMAND_MAP[cmdStr].p2 || 0,
        p3: COMMAND_MAP[cmdStr].p3 || 0,
        p4: COMMAND_MAP[cmdStr].p4 || 0,
        p5: COMMAND_MAP[cmdStr].p5 || 0,
        p6: COMMAND_MAP[cmdStr].p6 || 0,
        p7: COMMAND_MAP[cmdStr].p7 || 0,
      };
      const response = await axios.post(`${PYTHON_API_URL}/command`, payload);
      res.json(response.data);
    } catch (err) {
      res.status(500).json({ error: 'Command failed in python backend', details: err.message });
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

app.post('/api/parameters/set', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/parameters/set`, req.body);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to set parameter', details: err.message });
  }
});

app.post('/api/flyto', async (req, res) => {
  try {
    const response = await axios.post(`${PYTHON_API_URL}/flyto`, req.body);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to execute flyto', details: err.message });
  }
});
