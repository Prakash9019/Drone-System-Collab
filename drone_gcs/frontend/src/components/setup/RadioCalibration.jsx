import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import useTelemetryStore, { selectPrimaryVehicle } from '../../store/useTelemetryStore';

const API = 'http://localhost:8080/api';

const CH_LABELS = {
  1: 'Roll', 2: 'Pitch', 3: 'Throttle', 4: 'Yaw',
  5: 'Flight Mode', 6: 'Aux 1', 7: 'Aux 2', 8: 'Aux 3',
};

const DEFAULT_MIN = 1100;
const DEFAULT_MAX = 1900;
const DEFAULT_TRIM = 1500;

function ChannelBar({ ch, current, calMin, calMax, trim }) {
  const min = calMin ?? DEFAULT_MIN;
  const max = calMax ?? DEFAULT_MAX;
  const range = max - min || 1;
  const pct = ((current - min) / range) * 100;
  const trimPct = ((trim - min) / range) * 100;

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
        <span style={{ color: 'var(--text-secondary)' }}>CH{ch} {CH_LABELS[ch] || ''}</span>
        <span style={{ fontFamily: 'monospace', color: '#f8fafc' }}>{current ?? '—'}</span>
        <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{min} — {max}</span>
      </div>
      <div style={{ position: 'relative', height: 12, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'visible' }}>
        <div style={{ position: 'absolute', left: 0, height: '100%', width: `${Math.max(0, Math.min(100, pct))}%`, background: ch === 3 ? '#3b82f6' : '#10b981', borderRadius: 4, transition: 'width 0.05s' }} />
        {/* Trim marker */}
        <div style={{ position: 'absolute', left: `${Math.max(0, Math.min(100, trimPct))}%`, top: -2, bottom: -2, width: 2, background: '#f59e0b', transform: 'translateX(-50%)' }} />
      </div>
    </div>
  );
}

export default function RadioCalibration() {
  const vehicle = useTelemetryStore(selectPrimaryVehicle) || {};
  const rcChannels = vehicle?.rc_channels?.channels || {};

  const [state, setState] = useState('idle'); // idle | calibrating | done
  const [calMin, setCalMin] = useState({});
  const [calMax, setCalMax] = useState({});
  const [savedParams, setSavedParams] = useState({});
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const calRef = useRef({ min: {}, max: {} });

  // Load existing RC params
  useEffect(() => {
    axios.get(`${API}/setup/radio`)
      .then(r => {
        setSavedParams(r.data?.params || {});
        setStatus('Loaded existing RC calibration from vehicle.');
      })
      .catch(() => {});
  }, []);

  // Track min/max while calibrating
  useEffect(() => {
    if (state !== 'calibrating') return;
    Object.entries(rcChannels).forEach(([ch, val]) => {
      const n = Number(ch);
      const v = Number(val);
      if (!v) return;
      calRef.current.min[n] = Math.min(calRef.current.min[n] ?? v, v);
      calRef.current.max[n] = Math.max(calRef.current.max[n] ?? v, v);
    });
    setCalMin({ ...calRef.current.min });
    setCalMax({ ...calRef.current.max });
  }, [rcChannels, state]);

  const startCal = () => {
    calRef.current = { min: {}, max: {} };
    setCalMin({});
    setCalMax({});
    setState('calibrating');
    setStatus('Move all sticks to their full extents including corners. Move throttle fully up then down. Move all switches. When done, click Stop Calibration.');
  };

  const stopCal = () => {
    setState('done');
    setStatus('Calibration recorded. Click Save to write RC_MIN/MAX to vehicle.');
  };

  const save = async () => {
    const params = {};
    const channels = Object.keys(calMin).length ? Object.keys(calMin) : Object.keys(rcChannels);
    channels.forEach(ch => {
      const n = Number(ch);
      if (!n) return;
      params[`RC${n}_MIN`] = calMin[n] ?? DEFAULT_MIN;
      params[`RC${n}_MAX`] = calMax[n] ?? DEFAULT_MAX;
      // Preserve existing trim
      const existTrim = savedParams[`RC${n}_TRIM`];
      if (existTrim != null) params[`RC${n}_TRIM`] = existTrim;
    });
    setLoading(true);
    setStatus('Writing RC calibration parameters…');
    try {
      const res = await axios.post(`${API}/setup/radio`, { params });
      const failed = Object.entries(res.data?.results || {}).filter(([, r]) => !r.ok).map(([k]) => k);
      if (failed.length) {
        setStatus(`Partial write — failed: ${failed.join(', ')}`);
      } else {
        setStatus(`Saved calibration for ${res.data?.written} parameters.`);
        setSavedParams(p => ({ ...p, ...params }));
        setState('idle');
      }
    } catch (e) {
      setStatus(`Error: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const displayChannels = Array.from(new Set([
    ...Object.keys(rcChannels).map(Number),
    ...Object.keys(calMin).map(Number),
  ])).filter(Boolean).sort((a, b) => a - b).slice(0, 16);

  return (
    <div className="setup-section">
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
        Move transmitter sticks to their full extents while calibrating. The GCS records the minimum and maximum
        PWM values seen on each channel and writes them to the vehicle as RC{'{n}'}_MIN and RC{'{n}'}_MAX.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {state === 'idle' && (
          <button className="btn-toolbar primary" onClick={startCal}>Start Calibration</button>
        )}
        {state === 'calibrating' && (
          <>
            <span style={{ fontSize: 12, color: '#34d399', alignSelf: 'center', fontWeight: 600 }}>● RECORDING</span>
            <button className="btn-toolbar danger" onClick={stopCal}>Stop Calibration</button>
          </>
        )}
        {state === 'done' && (
          <>
            <button className="btn-toolbar" onClick={startCal}>Re-Calibrate</button>
            <button className="btn-toolbar primary" onClick={save} disabled={loading}>
              {loading ? 'Saving…' : 'Save RC Calibration'}
            </button>
          </>
        )}
      </div>

      {state === 'calibrating' && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(16,185,129,0.08)', border: '1px solid #10b981', borderRadius: 6, fontSize: 12, color: '#34d399' }}>
          ● Recording — move all sticks to maximum extents including corners, flip all switches, cycle throttle fully.
        </div>
      )}

      {/* Channel bars */}
      <div style={{ marginBottom: 16 }}>
        {displayChannels.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>No RC channels detected. Connect vehicle and enable RC telemetry.</div>
        )}
        {displayChannels.map(ch => (
          <ChannelBar
            key={ch}
            ch={ch}
            current={rcChannels[ch]}
            calMin={state !== 'idle' ? calMin[ch] : (savedParams[`RC${ch}_MIN`])}
            calMax={state !== 'idle' ? calMax[ch] : (savedParams[`RC${ch}_MAX`])}
            trim={savedParams[`RC${ch}_TRIM`] ?? DEFAULT_TRIM}
          />
        ))}
      </div>

      {/* Min/max table after calibration */}
      {(state === 'done' || state === 'calibrating') && Object.keys(calMin).length > 0 && (
        <div style={{ marginBottom: 14, fontSize: 11 }}>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 600 }}>Recorded values:</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['CH', 'Label', 'Min', 'Max', 'Range'].map(h => (
                  <th key={h} style={{ padding: '3px 6px', textAlign: 'left', fontSize: 10, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayChannels.filter(ch => calMin[ch] != null).map(ch => (
                <tr key={ch}>
                  <td style={{ padding: '2px 6px', fontFamily: 'monospace' }}>CH{ch}</td>
                  <td style={{ padding: '2px 6px', color: 'var(--text-secondary)' }}>{CH_LABELS[ch] || ''}</td>
                  <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#60a5fa' }}>{calMin[ch]}</td>
                  <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#60a5fa' }}>{calMax[ch]}</td>
                  <td style={{ padding: '2px 6px', fontFamily: 'monospace' }}>{(calMax[ch] ?? 0) - (calMin[ch] ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {status && (
        <div style={{ fontSize: 12, color: status.includes('Error') || status.includes('failed') ? '#fca5a5' : 'var(--text-secondary)' }}>
          {status}
        </div>
      )}
    </div>
  );
}
