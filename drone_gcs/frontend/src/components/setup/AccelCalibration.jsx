import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';

const API = 'http://localhost:8080/api';

// ArduPilot ACCELCAL_VEHICLE_POS enum values (param1 in MAV_CMD_ACCELCAL_VEHICLE_POS)
const POSITIONS = [
  { pos: 1, label: 'Level',       icon: '✈',  desc: 'Place vehicle flat and level on a surface.' },
  { pos: 2, label: 'Left Side',   icon: '◁',  desc: 'Place vehicle on its LEFT side.' },
  { pos: 3, label: 'Right Side',  icon: '▷',  desc: 'Place vehicle on its RIGHT side.' },
  { pos: 4, label: 'Nose Down',   icon: '▽',  desc: 'Place vehicle nose DOWN (forward end pointing down).' },
  { pos: 5, label: 'Nose Up',     icon: '△',  desc: 'Place vehicle nose UP (forward end pointing up).' },
  { pos: 6, label: 'Upside Down', icon: '▼',  desc: 'Place vehicle UPSIDE DOWN (belly up).' },
];

export default function AccelCalibration({ armed }) {
  const [phase, setPhase] = useState('idle'); // idle | running | done | failed
  const [requestedPos, setRequestedPos] = useState(0); // FC-requested position (1-6), 0=none
  const [completedPositions, setCompletedPositions] = useState([]);
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('');
  const [confirming, setConfirming] = useState(false);
  const pollRef = useRef(null);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const pollStatus = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/calibration/status`);
      const msgs = r.data?.messages || [];
      const pos = r.data?.accel_requested_pos ?? 0;

      if (msgs.length) setMessages(msgs.slice(-8));

      // Update which position FC is currently requesting
      if (pos > 0 && pos !== requestedPos) {
        setRequestedPos(pos);
        const posInfo = POSITIONS.find(p => p.pos === pos);
        setStatus(`Place vehicle: ${posInfo?.label || pos}. Then click Confirm.`);
      }

      const latest = (msgs[msgs.length - 1]?.text || '').toLowerCase();
      if (latest.includes('calibration successful') || latest.includes('cal successful')) {
        setPhase('done');
        setCompletedPositions(POSITIONS.map(p => p.pos));
        setStatus('Accelerometer calibration completed successfully!');
        stopPoll();
      } else if (latest.includes('calibration failed') || latest.includes('cal failed')) {
        setPhase('failed');
        setStatus('Calibration failed. Check vehicle is stable during each step.');
        stopPoll();
      }
    } catch { /* ignore poll errors */ }
  }, [requestedPos]);

  useEffect(() => () => stopPoll(), []);

  const startCal = async () => {
    if (armed) { setStatus('Disarm vehicle before calibration.'); return; }
    setPhase('running');
    setRequestedPos(0);
    setCompletedPositions([]);
    setMessages([]);
    setStatus('Starting accelerometer calibration…');
    try {
      await axios.post(`${API}/calibration/run`, { kind: 'accelerometer' });
      setStatus('Waiting for vehicle to request first position…');
      stopPoll();
      pollRef.current = setInterval(pollStatus, 1000);
    } catch (e) {
      const d = e.response?.data;
      setStatus(`Failed to start: ${d?.detail || d?.error || e.message}`);
      setPhase('failed');
    }
  };

  const confirmPosition = async () => {
    if (!requestedPos) return;
    setConfirming(true);
    try {
      // Send MAV_CMD_ACCELCAL_VEHICLE_POS (42429) with param1 = current requested position
      await axios.post(`${API}/calibration/accel_confirm`, { position: requestedPos });
      setCompletedPositions(prev => [...new Set([...prev, requestedPos])]);
      setStatus(`Position ${requestedPos} confirmed. Waiting for next position…`);
      setRequestedPos(0);
    } catch (e) {
      setStatus(`Confirm error: ${e.message}`);
    } finally {
      setConfirming(false);
    }
  };

  const reset = () => {
    stopPoll();
    setPhase('idle');
    setRequestedPos(0);
    setCompletedPositions([]);
    setMessages([]);
    setStatus('');
  };

  return (
    <div>
      {armed && (
        <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid #ef4444', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: '#fca5a5' }}>
          Vehicle is ARMED — disarm before accelerometer calibration.
        </div>
      )}

      {/* 6-position visual guide */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 14 }}>
        {POSITIONS.map(pos => {
          const done = completedPositions.includes(pos.pos);
          const active = phase === 'running' && requestedPos === pos.pos;
          return (
            <div key={pos.pos} style={{
              border: `2px solid ${done ? '#10b981' : active ? '#f59e0b' : 'var(--border-color)'}`,
              borderRadius: 8, padding: '10px 8px', textAlign: 'center',
              background: done ? 'rgba(16,185,129,0.08)' : active ? 'rgba(245,158,11,0.08)' : 'transparent',
              transition: 'all 0.3s',
            }}>
              <div style={{ fontSize: 28, marginBottom: 4 }}>{pos.icon}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: done ? '#34d399' : active ? '#fbbf24' : 'var(--text-primary)' }}>
                {done ? '✓ ' : active ? '→ ' : `${pos.pos}. `}{pos.label}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 3 }}>{pos.desc}</div>
            </div>
          );
        })}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {phase === 'idle' && (
          <button className="btn-toolbar primary" onClick={startCal} disabled={armed}>
            Start Accel Calibration
          </button>
        )}
        {phase === 'running' && (
          <>
            <button
              className="btn-toolbar primary"
              onClick={confirmPosition}
              disabled={!requestedPos || confirming}
            >
              {confirming ? 'Confirming…' : requestedPos
                ? `✓ Confirm: ${POSITIONS.find(p => p.pos === requestedPos)?.label}`
                : 'Waiting for vehicle…'}
            </button>
            <button className="btn-toolbar" onClick={reset}>Cancel</button>
          </>
        )}
        {(phase === 'done' || phase === 'failed') && (
          <button className="btn-toolbar" onClick={reset}>
            {phase === 'done' ? 'Done' : 'Try Again'}
          </button>
        )}
      </div>

      {/* Vehicle STATUSTEXT messages */}
      {messages.length > 0 && (
        <div style={{ marginBottom: 10, maxHeight: 120, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace', background: 'rgba(0,0,0,0.3)', borderRadius: 6, padding: '8px 10px' }}>
          {messages.map((m, i) => (
            <div key={i} style={{ color: i === messages.length - 1 ? '#fbbf24' : 'var(--text-secondary)', padding: '1px 0' }}>
              {m.text}
            </div>
          ))}
        </div>
      )}

      {status && (
        <div style={{ fontSize: 12, color: phase === 'done' ? '#34d399' : phase === 'failed' ? '#fca5a5' : 'var(--text-secondary)' }}>
          {status}
        </div>
      )}
    </div>
  );
}
