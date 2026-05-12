/**
 * Mission Planner–style operational phase from MAVLink-derived telemetry + link state.
 * Not a full autopilot state machine — best-effort from mode name + armed + climb.
 */

const LAND_MODES = new Set(['LAND', 'QLAND', 'AUTO_LAND']);
const RTL_MODES = new Set(['RTL', 'QRTL', 'SMART_RTL']);
const GUIDED_LIKE = new Set(['GUIDED', 'GUIDED_NOGPS', 'LOITER', 'BRAKE', 'POSHOLD', 'ALTHOLD', 'CIRCLE', 'DRIFT']);

/**
 * @param {object} opts
 * @param {string} opts.connectionState
 * @param {object | undefined} opts.vehicle
 */
export function deriveOperationalPhase({ connectionState, vehicle }) {
  const cs = connectionState || 'DISCONNECTED';
  if (cs === 'DISCONNECTED') return { phase: 'DISCONNECTED', label: 'Disconnected', tone: 'muted' };
  if (cs === 'CONNECTING' || cs === 'RECONNECTING') return { phase: 'CONNECTING', label: 'Connecting…', tone: 'warn' };
  if (cs === 'WAITING_FOR_HEARTBEAT') return { phase: 'CONNECTING', label: 'Waiting for vehicle…', tone: 'warn' };
  if (cs === 'HEARTBEAT_LOST') return { phase: 'HEARTBEAT_LOST', label: 'Link lost', tone: 'danger' };
  if (cs !== 'CONNECTED' && cs !== 'ACTIVE') {
    return { phase: 'CONNECTING', label: cs || 'Unknown', tone: 'warn' };
  }

  const armed = !!vehicle?.status?.armed;
  const mode = String(vehicle?.status?.mode || 'UNKNOWN').toUpperCase();
  const climb = Number(vehicle?.velocity?.climb ?? 0);

  if (!armed) {
    return { phase: 'DISARMED', label: 'Disarmed', tone: 'ok' };
  }

  if (RTL_MODES.has(mode) || mode.includes('RTL')) {
    return { phase: 'RTL', label: `RTL · ${mode}`, tone: 'warn' };
  }
  if (LAND_MODES.has(mode) || mode.includes('LAND')) {
    return { phase: 'LANDING', label: `Landing · ${mode}`, tone: 'warn' };
  }
  if (mode.includes('TAKEOFF') || (climb > 0.8 && !GUIDED_LIKE.has(mode) && !mode.includes('AUTO'))) {
    return { phase: 'TAKEOFF', label: `Takeoff / climb · ${mode}`, tone: 'ok' };
  }
  if (GUIDED_LIKE.has(mode) || mode.includes('GUIDED')) {
    return { phase: 'FLYING', label: `Flying · ${mode}`, tone: 'ok' };
  }
  if (mode.includes('AUTO')) {
    return { phase: 'FLYING', label: `Mission · ${mode}`, tone: 'ok' };
  }

  return { phase: 'ARMED', label: `Armed · ${mode}`, tone: 'ok' };
}
