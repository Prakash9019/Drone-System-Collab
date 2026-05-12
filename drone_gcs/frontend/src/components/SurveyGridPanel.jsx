import React, { useEffect, useMemo, useState } from 'react';
import { buildSurveyWaypoints } from '../utils/surveyGrid';

const MAV_CMD_NAV_SPLINE_WAYPOINT = 82;
const MAV_CMD_NAV_WAYPOINT = 16;

/**
 * Mission-style lawnmower survey over a rectangle (center + width/length + heading).
 */
export default function SurveyGridPanel({ onClose, replaceWaypoints, appendWaypoints, seed }) {
  const [lat, setLat] = useState(seed?.lat ?? 37.7749);
  const [lng, setLng] = useState(seed?.lng ?? -122.4194);
  const [widthM, setWidthM] = useState(80);
  const [lengthM, setLengthM] = useState(120);
  const [headingDeg, setHeadingDeg] = useState(0);
  const [lineSpacingM, setLineSpacingM] = useState(18);
  const [alongSpacingM, setAlongSpacingM] = useState(14);
  const [altitudeM, setAltitudeM] = useState(50);
  const [useSpline, setUseSpline] = useState(false);

  useEffect(() => {
    if (seed?.lat != null && !Number.isNaN(Number(seed.lat))) setLat(Number(seed.lat));
    if (seed?.lng != null && !Number.isNaN(Number(seed.lng))) setLng(Number(seed.lng));
  }, [seed?.lat, seed?.lng]);

  const previewCount = useMemo(() => {
    try {
      return buildSurveyWaypoints({
        centerLat: lat,
        centerLng: lng,
        widthM,
        lengthM,
        headingDeg,
        lineSpacingM,
        alongSpacingM,
        altitudeM,
        command: useSpline ? MAV_CMD_NAV_SPLINE_WAYPOINT : MAV_CMD_NAV_WAYPOINT,
      }).length;
    } catch {
      return 0;
    }
  }, [lat, lng, widthM, lengthM, headingDeg, lineSpacingM, alongSpacingM, altitudeM, useSpline]);

  const run = (mode) => {
    const wps = buildSurveyWaypoints({
      centerLat: lat,
      centerLng: lng,
      widthM,
      lengthM,
      headingDeg,
      lineSpacingM,
      alongSpacingM,
      altitudeM,
      command: useSpline ? MAV_CMD_NAV_SPLINE_WAYPOINT : MAV_CMD_NAV_WAYPOINT,
    });
    if (mode === 'replace') replaceWaypoints(wps);
    else appendWaypoints(wps);
    onClose();
  };

  return (
    <div
      className="survey-grid-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.65)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="survey-grid-title"
    >
      <div
        style={{
          width: 'min(440px, 100%)',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-color)',
          borderRadius: 10,
          padding: 18,
          boxShadow: '0 20px 50px rgba(0,0,0,0.45)',
        }}
      >
        <h3 id="survey-grid-title" style={{ margin: '0 0 12px', fontSize: 17 }}>
          Survey grid (lawnmower)
        </h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          Rectangle centered on the coordinates below. <strong>Heading</strong> is the direction of flight passes
          (0° = north, 90° = east). Spacing controls parallel passes and points along each pass. Large grids are
          subsampled to ~450 waypoints max.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>
            Center lat
            <input className="status-search" style={{ width: '100%', marginTop: 4 }} value={lat} onChange={(e) => setLat(Number(e.target.value))} type="number" step="any" />
          </label>
          <label style={{ fontSize: 12 }}>
            Center lng
            <input className="status-search" style={{ width: '100%', marginTop: 4 }} value={lng} onChange={(e) => setLng(Number(e.target.value))} type="number" step="any" />
          </label>
          <label style={{ fontSize: 12 }}>
            Width (m)
            <input className="status-search" style={{ width: '100%', marginTop: 4 }} value={widthM} onChange={(e) => setWidthM(Number(e.target.value))} type="number" min={10} />
          </label>
          <label style={{ fontSize: 12 }}>
            Length (m)
            <input className="status-search" style={{ width: '100%', marginTop: 4 }} value={lengthM} onChange={(e) => setLengthM(Number(e.target.value))} type="number" min={10} />
          </label>
          <label style={{ fontSize: 12 }}>
            Heading (° from N)
            <input className="status-search" style={{ width: '100%', marginTop: 4 }} value={headingDeg} onChange={(e) => setHeadingDeg(Number(e.target.value))} type="number" />
          </label>
          <label style={{ fontSize: 12 }}>
            Altitude (m rel)
            <input className="status-search" style={{ width: '100%', marginTop: 4 }} value={altitudeM} onChange={(e) => setAltitudeM(Number(e.target.value))} type="number" min={1} />
          </label>
          <label style={{ fontSize: 12 }}>
            Line spacing (m)
            <input className="status-search" style={{ width: '100%', marginTop: 4 }} value={lineSpacingM} onChange={(e) => setLineSpacingM(Number(e.target.value))} type="number" min={5} />
          </label>
          <label style={{ fontSize: 12 }}>
            Along spacing (m)
            <input className="status-search" style={{ width: '100%', marginTop: 4 }} value={alongSpacingM} onChange={(e) => setAlongSpacingM(Number(e.target.value))} type="number" min={5} />
          </label>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={useSpline} onChange={(e) => setUseSpline(e.target.checked)} />
          Use spline waypoints (MAV_CMD 82) — Copter/Plane where spline missions are enabled
        </label>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
          Estimated waypoints: <strong style={{ color: 'var(--text-primary)' }}>{previewCount}</strong>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button type="button" className="btn-toolbar" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-toolbar" onClick={() => run('append')}>
            Append grid
          </button>
          <button type="button" className="btn-toolbar primary" onClick={() => run('replace')}>
            Replace mission
          </button>
        </div>
      </div>
    </div>
  );
}
