import React from 'react';

// ─── Arc Gauge ────────────────────────────────────────────────────────────────

function arcPath(cx, cy, r, startDeg, endDeg) {
  const toR = d => (d - 90) * Math.PI / 180;
  const x1 = cx + r * Math.cos(toR(startDeg));
  const y1 = cy + r * Math.sin(toR(startDeg));
  const x2 = cx + r * Math.cos(toR(endDeg));
  const y2 = cy + r * Math.sin(toR(endDeg));
  const large = (endDeg - startDeg) > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

function needleXY(cx, cy, r, valueDeg) {
  const a = (valueDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

const ArcGauge = ({
  label, value, unit,
  min = 0, max = 100,
  warnAt, dangerAt,
  startDeg = -135, endDeg = 135,
  size = 110,
}) => {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;
  const totalDeg = endDeg - startDeg;
  const safeVal = isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
  const pct = (safeVal - min) / (max - min);
  const valueDeg = startDeg + pct * totalDeg;

  // Color based on warning thresholds
  const color = (() => {
    if (dangerAt != null && safeVal >= dangerAt) return '#ef4444';
    if (warnAt != null && safeVal >= warnAt) return '#f59e0b';
    return '#22c55e';
  })();

  const trackPath = arcPath(cx, cy, r, startDeg, endDeg);
  const valuePath = safeVal > min ? arcPath(cx, cy, r, startDeg, valueDeg) : null;
  const tip = needleXY(cx, cy, r * 0.85, valueDeg);

  // Tick marks
  const ticks = [];
  const tickCount = 9;
  for (let i = 0; i <= tickCount; i++) {
    const deg = startDeg + (i / tickCount) * totalDeg;
    const outer = needleXY(cx, cy, r + 4, deg);
    const inner = needleXY(cx, cy, r - (i % 2 === 0 ? 8 : 4), deg);
    ticks.push({ outer, inner, major: i % 2 === 0 });
  }

  return (
    <div className="gauge-wrap">
      <svg width={size} height={size} className="gauge-svg">
        {/* Track */}
        <path d={trackPath} fill="none" stroke="#1e293b" strokeWidth={6} />
        {/* Value arc */}
        {valuePath && (
          <path d={valuePath} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round" />
        )}
        {/* Ticks */}
        {ticks.map((t, i) => (
          <line
            key={i}
            x1={t.outer.x} y1={t.outer.y}
            x2={t.inner.x} y2={t.inner.y}
            stroke="#475569" strokeWidth={t.major ? 1.5 : 0.8}
          />
        ))}
        {/* Needle */}
        <line
          x1={cx} y1={cy}
          x2={tip.x} y2={tip.y}
          stroke="white" strokeWidth={2} strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r={4} fill="white" />
        {/* Value text */}
        <text x={cx} y={cy + r * 0.4} textAnchor="middle" fill={color} fontSize={size * 0.15} fontWeight="700" fontFamily="monospace">
          {isFinite(value) ? Number(value).toFixed(value >= 100 ? 0 : 1) : '--'}
        </text>
        <text x={cx} y={cy + r * 0.6} textAnchor="middle" fill="#64748b" fontSize={size * 0.1}>
          {unit}
        </text>
      </svg>
      <div className="gauge-label">{label}</div>
    </div>
  );
};

// Battery bar gauge
const BatteryGauge = ({ voltage, remaining }) => {
  const pct = isFinite(remaining) ? Math.max(0, Math.min(100, remaining)) : 0;
  const color = pct > 50 ? '#22c55e' : pct > 20 ? '#f59e0b' : '#ef4444';
  return (
    <div className="gauge-wrap" style={{ width: 110 }}>
      <div className="battery-gauge-outer">
        <div className="battery-gauge-fill" style={{ height: `${pct}%`, background: color }} />
        <div className="battery-gauge-pct">{Math.round(pct)}%</div>
        <div className="battery-gauge-v">{isFinite(voltage) ? voltage.toFixed(1) : '--'}V</div>
      </div>
      <div className="gauge-label">Battery</div>
    </div>
  );
};

// Compass rose
const CompassRose = ({ heading }) => {
  const hdg = isFinite(heading) ? heading : 0;
  const cardinals = [
    { label: 'N', deg: 0, color: '#ef4444' },
    { label: 'E', deg: 90, color: '#f8fafc' },
    { label: 'S', deg: 180, color: '#f8fafc' },
    { label: 'W', deg: 270, color: '#f8fafc' },
  ];
  const size = 110;
  const cx = size / 2, cy = size / 2, r = size * 0.38;
  return (
    <div className="gauge-wrap">
      <svg width={size} height={size} className="gauge-svg">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1e293b" strokeWidth={6} />
        {/* Rotating needle points to heading */}
        <g transform={`rotate(${hdg}, ${cx}, ${cy})`}>
          <line x1={cx} y1={cy - r + 8} x2={cx} y2={cy - 6} stroke="#ef4444" strokeWidth={3} strokeLinecap="round" />
          <line x1={cx} y1={cy + 6} x2={cx} y2={cy + r - 8} stroke="#94a3b8" strokeWidth={3} strokeLinecap="round" />
        </g>
        {/* Cardinal labels (fixed) */}
        {cardinals.map(({ label, deg, color }) => {
          const a = (deg - 90) * Math.PI / 180;
          const x = cx + (r + 12) * Math.cos(a);
          const y = cy + (r + 12) * Math.sin(a);
          return (
            <text key={label} x={x} y={y + 4} textAnchor="middle" fill={color} fontSize={11} fontWeight="700">
              {label}
            </text>
          );
        })}
        {/* Heading text */}
        <text x={cx} y={cy + 6} textAnchor="middle" fill="white" fontSize={13} fontWeight="700" fontFamily="monospace">
          {Math.round(hdg)}°
        </text>
      </svg>
      <div className="gauge-label">Heading</div>
    </div>
  );
};

// ─── Gauges Tab ────────────────────────────────────────────────────────────────

const GaugesTab = ({ vehicleState }) => {
  const v = vehicleState;
  const heading = v?.velocity?.heading ?? (v?.attitude?.yaw != null ? (v.attitude.yaw * 180 / Math.PI + 360) % 360 : 0);

  return (
    <div className="gauges-tab">
      <ArcGauge
        label="Airspeed"
        value={v?.velocity?.airspeed ?? 0}
        unit="m/s"
        min={0} max={50}
        warnAt={30} dangerAt={42}
      />
      <ArcGauge
        label="GroundSpeed"
        value={v?.velocity?.groundspeed ?? 0}
        unit="m/s"
        min={0} max={50}
        warnAt={30} dangerAt={42}
      />
      <ArcGauge
        label="Altitude"
        value={v?.position?.alt_rel ?? 0}
        unit="m"
        min={0} max={500}
        warnAt={400} dangerAt={480}
      />
      <ArcGauge
        label="Climb Rate"
        value={v?.velocity?.climb ?? 0}
        unit="m/s"
        min={-10} max={10}
        startDeg={-135} endDeg={135}
      />
      <CompassRose heading={heading} />
      <BatteryGauge
        voltage={v?.battery?.voltage ?? 0}
        remaining={v?.battery?.remaining ?? 0}
      />
      <ArcGauge
        label="Throttle"
        value={v?.velocity?.throttle ?? 0}
        unit="%"
        min={0} max={100}
        warnAt={80} dangerAt={95}
      />
      <ArcGauge
        label="Satellites"
        value={v?.status?.satellites ?? 0}
        unit="sats"
        min={0} max={24}
        warnAt={4} dangerAt={0}
      />
    </div>
  );
};

export default GaugesTab;
