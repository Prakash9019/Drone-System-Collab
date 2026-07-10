/**
 * Prometheus-compatible metrics for the Node API gateway (Phase 5A).
 *
 * A single Registry holds the golden-signal metrics for the gateway plus the
 * telemetry/ZMQ/WS internals the fleet ops team needs to see the F5 ceiling
 * approaching. Exposed at GET /metrics in text exposition format.
 */
'use strict';

const client = require('prom-client');

function createMetrics({ serviceName = 'drone-gcs-node-api', collectDefault = true } = {}) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: serviceName });
  if (collectDefault) {
    client.collectDefaultMetrics({ register: registry });
  }

  const httpRequests = new client.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests handled by the gateway',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const wsClients = new client.Gauge({
    name: 'ws_clients',
    help: 'Currently connected telemetry WebSocket clients',
    registers: [registry],
  });

  const wsMessagesSent = new client.Counter({
    name: 'ws_messages_sent_total',
    help: 'Telemetry frames sent to WebSocket clients',
    registers: [registry],
  });

  const wsSendDropped = new client.Counter({
    name: 'ws_send_dropped_total',
    help: 'Telemetry frames dropped due to a slow-client send-queue overflow',
    labelNames: ['reason'],
    registers: [registry],
  });

  const wsClientsDisconnected = new client.Counter({
    name: 'ws_clients_disconnected_total',
    help: 'WebSocket clients force-closed by the server',
    labelNames: ['reason'],
    registers: [registry],
  });

  const zmqFramesReceived = new client.Counter({
    name: 'zmq_frames_received_total',
    help: 'Frames received from the Python telemetry publisher over ZMQ',
    registers: [registry],
  });

  const zmqReconnects = new client.Counter({
    name: 'zmq_reconnects_total',
    help: 'ZMQ subscriber reconnect attempts after an error or stream end',
    registers: [registry],
  });

  const zmqConnected = new client.Gauge({
    name: 'zmq_connected',
    help: '1 when the ZMQ subscriber is connected and looping, else 0',
    registers: [registry],
  });

  const zmqLastFrameAge = new client.Gauge({
    name: 'zmq_last_frame_age_seconds',
    help: 'Seconds since the last ZMQ telemetry frame was received',
    registers: [registry],
  });

  const telemetryFramesProcessed = new client.Counter({
    name: 'telemetry_frames_processed_total',
    help: 'Telemetry frames processed by the enrichment engine',
    labelNames: ['drone_id'],
    registers: [registry],
  });

  const droneLastSeenAge = new client.Gauge({
    name: 'drone_last_seen_age_seconds',
    help: 'Seconds since a frame was last processed for a given drone_id',
    labelNames: ['drone_id'],
    registers: [registry],
  });

  return {
    client,
    registry,
    httpRequests,
    httpDuration,
    wsClients,
    wsMessagesSent,
    wsSendDropped,
    wsClientsDisconnected,
    zmqFramesReceived,
    zmqReconnects,
    zmqConnected,
    zmqLastFrameAge,
    telemetryFramesProcessed,
    droneLastSeenAge,
    async expose() {
      return registry.metrics();
    },
    contentType: registry.contentType,
  };
}

module.exports = { createMetrics };
