import React, { useState } from 'react';
import axios from 'axios';

const API = 'http://localhost:8080/api';

const AuxTab = ({ vehicleState }) => {
  const [status, setStatus] = useState('');
  const [statusOk, setStatusOk] = useState(true);
  const [relayStates, setRelayStates] = useState({ 0: false, 1: false, 2: false });
  const [servoChannel, setServoChannel] = useState(9);
  const [servoPwm, setServoPwm] = useState(1500);
  const [rcOverride, setRcOverride] = useState({});
  const [busy, setBusy] = useState(false);

  const showStatus = (msg, ok = true) => {
    setStatus(msg);
    setStatusOk(ok);
    setTimeout(() => setStatus(''), 5000);
  };

  const sendCommand = async (command, p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0, p6 = 0, p7 = 0, label = '') => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await axios.post(`${API}/mavlink/command`, { command, p1, p2, p3, p4, p5, p6, p7 });
      const d = res.data;
      if (d.accepted === false) {
        showStatus(`✗ ${label || `CMD ${command}`}: ${d.mav_result_text || 'REJECTED'}`, false);
      } else {
        showStatus(`✓ ${label || `CMD ${command}`}: ${d.mav_result_text || 'SENT'}`, true);
      }
    } catch (err) {
      const d = err?.response?.data;
      showStatus(`✗ ${label} failed: ${d?.detail || err.message}`, false);
    }
    setBusy(false);
  };

  const toggleRelay = async (relayNum) => {
    const newState = !relayStates[relayNum];
    setRelayStates(prev => ({ ...prev, [relayNum]: newState }));
    // MAV_CMD_DO_SET_RELAY = 181, p1=relay_num, p2=0(off)/1(on)
    await sendCommand(181, relayNum, newState ? 1 : 0, 0, 0, 0, 0, 0, `Relay ${relayNum + 1} ${newState ? 'ON' : 'OFF'}`);
  };

  const setServo = async () => {
    // MAV_CMD_DO_SET_SERVO = 183, p1=channel, p2=pwm
    await sendCommand(183, servoChannel, servoPwm, 0, 0, 0, 0, 0, `Servo ${servoChannel} → ${servoPwm}µs`);
  };

  const triggerCamera = async () => {
    // MAV_CMD_DO_DIGICAM_CONTROL = 203
    await sendCommand(203, 0, 0, 0, 0, 1, 0, 0, 'Trigger Camera');
  };

  const doLoiterUnlimited = async () => {
    // MAV_CMD_NAV_LOITER_UNLIM = 17
    await sendCommand(17, 0, 0, 0, 0, 0, 0, 0, 'Loiter Unlimited');
  };

  const doScriptingCmd = async (p1) => {
    // MAV_CMD_DO_SCRIPTING = 42701
    await sendCommand(42701, p1, 0, 0, 0, 0, 0, 0, `Scripting cmd ${p1}`);
  };

  const batteryReset = async () => {
    await sendCommand(2001, 255, 0, 0, 0, 0, 0, 0, 'Battery Reset');
  };

  const missionStart = async () => {
    // MAV_CMD_MISSION_START = 300
    await sendCommand(300, 0, 0, 0, 0, 0, 0, 0, 'Mission Start');
  };

  return (
    <div className="aux-tab">
      {status && (
        <div className="actions-status-banner" style={{ color: statusOk ? '#22c55e' : '#ef4444' }}>
          {status}
        </div>
      )}

      {/* Relay controls */}
      <div className="aux-section">
        <div className="aux-section-title">Relays (MAV_CMD_DO_SET_RELAY)</div>
        <div className="aux-relay-row">
          {[0, 1, 2].map(num => (
            <button
              key={num}
              className={`aux-relay-btn ${relayStates[num] ? 'relay-on' : 'relay-off'}`}
              onClick={() => toggleRelay(num)}
              disabled={busy}
            >
              Relay {num + 1}: {relayStates[num] ? 'ON' : 'OFF'}
            </button>
          ))}
        </div>
      </div>

      {/* Servo output */}
      <div className="aux-section">
        <div className="aux-section-title">Servo Output (MAV_CMD_DO_SET_SERVO)</div>
        <div className="aux-servo-row">
          <label>Channel:</label>
          <input
            type="number" min={1} max={16}
            value={servoChannel}
            onChange={e => setServoChannel(Number(e.target.value))}
            className="aux-input"
            style={{ width: 60 }}
          />
          <label>PWM (µs):</label>
          <input
            type="number" min={700} max={2300} step={10}
            value={servoPwm}
            onChange={e => setServoPwm(Number(e.target.value))}
            className="aux-input"
            style={{ width: 80 }}
          />
          <input
            type="range" min={700} max={2300} step={10}
            value={servoPwm}
            onChange={e => setServoPwm(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <button className="btn-toolbar" onClick={setServo} disabled={busy}>
            Set
          </button>
        </div>
      </div>

      {/* Mission + Camera */}
      <div className="aux-section">
        <div className="aux-section-title">Mission / Camera</div>
        <div className="aux-btn-row">
          <button className="action-btn-v2" style={{ '--ac': '#3b82f6' }} onClick={missionStart} disabled={busy}>
            Mission Start
          </button>
          <button className="action-btn-v2" style={{ '--ac': '#0ea5e9' }} onClick={triggerCamera} disabled={busy}>
            Trigger Camera
          </button>
          <button className="action-btn-v2" style={{ '--ac': '#8b5cf6' }} onClick={doLoiterUnlimited} disabled={busy}>
            Loiter Unlim
          </button>
          <button className="action-btn-v2" style={{ '--ac': '#f59e0b' }} onClick={batteryReset} disabled={busy}>
            Battery Reset
          </button>
        </div>
      </div>

      {/* Scripting */}
      <div className="aux-section">
        <div className="aux-section-title">Scripting (MAV_CMD_DO_SCRIPTING)</div>
        <div className="aux-btn-row">
          <button className="action-btn-v2" style={{ '--ac': '#10b981' }} onClick={() => doScriptingCmd(0)} disabled={busy}>
            Script Stop+Restart
          </button>
          <button className="action-btn-v2" style={{ '--ac': '#ef4444' }} onClick={() => doScriptingCmd(1)} disabled={busy}>
            Script Stop
          </button>
        </div>
      </div>

      {/* RC Channels live display */}
      {vehicleState?.rc_channels?.channels && (
        <div className="aux-section">
          <div className="aux-section-title">RC Channels (live)</div>
          <div className="aux-rc-grid">
            {Object.entries(vehicleState.rc_channels.channels).map(([ch, val]) => (
              <div key={ch} className="aux-rc-cell">
                <div className="aux-rc-label">CH{ch}</div>
                <div className="aux-rc-val">{val}</div>
                <div
                  className="aux-rc-bar"
                  style={{ width: `${Math.max(0, ((Number(val) - 1000) / 1000) * 100)}%` }}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default AuxTab;
