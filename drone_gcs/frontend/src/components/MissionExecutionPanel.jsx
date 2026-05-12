import React from 'react';

const fmtTime = (ts) => {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '--';
  }
};

const Badge = ({ text, color = '#64748b' }) => (
  <span
    style={{
      fontSize: 10,
      padding: '2px 6px',
      borderRadius: 999,
      background: color,
      color: '#f8fafc',
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      fontWeight: 600,
    }}
  >
    {text}
  </span>
);

export default function MissionExecutionPanel({
  operational,
  operationalHistory,
  commandStatus,
  commandHistory,
  missionSeq,
  missionTotal,
}) {
  const rows = [...(commandHistory || [])].reverse().slice(0, 12);
  const phases = [...(operationalHistory || [])].reverse().slice(0, 10);
  const activeCmd = Object.entries(commandStatus || {}).find(([, v]) => v?.state === 'pending');

  return (
    <div
      style={{
        borderTop: '1px solid var(--border-color)',
        marginTop: 8,
        paddingTop: 8,
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <strong style={{ fontSize: 12 }}>Mission Execution</strong>
        <Badge
          text={operational?.phase || 'UNKNOWN'}
          color={operational?.tone === 'danger' ? '#dc2626' : operational?.tone === 'warn' ? '#d97706' : '#0f766e'}
        />
      </div>
      <div style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>
        WP Progress: {missionSeq >= 0 ? missionSeq : '—'} / {Math.max(missionTotal - 1, 0)}
      </div>
      {activeCmd && (
        <div style={{ color: '#fbbf24', marginBottom: 6 }}>
          Pending command: <code>{activeCmd[0]}</code>
        </div>
      )}

      <div style={{ marginBottom: 6, color: 'var(--text-secondary)' }}>Command / ACK log</div>
      <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 6, marginBottom: 8 }}>
        <table className="waypoint-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Command</th>
              <th>State</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan="4" style={{ textAlign: 'center', padding: 8 }}>No command events yet.</td></tr>
            ) : rows.map((r, idx) => (
              <tr key={`${r.command}-${r.at}-${idx}`}>
                <td style={{ fontFamily: 'monospace' }}>{fmtTime(r.at)}</td>
                <td>{r.command}</td>
                <td>{r.state}</td>
                <td style={{ maxWidth: 220 }}>
                  {r.error
                    ? String(r.error)
                    : r.response?.mav_result_text
                      ? `${String(r.response.mav_result_text)}${r.response?.mav_result != null ? ` (${r.response.mav_result})` : ''}`
                      : r.response?.status
                        ? String(r.response.status)
                        : r.request
                          ? 'sent'
                          : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginBottom: 6, color: 'var(--text-secondary)' }}>Phase transitions</div>
      <div style={{ maxHeight: 110, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 6 }}>
        <table className="waypoint-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>From</th>
              <th>To</th>
            </tr>
          </thead>
          <tbody>
            {phases.length === 0 ? (
              <tr><td colSpan="3" style={{ textAlign: 'center', padding: 8 }}>No transitions recorded yet.</td></tr>
            ) : phases.map((p, idx) => (
              <tr key={`${p.at}-${idx}`}>
                <td style={{ fontFamily: 'monospace' }}>{fmtTime(p.at)}</td>
                <td>{p.from || '—'}</td>
                <td>{p.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

