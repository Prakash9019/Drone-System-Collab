import React from 'react';
import useMissionStore from '../store/useMissionStore';
import { Trash2 } from 'lucide-react';

const WaypointTable = () => {
  const waypoints = useMissionStore((state) => state.waypoints);
  const updateWaypointAlt = useMissionStore((state) => state.updateWaypointAlt);
  const removeWaypoint = useMissionStore((state) => state.removeWaypoint);

  return (
    <div className="waypoint-table-container">
      <table className="waypoint-table">
        <thead>
          <tr>
            <th>CMD</th>
            <th>Lat</th>
            <th>Lng</th>
            <th>Alt (m)</th>
            <th>Del</th>
          </tr>
        </thead>
        <tbody>
          {waypoints.length === 0 ? (
            <tr>
              <td colSpan="5" style={{ textAlign: 'center', padding: '20px', color: 'var(--text-secondary)' }}>
                Click on the map to add waypoints
              </td>
            </tr>
          ) : (
            waypoints.map((wp) => (
              <tr key={wp.seq}>
                <td>
                  <span className="wp-badge">{wp.command === 16 ? 'WAYPOINT' : wp.command}</span>
                </td>
                <td>{wp.lat.toFixed(6)}</td>
                <td>{wp.lng.toFixed(6)}</td>
                <td>
                  <input
                    type="number"
                    value={wp.alt}
                    onChange={(e) => updateWaypointAlt(wp.seq, e.target.value)}
                    className="alt-input"
                  />
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
