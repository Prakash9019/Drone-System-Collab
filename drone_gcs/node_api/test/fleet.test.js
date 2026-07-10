/**
 * Phase 4 tests — drone-aware telemetry engine, per-drone disconnect hygiene,
 * WS subscription filtering. Run with: npm test  (node --test)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TelemetryCoreEngine } = require('../telemetry');
const { VehicleStateManager, DEFAULT_DRONE_ID } = require('../telemetry/vehicleStateManager');
const { SubscriptionManager } = require('../ws/subscriptionManager');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEngine() {
  const sent = [];
  const engine = new TelemetryCoreEngine({
    broadcast: (data, droneId) => sent.push({ data: JSON.parse(data), droneId }),
  });
  return { engine, sent };
}

function telemetryFrame({ droneId, sysid = 1, lat = 17.45 }) {
  return JSON.stringify({
    type: 'TELEMETRY_UPDATE',
    vehicle_id: sysid,
    ...(droneId ? { drone_id: droneId } : {}),
    data: { sysid, compid: 1, position: { lat, lng: 78.37 } },
  });
}

function connectionFrame({ droneId, state = 'CONNECTED', primary = 1 }) {
  return JSON.stringify({
    type: 'CONNECTION_STATUS',
    ...(droneId ? { drone_id: droneId } : {}),
    data: { connection_state: state, primary_sysid: primary, running: true, vehicles: [] },
  });
}

class FakeWs {
  constructor() {
    this.sent = [];
    this._handlers = {};
  }
  on(event, fn) {
    this._handlers[event] = fn;
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  emit(event, arg) {
    this._handlers[event]?.(arg);
  }
}

// ── VehicleStateManager ──────────────────────────────────────────────────────

test('default drone keeps bare vehicle keys (legacy wire shape)', () => {
  const vm = new VehicleStateManager();
  assert.equal(vm.vehicleKey(DEFAULT_DRONE_ID, '1'), '1');
  assert.equal(vm.vehicleKey(undefined, '1'), '1');
  assert.equal(vm.vehicleKey('drone-b', '1'), 'drone-b:1');
});

test('disconnect wipes only that drone\'s vehicles', () => {
  const vm = new VehicleStateManager();
  vm.recordTelemetrySnapshot(vm.vehicleKey('default', '1'), { sysid: 1 }, 1000);
  vm.recordTelemetrySnapshot(vm.vehicleKey('drone-b', '2'), { sysid: 2 }, 1000);

  vm.applyConnectionStatus({ connection_state: 'DISCONNECTED' }, 'drone-b');
  assert.deepEqual(vm.listVehicleIds('default'), ['1']);
  assert.deepEqual(vm.listVehicleIds('drone-b'), []);

  vm.applyConnectionStatus({ connection_state: 'HEARTBEAT_LOST' }, 'default');
  assert.deepEqual(vm.listVehicleIds('default'), []);
});

test('legacy getters reflect the default drone only', () => {
  const vm = new VehicleStateManager();
  vm.applyConnectionStatus({ connection_state: 'CONNECTED', primary_sysid: 1 }, 'default');
  vm.applyConnectionStatus({ connection_state: 'DISCONNECTED', primary_sysid: 7 }, 'drone-b');
  assert.equal(vm.lastConnectionState, 'CONNECTED');
  assert.equal(vm.primarySysId, '1');
  assert.equal(vm.connectionStateFor('drone-b'), 'DISCONNECTED');
});

// ── TelemetryCoreEngine ──────────────────────────────────────────────────────

test('engine tags envelope with drone_id and passes it to broadcast', () => {
  const { engine, sent } = makeEngine();
  engine.processZmqFrameString(telemetryFrame({ droneId: 'drone-b' }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].droneId, 'drone-b');
  assert.equal(sent[0].data.engine_envelope.drone_id, 'drone-b');
  assert.equal(sent[0].data.data.telemetry_engine.fleet.drone_id, 'drone-b');
});

test('untagged (pre-fleet) frames map to the default drone', () => {
  const { engine, sent } = makeEngine();
  engine.processZmqFrameString(telemetryFrame({}));
  assert.equal(sent[0].droneId, 'default');
  assert.equal(sent[0].data.vehicle_id, '1'); // bare vehicle_id preserved
  assert.deepEqual(sent[0].data.data.telemetry_engine.fleet.known_vehicle_ids, ['1']);
});

test('per-drone vehicle isolation: one drone\'s disconnect leaves the other intact', () => {
  const { engine } = makeEngine();
  engine.processZmqFrameString(telemetryFrame({ droneId: 'default', sysid: 1 }));
  engine.processZmqFrameString(telemetryFrame({ droneId: 'drone-b', sysid: 1 }));
  assert.deepEqual(engine.vehicles.listVehicleIds('default'), ['1']);
  assert.deepEqual(engine.vehicles.listVehicleIds('drone-b'), ['drone-b:1']);

  engine.processZmqFrameString(connectionFrame({ droneId: 'drone-b', state: 'DISCONNECTED' }));
  assert.deepEqual(engine.vehicles.listVehicleIds('default'), ['1']);
  assert.deepEqual(engine.vehicles.listVehicleIds('drone-b'), []);
});

test('same sysid on two drones does not collide', () => {
  const { engine, sent } = makeEngine();
  engine.processZmqFrameString(telemetryFrame({ droneId: 'default', sysid: 1, lat: 10 }));
  engine.processZmqFrameString(telemetryFrame({ droneId: 'drone-b', sysid: 1, lat: 20 }));
  assert.equal(engine.vehicles.getVehicleSnapshot('1').position.lat, 10);
  assert.equal(engine.vehicles.getVehicleSnapshot('drone-b:1').position.lat, 20);
  // wire vehicle_id stays the sysid on both — drone identity travels separately
  assert.equal(sent[0].data.vehicle_id, '1');
  assert.equal(sent[1].data.vehicle_id, '1');
  assert.equal(sent[1].data.data.telemetry_engine.fleet.drone_id, 'drone-b');
});

test('debug snapshot exposes per-drone breakdown', () => {
  const { engine } = makeEngine();
  engine.processZmqFrameString(connectionFrame({ droneId: 'default' }));
  engine.processZmqFrameString(connectionFrame({ droneId: 'drone-b' }));
  const snap = engine.getDebugSnapshot();
  assert.equal(snap.drones.length, 2);
  assert.deepEqual(snap.drones.map((d) => d.drone_id).sort(), ['default', 'drone-b']);
});

// ── SubscriptionManager ──────────────────────────────────────────────────────

test('clients receive everything until they subscribe (back-compat)', () => {
  const subs = new SubscriptionManager();
  const ws = new FakeWs();
  subs.addClient(ws);
  assert.equal(subs.wants(ws, 'default'), true);
  assert.equal(subs.wants(ws, 'drone-b'), true);
  assert.equal(subs.wants(ws, null), true);
});

test('subscribe filters to the requested drones; untagged frames still pass', () => {
  const subs = new SubscriptionManager();
  const ws = new FakeWs();
  subs.addClient(ws);
  ws.emit('message', Buffer.from(JSON.stringify({ op: 'subscribe', drones: ['drone-b'] })));
  assert.equal(subs.wants(ws, 'drone-b'), true);
  assert.equal(subs.wants(ws, 'default'), false);
  assert.equal(subs.wants(ws, null), true);
  assert.equal(ws.sent[0].type, 'SUBSCRIPTION_ACK');
  assert.deepEqual(ws.sent[0].drones, ['drone-b']);
});

test('unsubscribe and subscribe_all round-trip', () => {
  const subs = new SubscriptionManager();
  const ws = new FakeWs();
  subs.addClient(ws);
  ws.emit('message', Buffer.from(JSON.stringify({ op: 'subscribe', drones: ['a', 'b'] })));
  ws.emit('message', Buffer.from(JSON.stringify({ op: 'unsubscribe', drones: ['a'] })));
  assert.equal(subs.wants(ws, 'a'), false);
  assert.equal(subs.wants(ws, 'b'), true);
  ws.emit('message', Buffer.from(JSON.stringify({ op: 'subscribe_all' })));
  assert.equal(subs.wants(ws, 'a'), true);
});

test('garbage inbound messages are ignored (legacy clients)', () => {
  const subs = new SubscriptionManager();
  const ws = new FakeWs();
  subs.addClient(ws);
  ws.emit('message', Buffer.from('not json'));
  ws.emit('message', Buffer.from('42'));
  assert.equal(subs.wants(ws, 'anything'), true);
});
