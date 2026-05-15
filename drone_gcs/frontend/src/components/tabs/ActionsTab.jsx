import React, { useState } from 'react';
import axios from 'axios';

const API = 'http://localhost:8080/api';

// ─── Action Definitions ───────────────────────────────────────────────────────

const FLIGHT_CONTROLS = [
  { label: 'ARM',    kind: 'shortcut', name: 'arm',    color: '#10b981', desc: 'Arm motors (MAV_CMD_COMPONENT_ARM_DISARM)' },
  { label: 'DISARM', kind: 'shortcut', name: 'disarm', color: '#ef4444', desc: 'Disarm motors' },
  { label: 'TAKEOFF', kind: 'shortcut', name: 'takeoff', color: '#3b82f6', desc: 'Auto-takeoff', needsAlt: true },
  { label: 'LAND',  kind: 'shortcut', name: 'land',  color: '#f59e0b', desc: 'Land in place (MAV_CMD_NAV_LAND)' },
  { label: 'RTL',   kind: 'shortcut', name: 'rtl',   color: '#f97316', desc: 'Return to launch (MAV_CMD_NAV_RETURN_TO_LAUNCH)' },
];

const FLIGHT_MODES = [
  'STABILIZE', 'ALT_HOLD', 'LOITER', 'AUTO', 'GUIDED',
  'LAND', 'RTL', 'CIRCLE', 'DRIFT', 'SPORT', 'FLIP',
  'AUTOTUNE', 'POSHOLD', 'BRAKE', 'THROW', 'SMARTRTL',
  'FLOWHOLD', 'FOLLOW', 'ZIGZAG', 'SYSTEMID', 'AUTOROTATE',
];

const CALIBRATIONS = [
  { label: 'Accel Calibrate',   kind: 'calibration', calib: 'accelerometer', color: '#8b5cf6', desc: 'Calibrate accelerometer (MAV_CMD_PREFLIGHT_CALIBRATION p5=1)' },
  { label: 'Compass Calibrate', kind: 'calibration', calib: 'compass',       color: '#8b5cf6', desc: 'Calibrate compass (p6=1)' },
  { label: 'Level Horizon',     kind: 'calibration', calib: 'level',         color: '#8b5cf6', desc: 'Level horizon (p7=1)' },
  { label: 'ESC Calibrate',     kind: 'calibration', calib: 'esc',           color: '#a21caf', desc: 'Calibrate ESCs (p1=3)' },
  { label: 'Gyro Calibrate',    kind: 'mavlink', command: 241, p1: 1, color: '#8b5cf6', desc: 'Calibrate gyro (p1=1)' },
];

const ADVANCED = [
  { label: 'Reboot FC',     kind: 'mavlink', command: 246, p1: 1,    color: '#dc2626', desc: 'Reboot flight controller (MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN)' },
  { label: 'Reboot AP',     kind: 'mavlink', command: 246, p2: 1,    color: '#dc2626', desc: 'Reboot autopilot board' },
  { label: 'Trigger Camera',kind: 'mavlink', command: 203, p5: 1,    color: '#0ea5e9', desc: 'Trigger camera shutter (MAV_CMD_DO_DIGICAM_CONTROL)' },
  { label: 'Do Parachute',  kind: 'mavlink', command: 208, p1: 2,    color: '#dc2626', desc: 'Release parachute (MAV_CMD_DO_PARACHUTE, p1=2=release)' },
  { label: 'Engine Start',  kind: 'mavlink', command: 223, p1: 1,    color: '#10b981', desc: 'Engine start (MAV_CMD_DO_ENGINE_CONTROL)' },
  { label: 'Engine Stop',   kind: 'mavlink', command: 223, p1: 0,    color: '#ef4444', desc: 'Engine stop' },
  { label: 'Battery Reset', kind: 'mavlink', command: 2001, p1: 0xff, color: '#f59e0b', desc: 'Reset battery monitor (MAV_CMD_BATTERY_RESET)' },
  { label: 'Toggle Safety', kind: 'mavlink', command: 2004, p1: 1,   color: '#6b7280', desc: 'Toggle safety switch (MAV_CMD_DO_SET_SAFETY_SWITCH_STATE)' },
  { label: 'Relay 1 ON',    kind: 'mavlink', command: 181, p1: 0, p2: 1, color: '#22c55e', desc: 'Set Relay 1 ON (MAV_CMD_DO_SET_RELAY)' },
  { label: 'Relay 1 OFF',   kind: 'mavlink', command: 181, p1: 0, p2: 0, color: '#6b7280', desc: 'Set Relay 1 OFF' },
];

// ─── Component ────────────────────────────────────────────────────────────────

const ActionsTab = ({ vehicleState }) => {
  const [status, setStatus] = useState('');
  const [statusOk, setStatusOk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [takeoffAlt, setTakeoffAlt] = useState(10);
  const [modeFilter, setModeFilter] = useState('');
  const [activeSection, setActiveSection] = useState('flight');

  const showStatus = (msg, ok = true) => {
    setStatus(msg);
    setStatusOk(ok);
    // Auto-clear after 6 seconds
    setTimeout(() => setStatus(''), 6000);
  };

  const handleAction = async (action) => {
    if (busy) return;
    setBusy(true);
    showStatus(`Sending ${action.label}…`, true);

    try {
      if (action.kind === 'shortcut') {
        const body = action.needsAlt ? { altitude_m: Number(takeoffAlt) } : {};
        const res = await axios.post(`${API}/shortcuts/${action.name}`, body);
        const d = res.data;
        if (d.accepted === false) {
          showStatus(`✗ ${action.label}: ${d.mav_result_text || 'REJECTED'}`, false);
        } else {
          showStatus(`✓ ${action.label}: ${d.mav_result_text || 'OK'}`, true);
        }
      } else if (action.kind === 'mode') {
        const res = await axios.post(`${API}/mode`, { mode: action.mode });
        showStatus(`✓ Mode → ${action.mode}`, true);
      } else if (action.kind === 'calibration') {
        const res = await axios.post(`${API}/calibration/run`, { kind: action.calib });
        const d = res.data;
        if (d.accepted === false) {
          showStatus(`✗ ${action.label}: ${d.mav_result_text || 'FAILED'}`, false);
        } else {
          showStatus(`✓ ${action.label} started`, true);
        }
      } else if (action.kind === 'mavlink') {
        const res = await axios.post(`${API}/mavlink/command`, {
          command: action.command,
          p1: action.p1 || 0, p2: action.p2 || 0,
          p3: action.p3 || 0, p4: action.p4 || 0,
          p5: action.p5 || 0, p6: action.p6 || 0,
          p7: action.p7 || 0,
        });
        const d = res.data;
        if (d.accepted === false) {
          showStatus(`✗ ${action.label}: ${d.mav_result_text || 'REJECTED'} — ${d.reason || ''}`, false);
        } else {
          showStatus(`✓ ${action.label}: ${d.mav_result_text || 'SENT'}`, true);
        }
      }
    } catch (err) {
      const d = err?.response?.data;
      const reason =
        (typeof d?.detail === 'string' && d.detail) ||
        d?.error ||
        d?.details?.error ||
        err.message ||
        'Network error';
      showStatus(`✗ ${action.label} failed: ${reason}`, false);
    }

    setBusy(false);
  };

  const handleModeSet = async (modeName) => {
    if (!modeName || busy) return;
    setBusy(true);
    showStatus(`Setting mode → ${modeName}…`, true);
    try {
      await axios.post(`${API}/mode`, { mode: modeName });
      showStatus(`✓ Mode → ${modeName}`, true);
    } catch (err) {
      const d = err?.response?.data;
      showStatus(`✗ Mode failed: ${d?.detail || err.message}`, false);
    }
    setBusy(false);
  };

  const filteredModes = FLIGHT_MODES.filter(m =>
    m.toLowerCase().includes(modeFilter.toLowerCase())
  );

  const sectionBtn = (id, label) => (
    <button
      className={`actions-section-btn ${activeSection === id ? 'active' : ''}`}
      onClick={() => setActiveSection(id)}
    >
      {label}
    </button>
  );

  return (
    <div className="actions-tab-v2">
      {/* Section selector */}
      <div className="actions-section-bar">
        {sectionBtn('flight', 'Flight')}
        {sectionBtn('modes', 'Modes')}
        {sectionBtn('calib', 'Calibration')}
        {sectionBtn('adv', 'Advanced')}
      </div>

      {/* Status banner */}
      {status && (
        <div
          className="actions-status-banner"
          style={{ color: statusOk ? '#22c55e' : '#ef4444' }}
        >
          {status}
        </div>
      )}

      {/* ── Flight Controls ───────────────────────────────────────────────── */}
      {activeSection === 'flight' && (
        <div className="actions-section">
          {/* Takeoff altitude */}
          <div className="actions-alt-row">
            <label>Takeoff Alt (m):</label>
            <input
              type="number"
              min={2}
              max={200}
              value={takeoffAlt}
              onChange={e => setTakeoffAlt(Math.max(2, Number(e.target.value) || 10))}
              className="actions-alt-input"
            />
          </div>
          <div className="actions-grid-v2">
            {FLIGHT_CONTROLS.map(action => (
              <button
                key={action.label}
                className="action-btn-v2"
                style={{ '--ac': action.color }}
                onClick={() => handleAction(action)}
                disabled={busy}
                title={action.desc}
              >
                {action.label}
              </button>
            ))}
          </div>
          <div className="actions-hint">
            ARM requires vehicle to pass pre-arm checks.<br />
            TAKEOFF requires vehicle to be armed first.
          </div>
        </div>
      )}

      {/* ── Flight Modes ──────────────────────────────────────────────────── */}
      {activeSection === 'modes' && (
        <div className="actions-section">
          <input
            className="actions-mode-filter"
            placeholder="Filter modes…"
            value={modeFilter}
            onChange={e => setModeFilter(e.target.value)}
          />
          <div className="actions-modes-grid">
            {filteredModes.map(m => (
              <button
                key={m}
                className="action-btn-mode"
                onClick={() => handleModeSet(m)}
                disabled={busy}
                title={`Set flight mode to ${m}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Calibration ───────────────────────────────────────────────────── */}
      {activeSection === 'calib' && (
        <div className="actions-section">
          <div className="actions-calib-note">
            ⚠ Calibration commands send MAV_CMD_PREFLIGHT_CALIBRATION.
            Drone must be stationary and disarmed.
          </div>
          <div className="actions-grid-v2">
            {CALIBRATIONS.map(action => (
              <button
                key={action.label}
                className="action-btn-v2"
                style={{ '--ac': action.color }}
                onClick={() => handleAction(action)}
                disabled={busy}
                title={action.desc}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Advanced ──────────────────────────────────────────────────────── */}
      {activeSection === 'adv' && (
        <div className="actions-section">
          <div className="actions-calib-note" style={{ color: '#ef4444' }}>
            ⚠ Advanced actions can cause immediate state changes or hardware resets.
            Use with caution.
          </div>
          <div className="actions-grid-v2">
            {ADVANCED.map(action => (
              <button
                key={action.label}
                className="action-btn-v2"
                style={{ '--ac': action.color }}
                onClick={() => handleAction(action)}
                disabled={busy}
                title={action.desc}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ActionsTab;
