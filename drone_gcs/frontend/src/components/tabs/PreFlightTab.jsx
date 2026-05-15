import React, { useMemo } from 'react';

// ─── Check result helpers ────────────────────────────────────────────────────

const PASS = (value) => ({ label: 'PASS', color: '#22c55e', value });
const FAIL = (value) => ({ label: 'FAIL', color: '#ef4444', value });
const WARN = (value) => ({ label: 'WARN', color: '#f59e0b', value });
const NA   = (value) => ({ label: 'N/A',  color: '#6b7280', value });

function bit(flags, n) {
  return Boolean(flags & (1 << n));
}

// ─── Build all pre-arm checks (Mission Planner parity) ────────────────────────

function buildChecks(v) {
  const disconnected = !v;

  const gpsFix    = Number(v?.status?.gps_fix ?? 0);
  const sats      = Number(v?.status?.satellites ?? 0);
  const hdop      = Number(v?.status?.gps_hdop ?? 0);
  const vdop      = Number(v?.status?.gps_vdop ?? 0);
  const battPct   = Number(v?.battery?.remaining ?? 0);
  const battV     = Number(v?.battery?.voltage ?? 0);
  const ekfFlags  = Number(v?.ekf_status?.flags ?? 0);
  const velVar    = Number(v?.ekf_status?.velocity_variance ?? 0);
  const horizVar  = Number(v?.ekf_status?.pos_horiz_variance ?? 0);
  const vertVar   = Number(v?.ekf_status?.pos_vert_variance ?? 0);
  const compVar   = Number(v?.ekf_status?.compass_variance ?? 0);
  const sensPresent = Number(v?.status?.sensors_present ?? 0);
  const sensHealth  = Number(v?.status?.sensors_health ?? 0);
  const rssi      = Number(v?.rc_channels?.rssi ?? 0);
  const vibX      = Number(v?.vibration?.vibration_x ?? 0);
  const vibY      = Number(v?.vibration?.vibration_y ?? 0);
  const vibZ      = Number(v?.vibration?.vibration_z ?? 0);
  const clip0     = Number(v?.vibration?.clipping_0 ?? 0);
  const clip1     = Number(v?.vibration?.clipping_1 ?? 0);
  const clip2     = Number(v?.vibration?.clipping_2 ?? 0);
  const isArmed   = Boolean(v?.status?.armed);
  const failsafe  = Boolean(v?.status?.failsafe);
  const hbAge     = v?.last_heartbeat ? (Date.now() / 1000 - v.last_heartbeat) : 99;

  if (disconnected) {
    // Show all checks as N/A when disconnected, so the UI is not blank.
    return [
      { group: 'GPS',      name: 'GPS Lock',            ...NA('No telemetry'), tip: '3D Fix required' },
      { group: 'GPS',      name: 'Satellites',           ...NA('No telemetry'), tip: '≥ 6 satellites required' },
      { group: 'GPS',      name: 'GPS HDOP',             ...NA('No telemetry'), tip: 'HDOP ≤ 2.0 required' },
      { group: 'EKF',      name: 'EKF Ready',            ...NA('No telemetry'), tip: 'EKF must have valid estimates' },
      { group: 'EKF',      name: 'EKF Velocity Var',     ...NA('No telemetry'), tip: '< 0.5 required' },
      { group: 'EKF',      name: 'EKF Horiz Pos Var',    ...NA('No telemetry'), tip: '< 0.5 required' },
      { group: 'EKF',      name: 'EKF Vert Pos Var',     ...NA('No telemetry'), tip: '< 0.5 required' },
      { group: 'EKF',      name: 'EKF Compass Var',      ...NA('No telemetry'), tip: '< 0.5 required' },
      { group: 'Battery',  name: 'Battery Voltage',      ...NA('No telemetry'), tip: '≥ 10.5V required' },
      { group: 'Battery',  name: 'Battery Level',        ...NA('No telemetry'), tip: '≥ 20% required' },
      { group: 'Sensors',  name: 'Compass Present',      ...NA('No telemetry'), tip: 'MAV_SYS_STATUS_SENSOR_3D_MAG bit' },
      { group: 'Sensors',  name: 'Gyro Health',          ...NA('No telemetry'), tip: 'Gyro must be healthy' },
      { group: 'Sensors',  name: 'Accel Health',         ...NA('No telemetry'), tip: 'Accel must be healthy' },
      { group: 'Sensors',  name: 'Barometer Health',     ...NA('No telemetry'), tip: 'Baro must be healthy' },
      { group: 'RC',       name: 'RC Active',            ...NA('No telemetry'), tip: 'RC signal must be present' },
      { group: 'RC',       name: 'RC RSSI Quality',      ...NA('No telemetry'), tip: 'RSSI ≥ 50 recommended' },
      { group: 'Vibration',name: 'Vibe X',               ...NA('No telemetry'), tip: '< 30 m/s/s recommended' },
      { group: 'Vibration',name: 'Vibe Y',               ...NA('No telemetry'), tip: '< 30 m/s/s recommended' },
      { group: 'Vibration',name: 'Vibe Z',               ...NA('No telemetry'), tip: '< 30 m/s/s recommended' },
      { group: 'Vibration',name: 'Accel Clipping',       ...NA('No telemetry'), tip: 'Should be 0' },
      { group: 'System',   name: 'Link Active',          ...FAIL('Disconnected'), tip: 'Heartbeat must be < 3s old' },
      { group: 'System',   name: 'Arming State',         ...NA('No telemetry'), tip: 'Should be Disarmed before pre-arm check' },
      { group: 'System',   name: 'Failsafe',             ...NA('No telemetry'), tip: 'No active failsafe' },
    ];
  }

  return [
    // ── GPS ─────────────────────────────────────────────────────────────────
    {
      group: 'GPS', name: 'GPS Lock',
      ...(gpsFix >= 3 ? PASS(`3D Fix`) : gpsFix === 2 ? WARN(`2D Fix`) : FAIL(`No Fix (${gpsFix})`)),
      tip: '3D Fix (type ≥ 3) required to arm',
    },
    {
      group: 'GPS', name: 'Satellites',
      ...(sats >= 6 ? PASS(`${sats} sats`) : sats >= 4 ? WARN(`${sats} sats`) : FAIL(`${sats} sats`)),
      tip: '≥ 6 satellites required for good positioning',
    },
    {
      group: 'GPS', name: 'GPS HDOP',
      ...(!hdop || hdop <= 0 ? NA('N/A') : hdop <= 1.5 ? PASS(`${hdop.toFixed(2)}`) : hdop <= 2.0 ? WARN(`${hdop.toFixed(2)}`) : FAIL(`${hdop.toFixed(2)}`)),
      tip: 'HDOP ≤ 2.0 required; ≤ 1.5 is good',
    },

    // ── EKF ─────────────────────────────────────────────────────────────────
    {
      group: 'EKF', name: 'EKF Ready',
      ...(ekfFlags !== 0 ? PASS(`flags 0x${ekfFlags.toString(16).toUpperCase()}`) : FAIL('flags=0 (EKF not running)')),
      tip: 'EKF must be running with non-zero flags',
    },
    {
      group: 'EKF', name: 'EKF Velocity Var',
      ...(velVar < 0.5 ? PASS(`${velVar.toFixed(4)}`) : velVar < 1.0 ? WARN(`${velVar.toFixed(4)}`) : FAIL(`${velVar.toFixed(4)}`)),
      tip: 'velocity_variance < 0.5 required',
    },
    {
      group: 'EKF', name: 'EKF Horiz Pos Var',
      ...(horizVar < 0.5 ? PASS(`${horizVar.toFixed(4)}`) : horizVar < 1.0 ? WARN(`${horizVar.toFixed(4)}`) : FAIL(`${horizVar.toFixed(4)}`)),
      tip: 'pos_horiz_variance < 0.5 required',
    },
    {
      group: 'EKF', name: 'EKF Vert Pos Var',
      ...(vertVar < 0.5 ? PASS(`${vertVar.toFixed(4)}`) : vertVar < 1.0 ? WARN(`${vertVar.toFixed(4)}`) : FAIL(`${vertVar.toFixed(4)}`)),
      tip: 'pos_vert_variance < 0.5 required',
    },
    {
      group: 'EKF', name: 'EKF Compass Var',
      ...(compVar < 0.5 ? PASS(`${compVar.toFixed(4)}`) : compVar < 1.0 ? WARN(`${compVar.toFixed(4)}`) : FAIL(`${compVar.toFixed(4)}`)),
      tip: 'compass_variance < 0.5 required',
    },

    // ── Battery ──────────────────────────────────────────────────────────────
    {
      group: 'Battery', name: 'Battery Voltage',
      ...(battV >= 11.1 ? PASS(`${battV.toFixed(2)}V`) : battV >= 10.5 ? WARN(`${battV.toFixed(2)}V`) : FAIL(`${battV.toFixed(2)}V`)),
      tip: '≥ 10.5V required; ≥ 11.1V recommended for 3S',
    },
    {
      group: 'Battery', name: 'Battery Level',
      ...(battPct >= 30 ? PASS(`${battPct}%`) : battPct >= 20 ? WARN(`${battPct}%`) : FAIL(`${battPct}%`)),
      tip: '≥ 20% required to arm; ≥ 30% recommended',
    },

    // ── Sensors ──────────────────────────────────────────────────────────────
    {
      group: 'Sensors', name: 'Compass Present',
      ...(bit(sensPresent, 2) ? (bit(sensHealth, 2) ? PASS('healthy') : WARN('present but unhealthy')) : FAIL('not detected')),
      tip: 'MAV_SYS_STATUS_SENSOR_3D_MAG (bit 2) must be present and healthy',
    },
    {
      group: 'Sensors', name: 'Gyro Health',
      ...(bit(sensPresent, 1) ? (bit(sensHealth, 1) ? PASS('healthy') : FAIL('unhealthy')) : NA('not present')),
      tip: 'Gyroscope must be healthy for stable flight',
    },
    {
      group: 'Sensors', name: 'Accel Health',
      ...(bit(sensPresent, 0) ? (bit(sensHealth, 0) ? PASS('healthy') : FAIL('unhealthy')) : NA('not present')),
      tip: 'Accelerometer must be healthy',
    },
    {
      group: 'Sensors', name: 'Barometer Health',
      ...(bit(sensPresent, 3) ? (bit(sensHealth, 3) ? PASS('healthy') : FAIL('unhealthy')) : NA('not present')),
      tip: 'Barometer required for altitude hold modes',
    },

    // ── RC ────────────────────────────────────────────────────────────────────
    {
      group: 'RC', name: 'RC Active',
      ...(rssi > 0 ? PASS(`RSSI ${rssi}`) : FAIL('No RC signal')),
      tip: 'RC signal must be present; rssi > 0',
    },
    {
      group: 'RC', name: 'RC RSSI Quality',
      ...(rssi >= 100 ? PASS(`${rssi}/255`) : rssi >= 50 ? WARN(`${rssi}/255`) : rssi > 0 ? FAIL(`${rssi}/255 — poor signal`) : NA('no signal')),
      tip: 'RSSI ≥ 100/255 recommended; < 50 is poor',
    },

    // ── Vibration ──────────────────────────────────────────────────────────────
    {
      group: 'Vibration', name: 'Vibe X',
      ...(vibX < 15 ? PASS(`${vibX.toFixed(1)} m/s²`) : vibX < 30 ? WARN(`${vibX.toFixed(1)} m/s²`) : FAIL(`${vibX.toFixed(1)} m/s² — HIGH`)),
      tip: 'vibration_x < 15 is ideal; > 30 causes EKF issues',
    },
    {
      group: 'Vibration', name: 'Vibe Y',
      ...(vibY < 15 ? PASS(`${vibY.toFixed(1)} m/s²`) : vibY < 30 ? WARN(`${vibY.toFixed(1)} m/s²`) : FAIL(`${vibY.toFixed(1)} m/s² — HIGH`)),
      tip: 'vibration_y < 15 is ideal',
    },
    {
      group: 'Vibration', name: 'Vibe Z',
      ...(vibZ < 15 ? PASS(`${vibZ.toFixed(1)} m/s²`) : vibZ < 30 ? WARN(`${vibZ.toFixed(1)} m/s²`) : FAIL(`${vibZ.toFixed(1)} m/s² — HIGH`)),
      tip: 'vibration_z < 15 is ideal',
    },
    {
      group: 'Vibration', name: 'Accel Clipping',
      ...((clip0 + clip1 + clip2) === 0 ? PASS('0') : WARN(`${clip0}/${clip1}/${clip2} clips`)),
      tip: 'Accelerometer clipping should be 0; indicates sensor saturation',
    },

    // ── System ────────────────────────────────────────────────────────────────
    {
      group: 'System', name: 'Link Active',
      ...(hbAge < 2 ? PASS(`HB ${hbAge.toFixed(1)}s ago`) : hbAge < 5 ? WARN(`HB ${hbAge.toFixed(1)}s ago`) : FAIL(`HB ${hbAge.toFixed(1)}s ago — stale`)),
      tip: 'Heartbeat must arrive within the last 2 seconds',
    },
    {
      group: 'System', name: 'Arming State',
      ...(!isArmed ? PASS('Disarmed') : WARN('Already armed — pre-arm check for safe state')),
      tip: 'Vehicle should be disarmed before conducting pre-arm checks',
    },
    {
      group: 'System', name: 'Failsafe',
      ...(!failsafe ? PASS('None active') : FAIL('FAILSAFE active!')),
      tip: 'No failsafe should be active before arming',
    },
  ];
}

// ─── Component ────────────────────────────────────────────────────────────────

const PreFlightTab = ({ vehicleState }) => {
  const checks = useMemo(() => buildChecks(vehicleState), [vehicleState]);

  const passCount = checks.filter(c => c.label === 'PASS').length;
  const failCount = checks.filter(c => c.label === 'FAIL').length;
  const warnCount = checks.filter(c => c.label === 'WARN').length;
  const total = checks.length;

  const scoreColor = failCount > 0 ? '#ef4444' : warnCount > 0 ? '#f59e0b' : '#22c55e';
  const readyToArm = failCount === 0;

  // Group checks
  const grouped = {};
  checks.forEach(c => {
    if (!grouped[c.group]) grouped[c.group] = [];
    grouped[c.group].push(c);
  });

  return (
    <div className="preflight-tab-v2">
      {/* Summary header */}
      <div className="preflight-summary">
        <div className="preflight-score" style={{ color: scoreColor }}>
          {passCount}/{total} Checks Passed
        </div>
        <div className="preflight-badges">
          {passCount > 0 && <span className="pf-badge pass">{passCount} PASS</span>}
          {warnCount > 0 && <span className="pf-badge warn">{warnCount} WARN</span>}
          {failCount > 0 && <span className="pf-badge fail">{failCount} FAIL</span>}
        </div>
        <div className="preflight-arm-status" style={{ color: readyToArm ? '#22c55e' : '#ef4444' }}>
          {!vehicleState ? '⊘ Disconnected' : readyToArm ? '✓ Ready to Arm' : '✗ Not Ready to Arm'}
        </div>
      </div>

      {/* Check list grouped */}
      <div className="preflight-list">
        {Object.entries(grouped).map(([group, rows]) => (
          <div key={group} className="pf-group">
            <div className="pf-group-header">{group}</div>
            {rows.map(c => (
              <div key={c.name} className="pf-row" title={c.tip}>
                <div className="pf-name">{c.name}</div>
                <div className="pf-value">{c.value}</div>
                <div className="pf-badge-inline" style={{ color: c.color, borderColor: c.color }}>
                  {c.label}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

export default PreFlightTab;
