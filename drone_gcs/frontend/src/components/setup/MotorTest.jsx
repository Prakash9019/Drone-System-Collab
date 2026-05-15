import React, { useState } from 'react';
import axios from 'axios';
import useTelemetryStore, { selectPrimaryVehicle } from '../../store/useTelemetryStore';

const API = 'http://localhost:8080/api';

const MOTOR_LAYOUTS = {
  quad: [
    { id: 1, label: 'Front-Right', pos: { top: '10%', right: '10%' } },
    { id: 2, label: 'Back-Left',   pos: { bottom: '10%', left: '10%' } },
    { id: 3, label: 'Front-Left',  pos: { top: '10%', left: '10%' } },
    { id: 4, label: 'Back-Right',  pos: { bottom: '10%', right: '10%' } },
  ],
  hex: [
    { id: 1, label: 'Front-Right',     pos: { top: '5%', right: '25%' } },
    { id: 2, label: 'Right',           pos: { top: '40%', right: '5%' } },
    { id: 3, label: 'Back-Right',      pos: { bottom: '5%', right: '25%' } },
    { id: 4, label: 'Back-Left',       pos: { bottom: '5%', left: '25%' } },
    { id: 5, label: 'Left',            pos: { top: '40%', left: '5%' } },
    { id: 6, label: 'Front-Left',      pos: { top: '5%', left: '25%' } },
  ],
};

export default function MotorTest() {
  const vehicle = useTelemetryStore(selectPrimaryVehicle) || {};
  const armed = !!vehicle?.status?.armed;

  const [layout, setLayout] = useState('quad');
  const [selectedMotor, setSelectedMotor] = useState(1);
  const [throttle, setThrottle] = useState(5);
  const [duration, setDuration] = useState(2);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const motors = MOTOR_LAYOUTS[layout] || MOTOR_LAYOUTS.quad;

  const runTest = async () => {
    if (armed) { setStatus('ERROR: Disarm vehicle before motor test!'); return; }
    if (!confirmed) { setStatus('ERROR: Check the safety confirmation box first.'); return; }
    setRunning(true);
    setStatus(`Testing Motor ${selectedMotor} @ ${throttle}% for ${duration}s…`);
    try {
      const res = await axios.post(`${API}/motor_test`, {
        motor_number: selectedMotor,
        throttle_pct: throttle,
        duration_s: duration,
      });
      if (res.data?.status === 'ok') {
        setStatus(`Motor ${selectedMotor}: test accepted — spun @ ${throttle}% for ${duration}s`);
      } else {
        setStatus(`Motor ${selectedMotor}: rejected — ${res.data?.mav_result_text || 'check connection'}`);
      }
    } catch (e) {
      const d = e.response?.data;
      setStatus(`Error: ${d?.detail || d?.error || e.message}`);
    } finally {
      setRunning(false);
    }
  };

  const stopAll = async () => {
    try {
      await axios.post(`${API}/motor_test`, { motor_number: 0, throttle_pct: 0, duration_s: 0 });
      setStatus('All motors stopped.');
    } catch { setStatus('Stop command sent.'); }
  };

  return (
    <div className="setup-section">
      {/* Safety warning */}
      <div className="setup-warning">
        <strong>⚠ DANGER — SPINNING MOTORS</strong>
        <ul style={{ marginTop: 6, paddingLeft: 20, fontSize: 12 }}>
          <li>Remove all propellers before running motor test</li>
          <li>Vehicle must be DISARMED</li>
          <li>Keep hands and objects clear of motors</li>
          <li>Maximum throttle is capped at 30% by the backend</li>
        </ul>
      </div>

      {armed && (
        <div style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', borderRadius: 6, padding: '10px 14px', marginBottom: 14, color: '#fca5a5', fontWeight: 600 }}>
          VEHICLE IS ARMED — Disarm before motor test
        </div>
      )}

      <div className="setup-row" style={{ flexWrap: 'wrap', gap: 16, marginBottom: 14 }}>
        {/* Layout selector */}
        <label className="setup-label">
          Frame Layout
          <select className="setup-select" value={layout} onChange={e => setLayout(e.target.value)}>
            <option value="quad">Quad (4 motors)</option>
            <option value="hex">Hex (6 motors)</option>
          </select>
        </label>

        {/* Motor diagram */}
        <div style={{ position: 'relative', width: 180, height: 180, border: '1px solid var(--border-color)', borderRadius: 8, background: 'rgba(255,255,255,0.02)', flexShrink: 0 }}>
          {/* Center cross */}
          <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1, background: 'rgba(148,163,184,0.2)', transform: 'translateY(-50%)' }} />
          <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(148,163,184,0.2)', transform: 'translateX(-50%)' }} />
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', fontSize: 20 }}>✈</div>
          {motors.map(m => (
            <button
              key={m.id}
              onClick={() => setSelectedMotor(m.id)}
              style={{
                position: 'absolute',
                ...m.pos,
                width: 36, height: 36,
                borderRadius: '50%',
                background: selectedMotor === m.id ? '#3b82f6' : 'rgba(51,65,85,0.8)',
                border: `2px solid ${selectedMotor === m.id ? '#60a5fa' : '#475569'}`,
                color: 'white',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              title={m.label}
            >
              {m.id}
            </button>
          ))}
        </div>
      </div>

      <div className="setup-row" style={{ gap: 20, flexWrap: 'wrap', marginBottom: 14 }}>
        <label className="setup-label">
          Motor #{selectedMotor}
          <select className="setup-select" value={selectedMotor} onChange={e => setSelectedMotor(Number(e.target.value))}>
            {motors.map(m => <option key={m.id} value={m.id}>Motor {m.id} — {m.label}</option>)}
          </select>
        </label>
        <label className="setup-label">
          Throttle: {throttle}%
          <input type="range" min={1} max={30} step={1} value={throttle}
            onChange={e => setThrottle(Number(e.target.value))}
            style={{ width: 160, display: 'block', marginTop: 6 }} />
          <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Max 30% for safety</span>
        </label>
        <label className="setup-label">
          Duration: {duration}s
          <input type="range" min={0.5} max={10} step={0.5} value={duration}
            onChange={e => setDuration(Number(e.target.value))}
            style={{ width: 160, display: 'block', marginTop: 6 }} />
        </label>
      </div>

      <label className="setup-checkbox-row" style={{ marginBottom: 14 }}>
        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
        <span>I confirm propellers are removed and the area is clear</span>
      </label>

      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn-toolbar primary" onClick={runTest} disabled={running || armed || !confirmed}>
          {running ? 'Running…' : `Test Motor ${selectedMotor}`}
        </button>
        <button className="btn-toolbar danger" onClick={stopAll} style={{ marginLeft: 8 }}>
          ■ Stop All
        </button>
      </div>

      {status && (
        <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 6, fontSize: 13, color: status.startsWith('ERROR') ? '#fca5a5' : 'var(--text-secondary)', border: '1px solid var(--border-color)' }}>
          {status}
        </div>
      )}
    </div>
  );
}
