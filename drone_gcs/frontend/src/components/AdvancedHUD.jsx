import React, { useMemo } from 'react';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function radToDeg(rad) {
  if (rad == null) return 0;
  let d = rad * (180 / Math.PI);
  if (d < 0) d += 360;
  return d;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ─── Sub-components ──────────────────────────────────────────────────────────

// Scrolling compass strip at the top.
function CompassStrip({ heading }) {
  const hdg = isFinite(heading) ? heading : 0;
  // Each degree = 4px. 1440px strip = 360°. We offset so centre = current heading.
  const PX_PER_DEG = 4;
  const STRIP_W = 360 * PX_PER_DEG; // 1440

  // Build cardinal labels
  const labels = useMemo(() => {
    const items = [];
    const cardinals = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let deg = 0; deg <= 360; deg += 5) {
      items.push({ deg, label: cardinals[deg % 360] || null });
    }
    return items;
  }, []);

  // translateX so that the current heading is centered in the 400px strip.
  const containerW = 400; // HUD width, adjust if needed
  const offset = (containerW / 2) - (hdg * PX_PER_DEG);

  return (
    <div className="hud2-compass-wrap">
      <div
        className="hud2-compass-inner"
        style={{ transform: `translateX(${offset}px)`, width: STRIP_W }}
      >
        {labels.map(({ deg, label }) => (
          <div
            key={deg}
            className={`hud2-compass-tick ${label ? 'major' : ''}`}
            style={{ left: deg * PX_PER_DEG }}
          >
            {label && <span className="hud2-compass-label">{label}</span>}
          </div>
        ))}
      </div>
      {/* Centre marker */}
      <div className="hud2-compass-pointer" />
      {/* Heading digital readout */}
      <div className="hud2-compass-readout">{Math.round(hdg).toString().padStart(3, '0')}°</div>
    </div>
  );
}

// Roll arc indicator — matches MP's style with pointer triangle inside arc.
function RollIndicator({ rollDeg }) {
  const R = 58;
  const cx = 100;
  const cy = 66;
  const arcTicks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];

  const toXY = (angleDeg, r) => {
    const a = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  };

  const arcPath = () => {
    const start = toXY(-60, R);
    const end = toXY(60, R);
    return `M ${start.x} ${start.y} A ${R} ${R} 0 0 1 ${end.x} ${end.y}`;
  };

  // Fixed triangle at top (0°) pointing down into arc — this is the reference mark
  const triTip = toXY(0, R - 2);
  const triL   = toXY(-3, R + 8);
  const triR   = toXY( 3, R + 8);

  // Moving pointer — a small triangle that rotates with roll
  const ptrTip = toXY(rollDeg, R + 2);
  const ptrL   = toXY(rollDeg - 3, R + 11);
  const ptrR   = toXY(rollDeg + 3, R + 11);

  return (
    <svg width="200" height="78" className="hud2-roll-svg">
      <path d={arcPath()} className="hud2-roll-arc" />
      {arcTicks.map((t) => {
        const outer = toXY(t, R);
        const tickLen = t === 0 ? 15 : t % 30 === 0 ? 12 : t % 10 === 0 ? 8 : 5;
        const inner = toXY(t, R - tickLen);
        return (
          <line key={t} x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y}
            className={`hud2-roll-tick ${t === 0 ? 'zero' : ''}`} />
        );
      })}
      {/* Fixed reference triangle at top */}
      <polygon
        points={`${triTip.x},${triTip.y} ${triL.x},${triL.y} ${triR.x},${triR.y}`}
        fill="none" stroke="#ffffff" strokeWidth="1.5"
      />
      {/* Moving roll pointer triangle */}
      <polygon
        points={`${ptrTip.x},${ptrTip.y} ${ptrL.x},${ptrL.y} ${ptrR.x},${ptrR.y}`}
        fill="#facc15" stroke="#facc15" strokeWidth="1"
      />
    </svg>
  );
}

// Pitch ladder rendered inside the artificial horizon (MP style — 6px/deg).
function PitchLadder({ pitchDeg, rollDeg }) {
  const PX_PER_DEG = 6;
  const pitchOffset = pitchDeg * PX_PER_DEG;
  const lines = [-45, -40, -35, -30, -25, -20, -15, -10, -5, 5, 10, 15, 20, 25, 30, 35, 40, 45];

  return (
    <div
      className="hud2-horizon-rotate"
      style={{ transform: `rotate(${-rollDeg}deg)` }}
    >
      <div
        className="hud2-horizon-translate"
        style={{ transform: `translateY(${pitchOffset}px)` }}
      >
        <div className="hud2-sky" />
        <div className="hud2-ground" />
        <div className="hud2-horizon-line" />
        {lines.map((deg) => {
          const isMajor = deg % 10 === 0;
          const yOff = -deg * PX_PER_DEG;
          return (
            <div
              key={deg}
              className={`hud2-pitch-line ${isMajor ? 'major' : 'minor'}`}
              style={{ top: `calc(50% + ${yOff}px)` }}
            >
              {isMajor && <span className="hud2-pitch-label left">{Math.abs(deg)}</span>}
              {isMajor && <span className="hud2-pitch-label right">{Math.abs(deg)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Speed tape — vertical scrolling strip on the left.
function SpeedTape({ airspeed, groundspeed }) {
  const speed = isFinite(airspeed) ? airspeed : 0;
  const gs = isFinite(groundspeed) ? groundspeed : 0;
  const PX_PER_UNIT = 8;
  const range = 25; // units visible above and below centre
  const ticks = [];
  const lo = Math.max(0, Math.floor(speed - range));
  const hi = Math.ceil(speed + range);
  for (let v = lo; v <= hi; v++) {
    ticks.push(v);
  }

  return (
    <div className="hud2-tape hud2-tape-left">
      <div className="hud2-tape-label-top">AS</div>
      <div className="hud2-tape-window">
        <div
          className="hud2-tape-track"
          style={{ transform: `translateY(${speed * PX_PER_UNIT}px)` }}
        >
          {ticks.map((v) => (
            <div
              key={v}
              className={`hud2-tape-tick ${v % 5 === 0 ? 'labeled' : ''}`}
              style={{ bottom: v * PX_PER_UNIT }}
            >
              {v % 5 === 0 && <span className="hud2-tape-num">{v}</span>}
            </div>
          ))}
        </div>
        {/* Centre value box */}
        <div className="hud2-tape-value-box">{speed.toFixed(1)}</div>
      </div>
      <div className="hud2-tape-label-bot">GS {gs.toFixed(1)}</div>
    </div>
  );
}

// Altitude tape — vertical scrolling strip on the right.
function AltitudeTape({ altitude, climbRate }) {
  const alt = isFinite(altitude) ? altitude : 0;
  const vsi = isFinite(climbRate) ? climbRate : 0;
  const PX_PER_UNIT = 3;
  const range = 40;
  const lo = Math.floor(alt - range);
  const hi = Math.ceil(alt + range);
  const ticks = [];
  for (let v = lo; v <= hi; v++) {
    ticks.push(v);
  }

  // VSI bar height: ±10 m/s maps to ±40px
  const vsiHeight = clamp(vsi * 4, -40, 40);
  const vsiPositive = vsiHeight >= 0;

  return (
    <div className="hud2-tape hud2-tape-right">
      <div className="hud2-tape-label-top">ALT</div>
      <div className="hud2-tape-window">
        <div
          className="hud2-tape-track"
          style={{ transform: `translateY(${alt * PX_PER_UNIT}px)` }}
        >
          {ticks.map((v) => (
            <div
              key={v}
              className={`hud2-tape-tick ${v % 10 === 0 ? 'labeled' : ''}`}
              style={{ bottom: v * PX_PER_UNIT }}
            >
              {v % 10 === 0 && <span className="hud2-tape-num">{v}</span>}
            </div>
          ))}
        </div>
        <div className="hud2-tape-value-box">{alt.toFixed(1)}</div>
      </div>
      {/* VSI bar on right edge of altitude tape */}
      <div className="hud2-vsi-container">
        <div
          className="hud2-vsi-bar"
          style={{
            height: Math.abs(vsiHeight),
            bottom: vsiPositive ? '50%' : `calc(50% - ${Math.abs(vsiHeight)}px)`,
            backgroundColor: vsiPositive ? '#22c55e' : '#ef4444',
          }}
        />
        <div className="hud2-vsi-label">
          {vsi >= 0 ? '+' : ''}{vsi.toFixed(1)}
        </div>
      </div>
      <div className="hud2-tape-label-bot">m/s</div>
    </div>
  );
}

// Status chips — matches MP's bottom status bar chip order.
function StatusChips({ gpsfix, sats, hdop, ekfHealth, isArmed, failsafe, mode, vibe, prearmText }) {
  const gpsLabel = (() => {
    if (gpsfix >= 6) return { text: `RTK Fixed ${sats}`, color: '#22c55e' };
    if (gpsfix >= 5) return { text: `RTK Float ${sats}`, color: '#4ade80' };
    if (gpsfix >= 4) return { text: `DGPS ${sats}`, color: '#4ade80' };
    if (gpsfix >= 3) return { text: `3D Fix ${sats}`, color: '#4ade80' };
    if (gpsfix >= 2) return { text: `2D Fix ${sats}`, color: '#f59e0b' };
    if (gpsfix >= 1) return { text: `No Fix ${sats}`, color: '#ef4444' };
    return { text: 'No GPS', color: '#6b7280' };
  })();

  const hdopColor = hdop < 1.5 ? '#4ade80' : hdop < 2.5 ? '#f59e0b' : '#ef4444';
  const ekfColor  = ekfHealth === 'RED' ? '#ef4444' : ekfHealth === 'WARN' ? '#f59e0b' : '#4ade80';
  const vibeHigh  = vibe?.vibration_x > 30 || vibe?.vibration_y > 30 || vibe?.vibration_z > 30;

  return (
    <div className="hud2-status-chips">
      <span className="hud2-chip" style={{ color: gpsLabel.color }}>GPS: {gpsLabel.text}</span>
      {hdop > 0 && <span className="hud2-chip" style={{ color: hdopColor }}>HDOP: {Number(hdop).toFixed(1)}</span>}
      <span className="hud2-chip" style={{ color: ekfColor }}>EKF: {ekfHealth}</span>
      <span className="hud2-chip" style={{
        color: isArmed ? '#ef4444' : '#4ade80', fontWeight: 700,
        background: isArmed ? 'rgba(239,68,68,0.15)' : 'rgba(74,222,128,0.08)',
        border: `1px solid ${isArmed ? 'rgba(239,68,68,0.4)' : 'rgba(74,222,128,0.2)'}`,
      }}>
        {isArmed ? 'ARMED' : 'DISARMED'}
      </span>
      {mode && <span className="hud2-chip" style={{ color: '#60a5fa' }}>{mode}</span>}
      {failsafe && (
        <span className="hud2-chip hud2-chip-blink" style={{ color: '#ef4444', background: 'rgba(239,68,68,0.2)', border: '1px solid #ef4444' }}>
          FS!
        </span>
      )}
      {vibeHigh && (
        <span className="hud2-chip hud2-chip-blink" style={{ color: '#f59e0b' }}>VIBE</span>
      )}
      {prearmText && !isArmed && (
        <span className="hud2-chip" style={{ color: '#f59e0b', fontSize: 9, maxWidth: '100%' }}>
          {prearmText}
        </span>
      )}
    </div>
  );
}

// Throttle bar — thin horizontal bar at the very bottom.
function ThrottleBar({ throttle }) {
  const pct = clamp(throttle || 0, 0, 100);
  const color = pct > 80 ? '#ef4444' : pct > 50 ? '#f59e0b' : '#22c55e';
  return (
    <div className="hud2-throttle-wrap">
      <span className="hud2-throttle-label">THR</span>
      <div className="hud2-throttle-track">
        <div className="hud2-throttle-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="hud2-throttle-pct">{Math.round(pct)}%</span>
    </div>
  );
}

// ─── Main HUD Component ────────────────────────────────────────────────────────

const AdvancedHUD = ({ vehicleState, operational }) => {
  const v = vehicleState;

  // Safe defaults — HUD always renders, never blank.
  const rollRad = v?.attitude?.roll ?? 0;
  const pitchRad = v?.attitude?.pitch ?? 0;
  const yawRad = v?.attitude?.yaw ?? 0;
  const rollDeg = rollRad * 180 / Math.PI;
  const pitchDeg = pitchRad * 180 / Math.PI;

  const heading = v?.velocity?.heading ?? (yawRad * 180 / Math.PI + 360) % 360;
  const airspeed = v?.velocity?.airspeed ?? 0;
  const groundspeed = v?.velocity?.groundspeed ?? 0;
  const altitude = v?.position?.alt_rel ?? 0;
  const climbRate = v?.velocity?.climb ?? 0;
  const throttle = v?.velocity?.throttle ?? 0;

  const gpsfix = v?.status?.gps_fix ?? 0;
  const sats = v?.status?.satellites ?? 0;
  const hdop = v?.status?.gps_hdop ?? 0;
  const isArmed = Boolean(v?.status?.armed);
  const failsafe = Boolean(v?.status?.failsafe);
  const mode = v?.status?.mode || (v ? 'UNKNOWN' : '');

  const ekfFlags = v?.ekf_status?.flags ?? 0;
  const velVar = v?.ekf_status?.velocity_variance ?? 0;
  const horizVar = v?.ekf_status?.pos_horiz_variance ?? 0;
  const ekfHealth = (() => {
    if (!v) return 'N/A';
    // Match Mission Planner EKF evaluation exactly (CurrentState.cs + HUD.cs)
    const EKF_ATTITUDE = 1;
    const EKF_UNINITIALIZED = 256;
    if (ekfFlags & EKF_UNINITIALIZED) return 'RED';  // UNINITIALIZED bit SET = not ready
    if (!(ekfFlags & EKF_ATTITUDE)) return 'RED';     // no attitude estimate
    const compVar = v?.ekf_status?.compass_variance ?? 0;
    const vertVar = v?.ekf_status?.pos_vert_variance ?? 0;
    const terrVar = v?.ekf_status?.terrain_alt_variance ?? 0;
    const maxVar = Math.max(velVar, horizVar, compVar, vertVar, terrVar);
    if (maxVar > 0.8) return 'RED';
    if (maxVar > 0.5) return 'WARN';
    return 'OK';
  })();

  const vibe = v?.vibration;

  // Pre-arm text from status messages (last WARNING-level message)
  const prearmText = (() => {
    if (!v?.status_messages?.length) return '';
    const warn = [...(v.status_messages || [])].reverse().find(m => m.severity <= 4);
    return warn?.text || '';
  })();

  const isDisconnected = !v;

  return (
    <div className={`hud2 ${isDisconnected ? 'hud2-disconnected' : ''}`}>

      {/* Compass strip */}
      <CompassStrip heading={heading} />

      {/* Roll arc */}
      <div className="hud2-roll-wrap">
        <RollIndicator rollDeg={rollDeg} />
      </div>

      {/* Main horizon area */}
      <div className="hud2-horizon-area">
        {/* Speed tape (left) */}
        <SpeedTape airspeed={airspeed} groundspeed={groundspeed} />

        {/* Horizon + pitch ladder */}
        <div className="hud2-horizon-clip">
          <PitchLadder pitchDeg={pitchDeg} rollDeg={rollDeg} />

          {/* Aircraft reference symbol — MP crosshair style */}
          <div className="hud2-aircraft-symbol">
            <div className="hud2-wing hud2-wing-left" />
            <div className="hud2-fuselage" />
            <div className="hud2-wing hud2-wing-right" />
          </div>
          {/* Centre vertical tick */}
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 2, height: 14,
            marginTop: 8,
            background: '#facc15', zIndex: 21, pointerEvents: 'none',
            boxShadow: '0 0 3px rgba(250,204,21,0.6)',
          }} />
        </div>

        {/* Altitude tape (right) */}
        <AltitudeTape altitude={altitude} climbRate={climbRate} />
      </div>

      {/* Battery bar — MP style: voltage · amps · % · mAh */}
      <div className="hud2-battery-bar">
        <span style={{ color: (() => {
          const pct = v?.battery?.remaining ?? 100;
          return pct < 15 ? '#f87171' : pct < 30 ? '#fbbf24' : '#94a3b8';
        })() }}>
          Bat: {(v?.battery?.voltage ?? 0).toFixed(1)}V
          · {(v?.battery?.current ?? 0).toFixed(1)}A
          · {v?.battery?.remaining ?? 0}%
          {v?.battery?.used_mah > 0 && ` · ${Math.round(v.battery.used_mah)}mAh`}
        </span>
        {isDisconnected && <span style={{ color: '#ef4444', marginLeft: 8 }}>NO LINK</span>}
      </div>

      {/* Throttle bar */}
      <ThrottleBar throttle={throttle} />

      {/* Status chips */}
      <StatusChips
        gpsfix={gpsfix}
        sats={sats}
        hdop={hdop}
        ekfHealth={ekfHealth}
        ekfFlags={ekfFlags}
        isArmed={isArmed}
        failsafe={failsafe}
        mode={mode}
        vibe={vibe}
        prearmText={prearmText}
      />
    </div>
  );
};

export default AdvancedHUD;
