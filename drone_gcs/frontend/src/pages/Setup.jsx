import React, { useState } from 'react';
import axios from 'axios';
import useTelemetryStore, { selectPrimaryVehicle } from '../store/useTelemetryStore';
import AccelCalibration from '../components/setup/AccelCalibration';
import CompassCalibration from '../components/setup/CompassCalibration';
import RadioCalibration from '../components/setup/RadioCalibration';
import FlightModeConfig from '../components/setup/FlightModeConfig';
import FailsafeConfig from '../components/setup/FailsafeConfig';
import BatteryMonitor from '../components/setup/BatteryMonitor';
import MotorTest from '../components/setup/MotorTest';
import Params from './Params';

const API = 'http://localhost:8080/api';

const SETUP_TABS = [
  { id: 'CAL',       label: 'Calibration' },
  { id: 'RADIO',     label: 'Radio Cal' },
  { id: 'FLTMODES',  label: 'Flight Modes' },
  { id: 'FAILSAFE',  label: 'Failsafe' },
  { id: 'BATTERY',   label: 'Battery' },
  { id: 'MOTORTEST', label: 'Motor Test' },
  { id: 'PARAMS',    label: 'Parameters' },
];

const QUICK_CAL_ITEMS = [
  {
    id: 'level',
    label: 'Level Horizon',
    icon: '—',
    hint: 'MAV_CMD_PREFLIGHT_CALIBRATION p5=2',
    danger: false,
    doc: {
      what: 'Level calibration corrects the IMU trim — it tells the FC what "flat" looks like for attitude estimation.',
      when: 'Run if the artificial horizon shows a tilt when the vehicle is sitting perfectly level on a flat surface.',
      how: 'Place vehicle on a flat, level surface. Click Run. The FC samples the accelerometer and stores trim offsets to AHRS_TRIM_X/Y/Z.',
      mavlink: 'MAV_CMD_PREFLIGHT_CALIBRATION (241), param5=2 (board level cal)',
    },
  },
  {
    id: 'esc',
    label: 'ESC Calibration',
    icon: '⚡',
    hint: 'MAV_CMD_PREFLIGHT_CALIBRATION p1=3 — REMOVE PROPS FIRST',
    danger: true,
    doc: {
      what: 'ESC throttle-range calibration synchronizes all ESCs so they respond identically to the same PWM signal.',
      when: 'Run when replacing ESCs, motors, or if motors spin at different speeds at the same throttle.',
      how: 'REMOVE ALL PROPELLERS. With vehicle powered, the FC raises throttle to max then min, teaching each ESC the full PWM range (1000–2000 µs). ESCs will beep to confirm.',
      mavlink: 'MAV_CMD_PREFLIGHT_CALIBRATION (241), param1=3',
      safety: 'REMOVE PROPS BEFORE ESC CALIBRATION. Motors will spin at high speed without control.',
    },
  },
  {
    id: 'gyro',
    label: 'Gyro Calibration',
    icon: '↺',
    hint: 'MAV_CMD_PREFLIGHT_CALIBRATION p1=1 — keep vehicle still',
    danger: false,
    doc: {
      what: 'Gyroscope calibration measures and removes sensor bias (drift at rest). The gyro reports small non-zero rotation rates when stationary — this calibration zeros them out.',
      when: 'Run automatically at each boot. Manually run if the vehicle drifts in Stabilize when perfectly still.',
      how: 'Place vehicle on flat surface. Do not move it during calibration (about 1 second). FC samples gyro at rest and subtracts the measured bias.',
      mavlink: 'MAV_CMD_PREFLIGHT_CALIBRATION (241), param1=1',
    },
  },
  {
    id: 'reboot',
    label: 'Reboot FC',
    icon: '⟳',
    hint: 'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN p1=1',
    danger: false,
    doc: {
      what: 'Sends a reboot command to the flight controller. Required after some calibrations and parameter changes.',
      when: 'After accelerometer/compass calibration, after parameter changes that need reboot, when FC becomes unresponsive.',
      how: 'Click Run. The FC will reboot and reconnect in ~10–15 seconds.',
      mavlink: 'MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN (246), param1=1',
    },
  },
];

// Inline calibration documentation cards
const CAL_EXPLANATIONS = [
  {
    id: 'accel',
    title: 'Accelerometer Calibration',
    color: '#3b82f6',
    sections: [
      {
        label: 'What is the accelerometer?',
        text: 'The accelerometer measures linear acceleration in X/Y/Z axes (including gravity). ArduPilot uses it to determine attitude (roll/pitch) and feed the EKF (Extended Kalman Filter) for state estimation.',
      },
      {
        label: 'Why calibrate?',
        text: 'Factory sensors have scale factor and bias errors. Without calibration, the FC perceives a tilted attitude even when level, causing the drone to drift or flip. Calibration measures the actual gravity vector in 6 orientations to compute accurate offsets.',
      },
      {
        label: '6-position calibration logic',
        text: 'The FC requests 6 vehicle positions (Level, Left side, Right side, Nose Down, Nose Up, Upside Down). For each position, gravity points along a different axis, letting the algorithm solve for all 3-axis biases and scale factors simultaneously.',
      },
      {
        label: 'MAVLink flow',
        text: 'Send MAV_CMD_PREFLIGHT_CALIBRATION (241, p5=1) → FC starts calibration → FC sends STATUSTEXT requesting each position → GCS sends MAV_CMD_ACCELCAL_VEHICLE_POS (42429) to confirm each position → FC writes ACCEL_CALX/CALY/CALZ params → reboot to apply.',
      },
      {
        label: 'When to recalibrate',
        text: 'After mounting hardware changes, after crash/impact, when level horizon drifts after level calibration, when vehicle consistently drifts in Stabilize despite good GPS/compass.',
      },
    ],
  },
  {
    id: 'compass',
    title: 'Compass / Magnetometer Calibration',
    color: '#8b5cf6',
    sections: [
      {
        label: 'What does the compass do?',
        text: 'The magnetometer (compass) measures Earth\'s magnetic field to determine heading (yaw). It is critical for GPS-assisted modes (Loiter, Auto, RTL) where the FC needs to know which direction is "forward" to navigate correctly.',
      },
      {
        label: 'Hard iron vs soft iron errors',
        text: 'Hard iron errors: constant offsets caused by permanent magnets on the frame (motors, battery). Soft iron errors: field distortions from ferrous materials that scale with the local field direction. ArduPilot calibrates both using a rotation-based algorithm.',
      },
      {
        label: 'Live rotation calibration',
        text: 'You rotate the vehicle slowly in all orientations (360° on all 3 axes). The magnetometer samples the magnetic field from many directions, fitting an ellipsoid to the data. The ellipsoid center gives hard-iron offsets; its shape gives soft-iron correction matrix.',
      },
      {
        label: 'How offsets are calculated',
        text: 'ArduPilot uses a least-squares ellipsoid fit. The result is stored in COMPASS_OFS_X/Y/Z (hard iron offsets) and COMPASS_DIA_X/Y/Z, COMPASS_ODI_X/Y/Z (soft iron matrix). Fitness value indicates calibration quality (lower = better, < 10 is good).',
      },
      {
        label: 'GPS + heading relation',
        text: 'GPS provides position but NOT heading. The compass provides heading. In Loiter/Auto, the FC uses compass heading to know which direction to apply roll/pitch commands to achieve desired navigation direction. A bad compass = GPS modes will circle or navigate incorrectly.',
      },
      {
        label: 'When to recalibrate',
        text: 'After any changes to the vehicle frame (new battery, ESC swap, adding payload). When flying in a new location with different local magnetic field. After a crash. If yaw drifts or vehicle doesn\'t fly straight in GPS modes.',
      },
      {
        label: 'MAVLink flow',
        text: 'Send MAV_CMD_DO_START_MAG_CAL (42424, p1=0 all compasses, p2=1 retry, p3=1 autosave) → Rotate vehicle → FC reports MAG_CAL_PROGRESS messages → On success FC reports MAG_CAL_REPORT with offsets → Reboot recommended.',
      },
    ],
  },
];

function CalExplanation({ item, expanded, onToggle }) {
  return (
    <div style={{ marginBottom: 8, border: `1px solid ${item.color}33`, borderRadius: 8, overflow: 'hidden' }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          textAlign: 'left',
          background: `${item.color}12`,
          border: 'none',
          padding: '10px 14px',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          color: item.color,
          fontWeight: 600,
          fontSize: 13,
        }}
      >
        <span>How it works: {item.title}</span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>{expanded ? 'collapse ▲' : 'expand ▼'}</span>
      </button>
      {expanded && (
        <div style={{ padding: '12px 14px', fontSize: 12, lineHeight: 1.7 }}>
          {item.sections.map(s => (
            <div key={s.label} style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 700, color: item.color, marginBottom: 2 }}>{s.label}</div>
              <div style={{ color: 'var(--text-secondary)' }}>{s.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QuickCalCard({ item, busy, armed, onRun, expanded, onToggle }) {
  return (
    <div className={`setup-cal-quick ${item.danger ? 'danger' : ''}`} style={{ position: 'relative' }}>
      <div style={{ fontSize: 22, marginBottom: 6 }}>{item.icon}</div>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{item.label}</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>{item.hint}</div>
      <button
        className={`btn-toolbar ${item.danger ? 'danger' : 'primary'}`}
        disabled={!!busy || (armed && item.id !== 'reboot')}
        onClick={() => onRun(item.id)}
        style={{ marginBottom: 6 }}
      >
        {busy === item.id ? 'Running…' : 'Run'}
      </button>
      <button
        onClick={onToggle}
        style={{ fontSize: 11, background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '2px 0' }}
      >
        {expanded ? 'Hide info ▲' : 'Show info ▼'}
      </button>
      {expanded && item.doc && (
        <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.6, textAlign: 'left', borderTop: '1px solid var(--border-color)', paddingTop: 8 }}>
          <div style={{ marginBottom: 4 }}><strong>What:</strong> {item.doc.what}</div>
          <div style={{ marginBottom: 4 }}><strong>When:</strong> {item.doc.when}</div>
          <div style={{ marginBottom: 4 }}><strong>How:</strong> {item.doc.how}</div>
          <div style={{ color: '#93c5fd' }}><strong>MAVLink:</strong> {item.doc.mavlink}</div>
          {item.doc.safety && (
            <div style={{ marginTop: 4, color: '#f87171' }}><strong>Safety:</strong> {item.doc.safety}</div>
          )}
        </div>
      )}
    </div>
  );
}

function CalibrationTab({ armed }) {
  const [busy, setBusy] = useState('');
  const [calStatus, setCalStatus] = useState('');
  const [expandedDocs, setExpandedDocs] = useState({});
  const [expandedCards, setExpandedCards] = useState({});

  const runQuickCal = async (kind) => {
    if (armed && kind !== 'reboot') {
      setCalStatus(`${kind} blocked: disarm vehicle first.`);
      return;
    }
    setBusy(kind);
    setCalStatus(`Running ${kind}…`);
    try {
      const res = await axios.post(`${API}/calibration/run`, { kind });
      setCalStatus(`${kind}: ${res.data?.mav_result_text || res.data?.status || 'command sent'}`);
    } catch (e) {
      const d = e.response?.data;
      setCalStatus(`${kind} failed: ${d?.detail || d?.error || e.message}`);
    } finally {
      setBusy('');
    }
  };

  const toggleDoc = (id) => setExpandedDocs(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleCard = (id) => setExpandedCards(prev => ({ ...prev, [id]: !prev[id] }));

  return (
    <div>
      {/* ── Accelerometer ── */}
      <div className="setup-cal-card">
        <div className="setup-cal-card-header">
          <span>Accelerometer Calibration</span>
          <span className="setup-badge">MAV_CMD 241 · p5=1</span>
        </div>
        <p className="setup-cal-desc">
          6-position calibration. Place vehicle in each orientation shown and confirm.
          Vehicle must be <strong>DISARMED</strong> and <strong>STATIONARY</strong> during each position.
          Required sensors: accelerometer, IMU.
        </p>
        <AccelCalibration armed={armed} />
        <div style={{ marginTop: 10 }}>
          <CalExplanation
            item={CAL_EXPLANATIONS[0]}
            expanded={!!expandedDocs['accel']}
            onToggle={() => toggleDoc('accel')}
          />
        </div>
      </div>

      {/* ── Compass ── */}
      <div className="setup-cal-card">
        <div className="setup-cal-card-header">
          <span>Compass / Magnetometer Calibration</span>
          <span className="setup-badge">MAV_CMD 42424</span>
        </div>
        <p className="setup-cal-desc">
          Rotate vehicle slowly in all axes (360° in multiple orientations) until calibration completes.
          Move <strong>10+ meters away</strong> from metal objects, electronics, and reinforced concrete.
          Required for GPS-assisted flight modes (Loiter, Auto, RTL).
        </p>
        <CompassCalibration armed={armed} />
        <div style={{ marginTop: 10 }}>
          <CalExplanation
            item={CAL_EXPLANATIONS[1]}
            expanded={!!expandedDocs['compass']}
            onToggle={() => toggleDoc('compass')}
          />
        </div>
      </div>

      {/* ── Quick calibration items ── */}
      <div style={{ marginTop: 16, marginBottom: 8, fontWeight: 600, fontSize: 13, color: 'var(--text-secondary)' }}>
        Quick Calibration Actions
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        {QUICK_CAL_ITEMS.map(c => (
          <QuickCalCard
            key={c.id}
            item={c}
            busy={busy}
            armed={armed}
            onRun={runQuickCal}
            expanded={!!expandedCards[c.id]}
            onToggle={() => toggleCard(c.id)}
          />
        ))}
      </div>

      {calStatus && (
        <div style={{ marginTop: 10, fontSize: 13, color: calStatus.includes('fail') || calStatus.includes('block') ? '#fca5a5' : 'var(--text-secondary)' }}>
          {calStatus}
        </div>
      )}

      {/* ── Radio Calibration Info ── */}
      <div style={{ marginTop: 20, padding: '12px 14px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 8, fontSize: 12 }}>
        <div style={{ fontWeight: 700, color: '#f59e0b', marginBottom: 6 }}>Radio Calibration — how it works</div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <p style={{ margin: '0 0 6px' }}>RC calibration records the minimum and maximum PWM output of your transmitter for each channel. The FC uses these limits to normalize stick inputs to a -1 to +1 range.</p>
          <p style={{ margin: '0 0 6px' }}><strong>Channels:</strong> CH1=Roll, CH2=Pitch, CH3=Throttle, CH4=Yaw, CH5=Flight Mode switch, CH6-8=Aux</p>
          <p style={{ margin: '0 0 6px' }}><strong>PWM range:</strong> Typically 1000–2000 µs. Center/trim position is stored in RC_TRIM. Dead zones (RC_DZ) prevent small stick inputs from commanding movement.</p>
          <p style={{ margin: 0 }}><strong>Reversed channels:</strong> Set RC_REVERSED=1 for channels where movement direction is backwards from expected.</p>
        </div>
      </div>

      {/* ── Battery Failsafe Info ── */}
      <div style={{ marginTop: 12, padding: '12px 14px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, fontSize: 12 }}>
        <div style={{ fontWeight: 700, color: '#f87171', marginBottom: 6 }}>Battery Failsafe — how it works</div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <p style={{ margin: '0 0 6px' }}>The FC monitors battery voltage and mAh consumed continuously. When voltage drops below FS_BATT_VOLTAGE or remaining capacity drops below FS_BATT_MAH, the failsafe action triggers.</p>
          <p style={{ margin: '0 0 6px' }}><strong>Actions available:</strong> Land immediately, Return to Launch (RTL), Smart RTL (retraces path), Terminate (disarm — use only with parachute).</p>
          <p style={{ margin: 0 }}><strong>Critical battery:</strong> A second, lower threshold triggers a more aggressive action (usually Land) regardless of what the first failsafe was set to.</p>
        </div>
      </div>

      {/* ── Motor Test Info ── */}
      <div style={{ marginTop: 12, padding: '12px 14px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 8, fontSize: 12 }}>
        <div style={{ fontWeight: 700, color: '#34d399', marginBottom: 6 }}>Motor Test — how it works</div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <p style={{ margin: '0 0 6px' }}>Motor test uses MAV_CMD_DO_MOTOR_TEST (209) to spin individual motors at a specified throttle percentage for a set duration. This validates motor order, direction, and ESC response.</p>
          <p style={{ margin: '0 0 6px' }}><strong>Motor order:</strong> ArduPilot Copter uses a standard motor numbering scheme (Motor 1 = front-right for quad+). Verify each motor spins in the correct direction (check prop rotation direction).</p>
          <p style={{ margin: '0 0 6px' }}><strong>Safety:</strong> Remove propellers before motor testing. Maximum throttle is capped at 30% in this GCS. Vehicle must be DISARMED.</p>
          <p style={{ margin: 0 }}><strong>ESC sync:</strong> If one motor spins faster than others at the same throttle, run ESC calibration first.</p>
        </div>
      </div>
    </div>
  );
}

const Setup = () => {
  const [tab, setTab] = useState('CAL');
  const vehicle = useTelemetryStore(selectPrimaryVehicle) || {};
  const armed = !!vehicle?.status?.armed;
  const connected = !!vehicle?.status;

  const gpsFix = Number(vehicle?.status?.gps_fix ?? 0);
  const sats = Number(vehicle?.status?.satellites ?? 0);
  const battery = Number(vehicle?.battery?.remaining ?? 0);
  const voltage = Number(vehicle?.battery?.voltage ?? 0);
  const mode = String(vehicle?.status?.mode || '—');

  return (
    <div className="setup-page">
      {/* Status bar */}
      <div className="setup-status-bar">
        <span className={`setup-status-chip ${connected ? 'ok' : 'err'}`}>
          {connected ? '● Connected' : '○ Disconnected'}
        </span>
        <span className={`setup-status-chip ${armed ? 'warn' : 'ok'}`}>
          {armed ? '⚠ ARMED' : '✓ Disarmed'}
        </span>
        <span className="setup-status-chip">
          GPS: fix {gpsFix} · {sats} sats
        </span>
        <span className={`setup-status-chip ${battery < 20 ? 'err' : battery < 40 ? 'warn' : 'ok'}`}>
          Batt: {battery}% {voltage > 0 ? `(${voltage.toFixed(1)}V)` : ''}
        </span>
        <span className="setup-status-chip">Mode: {mode}</span>
      </div>

      {/* Tab bar */}
      <div className="setup-tab-bar">
        {SETUP_TABS.map(t => (
          <button
            key={t.id}
            className={`setup-tab-btn ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="setup-content">
        {tab === 'CAL'       && <CalibrationTab armed={armed} />}
        {tab === 'RADIO'     && <RadioCalibration />}
        {tab === 'FLTMODES'  && <FlightModeConfig />}
        {tab === 'FAILSAFE'  && <FailsafeConfig />}
        {tab === 'BATTERY'   && <BatteryMonitor />}
        {tab === 'MOTORTEST' && <MotorTest />}
        {tab === 'PARAMS'    && <Params />}
      </div>
    </div>
  );
};

export default Setup;
