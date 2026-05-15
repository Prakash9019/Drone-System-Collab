import React, { useMemo } from 'react';

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ─── Compass Strip ─────────────────────────────────────────────────────────────
// 3-copy strip so heading wrap never shows a gap.
function CompassStrip({ heading }) {
  const hdg = isFinite(heading) ? ((heading % 360) + 360) % 360 : 0;
  const PX_PER_DEG = 4;
  const CONTAINER_W = 400; // mp-sidebar is exactly 400px

  const CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

  const ticks = useMemo(() => {
    const items = [];
    for (let i = 0; i < 1080; i += 5) {
      const deg = i % 360;
      const isMajor = deg % 10 === 0;
      const cardinal = CARDINALS[deg];
      let label = null;
      if (isMajor) {
        label = cardinal != null ? cardinal : String(deg === 0 ? '360' : deg);
      }
      items.push({ key: i, pos: i * PX_PER_DEG, label, isMajor, isCardinal: cardinal != null });
    }
    return items;
  }, []);

  // Center the current heading (in the 2nd copy = hdg+360) in the strip
  const offset = (CONTAINER_W / 2) - (hdg + 360) * PX_PER_DEG;

  return (
    <div className="hud2-compass-wrap">
      <div
        className="hud2-compass-inner"
        style={{ transform: `translateX(${offset}px)`, width: 1080 * PX_PER_DEG }}
      >
        {ticks.map(({ key, pos, label, isMajor, isCardinal }) => (
          <div
            key={key}
            className={`hud2-compass-tick${isMajor ? ' major' : ''}${isCardinal ? ' cardinal' : ''}`}
            style={{ left: pos }}
          >
            {label && (
              <span className={`hud2-compass-label${isCardinal ? ' cardinal' : ''}`}>{label}</span>
            )}
          </div>
        ))}
      </div>
      {/* Fixed centre pointer */}
      <div className="hud2-compass-pointer" />
      {/* Digital heading readout */}
      <div className="hud2-compass-readout">{Math.round(hdg).toString().padStart(3, '0')}°</div>
    </div>
  );
}

// ─── Roll Indicator ────────────────────────────────────────────────────────────
function RollIndicator({ rollDeg }) {
  const R = 58;
  const cx = 100;
  const cy = 65;
  const arcTicks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];
  // Only label the big angles to avoid clutter in 200px wide SVG
  const labeledAngles = new Set([60, 45, 30]);

  const toXY = (angleDeg, r) => {
    const a = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  };

  const arcPath = () => {
    const s = toXY(-60, R);
    const e = toXY(60, R);
    return `M ${s.x} ${s.y} A ${R} ${R} 0 0 1 ${e.x} ${e.y}`;
  };

  // Fixed triangle at 0° — reference mark
  const triTip = toXY(0, R - 2);
  const triL   = toXY(-3, R + 9);
  const triR   = toXY(3, R + 9);

  // Moving pointer rotates with roll
  const roll = clamp(rollDeg, -60, 60);
  const ptrTip = toXY(roll, R + 2);
  const ptrL   = toXY(roll - 3, R + 12);
  const ptrR   = toXY(roll + 3, R + 12);

  return (
    <svg width="200" height="78" className="hud2-roll-svg">
      <path d={arcPath()} className="hud2-roll-arc" />

      {arcTicks.map((t) => {
        const outer = toXY(t, R);
        const tickLen = t === 0 ? 16 : Math.abs(t) >= 45 ? 13 : Math.abs(t) >= 30 ? 10 : 7;
        const inner = toXY(t, R - tickLen);
        return (
          <line key={t} x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y}
            className={`hud2-roll-tick${t === 0 ? ' zero' : ''}`} />
        );
      })}

      {/* Degree labels outside arc at ±30, ±45, ±60 */}
      {arcTicks.filter(t => labeledAngles.has(Math.abs(t)) && t !== 0).map((t) => {
        const lp = toXY(t, R + 18);
        return (
          <text key={`lbl${t}`} x={lp.x} y={lp.y}
            fontSize="8" fill="#6b7280" textAnchor="middle" dominantBaseline="middle">
            {Math.abs(t)}
          </text>
        );
      })}

      {/* Fixed reference triangle at 0° */}
      <polygon
        points={`${triTip.x},${triTip.y} ${triL.x},${triL.y} ${triR.x},${triR.y}`}
        fill="none" stroke="#e2e8f0" strokeWidth="1.5"
      />
      {/* Moving roll pointer */}
      <polygon
        points={`${ptrTip.x},${ptrTip.y} ${ptrL.x},${ptrL.y} ${ptrR.x},${ptrR.y}`}
        fill="#facc15" stroke="#facc15" strokeWidth="1"
      />
    </svg>
  );
}

// ─── Pitch Ladder (inside artificial horizon) ──────────────────────────────────
function PitchLadder({ pitchDeg, rollDeg }) {
  const PX_PER_DEG = 6;
  const lines = [-45, -40, -35, -30, -25, -20, -15, -10, -5, 5, 10, 15, 20, 25, 30, 35, 40, 45];

  return (
    <div
      className="hud2-horizon-rotate"
      style={{ transform: `rotate(${-rollDeg}deg)` }}
    >
      <div
        className="hud2-horizon-translate"
        style={{ transform: `translateY(${pitchDeg * PX_PER_DEG}px)` }}
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

// ─── Speed Tape ────────────────────────────────────────────────────────────────
function SpeedTape({ airspeed, groundspeed }) {
  const speed = isFinite(airspeed) ? Math.max(0, airspeed) : 0;
  const gs    = isFinite(groundspeed) ? groundspeed : 0;
  const PX_PER_UNIT = 8;
  const range = 25;
  const lo = Math.max(0, Math.floor(speed - range));
  const hi = Math.ceil(speed + range);
  const ticks = [];
  for (let v = lo; v <= hi; v++) ticks.push(v);

  return (
    <div className="hud2-tape hud2-tape-left">
      <div className="hud2-tape-window">
        <div
          className="hud2-tape-track"
          style={{ transform: `translateY(${speed * PX_PER_UNIT}px)` }}
        >
          {ticks.map((v) => (
            <div
              key={v}
              className={`hud2-tape-tick${v % 5 === 0 ? ' labeled' : ''}`}
              style={{ bottom: v * PX_PER_UNIT }}
            >
              {v % 5 === 0 && <span className="hud2-tape-num">{v}</span>}
            </div>
          ))}
        </div>
        <div className="hud2-tape-valuebox">{speed.toFixed(1)}</div>
      </div>
      <div className="hud2-tape-footer">
        <div>AS {speed.toFixed(1)}m/s</div>
        <div>GS {gs.toFixed(1)}m/s</div>
      </div>
    </div>
  );
}

// ─── Altitude Tape ─────────────────────────────────────────────────────────────
function AltitudeTape({ altitude, climbRate }) {
  const alt = isFinite(altitude) ? altitude : 0;
  const vsi = isFinite(climbRate) ? climbRate : 0;
  const PX_PER_UNIT = 4;
  const range = 35;
  const lo = Math.floor(alt - range);
  const hi = Math.ceil(alt + range);
  const ticks = [];
  for (let v = lo; v <= hi; v++) ticks.push(v);

  const vsiH = clamp(vsi * 5, -48, 48);
  const vsiUp = vsiH >= 0;

  return (
    <div className="hud2-tape">
      <div className="hud2-tape-window">
        <div
          className="hud2-tape-track"
          style={{ transform: `translateY(${alt * PX_PER_UNIT}px)` }}
        >
          {ticks.map((v) => (
            <div
              key={v}
              className={`hud2-tape-tick hud2-tape-tick-r${v % 10 === 0 ? ' labeled' : ''}`}
              style={{ bottom: v * PX_PER_UNIT }}
            >
              {v % 10 === 0 && <span className="hud2-tape-num hud2-tape-num-r">{v}</span>}
            </div>
          ))}
        </div>
        <div className="hud2-tape-valuebox hud2-tape-valuebox-r">{alt.toFixed(1)}</div>
        {/* VSI bar on right edge */}
        <div className="hud2-vsi-wrap">
          <div
            className="hud2-vsi-fill"
            style={{
              height: Math.abs(vsiH),
              [vsiUp ? 'bottom' : 'top']: '50%',
              background: vsiUp ? '#22c55e' : '#ef4444',
            }}
          />
        </div>
      </div>
      <div className="hud2-tape-footer">
        <div>ALT {alt.toFixed(1)}m</div>
        <div style={{ color: vsi >= 0 ? '#4ade80' : '#f87171' }}>
          VSI {vsi >= 0 ? '+' : ''}{vsi.toFixed(1)}
        </div>
      </div>
    </div>
  );
}

// ─── Main HUD Component ────────────────────────────────────────────────────────
const AdvancedHUD = ({ vehicleState }) => {
  const v = vehicleState;

  // Attitude
  const rollDeg  = (v?.attitude?.roll  ?? 0) * 180 / Math.PI;
  const pitchDeg = (v?.attitude?.pitch ?? 0) * 180 / Math.PI;
  const yawRad   = v?.attitude?.yaw ?? 0;

  // Derived values
  const heading     = v?.velocity?.heading ?? ((yawRad * 180 / Math.PI) + 360) % 360;
  const airspeed    = v?.velocity?.airspeed ?? 0;
  const groundspeed = v?.velocity?.groundspeed ?? 0;
  const altitude    = v?.position?.alt_rel ?? 0;
  const climbRate   = v?.velocity?.climb ?? 0;
  const throttle    = clamp(v?.velocity?.throttle ?? 0, 0, 100);

  // Status
  const gpsfix  = v?.status?.gps_fix ?? 0;
  const sats    = v?.status?.satellites ?? 0;
  const hdop    = v?.status?.gps_hdop ?? 0;
  const isArmed = Boolean(v?.status?.armed);
  const failsafe = Boolean(v?.status?.failsafe);
  const mode    = v?.status?.mode || '';

  // Battery
  const voltage   = v?.battery?.voltage ?? 0;
  const current   = v?.battery?.current ?? 0;
  const remaining = v?.battery?.remaining ?? 0;
  const usedMah   = v?.battery?.used_mah ?? 0;

  // EKF health — matches Mission Planner CurrentState.cs logic
  const ekfFlags = v?.ekf_status?.flags ?? 0;
  const ekfHealth = (() => {
    if (!v) return 'N/A';
    if (ekfFlags & 256) return 'RED';           // EKF_UNINITIALIZED
    if (!(ekfFlags & 1)) return 'RED';           // no EKF_ATTITUDE
    const maxVar = Math.max(
      v?.ekf_status?.velocity_variance ?? 0,
      v?.ekf_status?.pos_horiz_variance ?? 0,
      v?.ekf_status?.compass_variance ?? 0,
      v?.ekf_status?.pos_vert_variance ?? 0,
    );
    if (maxVar > 0.8) return 'RED';
    if (maxVar > 0.5) return 'WARN';
    return 'OK';
  })();

  const vibe = v?.vibration;
  const vibeHigh = vibe?.vibration_x > 30 || vibe?.vibration_y > 30 || vibe?.vibration_z > 30;

  // GPS label
  const gpsText = (() => {
    if (gpsfix >= 6) return `RTK Fixed ${sats}`;
    if (gpsfix >= 5) return `RTK Float ${sats}`;
    if (gpsfix >= 4) return `DGPS ${sats}`;
    if (gpsfix >= 3) return `3D Fix ${sats}`;
    if (gpsfix >= 2) return `2D Fix ${sats}`;
    if (gpsfix >= 1) return `No Fix ${sats}`;
    return 'No GPS';
  })();

  const gpsColor = gpsfix >= 3 ? '#4ade80' : gpsfix >= 2 ? '#f59e0b' : '#ef4444';
  const ekfColor = ekfHealth === 'RED' ? '#ef4444' : ekfHealth === 'WARN' ? '#f59e0b' : '#4ade80';
  const batColor = remaining < 15 ? '#ef4444' : remaining < 30 ? '#fbbf24' : '#94a3b8';
  const thrColor = throttle > 80 ? '#ef4444' : throttle > 50 ? '#f59e0b' : '#22c55e';

  const isDisconnected = !v;

  return (
    <div className={`hud2${isDisconnected ? ' hud2-disconnected' : ''}`}>

      {/* ── Compass strip ── */}
      <CompassStrip heading={heading} />

      {/* ── Roll arc ── */}
      <div className="hud2-roll-wrap">
        <RollIndicator rollDeg={rollDeg} />
      </div>

      {/* ── Horizon area (speed tape | horizon+ladder | altitude tape) ── */}
      <div className="hud2-horizon-area">

        {/* Speed tape — left */}
        <SpeedTape airspeed={airspeed} groundspeed={groundspeed} />

        {/* Horizon + pitch ladder + fixed overlays */}
        <div className="hud2-horizon-clip">
          <PitchLadder pitchDeg={pitchDeg} rollDeg={rollDeg} />

          {/* ARMED / DISARMED overlay — prominent, MP style */}
          <div className={`hud2-arm-overlay${isArmed ? ' armed' : ' disarmed'}`}>
            {isArmed ? 'ARMED' : 'DISARMED'}
          </div>

          {/* Aircraft reference symbol — yellow gull-wing (MP style) */}
          <div className="hud2-aircraft-wrap">
            <svg viewBox="-54 -14 108 28" width="108" height="28" style={{ overflow: 'visible' }}>
              {/* Left wing: inner horizontal then outer angled down */}
              <line x1="-5" y1="0" x2="-28" y2="0"  stroke="#facc15" strokeWidth="3.5" strokeLinecap="round" />
              <line x1="-28" y1="0" x2="-44" y2="8" stroke="#facc15" strokeWidth="3.5" strokeLinecap="round" />
              {/* Right wing: mirror */}
              <line x1="5"  y1="0" x2="28"  y2="0"  stroke="#facc15" strokeWidth="3.5" strokeLinecap="round" />
              <line x1="28" y1="0" x2="44"  y2="8"  stroke="#facc15" strokeWidth="3.5" strokeLinecap="round" />
              {/* Centre dot */}
              <circle cx="0" cy="0" r="3.5" fill="#facc15" />
            </svg>
          </div>

          {/* Failsafe banner */}
          {failsafe && (
            <div className="hud2-failsafe-overlay">⚠ FAILSAFE</div>
          )}
        </div>

        {/* Altitude tape — right */}
        <AltitudeTape altitude={altitude} climbRate={climbRate} />
      </div>

      {/* ── Throttle bar ── */}
      <div className="hud2-thr-row">
        <span className="hud2-thr-label">THR</span>
        <div className="hud2-thr-track">
          <div className="hud2-thr-fill" style={{ width: `${throttle}%`, background: thrColor }} />
        </div>
        <span className="hud2-thr-pct">{Math.round(throttle)}%</span>
      </div>

      {/* ── Bottom status bar — MP style single line ── */}
      <div className="hud2-statusbar">
        <span style={{ color: batColor }}>
          Bat1 {voltage.toFixed(2)}v {current.toFixed(1)}A {remaining}%
          {usedMah > 0 && ` ${Math.round(usedMah)}mAh`}
        </span>
        <span className="hud2-sep">|</span>
        <span style={{ color: ekfColor }}>EKF</span>
        {vibeHigh && <><span className="hud2-sep">|</span><span style={{ color: '#f59e0b' }}>Vibe</span></>}
        <span className="hud2-sep">|</span>
        <span style={{ color: gpsColor }}>GPS: {gpsText}</span>
        {mode && (
          <>
            <span className="hud2-sep">|</span>
            <span style={{ color: '#60a5fa', fontWeight: 700 }}>{mode}</span>
          </>
        )}
        {isDisconnected && (
          <>
            <span className="hud2-sep">|</span>
            <span style={{ color: '#ef4444', fontWeight: 700 }}>NO LINK</span>
          </>
        )}
      </div>
    </div>
  );
};

export default AdvancedHUD;
