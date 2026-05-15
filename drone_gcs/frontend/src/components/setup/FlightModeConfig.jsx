import React, { useEffect, useState } from 'react';
import axios from 'axios';
import useTelemetryStore, { selectPrimaryVehicle } from '../../store/useTelemetryStore';

const API = 'http://localhost:8080/api';

const COPTER_MODES = [
  { v: 0, l: 'Stabilize' }, { v: 1, l: 'Acro' }, { v: 2, l: 'AltHold' },
  { v: 3, l: 'Auto' }, { v: 4, l: 'Guided' }, { v: 5, l: 'Loiter' },
  { v: 6, l: 'RTL' }, { v: 7, l: 'Circle' }, { v: 9, l: 'Land' },
  { v: 11, l: 'Drift' }, { v: 13, l: 'Sport' }, { v: 14, l: 'Flip' },
  { v: 15, l: 'AutoTune' }, { v: 16, l: 'PosHold' }, { v: 17, l: 'Brake' },
  { v: 18, l: 'Throw' }, { v: 19, l: 'Avoid_ADSB' }, { v: 20, l: 'Guided_NoGPS' },
  { v: 21, l: 'Smart_RTL' }, { v: 22, l: 'FlowHold' }, { v: 23, l: 'Follow' },
  { v: 24, l: 'ZigZag' }, { v: 25, l: 'SystemID' }, { v: 26, l: 'Heli_Autorotate' },
];

const FLTMODE_LABELS = [
  { param: 'FLTMODE1', label: 'Flight Mode 1 (lowest)' },
  { param: 'FLTMODE2', label: 'Flight Mode 2' },
  { param: 'FLTMODE3', label: 'Flight Mode 3' },
  { param: 'FLTMODE4', label: 'Flight Mode 4' },
  { param: 'FLTMODE5', label: 'Flight Mode 5' },
  { param: 'FLTMODE6', label: 'Flight Mode 6 (highest)' },
];

export default function FlightModeConfig() {
  const vehicle = useTelemetryStore(selectPrimaryVehicle) || {};
  const currentMode = String(vehicle?.status?.mode || '').toUpperCase();

  const [modes, setModes] = useState({ FLTMODE1: 0, FLTMODE2: 2, FLTMODE3: 3, FLTMODE4: 5, FLTMODE5: 6, FLTMODE6: 9 });
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    setLoading(true);
    axios.get(`${API}/setup/flight_modes`)
      .then(r => {
        const m = r.data?.modes || {};
        setModes(prev => {
          const next = { ...prev };
          Object.entries(m).forEach(([k, v]) => { if (v != null) next[k] = Number(v); });
          return next;
        });
        setStatus('Loaded from vehicle.');
      })
      .catch(e => setStatus(`Load failed: ${e.response?.data?.detail || e.message}`))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setLoading(true);
    setStatus('Writing flight modes…');
    try {
      const res = await axios.post(`${API}/setup/flight_modes`, { modes });
      const results = res.data?.results || {};
      const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
      if (failed.length) {
        setStatus(`Partial write — failed: ${failed.join(', ')}`);
      } else {
        setStatus(`All ${Object.keys(results).length} flight mode(s) written successfully.`);
      }
    } catch (e) {
      setStatus(`Error: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const modeNameOf = (v) => COPTER_MODES.find(m => m.v === Number(v))?.l || `Mode ${v}`;

  return (
    <div className="setup-section">
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
        Assign ArduPilot flight modes to RC switch positions (FLTMODE_CH, typically CH5).
        Current mode: <strong style={{ color: '#34d399' }}>{currentMode || '—'}</strong>
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        {FLTMODE_LABELS.map(({ param, label }) => {
          const val = modes[param] ?? 0;
          const modeName = modeNameOf(val);
          const isCurrent = modeName.toUpperCase() === currentMode;
          return (
            <label key={param} style={{ fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                {isCurrent && <span style={{ fontSize: 10, color: '#34d399', fontWeight: 700 }}>CURRENT</span>}
              </div>
              <select
                className="setup-select"
                value={val}
                onChange={e => setModes(m => ({ ...m, [param]: Number(e.target.value) }))}
                disabled={loading}
                style={{ borderColor: isCurrent ? '#34d399' : undefined }}
              >
                {COPTER_MODES.map(opt => (
                  <option key={opt.v} value={opt.v}>{opt.v} — {opt.l}</option>
                ))}
              </select>
            </label>
          );
        })}
      </div>

      {/* Summary row */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {FLTMODE_LABELS.map(({ param }) => (
          <span key={param} style={{ fontSize: 11, padding: '2px 8px', background: 'rgba(59,130,246,0.12)', borderRadius: 4, border: '1px solid rgba(59,130,246,0.3)', color: '#93c5fd' }}>
            {param}: {modeNameOf(modes[param])}
          </span>
        ))}
      </div>

      <button className="btn-toolbar primary" onClick={save} disabled={loading}>
        {loading ? 'Writing…' : 'Write Flight Modes'}
      </button>

      {status && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>{status}</div>
      )}

      <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        <strong>Note:</strong> Changes require vehicle reboot to take full effect.
        The RC switch channel is set via FLTMODE_CH parameter (default: 5).
        Switch positions map to modes based on PWM range thresholds.
      </div>
    </div>
  );
}
