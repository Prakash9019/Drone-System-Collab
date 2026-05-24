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

// ArduPilot MAV_CMD ids commonly used in copter missions.
const CMD_NAME = {
  16: 'WAYPOINT',
  17: 'LOITER (UNLIM)',
  18: 'LOITER (TURNS)',
  19: 'LOITER (TIME)',
  20: 'RTL',
  21: 'LAND',
  22: 'TAKEOFF',
  82: 'SPLINE WP',
  93: 'DELAY',
  112: 'DO_DELAY',
  115: 'DO_CHANGE_SPEED',
  177: 'DO_JUMP',
  189: 'DO_LAND_START',
  201: 'DO_SET_ROI',
};

export default function MissionExecutionPanel({
  operational,
  operationalHistory,
  commandStatus,
  commandHistory,
  missionSeq,
  missionTotal,
  plannedWaypoints,
  vehicleAltRel,
  vehicleGroundSpeed,
  vehicleWpDist,
  missionSyncStatus,
}) {
  const rows = [...(commandHistory || [])].reverse().slice(0, 12);
  const phases = [...(operationalHistory || [])].reverse().slice(0, 10);
  const activeCmd = Object.entries(commandStatus || {}).find(([, v]) => v?.state === 'pending');

  // Map the live SEQ to a command name. ArduPilot mission has HOME at seq=0 (auto-injected during
  // upload), so the user's planner indices shift by +1: planner[0] → drone seq 1.
  const activeSeq = Number(missionSeq);
  const planner = Array.isArray(plannedWaypoints) ? plannedWaypoints : [];
  const activeCmdId = activeSeq === 0 ? -1 : (planner[activeSeq - 1]?.command);
  const activeLabel = activeSeq < 0
    ? '—'
    : activeSeq === 0
      ? 'HOME (auto)'
      : (CMD_NAME[Number(activeCmdId)] || (activeCmdId != null ? `CMD ${activeCmdId}` : 'WP'));

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
      <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>
        WP Progress: <strong style={{ color: '#e2e8f0' }}>{activeSeq >= 0 ? activeSeq : '—'}</strong> / {Math.max(missionTotal - 1, 0)}
        {' '}<span style={{ color: '#60a5fa' }}>· {activeLabel}</span>
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 6, color: '#cbd5e1', fontSize: 11 }}>
        <span>ALT {Number.isFinite(Number(vehicleAltRel)) ? Number(vehicleAltRel).toFixed(1) : '—'} m</span>
        <span>GS  {Number.isFinite(Number(vehicleGroundSpeed)) ? Number(vehicleGroundSpeed).toFixed(1) : '—'} m/s</span>
        <span>→WP {Number.isFinite(Number(vehicleWpDist)) && Number(vehicleWpDist) >= 0 ? `${Number(vehicleWpDist).toFixed(0)} m` : '—'}</span>
      </div>
      {activeSeq === 0 && (
        <div style={{ color: '#fbbf24', fontSize: 11, marginBottom: 6 }}>
          Drone is at HOME (auto-injected seq 0). It will advance to your TAKEOFF immediately.
        </div>
      )}
      {missionSyncStatus?.ok === false && missionSyncStatus?.phase === 'FAILED' && (
        <div style={{
          color: '#fecaca', background: '#7f1d1d', padding: '4px 6px', borderRadius: 4,
          fontSize: 11, marginBottom: 6,
        }}>
          Mission {missionSyncStatus.direction || 'transfer'} FAILED — {missionSyncStatus.error || 'unknown'}
          {' '}({missionSyncStatus.current ?? 0}/{missionSyncStatus.total ?? 0}, retries {missionSyncStatus.retries ?? 0})
        </div>
      )}
      {missionSyncStatus?.phase && missionSyncStatus.phase !== 'IDLE' && missionSyncStatus.phase !== 'DONE' && missionSyncStatus.phase !== 'FAILED' && (
        <div style={{ color: '#93c5fd', fontSize: 11, marginBottom: 6 }}>
          {missionSyncStatus.direction || 'transfer'} · {missionSyncStatus.phase} · {missionSyncStatus.current ?? 0}/{missionSyncStatus.total ?? 0}
        </div>
      )}
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

