import React, { useState } from 'react';
import axios from 'axios';

const API = 'http://localhost:8080/api';

const ACTIONS = [
  { label: 'ARM',       command: 400, p1: 1, color: '#10b981', description: 'Arm motors' },
  { label: 'DISARM',    command: 400, p1: 0, color: '#ef4444', description: 'Disarm motors' },
  { label: 'TAKEOFF',   command: 22,  p7: 10, color: '#3b82f6', description: 'Auto-takeoff to 10m' },
  { label: 'LAND',      command: 21,  color: '#f59e0b', description: 'Land in place' },
  { label: 'RTL',       command: 20,  color: '#f59e0b', description: 'Return to launch' },
  { label: 'LOITER',    mode: 'LOITER', color: '#8b5cf6', description: 'Hold position' },
  { label: 'AUTO',      mode: 'AUTO',  color: '#8b5cf6', description: 'Run mission' },
  { label: 'GUIDED',    mode: 'GUIDED', color: '#8b5cf6', description: 'Guided mode' },
  { label: 'STABILIZE', mode: 'STABILIZE', color: '#6b7280', description: 'Manual stabilize' },
  { label: 'REBOOT FC', command: 246, p1: 1, color: '#dc2626', description: 'Reboot flight controller' },
];

const ActionsTab = ({ vehicleState }) => {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleAction = async (action) => {
    if (busy) return;
    setBusy(true);
    setStatus(`Sending: ${action.label}...`);
    try {
      if (action.mode) {
        await axios.post(`${API}/mode`, { mode: action.mode });
        setStatus(`✓ Mode set to ${action.mode}`);
      } else {
        const res = await axios.post(`${API}/mavlink/command`, {
          command: action.command,
          p1: action.p1 || 0, p2: 0, p3: 0, p4: 0,
          p5: 0, p6: 0, p7: action.p7 || 0,
        });
        const accepted = res?.data?.accepted;
        if (accepted === false) {
          setStatus(`✗ ${action.label} rejected: ${res?.data?.mav_result_text || 'FAILED'}`);
        } else {
          setStatus(`✓ ${action.label} sent`);
        }
      }
    } catch (err) {
      const d = err?.response?.data;
      const reason =
        (typeof d?.detail === 'string' && d.detail) ||
        d?.error ||
        d?.details?.error ||
        err.message;
      setStatus(`✗ ${action.label} failed: ${reason}`);
    }
    setBusy(false);
  };

  return (
    <div className="actions-tab">
      <div className="actions-grid">
        {ACTIONS.map(action => (
          <button
            key={action.label}
            className="action-btn"
            style={{ '--action-color': action.color }}
            onClick={() => handleAction(action)}
            disabled={busy}
            title={action.description}
          >
            {action.label}
          </button>
        ))}
      </div>
      {status && (
        <div className={`action-status ${status.startsWith('✗') ? 'error' : 'success'}`}>
          {status}
        </div>
      )}
    </div>
  );
};

export default ActionsTab;
