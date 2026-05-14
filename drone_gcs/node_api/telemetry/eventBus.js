const { EventEmitter } = require('events');

/**
 * Internal event bus for telemetry core (ingest → process → outbound).
 * WS clients still receive JSON strings; this bus is for in-process subscribers only.
 */
class TelemetryEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * Raw ZMQ frame received (string).
   * @param {string} frame
   */
  emitZmqFrame(frame) {
    this.emit('zmq:frame', frame);
  }

  /**
   * Parsed JSON object from ZMQ (before enrichment).
   * @param {Record<string, unknown>} msg
   */
  emitZmqParsed(msg) {
    this.emit('zmq:parsed', msg);
  }

  /**
   * Final outbound string sent to WebSocket broadcast.
   * @param {string} frame
   */
  emitOutbound(frame) {
    this.emit('telemetry:outbound', frame);
  }

  /**
   * Connection state transition (normalized string).
   * @param {{ from: string|null, to: string }} ev
   */
  emitConnectionTransition(ev) {
    this.emit('connection:transition', ev);
  }
}

module.exports = { TelemetryEventBus };
