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
  vehicleMode,
  vehicleArmed,
  statusMessages,
  fenceBreachText,
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

  // ─── Mission Complete detection ──────────────────────────────────────────────
  // When a NAV_RTL (cmd 20) or NAV_LAND (cmd 21) is reached in AUTO, ArduPilot
  // switches the flight mode to RTL / LAND. This is the *correct* end-of-mission
  // behaviour — but to a user watching the mode bar flip from AUTO to RTL it
  // looks identical to a failsafe. We detect this case here and surface a clear
  // "Mission complete" badge so the operator stops chasing a non-bug.
  //
  // Detection: the vehicle's current flight mode is RTL or LAND, the autopilot's
  // current mission seq points at a NAV_RTL or NAV_LAND item in the uploaded
  // plan, and that item is the last user waypoint. We treat any of those three
  // as enough for a soft "mission completing" state and require all three for
  // the firm "completed" state.
  const modeUpper = String(vehicleMode || '').toUpperCase();
  const inRtl = modeUpper === 'RTL' || modeUpper === 'SMARTRTL' || modeUpper === 'SMART RTL';
  const inLand = modeUpper === 'LAND';
  const inBrake = modeUpper === 'BRAKE';
  const activeCmdNum = Number(activeCmdId);
  const lastUserIdx = planner.length - 1;
  const lastUserCmd = lastUserIdx >= 0 ? Number(planner[lastUserIdx]?.command) : NaN;
  const reachingMissionEnd =
    (inRtl || inLand) &&
    (activeCmdNum === 20 || activeCmdNum === 21);
  const missionCompletedByPlan =
    (inRtl || inLand) &&
    (activeSeq - 1 === lastUserIdx) &&
    (lastUserCmd === 20 || lastUserCmd === 21);

  // ─── Holding (armed + AUTO, not yet started) ─────────────────────────────────
  // On AUTO entry ArduCopter advances MISSION_CURRENT to seq 1 (the TAKEOFF)
  // before the mission actually runs — identical to Mission Planner. While the
  // vehicle is armed, in AUTO, and still on the ground, "WP 1/N" is the
  // autopilot's cursor, NOT mission progress. Flag it so the operator doesn't
  // think the mission auto-started.
  const altRelNum = Number(vehicleAltRel);
  const airborne = Number.isFinite(altRelNum) && altRelNum > 0.8;
  const holding =
    Boolean(vehicleArmed) &&
    modeUpper === 'AUTO' &&
    !airborne &&
    activeSeq >= 1 &&
    !missionCompletedByPlan;

  // ─── Unplanned return detection (fence breach / failsafe) ────────────────────
  // When the autopilot drops out of AUTO into RTL/LAND/BRAKE *before* the planned
  // final RTL/LAND item, the mission did not finish — something forced it. The
  // most common (and most-missed) cause is a polygon/circle fence breach, which
  // ArduPilot reports at NOTICE severity so it never reaches the generic toast.
  // Surface the autopilot's own reason here, persistently, instead of hiding it
  // in the Messages tab.
  const unplannedReturn =
    Boolean(vehicleArmed) &&
    (inRtl || inLand || inBrake) &&
    !missionCompletedByPlan &&
    !reachingMissionEnd;
  // Most recent fence/failsafe STATUSTEXT, if any.
  const failsafeReason = (() => {
    if (Array.isArray(statusMessages) && statusMessages.length) {
      const hits = statusMessages.filter((m) => {
        const t = String(m?.text || '').toLowerCase();
        return t.includes('fence') || t.includes('breach') || t.includes('failsafe');
      });
      if (hits.length) {
        const latest = hits.reduce((a, b) => ((b?.timestamp ?? 0) > (a?.timestamp ?? 0) ? b : a));
        return latest.text;
      }
    }
    return fenceBreachText || '';
  })();

  return (
    <div
      style={{
        borderTop: '1px solid var(--border-color)',
        marginTop: 8,
        paddingTop: 8,
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 6 }}>
        <strong style={{ fontSize: 12 }}>Mission Execution</strong>
        <div style={{ display: 'flex', gap: 6 }}>
          {/* Override the warning/danger colour when the mode flip is the user's
              own planned RTL/LAND. Without this, ArduPilot's normal
              end-of-mission transition looks identical to a fence breach. */}
          {missionCompletedByPlan ? (
            <Badge text="MISSION COMPLETE" color="#15803d" />
          ) : unplannedReturn ? (
            <Badge text="UNPLANNED RETURN" color="#dc2626" />
          ) : reachingMissionEnd ? (
            <Badge text="ENDING (PLANNED)" color="#0f766e" />
          ) : holding ? (
            <Badge text="HOLDING · NOT STARTED" color="#b45309" />
          ) : null}
          <Badge
            text={operational?.phase || 'UNKNOWN'}
            color={
              missionCompletedByPlan
                ? '#15803d'
                : reachingMissionEnd
                  ? '#0f766e'
                  : operational?.tone === 'danger'
                    ? '#dc2626'
                    : operational?.tone === 'warn'
                      ? '#d97706'
                      : '#0f766e'
            }
          />
        </div>
      </div>
      {missionCompletedByPlan && (
        <div style={{
          background: 'rgba(34,197,94,0.10)', color: '#86efac', border: '1px solid rgba(34,197,94,0.35)',
          padding: '6px 8px', borderRadius: 6, marginBottom: 6, fontSize: 11, lineHeight: 1.4,
        }}>
          ✓ Mission completed normally. The AUTO → {modeUpper} transition is your planned WP {activeSeq} (cmd {activeCmdNum} = {activeCmdNum === 20 ? 'RTL' : 'LAND'}) executing — not a fence breach or failsafe.
        </div>
      )}
      {unplannedReturn && (
        <div style={{
          background: 'rgba(220,38,38,0.12)', color: '#fecaca', border: '1px solid rgba(220,38,38,0.5)',
          padding: '6px 8px', borderRadius: 6, marginBottom: 6, fontSize: 11, lineHeight: 1.45,
        }}>
          ⚠ <strong>Unplanned {modeUpper} at WP {activeSeq}</strong> — the mission did not reach its final RTL/LAND.
          The autopilot forced this.
          {failsafeReason
            ? <> Reason from autopilot: <strong>“{failsafeReason}”</strong>.</>
            : <> No fence/failsafe text captured yet — open the <strong>Messages</strong> tab for the autopilot's reason.</>}
          {/fence|breach/i.test(failsafeReason || '') && (
            <> {' '}A fence is enabled on the vehicle. Clearing the drawn polygon does not clear the onboard fence —
            go to Flight Planner → FENCE → <strong>Read</strong>, <strong>Clear</strong>, <strong>Write</strong>, then uncheck Enable → Apply.</>
          )}
        </div>
      )}
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
      {holding && (
        <div style={{ color: '#fbbf24', fontSize: 11, marginBottom: 6, lineHeight: 1.4 }}>
          ⏸ Armed in AUTO, holding on the ground. WP {activeSeq} is the autopilot's TAKEOFF
          cursor — the mission has <strong>not</strong> started. This matches Mission Planner;
          the counter advances on AUTO entry but the vehicle waits. Click <strong>Start Mission</strong> to begin.
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

