import React, { useState } from 'react';
import axios from 'axios';
import useTelemetryStore, { selectPrimaryVehicle } from '../store/useTelemetryStore';
import AccelCalibration from '../components/setup/AccelCalibration';
import CompassCalibration from '../components/setup/CompassCalibration';
import RadioCalibration from '../components/setup/RadioCalibration';
import FlightModeConfig from '../components/setup/FlightModeConfig';
import FailsafeConfig from '../components/setup/FailsafeConfig';
import BatteryMonitor from '../components/setup/BatteryMonitor';
import MotorTest from '../components/setup/MotorTest';
import Params from './Params';

const API = 'http://localhost:8080/api';

const SETUP_TABS = [
  { id: 'CAL',       label: 'Calibration' },
  { id: 'RADIO',     label: 'Radio Cal' },
  { id: 'FLTMODES',  label: 'Flight Modes' },
  { id: 'FAILSAFE',  label: 'Failsafe' },
  { id: 'BATTERY',   label: 'Battery' },
  { id: 'MOTORTEST', label: 'Motor Test' },
  { id: 'PARAMS',    label: 'Parameters' },
];

// Simple calibration items still handled with existing endpoint
const QUICK_CAL_ITEMS = [
  { id: 'level', label: 'Level Horizon', icon: '—', hint: 'MAV_CMD p7=1 — vehicle must be level', danger: false },
  { id: 'esc',   label: 'ESC Calibration', icon: '⚡', hint: 'MAV_CMD p1=3 — REMOVE PROPS FIRST', danger: true },
  { id: 'gyro',  label: 'Gyro Calibration', icon: '🔄', hint: 'MAV_CMD p1=1 — keep vehicle still', danger: false },
  { id: 'reboot', label: 'Reboot FC', icon: '↺', hint: 'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN', danger: false },
];

function CalibrationTab({ armed, vehicle }) {
  const [busy, setBusy] = useState('');
  const [calStatus, setCalStatus] = useState('');

  const runQuickCal = async (kind) => {
    if (armed && kind !== 'reboot') {
      setCalStatus(`${kind} blocked: disarm vehicle first.`);
      return;
    }
    setBusy(kind);
    setCalStatus(`Running ${kind}…`);
    try {
      const res = await axios.post(`${API}/calibration/run`, { kind });
      setCalStatus(`${kind}: ${res.data?.mav_result_text || res.data?.status || 'command sent'}`);
    } catch (e) {
      const d = e.response?.data;
      setCalStatus(`${kind} failed: ${d?.detail || d?.error || e.message}`);
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      {/* Accelerometer */}
      <div className="setup-cal-card">
        <div className="setup-cal-card-header">
          <span>Accelerometer Calibration</span>
          <span className="setup-badge">MAV_CMD 241 p5=1</span>
        </div>
        <p className="setup-cal-desc">
          6-position calibration. Place vehicle in each orientation and confirm. Vehicle must be DISARMED and STATIONARY.
        </p>
        <AccelCalibration armed={armed} />
      </div>

      {/* Compass */}
      <div className="setup-cal-card">
        <div className="setup-cal-card-header">
          <span>Compass Calibration</span>
          <span className="setup-badge">MAV_CMD 241 p6=1</span>
        </div>
        <p className="setup-cal-desc">
          Rotate vehicle slowly in all axes until calibration completes. Move away from metal objects and electronics.
        </p>
        <CompassCalibration armed={armed} />
      </div>

      {/* Quick cal items */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginTop: 10 }}>
        {QUICK_CAL_ITEMS.map(c => (
          <div key={c.id} className={`setup-cal-quick ${c.danger ? 'danger' : ''}`}>
            <div style={{ fontSize: 22, marginBottom: 6 }}>{c.icon}</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>{c.hint}</div>
            <button
              className={`btn-toolbar ${c.danger ? 'danger' : 'primary'}`}
              disabled={!!busy || (armed && c.id !== 'reboot')}
              onClick={() => runQuickCal(c.id)}
            >
              {busy === c.id ? 'Running…' : 'Run'}
            </button>
          </div>
        ))}
      </div>

      {calStatus && (
        <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-secondary)' }}>{calStatus}</div>
      )}
    </div>
  );
}

const Setup = () => {
  const [tab, setTab] = useState('CAL');
  const vehicle = useTelemetryStore(selectPrimaryVehicle) || {};
  const armed = !!vehicle?.status?.armed;
  const connected = !!vehicle?.status;

  const gpsFix = Number(vehicle?.status?.gps_fix ?? 0);
  const sats = Number(vehicle?.status?.satellites ?? 0);
  const battery = Number(vehicle?.battery?.remaining ?? 0);
  const voltage = Number(vehicle?.battery?.voltage ?? 0);
  const mode = String(vehicle?.status?.mode || '—');

  return (
    <div className="setup-page">
      {/* Status bar */}
      <div className="setup-status-bar">
        <span className={`setup-status-chip ${connected ? 'ok' : 'err'}`}>
          {connected ? '● Connected' : '○ Disconnected'}
        </span>
        <span className={`setup-status-chip ${armed ? 'warn' : 'ok'}`}>
          {armed ? '⚠ ARMED' : '✓ Disarmed'}
        </span>
        <span className="setup-status-chip">
          GPS: fix {gpsFix} · {sats} sats
        </span>
        <span className={`setup-status-chip ${battery < 20 ? 'err' : battery < 40 ? 'warn' : 'ok'}`}>
          Batt: {battery}% {voltage > 0 ? `(${voltage.toFixed(1)}V)` : ''}
        </span>
        <span className="setup-status-chip">Mode: {mode}</span>
      </div>

      {/* Tab bar */}
      <div className="setup-tab-bar">
        {SETUP_TABS.map(t => (
          <button
            key={t.id}
            className={`setup-tab-btn ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="setup-content">
        {tab === 'CAL' && <CalibrationTab armed={armed} vehicle={vehicle} />}
        {tab === 'RADIO' && <RadioCalibration />}
        {tab === 'FLTMODES' && <FlightModeConfig />}
        {tab === 'FAILSAFE' && <FailsafeConfig />}
        {tab === 'BATTERY' && <BatteryMonitor />}
        {tab === 'MOTORTEST' && <MotorTest />}
        {tab === 'PARAMS' && <Params />}
      </div>
    </div>
  );
};

export default Setup;
