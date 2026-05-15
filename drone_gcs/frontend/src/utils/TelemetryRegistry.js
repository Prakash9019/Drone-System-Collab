// TelemetryRegistry.js — 45+ telemetry fields matching Mission Planner Quick tab options.

function haversineM(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function radToDeg(r) {
  if (r == null) return null;
  let d = r * (180 / Math.PI);
  if (d < 0) d += 360;
  return d;
}

function fmt(val, decimals = 2, fallback = '0.00') {
  if (val == null || val === undefined || Number.isNaN(val)) return fallback;
  return Number(val).toFixed(decimals);
}

export const TelemetryRegistry = {
  // ─── Position ───────────────────────────────────────────────────────────
  altitude: {
    label: 'Altitude (m)',
    getValue: (s) => fmt(s?.position?.alt_rel, 2, '0.00'),
    color: 'var(--accent-red)',
    group: 'Position',
  },
  altAmsl: {
    label: 'Alt AMSL (m)',
    getValue: (s) => fmt(s?.position?.alt_amsl, 2, '0.00'),
    color: 'var(--accent-red)',
    group: 'Position',
  },
  latitude: {
    label: 'Latitude (deg)',
    getValue: (s) => fmt(s?.position?.lat, 7, '0.0000000'),
    color: 'var(--accent-blue)',
    group: 'Position',
  },
  longitude: {
    label: 'Longitude (deg)',
    getValue: (s) => fmt(s?.position?.lng, 7, '0.0000000'),
    color: 'var(--accent-blue)',
    group: 'Position',
  },
  distToMav: {
    label: 'Dist to Home (m)',
    getValue: (s) => {
      if (!s?.home?.valid) return '—';
      const d = haversineM(s?.position?.lat, s?.position?.lng, s?.home?.lat, s?.home?.lng);
      return d == null ? '—' : d.toFixed(1);
    },
    color: 'var(--accent-blue)',
    group: 'Position',
  },
  distTraveled: {
    label: 'Dist Traveled (m)',
    getValue: (s) => fmt(s?.flight_stats?.distance_traveled, 1, '0.0'),
    color: 'var(--accent-orange)',
    group: 'Position',
  },

  // ─── Speed ──────────────────────────────────────────────────────────────
  groundspeed: {
    label: 'GroundSpeed (m/s)',
    getValue: (s) => fmt(s?.velocity?.groundspeed, 2, '0.00'),
    color: 'var(--accent-orange)',
    group: 'Speed',
  },
  airspeed: {
    label: 'Airspeed (m/s)',
    getValue: (s) => fmt(s?.velocity?.airspeed, 2, '0.00'),
    color: 'var(--accent-orange)',
    group: 'Speed',
  },
  verticalSpeed: {
    label: 'Vertical Speed (m/s)',
    getValue: (s) => fmt(s?.velocity?.climb, 2, '0.00'),
    color: 'var(--accent-yellow)',
    group: 'Speed',
  },
  heading: {
    label: 'Heading (deg)',
    getValue: (s) => {
      const h = s?.velocity?.heading;
      if (h != null) return fmt(h, 1, '0.0');
      const y = radToDeg(s?.attitude?.yaw);
      return y == null ? '0.0' : fmt(y, 1, '0.0');
    },
    color: 'var(--accent-green)',
    group: 'Speed',
  },
  throttle: {
    label: 'Throttle (%)',
    getValue: (s) => fmt(s?.velocity?.throttle, 1, '0.0'),
    color: 'var(--accent-yellow)',
    group: 'Speed',
  },

  // ─── Attitude ───────────────────────────────────────────────────────────
  roll: {
    label: 'Roll (deg)',
    getValue: (s) => {
      const r = s?.attitude?.roll;
      return r == null ? '0.00' : (r * 180 / Math.PI).toFixed(2);
    },
    color: 'var(--accent-green)',
    group: 'Attitude',
  },
  pitch: {
    label: 'Pitch (deg)',
    getValue: (s) => {
      const p = s?.attitude?.pitch;
      return p == null ? '0.00' : (p * 180 / Math.PI).toFixed(2);
    },
    color: 'var(--accent-green)',
    group: 'Attitude',
  },
  yaw: {
    label: 'Yaw (deg)',
    getValue: (s) => {
      if (s?.attitude?.yaw === undefined) return '0.00';
      let deg = s.attitude.yaw * (180 / Math.PI);
      if (deg < 0) deg += 360;
      return deg.toFixed(2);
    },
    color: 'var(--accent-green)',
    group: 'Attitude',
  },

  // ─── Mission / Navigation ────────────────────────────────────────────────
  missionSeq: {
    label: 'Mission Seq',
    getValue: (s) => {
      const seq = s?.mission?.current_seq;
      return seq == null || seq < 0 ? '—' : String(seq);
    },
    color: 'var(--accent-red)',
    group: 'Navigation',
  },
  distToWp: {
    label: 'Dist to WP (m)',
    getValue: (s) => {
      const d = s?.navigation?.wp_dist;
      return d == null || d < 0 ? '—' : Number(d).toFixed(1);
    },
    color: 'var(--accent-red)',
    group: 'Navigation',
  },
  targetBearing: {
    label: 'WP Bearing (deg)',
    getValue: (s) => fmt(s?.navigation?.target_bearing, 1, '—'),
    color: 'var(--accent-blue)',
    group: 'Navigation',
  },
  navBearing: {
    label: 'Nav Bearing (deg)',
    getValue: (s) => fmt(s?.navigation?.nav_bearing, 1, '—'),
    color: 'var(--accent-blue)',
    group: 'Navigation',
  },
  timeInAir: {
    label: 'Time in Air',
    getValue: (s) => {
      const t = s?.flight_stats?.time_in_air_s ?? 0;
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const sec = Math.floor(t % 60);
      return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
        : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    },
    color: 'var(--accent-yellow)',
    group: 'Navigation',
  },

  // ─── GPS ────────────────────────────────────────────────────────────────
  gpsFix: {
    label: 'GPS Fix Type',
    getValue: (s) => {
      const f = s?.status?.gps_fix ?? 0;
      const labels = { 0: 'No GPS', 1: 'No Fix', 2: '2D Fix', 3: '3D Fix', 4: 'DGPS', 5: 'RTK Float', 6: 'RTK Fixed' };
      return labels[f] || `Fix ${f}`;
    },
    color: 'white',
    group: 'GPS',
  },
  satellites: {
    label: 'Satellites',
    getValue: (s) => String(s?.status?.satellites ?? 0),
    color: 'white',
    group: 'GPS',
  },
  gpsHdop: {
    label: 'GPS HDOP',
    getValue: (s) => {
      const h = s?.status?.gps_hdop;
      if (!h || h <= 0) return '—';
      return h.toFixed(2);
    },
    color: 'var(--accent-blue)',
    group: 'GPS',
  },
  gpsVdop: {
    label: 'GPS VDOP',
    getValue: (s) => {
      const v = s?.status?.gps_vdop;
      if (!v || v <= 0) return '—';
      return v.toFixed(2);
    },
    color: 'var(--accent-blue)',
    group: 'GPS',
  },

  // ─── Battery ────────────────────────────────────────────────────────────
  battery: {
    label: 'Battery',
    getValue: (s) => {
      const v = s?.battery?.voltage?.toFixed(1) || '0.0';
      const pct = s?.battery?.remaining ?? 0;
      return `${v}V (${pct}%)`;
    },
    color: 'white',
    group: 'Battery',
  },
  battVoltage: {
    label: 'Battery Voltage (V)',
    getValue: (s) => fmt(s?.battery?.voltage, 2, '0.00'),
    color: 'white',
    group: 'Battery',
  },
  battCurrent: {
    label: 'Battery Current (A)',
    getValue: (s) => fmt(s?.battery?.current, 2, '0.00'),
    color: 'var(--accent-yellow)',
    group: 'Battery',
  },
  battRemaining: {
    label: 'Battery Remaining (%)',
    getValue: (s) => String(s?.battery?.remaining ?? 0),
    color: 'white',
    group: 'Battery',
  },
  battConsumed: {
    label: 'Battery Consumed (mAh)',
    getValue: (s) => fmt(s?.battery?.consumed_mah, 0, '0'),
    color: 'var(--accent-orange)',
    group: 'Battery',
  },

  // ─── EKF ────────────────────────────────────────────────────────────────
  ekfVelVar: {
    label: 'EKF Velocity Var',
    getValue: (s) => fmt(s?.ekf_status?.velocity_variance, 4, '0.0000'),
    color: 'var(--accent-yellow)',
    group: 'EKF',
  },
  ekfHorizVar: {
    label: 'EKF Horiz Var',
    getValue: (s) => fmt(s?.ekf_status?.pos_horiz_variance, 4, '0.0000'),
    color: 'var(--accent-yellow)',
    group: 'EKF',
  },
  ekfVertVar: {
    label: 'EKF Vert Var',
    getValue: (s) => fmt(s?.ekf_status?.pos_vert_variance, 4, '0.0000'),
    color: 'var(--accent-yellow)',
    group: 'EKF',
  },
  ekfCompassVar: {
    label: 'EKF Compass Var',
    getValue: (s) => fmt(s?.ekf_status?.compass_variance, 4, '0.0000'),
    color: 'var(--accent-yellow)',
    group: 'EKF',
  },
  ekfFlags: {
    label: 'EKF Flags',
    getValue: (s) => `0x${(s?.ekf_status?.flags ?? 0).toString(16).toUpperCase()}`,
    color: 'var(--accent-green)',
    group: 'EKF',
  },

  // ─── Vibration ──────────────────────────────────────────────────────────
  vibX: {
    label: 'Vibe X',
    getValue: (s) => fmt(s?.vibration?.vibration_x, 3, '0.000'),
    color: 'var(--accent-orange)',
    group: 'Vibration',
  },
  vibY: {
    label: 'Vibe Y',
    getValue: (s) => fmt(s?.vibration?.vibration_y, 3, '0.000'),
    color: 'var(--accent-orange)',
    group: 'Vibration',
  },
  vibZ: {
    label: 'Vibe Z',
    getValue: (s) => fmt(s?.vibration?.vibration_z, 3, '0.000'),
    color: 'var(--accent-orange)',
    group: 'Vibration',
  },
  clip0: {
    label: 'Clipping 0',
    getValue: (s) => String(s?.vibration?.clipping_0 ?? 0),
    color: 'var(--accent-red)',
    group: 'Vibration',
  },

  // ─── RC / Radio ─────────────────────────────────────────────────────────
  rcRssi: {
    label: 'RC RSSI',
    getValue: (s) => String(s?.rc_channels?.rssi ?? 0),
    color: 'white',
    group: 'RC',
  },
  ch1: {
    label: 'RC Ch 1',
    getValue: (s) => String(s?.rc_channels?.channels?.[1] ?? 0),
    color: 'var(--accent-blue)',
    group: 'RC',
  },
  ch2: {
    label: 'RC Ch 2',
    getValue: (s) => String(s?.rc_channels?.channels?.[2] ?? 0),
    color: 'var(--accent-blue)',
    group: 'RC',
  },
  ch3: {
    label: 'RC Ch 3',
    getValue: (s) => String(s?.rc_channels?.channels?.[3] ?? 0),
    color: 'var(--accent-blue)',
    group: 'RC',
  },
  ch4: {
    label: 'RC Ch 4',
    getValue: (s) => String(s?.rc_channels?.channels?.[4] ?? 0),
    color: 'var(--accent-blue)',
    group: 'RC',
  },

  // ─── Servo Output ────────────────────────────────────────────────────────
  servo1: {
    label: 'Servo 1 (PWM)',
    getValue: (s) => String(s?.servo_output?.channels?.[1] ?? 0),
    color: 'var(--accent-green)',
    group: 'Servo',
  },
  servo2: {
    label: 'Servo 2 (PWM)',
    getValue: (s) => String(s?.servo_output?.channels?.[2] ?? 0),
    color: 'var(--accent-green)',
    group: 'Servo',
  },

  // ─── Link / Connection ────────────────────────────────────────────────────
  latency: {
    label: 'Link Latency (ms)',
    getValue: (s) => fmt(s?.link_status?.latency_ms, 1, '0.0'),
    color: 'var(--accent-blue)',
    group: 'Link',
  },
  packetLoss: {
    label: 'Packet Loss (%)',
    getValue: (s) => fmt(s?.link_status?.packet_loss_percent, 2, '0.00'),
    color: 'var(--accent-red)',
    group: 'Link',
  },

  // ─── Wind ────────────────────────────────────────────────────────────────
  windSpeed: {
    label: 'Wind Speed (m/s)',
    getValue: (s) => fmt(s?.wind?.speed, 2, '0.00'),
    color: 'var(--accent-blue)',
    group: 'Wind',
  },
  windDir: {
    label: 'Wind Direction (deg)',
    getValue: (s) => fmt(s?.wind?.direction, 1, '0.0'),
    color: 'var(--accent-blue)',
    group: 'Wind',
  },

  // ─── Rangefinder ────────────────────────────────────────────────────────
  range: {
    label: 'Rangefinder (m)',
    getValue: (s) => fmt(s?.rangefinder?.distance, 2, '—'),
    color: 'var(--accent-yellow)',
    group: 'Sensors',
  },
};
