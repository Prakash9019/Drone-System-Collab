import React, { useEffect, useState } from 'react';
import axios from 'axios';
import useTelemetryStore, { selectPrimaryVehicle } from '../../store/useTelemetryStore';

const API = 'http://localhost:8080/api';

const COPTER_MODES = [
  { v: 0,  l: 'Stabilize' },
  { v: 1,  l: 'Acro' },
  { v: 2,  l: 'AltHold' },
  { v: 3,  l: 'Auto' },
  { v: 4,  l: 'Guided' },
  { v: 5,  l: 'Loiter' },
  { v: 6,  l: 'RTL' },
  { v: 7,  l: 'Circle' },
  { v: 9,  l: 'Land' },
  { v: 11, l: 'Drift' },
  { v: 13, l: 'Sport' },
  { v: 14, l: 'Flip' },
  { v: 15, l: 'AutoTune' },
  { v: 16, l: 'PosHold' },
  { v: 17, l: 'Brake' },
  { v: 18, l: 'Throw' },
  { v: 19, l: 'Avoid_ADSB' },
  { v: 20, l: 'Guided_NoGPS' },
  { v: 21, l: 'Smart_RTL' },
  { v: 22, l: 'FlowHold' },
  { v: 23, l: 'Follow' },
  { v: 24, l: 'ZigZag' },
  { v: 25, l: 'SystemID' },
  { v: 26, l: 'Heli_Autorotate' },
];

const FLTMODE_LABELS = [
  { param: 'FLTMODE1', label: 'Flight Mode 1 (lowest PWM)' },
  { param: 'FLTMODE2', label: 'Flight Mode 2' },
  { param: 'FLTMODE3', label: 'Flight Mode 3' },
  { param: 'FLTMODE4', label: 'Flight Mode 4' },
  { param: 'FLTMODE5', label: 'Flight Mode 5' },
  { param: 'FLTMODE6', label: 'Flight Mode 6 (highest PWM)' },
];

// Comprehensive mode reference — matches ArduPilot Copter documentation
const MODE_DOCS = {
  Stabilize: {
    purpose: 'Manual attitude control with self-leveling. Motors stay on when armed.',
    behavior: 'Pilot controls roll/pitch angles directly. Throttle controls motor speed. Release sticks → returns to level. No altitude or position hold.',
    sensors: 'Gyroscope, Accelerometer',
    pilotControl: 'Full — roll, pitch, yaw, throttle all manual',
    gps: 'Not required',
    useCase: 'Learning to fly, manual aerobatics, testing motor/control response, flying without GPS.',
    safety: 'If you release throttle the drone will descend. Always maintain throttle awareness.',
    color: '#3b82f6',
  },
  Acro: {
    purpose: 'Rate-based control for aerobatics. No self-leveling.',
    behavior: 'Pilot controls rotation RATES not angles. Releasing sticks stops rotation but vehicle stays at whatever angle it reached. Requires significant skill.',
    sensors: 'Gyroscope',
    pilotControl: 'Full rate control — very responsive, no stabilization',
    gps: 'Not required',
    useCase: 'Racing, aerobatics, freestyle flying, advanced pilots only.',
    safety: 'Dangerous without experience. Vehicle will not self-level. Easy to crash.',
    color: '#ef4444',
  },
  AltHold: {
    purpose: 'Altitude hold with manual roll/pitch/yaw control.',
    behavior: 'Barometer holds current altitude. Pilot controls roll/pitch/yaw. Throttle centered = hold altitude. Throttle up/down = climb/descend. Releases to hover at current altitude.',
    sensors: 'Gyroscope, Accelerometer, Barometer',
    pilotControl: 'Roll/pitch/yaw manual, altitude auto-held',
    gps: 'Not required',
    useCase: 'General flying when you want altitude stability but manual positioning.',
    safety: 'Wind can still cause horizontal drift. No position hold.',
    color: '#8b5cf6',
  },
  Auto: {
    purpose: 'Fully autonomous waypoint mission execution.',
    behavior: 'Vehicle follows a pre-programmed mission uploaded via GCS. Executes waypoints, actions (takeoff, land, RTL, delay, camera trigger) in sequence. Pilot can override throttle in some configs.',
    sensors: 'GPS, Barometer, Compass, Accelerometer',
    pilotControl: 'None during mission (monitoring only)',
    gps: 'Required — 3D fix minimum',
    useCase: 'Survey mapping, delivery, inspection, any pre-planned autonomous mission.',
    safety: 'Arm with a safe mission loaded. Always have RTL/Loiter override on switch.',
    color: '#10b981',
  },
  Guided: {
    purpose: 'Position/velocity targeting via external GCS command (MAVLink).',
    behavior: 'GCS sends SET_POSITION_TARGET_GLOBAL_INT or SET_ATTITUDE_TARGET. Vehicle navigates to commanded position autonomously. Used by companion computers and ground control software.',
    sensors: 'GPS, Barometer, Compass, Accelerometer',
    pilotControl: 'Minimal — commanded from ground software',
    gps: 'Required',
    useCase: 'Companion computer control, precision landing, point-and-click navigation in GCS.',
    safety: 'Commands come from software — validate GCS/companion connection before use.',
    color: '#f59e0b',
  },
  Loiter: {
    purpose: 'GPS position hold. Holds current lat/lon/altitude against wind.',
    behavior: 'Uses GPS + barometer to maintain exact position. Stick inputs move the vehicle from the hold point. Release sticks → brakes and holds new position. Like AltHold but with GPS horizontal hold.',
    sensors: 'GPS, Barometer, Compass, Accelerometer',
    pilotControl: 'Roll/pitch = move from hold point, releases to new hold',
    gps: 'Required — good HDOP recommended',
    useCase: 'Photography, hovering in wind, precision positioning, beginner-friendly.',
    safety: 'GPS glitch can cause position jump. Keep clear of obstacles on all sides.',
    color: '#06b6d4',
  },
  RTL: {
    purpose: 'Return to Launch — autonomous return home and land.',
    behavior: 'Climbs to RTL_ALT (if below it), flies to home position at current altitude, then descends and lands. Home is set at arming location unless explicitly changed.',
    sensors: 'GPS, Barometer, Compass',
    pilotControl: 'None — fully autonomous',
    gps: 'Required',
    useCase: 'Battery failsafe return, emergency recall, end-of-mission return.',
    safety: 'Ensure home position was set correctly at arming. Set RTL_ALT high enough to clear obstacles.',
    color: '#f97316',
  },
  Land: {
    purpose: 'Descend and land at current position.',
    behavior: 'Vehicle descends at LAND_SPEED (cm/s) until it detects landing (low throttle) then disarms motors. Does not move horizontally — lands directly below current position.',
    sensors: 'Barometer, Accelerometer (GPS optional)',
    pilotControl: 'None — auto descent',
    gps: 'Not required (uses baro)',
    useCase: 'Emergency landing, end of flight when already in correct position.',
    safety: 'Ensure area below is clear. Vehicle will not move horizontally to avoid obstacles.',
    color: '#64748b',
  },
  Circle: {
    purpose: 'Orbit a fixed point at a constant radius.',
    behavior: 'Vehicle circles around a point (set when mode entered) at CIRCLE_RADIUS and CIRCLE_RATE. Nose points to center. Pilot can adjust altitude with throttle.',
    sensors: 'GPS, Barometer, Compass',
    pilotControl: 'Altitude only',
    gps: 'Required',
    useCase: 'Cinematic orbiting shots, area surveillance.',
    safety: 'Set radius large enough to avoid obstacles in circular path.',
    color: '#a78bfa',
  },
  PosHold: {
    purpose: 'GPS position hold with soft stick feel (improved Loiter).',
    behavior: 'Similar to Loiter but with better stick feel. Small stick inputs give smooth velocity control. Large inputs give faster movement. Releases to hold position.',
    sensors: 'GPS, Barometer, Compass',
    pilotControl: 'Velocity-based with position hold on release',
    gps: 'Required',
    useCase: 'Photography, cinematic flying, general GPS-assisted flight.',
    safety: 'Preferred over Loiter for general flying due to better feel.',
    color: '#06b6d4',
  },
  Brake: {
    purpose: 'Immediately stops and holds position.',
    behavior: 'When activated, vehicle applies maximum braking force to stop all movement. Holds the stopped position. Useful as emergency stop when Loiter/PosHold drift is unacceptable.',
    sensors: 'GPS, Barometer, Compass, Accelerometer',
    pilotControl: 'None — automatic braking',
    gps: 'Required',
    useCase: 'Emergency stop, precision halt during fast maneuvers.',
    safety: 'Very effective emergency stop mode. Switch to Loiter after braking.',
    color: '#dc2626',
  },
  Smart_RTL: {
    purpose: 'Returns home along the recorded outbound path.',
    behavior: 'Vehicle records waypoints as it flies away from home. On Smart RTL, it retraces this path in reverse. Avoids obstacles along the route if outbound path was obstacle-free.',
    sensors: 'GPS, Barometer, Compass',
    pilotControl: 'None — autonomous',
    gps: 'Required',
    useCase: 'Complex terrain where direct RTL path may hit obstacles (e.g., flying around a building).',
    safety: 'Requires flight from home (does not work if armed without flying first).',
    color: '#f97316',
  },
  AutoTune: {
    purpose: 'Automatic PID gain tuning.',
    behavior: 'Vehicle performs systematic twitches on roll/pitch axes to measure and optimize PID gains. Saves new gains to EEPROM when complete. Must start in AltHold, then switch to AutoTune.',
    sensors: 'Gyroscope, Accelerometer, Barometer',
    pilotControl: 'None during tuning — maintain hover position',
    gps: 'Not required',
    useCase: 'First-time setup, after hardware changes, performance optimization.',
    safety: 'Fly in calm conditions, large open area, plenty of altitude. Vehicle may twitch aggressively.',
    color: '#84cc16',
  },
  Guided_NoGPS: {
    purpose: 'Guided mode without GPS (attitude/rate targets only).',
    behavior: 'Similar to Guided but uses attitude targets instead of position targets. Designed for indoor use or GPS-denied environments with companion computer control.',
    sensors: 'Gyroscope, Accelerometer, Optical flow (optional)',
    pilotControl: 'External computer sends attitude targets',
    gps: 'Not required',
    useCase: 'Indoor autonomous flight, visual odometry systems, GPS-denied operations.',
    safety: 'No position hold — drift is possible. Companion computer must be reliable.',
    color: '#f59e0b',
  },
};

const InfoCard = ({ mode }) => {
  const doc = MODE_DOCS[mode];
  if (!doc) return null;
  return (
    <div style={{
      padding: '10px 14px',
      background: `${doc.color}18`,
      border: `1px solid ${doc.color}44`,
      borderRadius: 8,
      fontSize: 12,
      lineHeight: 1.6,
      marginTop: 8,
    }}>
      <div style={{ fontWeight: 700, color: doc.color, marginBottom: 4 }}>{mode}</div>
      <div style={{ marginBottom: 4 }}><strong>Purpose:</strong> {doc.purpose}</div>
      <div style={{ marginBottom: 4 }}><strong>Behavior:</strong> {doc.behavior}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <span><strong>Sensors:</strong> {doc.sensors}</span>
        <span><strong>GPS:</strong> {doc.gps}</span>
        <span><strong>Pilot input:</strong> {doc.pilotControl}</span>
      </div>
      <div style={{ marginTop: 4, color: '#fbbf24' }}><strong>Use case:</strong> {doc.useCase}</div>
      {doc.safety && <div style={{ marginTop: 4, color: '#f87171' }}><strong>Safety:</strong> {doc.safety}</div>}
    </div>
  );
};

export default function FlightModeConfig() {
  const vehicle = useTelemetryStore(selectPrimaryVehicle) || {};
  const currentMode = String(vehicle?.status?.mode || '').toUpperCase();

  const [modes, setModes] = useState({ FLTMODE1: 0, FLTMODE2: 2, FLTMODE3: 3, FLTMODE4: 5, FLTMODE5: 6, FLTMODE6: 9 });
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [showDocs, setShowDocs] = useState(false);
  const [hoveredMode, setHoveredMode] = useState(null);

  useEffect(() => {
    setLoading(true);
    axios.get(`${API}/setup/flight_modes`)
      .then(r => {
        const m = r.data?.modes || {};
        setModes(prev => {
          const next = { ...prev };
          Object.entries(m).forEach(([k, v]) => { if (v != null) next[k] = Number(v); });
          return next;
        });
        setStatus('Loaded from vehicle.');
      })
      .catch(e => setStatus(`Load failed: ${e.response?.data?.detail || e.message}`))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setLoading(true);
    setStatus('Writing flight modes…');
    try {
      const res = await axios.post(`${API}/setup/flight_modes`, { modes });
      const results = res.data?.results || {};
      const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
      if (failed.length) {
        setStatus(`Partial write — failed: ${failed.join(', ')}`);
      } else {
        setStatus(`All ${Object.keys(results).length} flight mode(s) written successfully.`);
      }
    } catch (e) {
      setStatus(`Error: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const modeNameOf = (v) => COPTER_MODES.find(m => m.v === Number(v))?.l || `Mode ${v}`;

  return (
    <div className="setup-section">
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
        Assign ArduPilot flight modes to RC switch positions (<code>FLTMODE_CH</code>, typically CH5).
        Current active mode: <strong style={{ color: '#34d399' }}>{currentMode || '—'}</strong>
      </p>

      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14, padding: '8px 12px', background: 'rgba(59,130,246,0.08)', borderRadius: 6, border: '1px solid rgba(59,130,246,0.2)' }}>
        <strong>How RC mode switching works:</strong> The RC transmitter switch on CH5 (or FLTMODE_CH) outputs a PWM value
        between ~1000–2000 µs. ArduPilot maps PWM ranges to FLTMODE1–6: low PWM = Mode1, high PWM = Mode6.
        A 3-position switch typically gives access to 3 of the 6 modes. A 6-position switch gives full access.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        {FLTMODE_LABELS.map(({ param, label }) => {
          const val = modes[param] ?? 0;
          const modeName = modeNameOf(val);
          const isCurrent = modeName.toUpperCase() === currentMode;
          const doc = MODE_DOCS[modeName];
          return (
            <div key={param}>
              <label style={{ fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                  {isCurrent && <span style={{ fontSize: 10, color: '#34d399', fontWeight: 700 }}>ACTIVE</span>}
                </div>
                <select
                  className="setup-select"
                  value={val}
                  onChange={e => {
                    setModes(m => ({ ...m, [param]: Number(e.target.value) }));
                    setHoveredMode(modeNameOf(Number(e.target.value)));
                  }}
                  onFocus={() => setHoveredMode(modeName)}
                  disabled={loading}
                  style={{ borderColor: isCurrent ? '#34d399' : undefined, width: '100%' }}
                >
                  {COPTER_MODES.map(opt => (
                    <option key={opt.v} value={opt.v}>{opt.v} — {opt.l}</option>
                  ))}
                </select>
              </label>
              {doc && (
                <div style={{ fontSize: 11, color: doc.color, marginTop: 3, paddingLeft: 2 }}>
                  {doc.purpose.split('.')[0]}.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Summary row */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {FLTMODE_LABELS.map(({ param }) => {
          const name = modeNameOf(modes[param]);
          const doc = MODE_DOCS[name];
          return (
            <span key={param} style={{ fontSize: 11, padding: '2px 8px', background: doc ? `${doc.color}18` : 'rgba(59,130,246,0.12)', borderRadius: 4, border: `1px solid ${doc ? doc.color + '44' : 'rgba(59,130,246,0.3)'}`, color: doc?.color || '#93c5fd' }}>
              {param}: {name}
            </span>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className="btn-toolbar primary" onClick={save} disabled={loading}>
          {loading ? 'Writing…' : 'Write Flight Modes to Vehicle'}
        </button>
        <button
          className="btn-toolbar"
          onClick={() => setShowDocs(v => !v)}
          style={{ fontSize: 12 }}
        >
          {showDocs ? 'Hide Mode Reference' : 'Show Mode Reference'}
        </button>
      </div>

      {status && (
        <div style={{ marginBottom: 12, fontSize: 12, color: status.includes('fail') || status.includes('Error') ? '#fca5a5' : 'var(--text-secondary)' }}>
          {status}
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 16 }}>
        <strong>Note:</strong> Changes are written immediately via PARAM_SET. Reboot the FC to apply cleanly.
        The RC switch channel is controlled by <code>FLTMODE_CH</code> (default: 5).
        Switch positions map to modes based on PWM thresholds (see ArduPilot docs for exact ranges).
      </div>

      {/* Full Mode Reference Panel */}
      {showDocs && (
        <div>
          <h3 style={{ fontSize: 14, marginBottom: 12, color: 'var(--text-secondary)' }}>
            Flight Mode Reference — ArduPilot Copter
          </h3>

          {/* ARM / DISARM special cases */}
          <div style={{ padding: '10px 14px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 8, fontSize: 12, marginBottom: 10 }}>
            <div style={{ fontWeight: 700, color: '#10b981', marginBottom: 4 }}>ARM (not a flight mode)</div>
            <div><strong>What it does:</strong> Enables motor output. After arming, Stabilize/AltHold/etc. modes will spin motors on throttle input. Arming requires pre-flight checks to pass (GPS lock, EKF health, etc. depending on config).</div>
            <div style={{ marginTop: 4 }}><strong>How to arm:</strong> Hold throttle down + yaw right for ~2 seconds (default). Or use GCS/MAVLink command. Requires: DISARMED state, EKF healthy, GPS fix (if required by ARMING_CHECK).</div>
            <div style={{ marginTop: 4, color: '#fbbf24' }}><strong>Safety:</strong> NEVER arm near people. Props can cause severe injury. Always verify DISARMED before handling vehicle.</div>
          </div>

          <div style={{ padding: '10px 14px', background: 'rgba(100,116,139,0.1)', border: '1px solid rgba(100,116,139,0.3)', borderRadius: 8, fontSize: 12, marginBottom: 10 }}>
            <div style={{ fontWeight: 700, color: '#94a3b8', marginBottom: 4 }}>DISARM (not a flight mode)</div>
            <div><strong>What it does:</strong> Stops all motor output immediately. Safe state for handling vehicle.</div>
            <div style={{ marginTop: 4 }}><strong>How to disarm:</strong> Hold throttle down + yaw left for ~2 seconds, or land and let auto-disarm trigger (DISARM_DELAY). Emergency disarm: press safety switch (if fitted).</div>
          </div>

          {/* Individual mode docs */}
          {Object.entries(MODE_DOCS).map(([name, doc]) => (
            <div key={name} style={{ marginBottom: 10 }}>
              <InfoCard mode={name} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
