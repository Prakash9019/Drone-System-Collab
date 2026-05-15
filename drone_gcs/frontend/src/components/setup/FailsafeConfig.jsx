import React, { useEffect, useState } from 'react';
import axios from 'axios';

const API = 'http://localhost:8080/api';

const FS_SCHEMA = [
  {
    group: 'Battery Failsafe',
    items: [
      { param: 'FS_BATT_ENABLE', label: 'Battery Failsafe Action', type: 'select',
        options: [{v:0,l:'Disabled'},{v:1,l:'Land'},{v:2,l:'RTL'},{v:3,l:'SmartRTL'},{v:4,l:'SmartRTL+Land'},{v:5,l:'Terminate'}],
        desc: 'Action taken when battery drops below low voltage/mAh threshold.' },
      { param: 'FS_BATT_VOLTAGE', label: 'Low Battery Voltage (V)', type: 'number', step: 0.1, min: 0,
        desc: 'Voltage to trigger battery failsafe (0 = disabled). e.g. 14.0V for 4S.' },
      { param: 'FS_BATT_MAH', label: 'Low Battery mAh Remaining', type: 'number', step: 50, min: 0,
        desc: 'mAh remaining to trigger failsafe (0 = disabled). e.g. 400 mAh.' },
    ]
  },
  {
    group: 'RC / GCS Failsafe',
    items: [
      { param: 'FS_RC_ENABLE', label: 'RC Loss Failsafe Action', type: 'select',
        options: [{v:0,l:'Disabled'},{v:1,l:'Land'},{v:2,l:'RTL'},{v:3,l:'SmartRTL'},{v:4,l:'Brake+Land'},{v:5,l:'SmartRTL+Land'}],
        desc: 'Action when RC signal is lost for >RC_FS_THR seconds.' },
      { param: 'FS_GCS_ENABLE', label: 'GCS Loss Failsafe Action', type: 'select',
        options: [{v:0,l:'Disabled'},{v:1,l:'Land'},{v:2,l:'RTL'},{v:3,l:'SmartRTL'},{v:4,l:'SmartRTL+Land'},{v:5,l:'Terminate'}],
        desc: 'Action when ground control station heartbeat is lost.' },
    ]
  },
  {
    group: 'EKF Failsafe',
    items: [
      { param: 'FS_EKF_ACTION', label: 'EKF Failsafe Action', type: 'select',
        options: [{v:1,l:'Land'},{v:2,l:'AltHold'},{v:3,l:'Land+Disarm'}],
        desc: 'Action when EKF variance exceeds threshold.' },
      { param: 'FS_EKF_THRESH', label: 'EKF Variance Threshold', type: 'number', step: 0.05, min: 0,
        desc: 'EKF variance above which failsafe activates (default 0.8).' },
    ]
  },
  {
    group: 'RTL / Land Settings',
    items: [
      { param: 'RTL_ALT', label: 'RTL Altitude (cm)', type: 'number', step: 100, min: 100,
        desc: 'Altitude in cm to climb to before RTL (e.g. 1500 = 15m).' },
      { param: 'LAND_SPEED', label: 'Landing Speed (cm/s)', type: 'number', step: 10, min: 20,
        desc: 'Vertical speed during landing phase (default 50 cm/s).' },
    ]
  },
];

export default function FailsafeConfig() {
  const [params, setParams] = useState({});
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setLoading(true);
    axios.get(`${API}/setup/failsafe`)
      .then(r => {
        const p = r.data?.params || {};
        const cleaned = {};
        Object.entries(p).forEach(([k, v]) => { if (v != null) cleaned[k] = Number(v); });
        setParams(cleaned);
        setStatus('Loaded from vehicle.');
        setDirty(false);
      })
      .catch(e => setStatus(`Load failed: ${e.response?.data?.detail || e.message}`))
      .finally(() => setLoading(false));
  }, []);

  const update = (param, val) => {
    setParams(p => ({ ...p, [param]: val }));
    setDirty(true);
  };

  const save = async () => {
    setLoading(true);
    setStatus('Writing failsafe parameters…');
    try {
      const res = await axios.post(`${API}/setup/failsafe`, { params });
      const results = res.data?.results || {};
      const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
      if (failed.length) {
        setStatus(`Partial write — failed: ${failed.join(', ')}. Check vehicle connection.`);
      } else {
        setStatus(`All failsafe parameters written successfully.`);
        setDirty(false);
      }
    } catch (e) {
      setStatus(`Error: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const refresh = () => {
    setLoading(true);
    axios.get(`${API}/setup/failsafe`)
      .then(r => {
        const p = r.data?.params || {};
        const cleaned = {};
        Object.entries(p).forEach(([k, v]) => { if (v != null) cleaned[k] = Number(v); });
        setParams(cleaned);
        setStatus('Refreshed from vehicle.');
        setDirty(false);
      })
      .catch(e => setStatus(`Refresh failed: ${e.message}`))
      .finally(() => setLoading(false));
  };

  return (
    <div className="setup-section">
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button className="btn-toolbar" onClick={refresh} disabled={loading}>↻ Refresh</button>
        <button className="btn-toolbar primary" onClick={save} disabled={loading || !dirty}>
          {loading ? 'Writing…' : 'Write Failsafe Config'}
        </button>
        {dirty && <span style={{ fontSize: 11, color: '#f59e0b', alignSelf: 'center' }}>● Unsaved changes</span>}
      </div>

      {FS_SCHEMA.map(({ group, items }) => (
        <div key={group} className="setup-param-group">
          <div className="setup-param-group-header">{group}</div>
          {items.map(({ param, label, type, options, step, min, desc }) => (
            <div key={param} className="setup-param-row">
              <div className="setup-param-info">
                <div className="setup-param-label">{label}</div>
                <div className="setup-param-desc">{desc}</div>
              </div>
              <div className="setup-param-control">
                {type === 'select' ? (
                  <select
                    className="setup-select"
                    value={params[param] ?? ''}
                    onChange={e => update(param, Number(e.target.value))}
                    disabled={loading}
                  >
                    {params[param] == null && <option value="">— not loaded —</option>}
                    {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                  </select>
                ) : (
                  <input
                    type="number"
                    className="setup-number-input"
                    value={params[param] ?? ''}
                    step={step ?? 1}
                    min={min ?? 0}
                    onChange={e => update(param, Number(e.target.value))}
                    disabled={loading}
                    placeholder="—"
                  />
                )}
                <span className="setup-param-id">{param}</span>
              </div>
            </div>
          ))}
        </div>
      ))}

      {status && (
        <div style={{ marginTop: 12, fontSize: 12, color: status.includes('fail') || status.includes('Error') ? '#fca5a5' : 'var(--text-secondary)' }}>
          {status}
        </div>
      )}
    </div>
  );
}
