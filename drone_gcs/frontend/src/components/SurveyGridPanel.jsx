import React, { useEffect, useMemo, useState } from 'react';
import { buildSurveyWaypoints } from '../utils/surveyGrid';

const MAV_CMD_NAV_SPLINE_WAYPOINT = 82;
const MAV_CMD_NAV_WAYPOINT = 16;
const MAV_CMD_NAV_TAKEOFF = 22;
const MAV_CMD_NAV_RTL = 20;

// Compute line spacing from camera overlap % + altitude + sensor FOV
function overlapToLineSpacing(overlapPct, altM, sensorWidthMm, focalLengthMm) {
  if (!sensorWidthMm || !focalLengthMm || !altM) return null;
  const gsdM = (altM * sensorWidthMm) / (focalLengthMm * 1000); // m/px at 1px resolution
  const swathM = gsdM * 1000; // assume ~1000px sensor width → ground swath in metres
  // actually: swath = altM * (sensorWidthMm / focalLengthMm)
  const swath = altM * (sensorWidthMm / focalLengthMm);
  const overlap = Math.max(0, Math.min(99, overlapPct)) / 100;
  return Math.max(5, swath * (1 - overlap));
}

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
  const [addTakeoff, setAddTakeoff] = useState(true);
  const [addRtl, setAddRtl] = useState(true);
  const [gridError, setGridError] = useState('');

  // Camera overlap mode
  const [useOverlap, setUseOverlap] = useState(false);
  const [overlapPct, setOverlapPct] = useState(70);
  const [sensorWidthMm, setSensorWidthMm] = useState(6.3);
  const [focalLengthMm, setFocalLengthMm] = useState(3.6);

  useEffect(() => {
    if (seed?.lat != null && !Number.isNaN(Number(seed.lat))) setLat(Number(seed.lat));
    if (seed?.lng != null && !Number.isNaN(Number(seed.lng))) setLng(Number(seed.lng));
  }, [seed?.lat, seed?.lng]);

  // Compute line spacing from camera overlap if enabled
  const effectiveLineSpacing = useMemo(() => {
    if (!useOverlap) return lineSpacingM;
    const computed = overlapToLineSpacing(overlapPct, altitudeM, sensorWidthMm, focalLengthMm);
    return computed ?? lineSpacingM;
  }, [useOverlap, overlapPct, altitudeM, sensorWidthMm, focalLengthMm, lineSpacingM]);

  const computedGSD = useMemo(() => {
    if (!sensorWidthMm || !focalLengthMm || !altitudeM) return null;
    // GSD (cm/px) = (altitude * sensor_width) / (focal_length * image_width_px) * 100
    // Simplified for 4000px wide sensor:
    const gsd = (altitudeM * sensorWidthMm) / (focalLengthMm * 4000) * 100;
    return gsd.toFixed(2);
  }, [altitudeM, sensorWidthMm, focalLengthMm]);

  const computedSwath = useMemo(() => {
    if (!sensorWidthMm || !focalLengthMm || !altitudeM) return null;
    return (altitudeM * (sensorWidthMm / focalLengthMm)).toFixed(1);
  }, [altitudeM, sensorWidthMm, focalLengthMm]);

  const previewCount = useMemo(() => {
    try {
      const base = buildSurveyWaypoints({
        centerLat: lat, centerLng: lng, widthM, lengthM, headingDeg,
        lineSpacingM: effectiveLineSpacing, alongSpacingM, altitudeM,
        command: useSpline ? MAV_CMD_NAV_SPLINE_WAYPOINT : MAV_CMD_NAV_WAYPOINT,
      }).length;
      return base + (addTakeoff ? 1 : 0) + (addRtl ? 1 : 0);
    } catch {
      return 0;
    }
  }, [lat, lng, widthM, lengthM, headingDeg, effectiveLineSpacing, alongSpacingM, altitudeM, useSpline, addTakeoff, addRtl]);

  const run = (mode) => {
    setGridError('');
    try {
      let wps = buildSurveyWaypoints({
        centerLat: lat, centerLng: lng, widthM, lengthM, headingDeg,
        lineSpacingM: effectiveLineSpacing, alongSpacingM, altitudeM,
        command: useSpline ? MAV_CMD_NAV_SPLINE_WAYPOINT : MAV_CMD_NAV_WAYPOINT,
      });

      if (addTakeoff && wps.length > 0) {
        const first = wps[0];
        wps = [
          { command: MAV_CMD_NAV_TAKEOFF, lat: first.lat, lng: first.lng, alt: altitudeM, frame: 3, param1: 0, param2: 0, param3: 0, param4: 0 },
          ...wps,
        ];
      }

      if (addRtl && wps.length > 0) {
        const last = wps[wps.length - 1];
        wps = [
          ...wps,
          { command: MAV_CMD_NAV_RTL, lat: last.lat, lng: last.lng, alt: 0, frame: 3, param1: 0, param2: 0, param3: 0, param4: 0 },
        ];
      }

      if (mode === 'replace') replaceWaypoints(wps);
      else appendWaypoints(wps);
      onClose();
    } catch (e) {
      setGridError(e?.message || 'Failed to generate survey grid.');
    }
  };

  const row = { fontSize: 12 };
  const inp = { width: '100%', marginTop: 4 };

  return (
    <div
      className="survey-grid-overlay"
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.65)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog" aria-modal="true" aria-labelledby="survey-grid-title"
    >
      <div style={{ width: 'min(480px, 100%)', background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 18, boxShadow: '0 20px 50px rgba(0,0,0,0.45)', maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 id="survey-grid-title" style={{ margin: '0 0 10px', fontSize: 17 }}>
          Survey grid (lawnmower)
        </h3>

        {/* Position + size */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <label style={row}>Center lat<input className="status-search" style={inp} value={lat} onChange={e => setLat(Number(e.target.value))} type="number" step="any" /></label>
          <label style={row}>Center lng<input className="status-search" style={inp} value={lng} onChange={e => setLng(Number(e.target.value))} type="number" step="any" /></label>
          <label style={row}>Width (m)<input className="status-search" style={inp} value={widthM} onChange={e => setWidthM(Number(e.target.value))} type="number" min={10} /></label>
          <label style={row}>Length (m)<input className="status-search" style={inp} value={lengthM} onChange={e => setLengthM(Number(e.target.value))} type="number" min={10} /></label>
          <label style={row}>Heading (° from N)<input className="status-search" style={inp} value={headingDeg} onChange={e => setHeadingDeg(Number(e.target.value))} type="number" /></label>
          <label style={row}>Altitude (m rel)<input className="status-search" style={inp} value={altitudeM} onChange={e => setAltitudeM(Number(e.target.value))} type="number" min={1} /></label>
          <label style={row}>Along spacing (m)<input className="status-search" style={inp} value={alongSpacingM} onChange={e => setAlongSpacingM(Number(e.target.value))} type="number" min={5} /></label>
          {!useOverlap && (
            <label style={row}>Line spacing (m)<input className="status-search" style={inp} value={lineSpacingM} onChange={e => setLineSpacingM(Number(e.target.value))} type="number" min={5} /></label>
          )}
        </div>

        {/* Camera overlap */}
        <div style={{ border: '1px solid var(--border-color)', borderRadius: 6, padding: '10px 12px', marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: useOverlap ? 10 : 0 }}>
            <input type="checkbox" checked={useOverlap} onChange={e => setUseOverlap(e.target.checked)} />
            <strong>Camera overlap mode</strong> (auto-compute line spacing)
          </label>
          {useOverlap && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label style={row}>Overlap %<input className="status-search" style={inp} value={overlapPct} onChange={e => setOverlapPct(Number(e.target.value))} type="number" min={0} max={99} /></label>
              <label style={row}>Sensor width (mm)<input className="status-search" style={inp} value={sensorWidthMm} onChange={e => setSensorWidthMm(Number(e.target.value))} type="number" step="0.1" min={1} /></label>
              <label style={row}>Focal length (mm)<input className="status-search" style={inp} value={focalLengthMm} onChange={e => setFocalLengthMm(Number(e.target.value))} type="number" step="0.1" min={1} /></label>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', paddingTop: 16 }}>
                <div>Swath: <strong style={{ color: 'var(--text-primary)' }}>{computedSwath ?? '—'} m</strong></div>
                <div>GSD: <strong style={{ color: 'var(--text-primary)' }}>{computedGSD ?? '—'} cm/px</strong></div>
                <div>Line spacing: <strong style={{ color: '#34d399' }}>{effectiveLineSpacing.toFixed(1)} m</strong></div>
              </div>
            </div>
          )}
        </div>

        {/* Options row */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={useSpline} onChange={e => setUseSpline(e.target.checked)} />
            Spline WPs (cmd 82)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={addTakeoff} onChange={e => setAddTakeoff(e.target.checked)} />
            Prepend TAKEOFF
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={addRtl} onChange={e => setAddRtl(e.target.checked)} />
            Append RTL
          </label>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
          Estimated waypoints: <strong style={{ color: 'var(--text-primary)' }}>{previewCount}</strong>
          {addTakeoff && <span style={{ color: '#f59e0b' }}> (incl. TAKEOFF)</span>}
          {addRtl && <span style={{ color: '#f97316' }}> (incl. RTL)</span>}
        </div>

        {gridError && <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 10 }}>{gridError}</div>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button type="button" className="btn-toolbar" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-toolbar" onClick={() => run('append')}>Append grid</button>
          <button type="button" className="btn-toolbar primary" onClick={() => run('replace')}>Replace mission</button>
        </div>
      </div>
    </div>
  );
}
