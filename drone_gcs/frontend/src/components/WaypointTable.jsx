import React from 'react';
import useMissionStore from '../store/useMissionStore';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';

const WaypointTable = () => {
  const waypoints = useMissionStore((state) => state.waypoints);
  const selectedSeq = useMissionStore((state) => state.selectedSeq);
  const missionCurrentSeq = useMissionStore((state) => state.missionCurrentSeq);
  const updateWaypointField = useMissionStore((state) => state.updateWaypointField);
  const removeWaypoint = useMissionStore((state) => state.removeWaypoint);
  const moveWaypoint = useMissionStore((state) => state.moveWaypoint);
  const selectWaypoint = useMissionStore((state) => state.selectWaypoint);

  return (
    <div className="waypoint-table-container">
      <table className="waypoint-table">
        <thead>
          <tr>
            <th>CMD</th>
            <th>Frame</th>
            <th>Lat</th>
            <th>Lng</th>
            <th>Alt (m)</th>
            <th>P1</th>
            <th>P2</th>
            <th>P3</th>
            <th>P4</th>
            <th>Order</th>
            <th>Del</th>
          </tr>
        </thead>
        <tbody>
          {waypoints.length === 0 ? (
            <tr>
              <td colSpan="11" style={{ textAlign: 'center', padding: '20px', color: 'var(--text-secondary)' }}>
                Click on the map to add waypoints
              </td>
            </tr>
          ) : (
            waypoints.map((wp) => (
              <tr
                key={wp.seq}
                onClick={() => selectWaypoint(wp.seq)}
                style={{
                  backgroundColor:
                    selectedSeq === wp.seq
                      ? 'rgba(59,130,246,0.12)'
                      : missionCurrentSeq === wp.seq
                        ? 'rgba(16,185,129,0.14)'
                        : 'transparent',
                }}
              >
                <td>
                  <input
                    type="number"
                    value={wp.command}
                    onChange={(e) => updateWaypointField(wp.seq, 'command', e.target.value)}
                    className="alt-input"
                  />
                </td>
                <td>
                  <input
                    type="number"
                    value={wp.frame}
                    onChange={(e) => updateWaypointField(wp.seq, 'frame', e.target.value)}
                    className="alt-input"
                  />
                </td>
                <td>
                  {Number(wp.lat).toFixed(6)}
                  {missionCurrentSeq === wp.seq && (
                    <span style={{ marginLeft: 6, fontSize: 11, color: '#34d399' }}>CURRENT</span>
                  )}
                </td>
                <td>{Number(wp.lng).toFixed(6)}</td>
                <td>
                  <input
                    type="number"
                    value={wp.alt}
                    onChange={(e) => updateWaypointField(wp.seq, 'alt', e.target.value)}
                    className="alt-input"
                  />
                </td>
                {['param1', 'param2', 'param3', 'param4'].map((p) => (
                  <td key={p}>
                    <input
                      type="number"
                      value={wp[p]}
                      onChange={(e) => updateWaypointField(wp.seq, p, e.target.value)}
                      className="alt-input"
                    />
                  </td>
                ))}
                <td style={{ display: 'flex', gap: '4px' }}>
                  <button onClick={() => moveWaypoint(wp.seq, -1)} className="btn-icon">
                    <ArrowUp size={14} />
                  </button>
                  <button onClick={() => moveWaypoint(wp.seq, 1)} className="btn-icon">
                    <ArrowDown size={14} />
                  </button>
                </td>
                <td>
                  <button onClick={() => removeWaypoint(wp.seq)} className="btn-icon danger">
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
};

export default WaypointTable;
