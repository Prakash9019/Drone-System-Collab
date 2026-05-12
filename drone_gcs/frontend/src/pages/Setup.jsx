import React, { useMemo, useState } from 'react';
import axios from 'axios';
import Params from './Params';
import useTelemetryStore, { selectPrimaryVehicle } from '../store/useTelemetryStore';

const API = 'http://localhost:8080/api';

const CAL_ITEMS = [
  { id: 'accelerometer', label: 'Accelerometer Calibration', hint: 'MAV_CMD_PREFLIGHT_CALIBRATION p5=1' },
  { id: 'compass', label: 'Compass Calibration', hint: 'MAV_CMD_PREFLIGHT_CALIBRATION p6=1' },
  { id: 'level', label: 'Level Horizon', hint: 'MAV_CMD_PREFLIGHT_CALIBRATION p7=1' },
  { id: 'esc', label: 'ESC Calibration', hint: 'MAV_CMD_PREFLIGHT_CALIBRATION p1=3' },
  { id: 'reboot', label: 'Reboot Autopilot', hint: 'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN' },
];

const Setup = () => {
  const [tab, setTab] = useState('CALIBRATION');
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');
  const vehicle = useTelemetryStore(selectPrimaryVehicle) || {};

  const preflightSummary = useMemo(() => ({
    gpsFix: Number(vehicle?.status?.gps_fix ?? 0),
    sats: Number(vehicle?.status?.satellites ?? 0),
    hdop: Number(vehicle?.status?.gps_hdop ?? 0),
    battery: Number(vehicle?.battery?.remaining ?? 0),
    armed: !!vehicle?.status?.armed,
  }), [vehicle]);

  const runCalibration = async (kind) => {
    setBusy(kind);
    setStatus(`Running ${kind}...`);
    try {
      const res = await axios.post(`${API}/calibration/run`, { kind });
      setStatus(`${kind}: ${res.data?.mav_result_text || res.data?.status || 'done'}`);
    } catch (e) {
      const d = e.response?.data;
      setStatus(`${kind} failed: ${d?.detail || d?.error || e.message}`);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flight-planner" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <button className={`btn-toolbar ${tab === 'CALIBRATION' ? 'primary' : ''}`} onClick={() => setTab('CALIBRATION')}>
          Calibration
        </button>
        <button className={`btn-toolbar ${tab === 'PARAMS' ? 'primary' : ''}`} onClick={() => setTab('PARAMS')}>
          Parameters
        </button>
      </div>
      {tab === 'CALIBRATION' ? (
        <>
          <div style={{ marginBottom: 12, color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: 12 }}>
            GPS: fix {preflightSummary.gpsFix}, sats {preflightSummary.sats}, HDOP {preflightSummary.hdop > 0 ? preflightSummary.hdop.toFixed(2) : 'N/A'}
            {' '}| Battery: {preflightSummary.battery}% | Armed: {preflightSummary.armed ? 'YES' : 'NO'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 10 }}>
            {CAL_ITEMS.map((c) => (
              <div key={c.id} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 700 }}>{c.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '6px 0 10px' }}>{c.hint}</div>
                <button
                  className="btn-toolbar primary"
                  disabled={!!busy}
                  onClick={() => runCalibration(c.id)}
                >
                  {busy === c.id ? 'Running...' : 'Run'}
                </button>
              </div>
            ))}
          </div>
          {status && <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary)' }}>{status}</div>}
        </>
      ) : (
        <Params />
      )}
    </div>
  );
};

export default Setup;

