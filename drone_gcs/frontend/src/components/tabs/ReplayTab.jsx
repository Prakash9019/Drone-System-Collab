import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import useTelemetryStore from '../../store/useTelemetryStore';

const API = 'http://localhost:8080/api';

// Telemetry replay UI. Talks only to the Node API gateway; never to the Python service directly.
// State (is_recording / is_playing / progress_s / duration_s) is broadcast through the live
// telemetry WebSocket as `REPLAY_STATUS` and lands in store.replayStatus.
const ReplayTab = () => {
  const replayStatus = useTelemetryStore((s) => s.replayStatus);
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refreshSessions = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/replay/sessions`);
      const list = Array.isArray(r.data?.sessions) ? r.data.sessions
                 : Array.isArray(r.data) ? r.data
                 : [];
      setSessions(list);
      if (!selected && list.length > 0) setSelected(list[0].session_id);
    } catch (err) {
      setMsg(`Failed to list sessions: ${err.message}`);
    }
  }, [selected]);

  useEffect(() => {
    refreshSessions();
    const t = setInterval(refreshSessions, 5000);
    return () => clearInterval(t);
  }, [refreshSessions]);

  const call = async (path, body) => {
    setBusy(true);
    setMsg('');
    try {
      const r = body
        ? await axios.post(`${API}${path}`, body)
        : await axios.post(`${API}${path}`);
      setMsg(`${path}: OK`);
      return r.data;
    } catch (err) {
      const d = err.response?.data;
      setMsg(d?.error || d?.details || err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleRecording = async () => {
    if (replayStatus.is_recording) {
      await call('/replay/record/stop');
    } else {
      await call('/replay/record/start');
    }
    refreshSessions();
  };

  const onSeek = (e) => {
    const t = Number(e.target.value);
    if (!Number.isFinite(t)) return;
    call('/replay/playback/seek', { time_s: t });
  };

  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
  };

  const fmtSize = (b) => {
    if (!Number.isFinite(b)) return '—';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  };

  const progressPct = replayStatus.duration_s > 0
    ? Math.min(100, Math.max(0, (replayStatus.progress_s / replayStatus.duration_s) * 100))
    : 0;

  return (
    <div style={{ padding: 12, color: 'var(--text-primary, #e2e8f0)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Telemetry Replay</h3>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          {replayStatus.is_recording ? 'REC' : replayStatus.is_playing ? (replayStatus.is_paused ? 'PAUSED' : 'PLAYING') : 'IDLE'}
        </span>
      </div>

      {/* Recording */}
      <div style={{ border: '1px solid #334155', borderRadius: 6, padding: 10, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <button
            type="button"
            onClick={toggleRecording}
            disabled={busy}
            style={{
              padding: '6px 14px',
              background: replayStatus.is_recording ? '#dc2626' : '#16a34a',
              border: 0,
              color: '#fff',
              borderRadius: 4,
              fontWeight: 700,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {replayStatus.is_recording ? '■ Stop Recording' : '● Start Recording'}
          </button>
          {replayStatus.is_recording && replayStatus.recording_session_id && (
            <code style={{ fontSize: 11, color: '#94a3b8' }} title={replayStatus.recording_session_id}>
              {String(replayStatus.recording_session_id).slice(0, 8)}…
            </code>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#64748b' }}>
          Records all live telemetry to <code>recordings/&lt;session&gt;.jsonl</code>. Stops automatically on disconnect.
        </div>
      </div>

      {/* Playback */}
      <div style={{ border: '1px solid #334155', borderRadius: 6, padding: 10 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy || sessions.length === 0}
            style={{
              flex: 1,
              minWidth: 180,
              height: 28,
              background: '#0f172a',
              color: '#e2e8f0',
              border: '1px solid #334155',
              borderRadius: 4,
              padding: '0 6px',
              fontSize: 12,
            }}
          >
            {sessions.length === 0 && <option value="">No recordings</option>}
            {sessions.map((s) => (
              <option key={s.session_id} value={s.session_id}>
                {String(s.session_id).slice(0, 8)}… · {fmtSize(s.size_bytes)}
              </option>
            ))}
          </select>
          <button type="button" onClick={refreshSessions} disabled={busy}
            style={{ padding: '4px 10px', background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, fontSize: 11 }}>
            Refresh
          </button>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => call('/replay/playback/start', { session_id: selected })}
            disabled={busy || !selected || replayStatus.is_playing}
            style={{ padding: '5px 12px', background: '#2563eb', color: '#fff', border: 0, borderRadius: 4, fontSize: 12, cursor: 'pointer' }}
          >
            ▶ Play
          </button>
          <button
            type="button"
            onClick={() => call('/replay/playback/pause')}
            disabled={busy || !replayStatus.is_playing || replayStatus.is_paused}
            style={{ padding: '5px 12px', background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, fontSize: 12 }}
          >
            ❚❚ Pause
          </button>
          <button
            type="button"
            onClick={() => call('/replay/playback/resume')}
            disabled={busy || !replayStatus.is_paused}
            style={{ padding: '5px 12px', background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4, fontSize: 12 }}
          >
            ▶ Resume
          </button>
          <button
            type="button"
            onClick={() => call('/replay/playback/stop')}
            disabled={busy || !replayStatus.is_playing}
            style={{ padding: '5px 12px', background: '#7c2d12', color: '#fff', border: 0, borderRadius: 4, fontSize: 12, cursor: 'pointer' }}
          >
            ■ Stop
          </button>
        </div>

        {/* Progress + scrub */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#94a3b8', minWidth: 42 }}>
            {fmt(replayStatus.progress_s)}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(1, replayStatus.duration_s || 0)}
            step={0.1}
            value={replayStatus.progress_s || 0}
            onChange={onSeek}
            disabled={!replayStatus.is_playing || busy}
            style={{ flex: 1 }}
          />
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#94a3b8', minWidth: 42 }}>
            {fmt(replayStatus.duration_s)}
          </span>
        </div>
        <div style={{ marginTop: 6, height: 4, background: '#1e293b', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${progressPct}%`, height: '100%', background: '#2563eb' }} />
        </div>
      </div>

      {msg && (
        <div style={{
          marginTop: 10,
          padding: '6px 10px',
          background: msg.toLowerCase().includes('fail') ? '#3f1010' : '#0f172a',
          color: msg.toLowerCase().includes('fail') ? '#fca5a5' : '#cbd5e1',
          fontSize: 11,
          borderRadius: 4,
        }}>
          {msg}
        </div>
      )}
    </div>
  );
};

export default ReplayTab;
