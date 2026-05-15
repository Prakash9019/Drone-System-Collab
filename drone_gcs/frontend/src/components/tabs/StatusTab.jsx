import React, { useState } from 'react';

// Flat, searchable list of every important telemetry field
const buildStatusRows = (v) => {
  if (!v) return [];
  return [
    // --- Connection ---
    { group: 'Connection', key: 'connection_state', value: v.connection_state ?? '--' },
    { group: 'Connection', key: 'last_heartbeat_age_s', value: v.last_heartbeat ? `${(Date.now() / 1000 - v.last_heartbeat).toFixed(1)}s ago` : '--' },
    { group: 'Connection', key: 'packet_loss_%', value: `${(v.link_status?.packet_loss_percent ?? 0).toFixed(2)}%` },
    { group: 'Connection', key: 'latency_ms', value: `${(v.link_status?.latency_ms ?? 0).toFixed(1)} ms` },
    { group: 'Connection', key: 'packets_rx', value: v.link_status?.total_packets_received ?? 0 },
    { group: 'Connection', key: 'packets_lost', value: v.link_status?.total_packets_lost ?? 0 },

    // --- Vehicle Status ---
    { group: 'Status', key: 'mode', value: v.status?.mode ?? '--' },
    { group: 'Status', key: 'armed', value: v.status?.armed ? '✓ ARMED' : '✗ DISARMED' },
    { group: 'Status', key: 'system_type', value: v.status?.system_type ?? '--' },

    // --- GPS ---
    { group: 'GPS', key: 'fix_type', value: v.status?.gps_fix ?? 0 },
    { group: 'GPS', key: 'satellites', value: v.status?.satellites ?? 0 },
    { group: 'GPS', key: 'hdop', value: v.status?.gps_hdop?.toFixed?.(2) ?? '--' },
    { group: 'GPS', key: 'vdop', value: v.status?.gps_vdop?.toFixed?.(2) ?? '--' },
    { group: 'GPS', key: 'lat', value: v.position?.lat?.toFixed(7) ?? '--' },
    { group: 'GPS', key: 'lng', value: v.position?.lng?.toFixed(7) ?? '--' },
    { group: 'GPS', key: 'alt_amsl_m', value: v.position?.alt_amsl?.toFixed(2) ?? '--' },
    { group: 'GPS', key: 'alt_rel_m', value: v.position?.alt_rel?.toFixed(2) ?? '--' },

    // --- Attitude ---
    { group: 'Attitude', key: 'roll_rad', value: v.attitude?.roll?.toFixed(4) ?? '--' },
    { group: 'Attitude', key: 'pitch_rad', value: v.attitude?.pitch?.toFixed(4) ?? '--' },
    { group: 'Attitude', key: 'yaw_rad', value: v.attitude?.yaw?.toFixed(4) ?? '--' },

    // --- Velocity ---
    { group: 'Velocity', key: 'groundspeed_m/s', value: v.velocity?.groundspeed?.toFixed(2) ?? '--' },
    { group: 'Velocity', key: 'airspeed_m/s', value: v.velocity?.airspeed?.toFixed(2) ?? '--' },
    { group: 'Velocity', key: 'climb_m/s', value: v.velocity?.climb?.toFixed(2) ?? '--' },
    { group: 'Velocity', key: 'heading_deg', value: v.velocity?.heading ?? '--' },
    { group: 'Velocity', key: 'throttle_%', value: v.velocity?.throttle ?? '--' },

    // --- Battery ---
    { group: 'Battery', key: 'voltage_V', value: v.battery?.voltage?.toFixed(2) ?? '--' },
    { group: 'Battery', key: 'current_A', value: v.battery?.current?.toFixed(2) ?? '--' },
    { group: 'Battery', key: 'remaining_%', value: v.battery?.remaining ?? '--' },

    // --- EKF ---
    { group: 'EKF', key: 'flags', value: `0x${(v.ekf_status?.flags ?? 0).toString(16).toUpperCase()}` },
    { group: 'EKF', key: 'velocity_variance', value: v.ekf_status?.velocity_variance?.toFixed(4) ?? '--' },
    { group: 'EKF', key: 'pos_horiz_variance', value: v.ekf_status?.pos_horiz_variance?.toFixed(4) ?? '--' },
    { group: 'EKF', key: 'pos_vert_variance', value: v.ekf_status?.pos_vert_variance?.toFixed(4) ?? '--' },
    { group: 'EKF', key: 'compass_variance', value: v.ekf_status?.compass_variance?.toFixed(4) ?? '--' },
    { group: 'EKF', key: 'terrain_alt_variance', value: v.ekf_status?.terrain_alt_variance?.toFixed(4) ?? '--' },

    // --- Navigation ---
    { group: 'Navigation', key: 'mission_current_seq', value: v.mission?.current_seq ?? -1 },
    { group: 'Navigation', key: 'wp_dist_m', value: v.navigation?.wp_dist?.toFixed?.(1) ?? '--' },
    { group: 'Navigation', key: 'target_bearing_deg', value: v.navigation?.target_bearing?.toFixed?.(1) ?? '--' },
    { group: 'Navigation', key: 'nav_bearing_deg', value: v.navigation?.nav_bearing?.toFixed?.(1) ?? '--' },

    // --- Vibration ---
    { group: 'Vibration', key: 'vib_x', value: v.vibration?.vibration_x?.toFixed(3) ?? '--' },
    { group: 'Vibration', key: 'vib_y', value: v.vibration?.vibration_y?.toFixed(3) ?? '--' },
    { group: 'Vibration', key: 'vib_z', value: v.vibration?.vibration_z?.toFixed(3) ?? '--' },
    { group: 'Vibration', key: 'clip_0', value: v.vibration?.clipping_0 ?? 0 },
    { group: 'Vibration', key: 'clip_1', value: v.vibration?.clipping_1 ?? 0 },
    { group: 'Vibration', key: 'clip_2', value: v.vibration?.clipping_2 ?? 0 },

    // --- RC ---
    { group: 'RC', key: 'rssi', value: v.rc_channels?.rssi ?? '--' },
    ...Object.entries(v.rc_channels?.channels ?? {}).map(([ch, val]) => ({
      group: 'RC', key: `ch${ch}_raw`, value: val
    })),
    ...Object.entries(v.servo_output?.channels ?? {}).map(([ch, val]) => ({
      group: 'Servo', key: `servo${ch}_raw`, value: val
    })),
  ];
};

const StatusTab = ({ vehicleState }) => {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState({});

  const rows = buildStatusRows(vehicleState);
  const filtered = search
    ? rows.filter(r =>
        r.key.toLowerCase().includes(search.toLowerCase()) ||
        String(r.value).toLowerCase().includes(search.toLowerCase())
      )
    : rows;

  // Group
  const groups = {};
  filtered.forEach(row => {
    if (!groups[row.group]) groups[row.group] = [];
    groups[row.group].push(row);
  });

  const toggleGroup = (g) => setCollapsed(c => ({ ...c, [g]: !c[g] }));

  if (!vehicleState) {
    return (
      <div className="status-tab">
        <input className="status-search" placeholder="🔍 Filter fields..." disabled value="" onChange={() => {}} />
        <div style={{ padding: '20px 12px', color: '#4b5563', fontSize: 13 }}>
          No telemetry — connect vehicle to see live status data.
        </div>
      </div>
    );
  }

  return (
    <div className="status-tab">
      <input
        className="status-search"
        placeholder="🔍 Filter fields..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      <div className="status-rows">
        {Object.entries(groups).map(([group, groupRows]) => (
          <div key={group} className="status-group">
            <div className="status-group-header" onClick={() => toggleGroup(group)}>
              <span>{collapsed[group] ? '▶' : '▼'}</span>
              <span>{group}</span>
              <span className="status-group-count">{groupRows.length}</span>
            </div>
            {!collapsed[group] && groupRows.map(row => (
              <div key={row.key} className="status-row">
                <span className="status-key">{row.key}</span>
                <span className="status-value">{String(row.value)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

export default StatusTab;
