/**
 * WS broadcast with per-client send-queue cap (Phase 5A).
 *
 * Original broadcast did an unconditional `ws.send` per client — a slow client's
 * kernel/ws buffer grows unbounded and eventually OOMs the single Node process
 * (Failure Mode table: "Slow WS client → Node buffers grow unboundedly").
 *
 * Policy, using `ws.bufferedAmount` as the backpressure signal:
 *   - soft cap  → shed load: skip this frame for that client (count ws_send_dropped).
 *     Telemetry is a stream of full snapshots, so dropping the newest frame for a
 *     lagging client is safe — the next frame supersedes it (drop-oldest-equivalent).
 *   - hard cap  → the client is hopelessly behind: terminate it with a notice so
 *     it reconnects fresh instead of dragging the whole gateway down.
 */
'use strict';

const OPEN = 1;

/**
 * @param {{ metrics?: object, softCapBytes: number, logger?: object }} opts
 */
function createBroadcaster(opts) {
  const softCap = opts.softCapBytes;
  const hardCap = softCap * 4; // terminate well past the shed threshold
  const metrics = opts.metrics || null;
  const logger = opts.logger || null;
  const subscriptions = opts.subscriptions;

  /**
   * @param {Iterable<object>} clients  wss.clients
   * @param {string} data  serialized frame
   * @param {string|null} droneId
   */
  return function broadcast(clients, data, droneId) {
    for (const client of clients) {
      if (client.readyState !== OPEN) continue;
      if (subscriptions && !subscriptions.wants(client, droneId)) continue;

      const buffered = client.bufferedAmount || 0;

      if (buffered > hardCap) {
        try {
          client.send(
            JSON.stringify({ type: 'SLOW_CONSUMER', reason: 'send_queue_overflow', buffered_bytes: buffered })
          );
        } catch { /* ignore */ }
        try { client.terminate(); } catch { /* ignore */ }
        if (metrics) {
          metrics.wsSendDropped.inc({ reason: 'hard_cap' });
          metrics.wsClientsDisconnected.inc({ reason: 'slow_consumer' });
        }
        if (logger) logger.warn('terminated slow WS client', { buffered_bytes: buffered });
        continue;
      }

      if (buffered > softCap) {
        if (metrics) metrics.wsSendDropped.inc({ reason: 'soft_cap' });
        continue; // shed this frame; next snapshot supersedes it
      }

      try {
        client.send(data);
        if (metrics) metrics.wsMessagesSent.inc();
      } catch (err) {
        if (logger) logger.debug('ws send failed', { error: String(err && err.message || err) });
      }
    }
  };
}

module.exports = { createBroadcaster };
