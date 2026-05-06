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

// Command stub route (to be expanded in later phases)
app.post('/api/command/:cmd', async (req, res) => {
  // In the future, proxy commands to python
  res.json({ status: 'Command received but not implemented yet in Python', cmd: req.params.cmd });
});
