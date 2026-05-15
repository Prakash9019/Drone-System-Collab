import React, { useMemo, useState } from 'react';
import useMissionStore from '../store/useMissionStore';
import { ArrowDown, ArrowUp, Trash2, Copy, ZoomIn } from 'lucide-react';

// ─── MAVLink command dictionary ────────────────────────────────────────────────
export const CMD_NAMES = {
  16:   'NAV_WAYPOINT',
  17:   'LOITER_UNLIM',
  18:   'LOITER_TURNS',
  19:   'LOITER_TIME',
  20:   'RTL',
  21:   'LAND',
  22:   'TAKEOFF',
  82:   'SPLINE_WP',
  93:   'SPLINE_TAKEOFF',
  115:  'GUIDED_ENABLE',
  177:  'DO_JUMP',
  178:  'DO_CHANGE_SPEED',
  179:  'DO_SET_HOME',
  181:  'DO_SET_RELAY',
  183:  'DO_SET_SERVO',
  201:  'DO_SET_ROI',
  203:  'DO_DIGICAM',
  206:  'CAM_TRIGG_DIST',
  5001: 'FENCE_INC',
  5002: 'FENCE_EXC',
  5100: 'RALLY_PT',
};

// Human-readable label per command
const CMD_OPTIONS = [
  { value: 16,   label: '16 — NAV_WAYPOINT' },
  { value: 22,   label: '22 — TAKEOFF' },
  { value: 21,   label: '21 — LAND' },
  { value: 20,   label: '20 — RTL' },
  { value: 17,   label: '17 — LOITER_UNLIM' },
  { value: 18,   label: '18 — LOITER_TURNS' },
  { value: 19,   label: '19 — LOITER_TIME' },
  { value: 82,   label: '82 — SPLINE_WP' },
  { value: 93,   label: '93 — SPLINE_TAKEOFF' },
  { value: 177,  label: '177 — DO_JUMP' },
  { value: 178,  label: '178 — DO_CHANGE_SPEED' },
  { value: 179,  label: '179 — DO_SET_HOME' },
  { value: 181,  label: '181 — DO_SET_RELAY' },
  { value: 183,  label: '183 — DO_SET_SERVO' },
  { value: 201,  label: '201 — DO_SET_ROI' },
  { value: 203,  label: '203 — DO_DIGICAM' },
  { value: 206,  label: '206 — CAM_TRIGG_DIST' },
  { value: 5001, label: '5001 — FENCE_INCLUSION' },
  { value: 5002, label: '5002 — FENCE_EXCLUSION' },
  { value: 5100, label: '5100 — RALLY_POINT' },
];

// Parameter labels per command
const CMD_PARAM_LABELS = {
  16:   ['Hold(s)', 'Acc(m)', 'PassRad(m)', 'Yaw(°)'],
  17:   ['', 'Rad(m)', 'Orb(°)', 'Yaw(°)'],
  18:   ['Turns', 'Rad(m)', 'Dir', 'Yaw(°)'],
  19:   ['Time(s)', 'Rad(m)', 'Orb(°)', 'Yaw(°)'],
  22:   ['Pitch(°)', '', '', 'Yaw(°)'],
  21:   ['Abort(m)', '', '', 'Yaw(°)'],
  177:  ['To seq', 'Repeat', '', ''],
  178:  ['Type', 'Speed(m/s)', 'Throttle', ''],
  206:  ['Dist(m)', 'Shutter', 'Trigg', ''],
  203:  ['', '', '', ''],
};

// Row color by command type
const CMD_ROW_COLOR = {
  22:   'rgba(250,204,21,0.08)',   // TAKEOFF — yellow
  21:   'rgba(239,68,68,0.08)',    // LAND — red
  20:   'rgba(249,115,22,0.08)',   // RTL — orange
  17:   'rgba(139,92,246,0.08)',   // LOITER — purple
  18:   'rgba(139,92,246,0.08)',
  19:   'rgba(139,92,246,0.08)',
  201:  'rgba(14,165,233,0.08)',   // ROI — cyan
  206:  'rgba(16,185,129,0.08)',   // camera — green
  203:  'rgba(16,185,129,0.08)',
};

const FRAME_OPTIONS = [
  { value: 0, label: '0 — Global (MSL)' },
  { value: 3, label: '3 — Relative (AGL)' },
  { value: 5, label: '5 — Terrain' },
];

// Haversine distance in metres
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1))*Math.cos(toR(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── Component ────────────────────────────────────────────────────────────────

const WaypointTable = () => {
  const waypoints = useMissionStore(s => s.waypoints);
  const selectedSeq = useMissionStore(s => s.selectedSeq);
  const missionCurrentSeq = useMissionStore(s => s.missionCurrentSeq);
  const missionType = useMissionStore(s => s.missionType);
  const updateWaypointField = useMissionStore(s => s.updateWaypointField);
  const removeWaypoint = useMissionStore(s => s.removeWaypoint);
  const moveWaypoint = useMissionStore(s => s.moveWaypoint);
  const selectWaypoint = useMissionStore(s => s.selectWaypoint);
  const insertWaypointAt = useMissionStore(s => s.insertWaypointAt);
  const undoLastAction = useMissionStore(s => s.undoLastAction);
  const mapInstance = useMissionStore(s => s.mapInstance);

  const [bulkAlt, setBulkAlt] = useState('');
  const [showBulkAlt, setShowBulkAlt] = useState(false);

  // Mission stats
  const stats = useMemo(() => {
    if (!waypoints.length) return null;
    let totalDist = 0;
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      if (a.lat && a.lng && b.lat && b.lng) {
        totalDist += distM(a.lat, a.lng, b.lat, b.lng);
      }
    }
    const estTimeSec = totalDist / 8; // assume 8 m/s cruise
    const mins = Math.floor(estTimeSec / 60);
    const secs = Math.round(estTimeSec % 60);
    return {
      count: waypoints.length,
      distM: totalDist,
      distKm: (totalDist / 1000).toFixed(2),
      time: `${mins}:${String(secs).padStart(2, '0')}`,
    };
  }, [waypoints]);

  const applyBulkAlt = () => {
    const alt = parseFloat(bulkAlt);
    if (!isFinite(alt)) return;
    waypoints.forEach(wp => updateWaypointField(wp.seq, 'alt', alt));
    setShowBulkAlt(false);
    setBulkAlt('');
  };

  const duplicateWp = (wp) => {
    insertWaypointAt(wp.seq + 1, { ...wp });
  };

  const zoomToWp = (wp) => {
    if (!mapInstance) return;
    mapInstance.flyTo({ center: [wp.lng, wp.lat], zoom: 17 });
  };

  const paramLabels = (cmd) => CMD_PARAM_LABELS[Number(cmd)] || ['P1', 'P2', 'P3', 'P4'];

  return (
    <div className="waypoint-table-container" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div className="wp-table-toolbar">
        <button className="btn-toolbar" onClick={undoLastAction} title="Undo last waypoint change">
          ↩ Undo
        </button>
        <button
          className="btn-toolbar"
          onClick={() => setShowBulkAlt(v => !v)}
          title="Set all waypoints to same altitude"
        >
          ⬆ Bulk Alt
        </button>
        {waypoints.length > 0 && (
          <span className="wp-stat-badge">
            {stats?.count} WPs · {stats?.distKm} km · ~{stats?.time}
          </span>
        )}
      </div>

      {/* Bulk altitude row */}
      {showBulkAlt && (
        <div className="wp-bulk-alt-row">
          <span>Set ALL waypoint altitudes to:</span>
          <input
            type="number"
            className="alt-input"
            value={bulkAlt}
            onChange={e => setBulkAlt(e.target.value)}
            placeholder="metres"
            style={{ width: 80 }}
          />
          <button className="btn-toolbar primary" onClick={applyBulkAlt}>Apply</button>
          <button className="btn-toolbar" onClick={() => setShowBulkAlt(false)}>Cancel</button>
        </div>
      )}

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto' }}>
        <table className="waypoint-table">
          <thead>
            <tr>
              <th style={{ width: 30 }}>#</th>
              <th style={{ width: 160 }}>Command</th>
              <th style={{ width: 90 }}>Frame</th>
              <th style={{ width: 90 }}>Latitude</th>
              <th style={{ width: 90 }}>Longitude</th>
              <th style={{ width: 66 }}>Alt (m)</th>
              <th style={{ width: 54 }}>P1</th>
              <th style={{ width: 54 }}>P2</th>
              <th style={{ width: 54 }}>P3</th>
              <th style={{ width: 54 }}>P4</th>
              <th style={{ width: 60 }}>Order</th>
              <th style={{ width: 80 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {waypoints.length === 0 ? (
              <tr>
                <td colSpan={12} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)' }}>
                  Click on the map to add waypoints
                </td>
              </tr>
            ) : (
              waypoints.map((wp) => {
                const cmdNum = Number(wp.command);
                const cmdName = CMD_NAMES[cmdNum] || `CMD ${cmdNum}`;
                const pLabels = paramLabels(cmdNum);
                const rowBg = selectedSeq === wp.seq
                  ? 'rgba(59,130,246,0.15)'
                  : missionCurrentSeq === wp.seq
                    ? 'rgba(16,185,129,0.18)'
                    : CMD_ROW_COLOR[cmdNum] || 'transparent';

                return (
                  <tr
                    key={wp.seq}
                    onClick={() => selectWaypoint(wp.seq)}
                    style={{ backgroundColor: rowBg, cursor: 'pointer' }}
                    title={`${wp.seq}: ${cmdName} @ ${Number(wp.lat).toFixed(5)}, ${Number(wp.lng).toFixed(5)}`}
                  >
                    {/* Seq number */}
                    <td style={{ textAlign: 'center', fontWeight: 700 }}>
                      {wp.seq}
                      {missionCurrentSeq === wp.seq && (
                        <span style={{ display: 'block', fontSize: 8, color: '#34d399' }}>NOW</span>
                      )}
                    </td>

                    {/* Command dropdown */}
                    <td>
                      <select
                        className="wp-cmd-select"
                        value={cmdNum}
                        onChange={e => updateWaypointField(wp.seq, 'command', Number(e.target.value))}
                        onClick={e => e.stopPropagation()}
                        title={`${cmdNum} — ${cmdName}`}
                      >
                        {CMD_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                        {/* If cmd not in list, add it */}
                        {!CMD_OPTIONS.find(o => o.value === cmdNum) && (
                          <option value={cmdNum}>{cmdNum} — {cmdName}</option>
                        )}
                      </select>
                    </td>

                    {/* Frame dropdown */}
                    <td>
                      <select
                        className="wp-cmd-select"
                        value={Number(wp.frame)}
                        onChange={e => updateWaypointField(wp.seq, 'frame', Number(e.target.value))}
                        onClick={e => e.stopPropagation()}
                      >
                        {FRAME_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </td>

                    {/* Lat */}
                    <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                      {Number(wp.lat).toFixed(6)}
                    </td>

                    {/* Lng */}
                    <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                      {Number(wp.lng).toFixed(6)}
                    </td>

                    {/* Altitude */}
                    <td>
                      <input
                        type="number"
                        value={wp.alt}
                        onChange={e => updateWaypointField(wp.seq, 'alt', e.target.value)}
                        onClick={e => e.stopPropagation()}
                        className="alt-input"
                        style={{ width: 58 }}
                        title="Altitude in metres"
                      />
                    </td>

                    {/* P1–P4 with dynamic labels */}
                    {['param1', 'param2', 'param3', 'param4'].map((p, i) => (
                      <td key={p}>
                        <input
                          type="number"
                          value={wp[p]}
                          onChange={e => updateWaypointField(wp.seq, p, e.target.value)}
                          onClick={e => e.stopPropagation()}
                          className="alt-input"
                          style={{ width: 46 }}
                          title={pLabels[i] || p}
                        />
                      </td>
                    ))}

                    {/* Order controls */}
                    <td>
                      <div style={{ display: 'flex', gap: 2 }}>
                        <button
                          onClick={e => { e.stopPropagation(); moveWaypoint(wp.seq, -1); }}
                          className="btn-icon"
                          title="Move up"
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); moveWaypoint(wp.seq, 1); }}
                          className="btn-icon"
                          title="Move down"
                        >
                          <ArrowDown size={12} />
                        </button>
                      </div>
                    </td>

                    {/* Row actions */}
                    <td>
                      <div style={{ display: 'flex', gap: 2 }}>
                        <button
                          onClick={e => { e.stopPropagation(); duplicateWp(wp); }}
                          className="btn-icon"
                          title="Duplicate waypoint"
                        >
                          <Copy size={12} />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); zoomToWp(wp); }}
                          className="btn-icon"
                          title="Zoom to waypoint on map"
                        >
                          <ZoomIn size={12} />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); removeWaypoint(wp.seq); }}
                          className="btn-icon danger"
                          title="Delete waypoint"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Stats footer */}
      {stats && (
        <div className="wp-stats-footer">
          <span>{stats.count} waypoints</span>
          <span>·</span>
          <span>{stats.distKm} km total</span>
          <span>·</span>
          <span>~{stats.time} @ 8 m/s</span>
          {missionType === 'MISSION' && waypoints.some(w => w.command === 22) === false && (
            <span style={{ color: '#f59e0b', marginLeft: 8 }}>⚠ No TAKEOFF command</span>
          )}
          {missionType === 'MISSION' && waypoints.some(w => [20, 21].includes(Number(w.command))) === false && (
            <span style={{ color: '#f59e0b', marginLeft: 8 }}>⚠ No RTL/LAND command</span>
          )}
        </div>
      )}
    </div>
  );
};

export default WaypointTable;
