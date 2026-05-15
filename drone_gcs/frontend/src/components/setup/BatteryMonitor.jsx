import React, { useEffect, useState } from 'react';
import axios from 'axios';
import useTelemetryStore, { selectPrimaryVehicle } from '../../store/useTelemetryStore';

const API = 'http://localhost:8080/api';

const BATT_SCHEMA = [
  { param: 'BATT_MONITOR', label: 'Monitor Type', type: 'select',
    options: [{v:0,l:'Disabled'},{v:3,l:'Voltage Only'},{v:4,l:'Voltage + Current (Pixhawk)'},{v:5,l:'Solo'},{v:7,l:'SMBUS-Generic'},{v:8,l:'UAVCAN-BatteryInfo'},{v:9,l:'ESC Telemetry'},{v:10,l:'Sum'},{v:13,l:'SMBUS-SUI3'},{v:14,l:'SMBUS-SUI6'},{v:17,l:'INA231'}],
    desc: 'Battery monitor type. Must reboot after changing.' },
  { param: 'BATT_VOLT_PIN', label: 'Voltage Sensor Pin', type: 'number', desc: 'ADC pin for voltage (Pixhawk: 2).' },
  { param: 'BATT_CURR_PIN', label: 'Current Sensor Pin', type: 'number', desc: 'ADC pin for current (Pixhawk: 3).' },
  { param: 'BATT_VOLT_MULT', label: 'Voltage Multiplier', type: 'number', step: 0.001, desc: 'Multiplier to convert ADC reading to volts. Calibrate to actual voltage.' },
  { param: 'BATT_AMP_PERVLT', label: 'Amps Per Volt', type: 'number', step: 0.1, desc: 'Calibrate current sensor (amps per volt from ADC).' },
  { param: 'BATT_CAPACITY', label: 'Battery Capacity (mAh)', type: 'number', step: 100, desc: 'Full battery capacity for mAh tracking.' },
  { param: 'BATT_LOW_VOLT', label: 'Low Voltage Threshold (V)', type: 'number', step: 0.1, desc: 'Voltage to trigger low battery failsafe.' },
  { param: 'BATT_CRT_VOLT', label: 'Critical Voltage (V)', type: 'number', step: 0.1, desc: 'Voltage to trigger critical failsafe (must be < Low).' },
  { param: 'BATT_LOW_MAH', label: 'Low Battery mAh', type: 'number', step: 50, desc: 'Remaining mAh to trigger low battery warning.' },
  { param: 'BATT_CRT_MAH', label: 'Critical mAh', type: 'number', step: 50, desc: 'Remaining mAh to trigger critical failsafe.' },
  { param: 'BATT_ARM_VOLT', label: 'Arming Min Voltage (V)', type: 'number', step: 0.1, desc: 'Minimum voltage required to arm (0 = disabled).' },
];

function LiveBatteryDisplay({ vehicle }) {
  const batt = vehicle?.battery || {};
  const pct = Number(batt.remaining ?? 0);
  const volt = Number(batt.voltage ?? 0);
  const curr = Number(batt.current ?? 0);
  const mah = Number(batt.consumed_mah ?? 0);

  const barColor = pct > 50 ? '#22c55e' : pct > 20 ? '#f59e0b' : '#ef4444';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 16 }}>
      {[
        { label: 'Voltage', value: volt > 0 ? `${volt.toFixed(2)} V` : '—', color: volt < 14 && volt > 0 ? '#f59e0b' : '#22c55e' },
        { label: 'Current', value: curr > 0 ? `${curr.toFixed(1)} A` : '—' },
        { label: 'Remaining', value: `${pct}%`, color: barColor },
        { label: 'Consumed', value: mah > 0 ? `${Math.round(mah)} mAh` : '—' },
      ].map(({ label, value, color }) => (
        <div key={label} style={{ border: '1px solid var(--border-color)', borderRadius: 6, padding: '10px 12px', background: 'var(--bg-panel)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: color || 'var(--text-primary)', fontFamily: 'monospace' }}>{value}</div>
        </div>
      ))}
      <div style={{ gridColumn: '1 / -1' }}>
        <div style={{ height: 8, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, pct))}%`, background: barColor, transition: 'width 0.5s, background 0.5s', borderRadius: 4 }} />
        </div>
      </div>
    </div>
  );
}

export default function BatteryMonitor() {
  const vehicle = useTelemetryStore(selectPrimaryVehicle) || {};
  const [params, setParams] = useState({});
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = () => {
    setLoading(true);
    axios.get(`${API}/setup/battery`)
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
  };

  useEffect(() => { load(); }, []);

  const update = (param, val) => {
    setParams(p => ({ ...p, [param]: val }));
    setDirty(true);
  };

  const save = async () => {
    setLoading(true);
    setStatus('Writing battery parameters…');
    try {
      const res = await axios.post(`${API}/setup/battery`, { params });
      const results = res.data?.results || {};
      const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
      if (failed.length) {
        setStatus(`Partial write — failed: ${failed.join(', ')}`);
      } else {
        setStatus('Battery configuration saved. Reboot may be required for monitor type change.');
        setDirty(false);
      }
    } catch (e) {
      setStatus(`Error: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="setup-section">
      <LiveBatteryDisplay vehicle={vehicle} />

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button className="btn-toolbar" onClick={load} disabled={loading}>↻ Refresh</button>
        <button className="btn-toolbar primary" onClick={save} disabled={loading || !dirty}>
          {loading ? 'Writing…' : 'Write Battery Config'}
        </button>
        {dirty && <span style={{ fontSize: 11, color: '#f59e0b', alignSelf: 'center' }}>● Unsaved changes</span>}
      </div>

      <div className="setup-param-group">
        <div className="setup-param-group-header">Battery Monitor Parameters</div>
        {BATT_SCHEMA.map(({ param, label, type, options, step, desc }) => (
          <div key={param} className="setup-param-row">
            <div className="setup-param-info">
              <div className="setup-param-label">{label}</div>
              <div className="setup-param-desc">{desc}</div>
            </div>
            <div className="setup-param-control">
              {type === 'select' ? (
                <select className="setup-select" value={params[param] ?? ''} onChange={e => update(param, Number(e.target.value))} disabled={loading}>
                  {params[param] == null && <option value="">— not loaded —</option>}
                  {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              ) : (
                <input type="number" className="setup-number-input" value={params[param] ?? ''} step={step ?? 1} min={0}
                  onChange={e => update(param, Number(e.target.value))} disabled={loading} placeholder="—" />
              )}
              <span className="setup-param-id">{param}</span>
            </div>
          </div>
        ))}
      </div>

      {status && (
        <div style={{ marginTop: 12, fontSize: 12, color: status.includes('fail') || status.includes('Error') ? '#fca5a5' : 'var(--text-secondary)' }}>
          {status}
        </div>
      )}
    </div>
  );
}
