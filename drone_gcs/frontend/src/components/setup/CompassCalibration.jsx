import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
/* eslint-disable no-unused-vars */

const API = 'http://localhost:8080/api';

// MAG_CAL status codes
const CAL_STATUS = {
  0: { label: 'Not Started', color: '#6b7280' },
  1: { label: 'Waiting', color: '#f59e0b' },
  2: { label: 'Running (Step 1)', color: '#3b82f6' },
  3: { label: 'Running (Step 2)', color: '#8b5cf6' },
  4: { label: 'Success', color: '#10b981' },
  5: { label: 'Failed', color: '#ef4444' },
  6: { label: 'Bad Radius', color: '#ef4444' },
  7: { label: 'Waiting for GPS', color: '#f59e0b' },
};

function CompassProgress({ id, data }) {
  const s = CAL_STATUS[data?.cal_status ?? 0] || CAL_STATUS[0];
  const pct = data?.pct ?? 0;
  const fitness = data?.fitness;
  const type = data?.type;

  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '12px 14px', marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>Compass {Number(id) + 1}</span>
        <span style={{ fontSize: 12, color: s.color, fontWeight: 600 }}>{s.label}</span>
      </div>
      {type === 'progress' && (
        <>
          <div style={{ height: 8, background: 'rgba(255,255,255,0.06)', borderRadius: 4, marginBottom: 6, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: '#3b82f6', borderRadius: 4, transition: 'width 0.5s' }} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{pct.toFixed(0)}% complete</div>
        </>
      )}
      {type === 'report' && (
        <div style={{ fontSize: 12, color: s.color }}>
          Fitness: {fitness?.toFixed(3) ?? '—'}
          {data?.ofs_x != null && (
            <span style={{ marginLeft: 12, color: 'var(--text-secondary)' }}>
              Offsets: [{data.ofs_x.toFixed(1)}, {data.ofs_y.toFixed(1)}, {data.ofs_z.toFixed(1)}]
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function CompassCalibration({ armed }) {
  const [phase, setPhase] = useState('idle');
  const [compassData, setCompassData] = useState({});
  const [messages, setMessages] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState('');
  const pollRef = useRef(null);
  const timerRef = useRef(null);
  const startTimeRef = useRef(0);

  const stopAll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  useEffect(() => () => stopAll(), []);

  const pollStatus = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/calibration/status`);
      const msgs = r.data?.messages || [];
      const progress = r.data?.compass_progress || {};

      setCompassData(progress);
      if (msgs.length) setMessages(msgs.slice(-8));

      // Check for completion from STATUSTEXT
      const latestText = (msgs[msgs.length - 1]?.text || '').toLowerCase();
      // Completion: all compasses autosaved (p3=1 was set in DO_START_MAG_CAL)
      const compassCount = Object.keys(progress).length;
      const allAutosaved = compassCount > 0 && Object.values(progress).every(
        d => d.cal_status === 4 && d.type === 'report' && d.autosaved === 1
      );
      // Fallback: all report cal_status=4 even if autosaved field missing
      const allSucceeded = compassCount > 0 && Object.values(progress).every(
        d => d.cal_status === 4 && d.type === 'report'
      );
      const anyFailed = Object.values(progress).some(d => d.cal_status === 5 || d.cal_status === 6);

      if ((allAutosaved || allSucceeded) && compassCount > 0) {
        setPhase('done');
        setStatus('Compass calibration complete! Parameters saved. Please reboot the autopilot for changes to take effect.');
        stopAll();
      } else if (anyFailed || latestText.includes('calibration failed')) {
        setPhase('failed');
        setStatus('Calibration failed. Ensure no magnetic interference. Try again further from electronics.');
        stopAll();
      } else if (latestText.includes('compass calibration successful') || latestText.includes('cal successful')) {
        setPhase('done');
        setStatus('Compass calibration successful!');
        stopAll();
      }
    } catch { /* ignore */ }
  }, []);

  const startCal = async () => {
    if (armed) { setStatus('Disarm before compass calibration.'); return; }
    setPhase('running');
    setCompassData({});
    setMessages([]);
    setElapsed(0);
    startTimeRef.current = Date.now();
    setStatus('Compass calibration started. Rotate vehicle slowly in all directions — pitch, roll, and yaw — covering all axes.');
    try {
      await axios.post(`${API}/calibration/run`, { kind: 'compass' });
      stopAll();
      pollRef.current = setInterval(pollStatus, 1500);
      timerRef.current = setInterval(() => {
        setElapsed(Math.round((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    } catch (e) {
      const d = e.response?.data;
      setStatus(`Failed to start: ${d?.detail || d?.error || e.message}`);
      setPhase('failed');
    }
  };

  const cancelCal = async () => {
    stopAll();
    setPhase('idle');
    setStatus('Calibration cancelled.');
    try {
      // Send DO_CANCEL_MAG_CAL (42426) so the FC stops the calibration routine
      await axios.post(`${API}/calibration/compass_cancel`);
    } catch { /* ignore — UI state already reset */ }
  };

  const hasProgress = Object.keys(compassData).length > 0;

  return (
    <div>
      {armed && (
        <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid #ef4444', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: '#fca5a5' }}>
          Vehicle is ARMED — disarm before compass calibration.
        </div>
      )}

      {/* Rotation guide */}
      {phase === 'running' && (
        <div style={{ marginBottom: 14, padding: '12px 14px', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Rotation Instructions:</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            1. Hold drone in front of you facing forward<br />
            2. Rotate 360° clockwise (nose traces a circle)<br />
            3. Tilt nose up, rotate 360° again<br />
            4. Tilt nose down, rotate 360° again<br />
            5. Roll left 90°, rotate 360° again<br />
            6. Roll right 90°, rotate 360° again<br />
            Continue until all compasses show 100% or Success.
          </div>
          <div style={{ marginTop: 8, fontSize: 13, color: '#60a5fa', fontWeight: 600 }}>
            Elapsed: {elapsed}s
          </div>
        </div>
      )}

      {/* Compass progress bars */}
      {hasProgress && Object.entries(compassData).map(([id, data]) => (
        <CompassProgress key={id} id={id} data={data} />
      ))}

      {!hasProgress && phase === 'running' && (
        <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
          Waiting for MAG_CAL_PROGRESS messages from vehicle… ({elapsed}s)
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {phase === 'idle' && (
          <button className="btn-toolbar primary" onClick={startCal} disabled={armed}>
            Start Compass Calibration
          </button>
        )}
        {phase === 'running' && (
          <button className="btn-toolbar danger" onClick={cancelCal}>Cancel</button>
        )}
        {(phase === 'done' || phase === 'failed') && (
          <button className="btn-toolbar" onClick={() => { setPhase('idle'); setStatus(''); setCompassData({}); }}>
            {phase === 'done' ? 'Done' : 'Try Again'}
          </button>
        )}
      </div>

      {/* Reboot prompt — ArduPilot applies new compass offsets only after reboot */}
      {phase === 'done' && (
        <div style={{ marginBottom: 12, padding: '10px 14px', background: 'rgba(245,158,11,0.1)', border: '1px solid #f59e0b', borderRadius: 8, fontSize: 12, color: '#fbbf24' }}>
          <strong>Reboot Required:</strong> Please reboot the autopilot for new compass offsets to take effect.
          <button
            className="btn-toolbar"
            style={{ marginLeft: 12, padding: '2px 10px', fontSize: 11 }}
            onClick={async () => {
              try { await axios.post(`${API}/calibration/run`, { kind: 'reboot' }); }
              catch { /* ignore */ }
            }}
          >
            Reboot FC
          </button>
        </div>
      )}

      {/* STATUSTEXT from vehicle */}
      {messages.length > 0 && (
        <div style={{ maxHeight: 100, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace', background: 'rgba(0,0,0,0.3)', borderRadius: 6, padding: '6px 10px', marginBottom: 10 }}>
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
