import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import useTelemetryStore from '../store/useTelemetryStore';

const API = 'http://localhost:8080/api';

const Help = () => {
  const adsbTracks = useTelemetryStore((s) => s.adsbTracks);
  const [inspector, setInspector] = useState({ counts: [] });
  const [query, setQuery] = useState('');
  const [logResult, setLogResult] = useState(null);
  const [logBusy, setLogBusy] = useState(false);
  const [logErr, setLogErr] = useState('');

  useEffect(() => {
    const run = () => axios.get(`${API}/mavlink/inspector`).then((r) => setInspector(r.data)).catch(() => {});
    run();
    const t = setInterval(run, 1500);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const src = inspector?.counts || [];
    if (!q) return src;
    return src.filter((r) => String(r.message).toLowerCase().includes(q));
  }, [inspector, query]);

  const logBarRows = useMemo(() => {
    const src = logResult?.message_counts || [];
    const top = [...src].sort((a, b) => b.count - a.count).slice(0, 14);
    const max = Math.max(...top.map((r) => r.count), 1);
    return top.map((r) => ({ ...r, pct: (r.count / max) * 100 }));
  }, [logResult]);

  const onLogFile = async (evt) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    setLogBusy(true);
    setLogErr('');
    setLogResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await axios.post(`${API}/logs/analyze`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setLogResult(r.data);
    } catch (e) {
      setLogErr(e.response?.data?.details || e.response?.data?.error || e.message || 'Analyze failed');
    } finally {
      setLogBusy(false);
      evt.target.value = '';
    }
  };

  return (
    <div className="flight-planner" style={{ padding: 20 }}>
      <h2 style={{ marginBottom: 10 }}>Help & Diagnostics</h2>
      <div style={{ marginBottom: 14, color: 'var(--text-secondary)', fontSize: 13 }}>
        Live MAVLink inspector (message frequency/counts), plus quick links.
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <a className="btn-toolbar" href="https://ardupilot.org/" target="_blank" rel="noreferrer">ArduPilot Docs</a>
        <a className="btn-toolbar" href="https://mavlink.io/en/messages/common.html" target="_blank" rel="noreferrer">MAVLink Messages</a>
      </div>

      <div style={{ marginBottom: 20, padding: 12, border: '1px solid var(--border-color)', borderRadius: 6 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Log analyzer</h3>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          Upload a Mission Planner <code>.tlog</code> or ArduPilot dataflash <code>.bin</code>. Summary runs locally in the Python service (sampled scan).
        </div>
        <label className="btn-toolbar" style={{ cursor: logBusy ? 'wait' : 'pointer' }}>
          {logBusy ? 'Analyzing…' : 'Choose log file…'}
          <input type="file" accept=".tlog,.log,.bin,.BIN" style={{ display: 'none' }} disabled={logBusy} onChange={onLogFile} />
        </label>
        {logErr && <div style={{ marginTop: 8, color: '#f87171', fontSize: 12 }}>{logErr}</div>}
        {logResult && (logResult.csv || (logResult.message_counts && logResult.message_counts.length)) && (
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn-toolbar"
              onClick={() => {
                let csv = logResult.csv;
                if (!csv && logResult.message_counts) {
                  const lines = ['message,count'];
                  for (const r of logResult.message_counts) {
                    const msg = String(r.message || '').replace(/"/g, '""');
                    lines.push(`"${msg}",${Number(r.count) || 0}`);
                  }
                  csv = `${lines.join('\n')}\n`;
                }
                const blob = new Blob([csv || ''], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `log-summary-${Date.now()}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download CSV (message counts)
            </button>
          </div>
        )}
        {logResult && (
          <div style={{ marginTop: 12, fontSize: 12 }}>
            <div style={{ marginBottom: 6, fontFamily: 'monospace' }}>
              Format: {logResult.format} · Samples: {logResult.samples_read} · Types: {logResult.unique_types}
              {logResult.duration_s != null && ` · Duration: ${Number(logResult.duration_s).toFixed(1)}s`}
            </div>
            {logResult.error && <div style={{ color: '#fbbf24' }}>{logResult.error}</div>}
            {logBarRows.length > 0 && (
              <div style={{ marginTop: 12, marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  Top messages (relative)
                </div>
                {logBarRows.map((r) => (
                  <div key={r.message} style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
                      <span style={{ paddingRight: 8 }}>{r.message}</span>
                      <span style={{ fontFamily: 'monospace' }}>{r.count}</span>
                    </div>
                    <div style={{ height: 6, background: '#334155', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${r.pct}%`, height: '100%', background: '#38bdf8', borderRadius: 3 }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 4 }}>
              <table className="waypoint-table">
                <thead>
                  <tr><th>Message</th><th>Count</th></tr>
                </thead>
                <tbody>
                  {(logResult.message_counts || []).map((r) => (
                    <tr key={r.message}><td>{r.message}</td><td>{r.count}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginBottom: 20, padding: 12, border: '1px solid var(--border-color)', borderRadius: 6 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>ADS-B traffic (Phase C)</h3>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          Tracks from MAVLink <code>ADSB_VEHICLE</code> on the active link (1 Hz updates). Same targets appear on the Flight Data map.
        </div>
        <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 4 }}>
          <table className="waypoint-table">
            <thead>
              <tr>
                <th>ICAO</th>
                <th>Callsign</th>
                <th>Alt (m)</th>
                <th>Hdg</th>
              </tr>
            </thead>
            <tbody>
              {(adsbTracks || []).length === 0 ? (
                <tr><td colSpan="4" style={{ textAlign: 'center', padding: 10 }}>No ADS-B tracks yet.</td></tr>
              ) : (
                adsbTracks.map((t) => (
                  <tr key={t.icao}>
                    <td style={{ fontFamily: 'monospace' }}>{t.icao}</td>
                    <td>{t.callsign || '—'}</td>
                    <td>{t.alt_m != null ? Math.round(t.alt_m) : '—'}</td>
                    <td>{t.heading != null ? Math.round(t.heading) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <input
        className="status-search"
        placeholder="Filter MAVLink message name..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 10, width: 340 }}
      />
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
        Message types: {inspector?.total_types || 0}
      </div>
      <div style={{ maxHeight: '70vh', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 6 }}>
        <table className="waypoint-table">
          <thead>
            <tr>
              <th>Message</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan="2" style={{ textAlign: 'center', padding: 12 }}>No messages yet.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.message}>
                <td>{r.message}</td>
                <td>{r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Help;

