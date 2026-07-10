/**
 * Per-client drone subscriptions for the telemetry WebSocket.
 *
 * Back-compat: a client that never sends a subscribe op receives EVERYTHING
 * (the pre-fleet broadcast behavior). Once it sends {op:"subscribe"} it only
 * receives the drones it asked for, until {op:"subscribe_all"}.
 *
 * Inbound ops (JSON):
 *   {op:"subscribe",     drones:["default","drone-b"]}   — replace subscription set
 *   {op:"unsubscribe",   drones:["drone-b"]}             — remove from set
 *   {op:"subscribe_all"}                                  — back to firehose
 */
class SubscriptionManager {
  constructor() {
    /** @type {Map<import('ws').WebSocket, Set<string>|null>} null = all drones */
    this._subs = new Map();
  }

  addClient(ws) {
    this._subs.set(ws, null);
    ws.on('close', () => this._subs.delete(ws));
    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return; // pre-fleet clients never send anything valid — ignore
      }
      if (!msg || typeof msg !== 'object') return;
      this._applyOp(ws, msg);
    });
  }

  _applyOp(ws, msg) {
    const op = String(msg.op || '');
    if (op === 'subscribe_all') {
      this._subs.set(ws, null);
      this._ack(ws);
      return;
    }
    const drones = Array.isArray(msg.drones) ? msg.drones.map(String) : [];
    if (op === 'subscribe') {
      this._subs.set(ws, new Set(drones));
      this._ack(ws);
    } else if (op === 'unsubscribe') {
      const cur = this._subs.get(ws);
      if (cur instanceof Set) {
        drones.forEach((d) => cur.delete(d));
        this._ack(ws);
      }
    }
  }

  _ack(ws) {
    const cur = this._subs.get(ws);
    try {
      ws.send(JSON.stringify({
        type: 'SUBSCRIPTION_ACK',
        drones: cur === null ? 'all' : [...cur],
      }));
    } catch {
      /* client gone */
    }
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {string|null|undefined} droneId  null/undefined = untagged message (send to all)
   */
  wants(ws, droneId) {
    const cur = this._subs.get(ws);
    if (cur === undefined) return true; // client not tracked (defensive) — behave like firehose
    if (cur === null) return true;      // subscribed to all
    if (droneId == null) return true;   // untagged frames go to everyone
    return cur.has(String(droneId));
  }
}

module.exports = { SubscriptionManager };
