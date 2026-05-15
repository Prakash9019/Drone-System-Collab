import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useLocation, useNavigate } from 'react-router-dom';
import useMissionStore, { FENCE_CMD_INCLUSION, FENCE_CMD_EXCLUSION } from '../store/useMissionStore';
import useTelemetryStore, { selectPrimaryVehicle } from '../store/useTelemetryStore';
import MapEditor from '../components/MapEditor';
import WaypointTable from '../components/WaypointTable';
import SurveyGridPanel from '../components/SurveyGridPanel';
import { UploadCloud, DownloadCloud, Trash2, Grid3x3, Save, FolderOpen, ZoomIn, AlertTriangle } from 'lucide-react';

const API_URL = 'http://localhost:8080';

const extractErrText = (err, fallback) => {
  const d = err?.response?.data;
  if (typeof d?.detail === 'string') return d.detail;
  if (d?.detail?.error) {
    const tr = d.detail.transfer;
    if (tr?.error) return `${d.detail.error}: ${tr.error}`;
    return d.detail.error;
  }
  if (d?.error) return d.error;
  return fallback || err?.message || 'Request failed';
};

// ─── .waypoints file format (QGC WPL 110) ────────────────────────────────────
function parseWaypointsFile(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines[0].startsWith('QGC WPL')) throw new Error('Not a valid .waypoints file (missing QGC WPL header)');
  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length < 12) continue;
    items.push({
      seq: Number(parts[0]),
      current: Number(parts[1]),
      frame: Number(parts[2]),
      command: Number(parts[3]),
      param1: Number(parts[4]),
      param2: Number(parts[5]),
      param3: Number(parts[6]),
      param4: Number(parts[7]),
      lat: Number(parts[8]),
      lng: Number(parts[9]),
      alt: Number(parts[10]),
      autocontinue: Number(parts[11]),
    });
  }
  return items;
}

function buildWaypointsFile(waypoints) {
  const lines = ['QGC WPL 110'];
  waypoints.forEach((wp, idx) => {
    lines.push([
      idx,
      idx === 0 ? 1 : 0,
      wp.frame ?? 3,
      wp.command ?? 16,
      wp.param1 ?? 0,
      wp.param2 ?? 0,
      wp.param3 ?? 0,
      wp.param4 ?? 0,
      Number(wp.lat).toFixed(8),
      Number(wp.lng).toFixed(8),
      Number(wp.alt).toFixed(3),
      wp.autocontinue ?? 1,
    ].join('\t'));
  });
  return lines.join('\n');
}

// Group consecutive fence vertices by command type into polygon objects (mirrors MP Fence.LocationToFence)
function buildFencePolygonGroups(waypoints) {
  const groups = [];
  let current = null;
  waypoints.forEach(wp => {
    const cmd = Number(wp.command);
    const validCmd = (cmd === FENCE_CMD_INCLUSION || cmd === FENCE_CMD_EXCLUSION) ? cmd : FENCE_CMD_INCLUSION;
    if (!current || current.cmd !== validCmd) {
      if (current) groups.push(current);
      current = { cmd: validCmd, items: [] };
    }
    current.items.push({ ...wp, command: validCmd });
  });
  if (current) groups.push(current);
  return groups;
}

// ─── Mission/fence validation ─────────────────────────────────────────────────
function validateFence(waypoints) {
  const warnings = [];
  const groups = buildFencePolygonGroups(waypoints);
  groups.forEach((g, i) => {
    const typeName = g.cmd === FENCE_CMD_EXCLUSION ? 'exclusion' : 'inclusion';
    if (g.items.length < 3) {
      warnings.push(`Polygon ${i + 1} (${typeName}) has ${g.items.length} point(s) — minimum 3 required for a valid polygon`);
    }
  });
  const hasInclusion = groups.some(g => g.cmd === FENCE_CMD_INCLUSION);
  const hasExclusion = groups.some(g => g.cmd === FENCE_CMD_EXCLUSION);
  if (hasExclusion && !hasInclusion) {
    warnings.push('Exclusion zone defined without an inclusion zone — vehicle has no explicitly safe area');
  }
  return warnings;
}

function validateMission(waypoints, missionType) {
  if (missionType === 'FENCE') return validateFence(waypoints);
  if (missionType !== 'MISSION') return [];
  const warnings = [];
  const cmds = waypoints.map(w => Number(w.command));
  if (!cmds.includes(22)) warnings.push('No TAKEOFF command (cmd 22) — drone may not arm for AUTO mode');
  if (!cmds.some(c => c === 20 || c === 21)) warnings.push('No RTL (20) or LAND (21) — mission may not end cleanly');
  if (waypoints.length > 500) warnings.push(`Large mission: ${waypoints.length} waypoints (limit may be 512)`);
  if (waypoints.some(w => !w.lat && !w.lng)) warnings.push('Some waypoints have zero coordinates — check table');
  return warnings;
}

const FlightPlanner = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  const waypoints = useMissionStore((state) => state.waypoints);
  const mapInstance = useMissionStore((state) => state.mapInstance);
  const missionType = useMissionStore((state) => state.missionType);
  const setMissionType = useMissionStore((state) => state.setMissionType);
  const fencePolygonMode = useMissionStore((state) => state.fencePolygonMode);
  const setFencePolygonMode = useMissionStore((state) => state.setFencePolygonMode);
  const setWaypoints = useMissionStore((state) => state.setWaypoints);
  const clearMission = useMissionStore((state) => state.clearMission);
  const replaceWaypoints = useMissionStore((state) => state.replaceWaypoints);
  const appendWaypoints = useMissionStore((state) => state.appendWaypoints);
  const insertWaypointAt = useMissionStore((state) => state.insertWaypointAt);
  const setMissionCurrentSeq = useMissionStore((state) => state.setMissionCurrentSeq);
  const missionPlannedTotal = useMissionStore((state) => state.missionPlannedTotal);
  const setMissionPlannedTotal = useMissionStore((state) => state.setMissionPlannedTotal);

  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [actionMsg, setActionMsg] = useState('');
  const [surveyOpen, setSurveyOpen] = useState(false);
  const [surveyFromNav, setSurveyFromNav] = useState(null);
  const [transferStatus, setTransferStatus] = useState(null);
  const [fenceStatus, setFenceStatus] = useState(null);
  const [showValidation, setShowValidation] = useState(false);
  const [fenceForm, setFenceForm] = useState({
    enabled: false, action: 0, radius: 100.0, alt_max: 120.0, alt_min: 0.0,
  });

  const vehicle = useTelemetryStore(selectPrimaryVehicle) || {};
  const sendShortcutCommand = useTelemetryStore((s) => s.sendShortcutCommand);
  const setFlightMode = useTelemetryStore((s) => s.setFlightMode);
  const fenceEnabled = Number(vehicle?.parameters?.FENCE_ENABLE ?? 0);
  const fenceAction = Number(vehicle?.parameters?.FENCE_ACTION ?? 0);
  const currentMode = String(vehicle?.status?.mode || 'UNKNOWN').toUpperCase();
  const missionSeq = Number(vehicle?.mission?.current_seq ?? -1);

  const validationWarnings = useMemo(() => validateMission(waypoints, missionType), [waypoints, missionType]);

  const fenceCounts = useMemo(() => ({
    inc: waypoints.filter(w => Number(w.command) === FENCE_CMD_INCLUSION).length,
    exc: waypoints.filter(w => Number(w.command) === FENCE_CMD_EXCLUSION).length,
  }), [waypoints]);

  // Per-polygon breakdown for display — matches MP's polygon-object model
  const fencePolygons = useMemo(() => {
    if (missionType !== 'FENCE' || !waypoints.length) return [];
    return buildFencePolygonGroups(waypoints);
  }, [waypoints, missionType]);

  const surveySeed = useMemo(() => {
    if (surveyFromNav?.lat != null && surveyFromNav?.lng != null) {
      return { lat: surveyFromNav.lat, lng: surveyFromNav.lng };
    }
    const h = vehicle?.home;
    if (h?.valid && h.lat != null && h.lng != null && Math.abs(h.lat) <= 90 && Math.abs(h.lng) <= 180) {
      return { lat: h.lat, lng: h.lng };
    }
    if (waypoints.length > 0) {
      const w0 = waypoints[0];
      if (w0?.lat != null && w0?.lng != null) return { lat: w0.lat, lng: w0.lng };
    }
    return null;
  }, [surveyFromNav, vehicle?.home, waypoints]);

  useEffect(() => {
    const st = location.state;
    if (st?.openSurvey && st.centerLat != null && st.centerLng != null) {
      setSurveyFromNav({ lat: Number(st.centerLat), lng: Number(st.centerLng) });
      setMissionType('MISSION');
      setSurveyOpen(true);
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location.state, location.pathname, navigate, setMissionType]);

  useEffect(() => { setMissionCurrentSeq(missionSeq); }, [missionSeq, setMissionCurrentSeq]);

  useEffect(() => {
    if (transferStatus?.mission_type === 'MISSION' && Number(transferStatus?.total) >= 0) {
      setMissionPlannedTotal(Number(transferStatus.total));
    }
  }, [transferStatus, setMissionPlannedTotal]);

  useEffect(() => {
    let stopped = false;
    const run = () => {
      axios.get(`${API_URL}/api/mission/transfer/status`).then(r => {
        if (!stopped) setTransferStatus(r.data || null);
      }).catch(() => { if (!stopped) setTransferStatus(null); });
    };
    run();
    const t = setInterval(run, 900);
    return () => { stopped = true; clearInterval(t); };
  }, []);

  const buildMissionItemsForType = (items) => {
    if (missionType === 'FENCE') {
      // Group consecutive vertices by type — each polygon gets its own param1 count.
      // This matches Mission Planner's Fence.FenceToLocation() where every vertex in a
      // polygon carries param1 = total vertices in THAT polygon (not the total fence count).
      const defaultCmd = fencePolygonMode === 'EXCLUSION' ? FENCE_CMD_EXCLUSION : FENCE_CMD_INCLUSION;
      const groups = buildFencePolygonGroups(
        items.map(wp => ({ ...wp, command: (Number(wp.command) === FENCE_CMD_INCLUSION || Number(wp.command) === FENCE_CMD_EXCLUSION) ? wp.command : defaultCmd }))
      );
      const result = [];
      groups.forEach(poly => {
        poly.items.forEach(wp => {
          result.push({
            ...wp,
            seq: result.length,
            frame: 0,        // MAV_FRAME_GLOBAL — required by ArduPilot for fence items
            command: poly.cmd,
            param1: poly.items.length,  // total vertices in THIS polygon (not total fence vertices)
            alt: 0,
          });
        });
      });
      return result;
    }
    if (missionType === 'RALLY') {
      return items.map((wp, idx) => ({ ...wp, seq: idx, frame: 3, command: 5100 }));
    }
    return items;
  };

  const handleRead = async () => {
    setLoading(true);
    setStatusMsg('Downloading mission from drone...');
    try {
      const endpoint = missionType === 'FENCE'
        ? `${API_URL}/api/fence`
        : missionType === 'RALLY'
          ? `${API_URL}/api/rally`
          : `${API_URL}/api/mission`;
      const res = await axios.get(endpoint, {
        params: missionType === 'MISSION' ? { mission_type: missionType } : {}
      });
      const loaded = res.data.items || [];
      setWaypoints(loaded);
      if (missionType === 'FENCE' && loaded.length > 0) {
        const cmds = loaded.map(i => Number(i.command));
        if (cmds.every(c => c === FENCE_CMD_EXCLUSION)) setFencePolygonMode('EXCLUSION');
        else if (cmds.every(c => c === FENCE_CMD_INCLUSION || c === 0 || Number.isNaN(c))) setFencePolygonMode('INCLUSION');
      }
      setStatusMsg(`Read ${loaded.length} ${missionType} items from vehicle.`);
    } catch (err) {
      setStatusMsg(extractErrText(err, 'Failed to read mission.'));
    } finally {
      setLoading(false);
    }
  };

  const handleWrite = async () => {
    setLoading(true);
    setStatusMsg('Uploading mission to drone...');
    try {
      const payloadItems = buildMissionItemsForType(waypoints);
      const endpoint = missionType === 'FENCE'
        ? `${API_URL}/api/fence/upload`
        : missionType === 'RALLY'
          ? `${API_URL}/api/rally/upload`
          : `${API_URL}/api/mission/upload`;
      await axios.post(endpoint, { items: payloadItems, mission_type: missionType });
      setStatusMsg(`${missionType} uploaded successfully!`);
    } catch (err) {
      setStatusMsg(extractErrText(err, 'Failed to upload mission.'));
    } finally {
      setLoading(false);
    }
  };

  // ─── Save / Load file ────────────────────────────────────────────────────
  const handleSaveFile = () => {
    if (!waypoints.length) { setStatusMsg('No waypoints to save.'); return; }
    const text = buildWaypointsFile(waypoints);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mission_${Date.now()}.waypoints`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMsg(`Saved ${waypoints.length} waypoints to file.`);
  };

  const handleLoadFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const items = parseWaypointsFile(ev.target.result);
        setWaypoints(items);
        setStatusMsg(`Loaded ${items.length} waypoints from file.`);
      } catch (err) {
        setStatusMsg(`Load failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // ─── Zoom to fit mission ─────────────────────────────────────────────────
  const handleZoomToFit = () => {
    if (!mapInstance || !waypoints.length) return;
    const lats = waypoints.map(w => w.lat).filter(Boolean);
    const lngs = waypoints.map(w => w.lng).filter(Boolean);
    if (!lats.length) return;
    const minLat = Math.min(...lats); const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs); const maxLng = Math.max(...lngs);
    mapInstance.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 80, maxZoom: 18 });
  };

  useEffect(() => {
    if (missionType !== 'FENCE') return;
    const run = async () => {
      try {
        const res = await axios.get(`${API_URL}/api/fence/status`);
        setFenceStatus(res.data);
        setFenceForm({
          enabled: !!res.data?.enabled,
          action: Number(res.data?.action ?? 0),
          radius: Number(res.data?.radius ?? 100),
          alt_max: Number(res.data?.alt_max ?? 120),
          alt_min: Number(res.data?.alt_min ?? 0),
        });
      } catch { setFenceStatus(null); }
    };
    run();
    const t = setInterval(run, 2500);
    return () => clearInterval(t);
  }, [missionType]);

  const applyFenceConfig = async () => {
    try {
      setLoading(true);
      await axios.post(`${API_URL}/api/fence/config`, fenceForm);
      setStatusMsg('Fence configuration applied.');
      const res = await axios.get(`${API_URL}/api/fence/status`);
      setFenceStatus(res.data);
    } catch (err) {
      setStatusMsg(extractErrText(err, 'Failed to apply fence configuration.'));
    } finally { setLoading(false); }
  };

  const setMode = async (mode) => {
    setActionMsg('');
    try {
      const res = await setFlightMode(mode);
      setActionMsg(res?.data?.status === 'success' ? `Mode set: ${mode}` : `Mode request sent: ${mode}`);
    } catch (e) {
      const d = e.response?.data;
      setActionMsg(typeof d?.detail === 'string' ? d.detail : d?.error || e.message || `Failed to set ${mode}`);
    }
  };

  const startMission = async () => {
    setActionMsg('');
    try {
      const out = await sendShortcutCommand('mission_start');
      if (out?.accepted === false) {
        setActionMsg(`Mission start rejected: ${out.mav_result_text || out.reason || 'rejected'}`);
      } else {
        setActionMsg(`Mission start ACK: ${out?.mav_result_text || 'OK'}`);
      }
    } catch (e) {
      const d = e.details || e.response?.data;
      setActionMsg(typeof d?.detail === 'string' ? d.detail : d?.error || e.message || 'Mission start failed');
    }
  };

  const nearestRally = useMemo(() => {
    if (missionType !== 'RALLY' || !waypoints.length) return null;
    const lat = Number(vehicle?.position?.lat);
    const lng = Number(vehicle?.position?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
    const distM = (aLat, aLng) => {
      const dLat = (aLat - lat) * 111111;
      const dLng = (aLng - lng) * 111111 * Math.cos((lat * Math.PI) / 180);
      return Math.sqrt(dLat * dLat + dLng * dLng);
    };
    let best = null;
    for (const wp of waypoints) {
      const d = distM(Number(wp.lat), Number(wp.lng));
      if (!best || d < best.dist) best = { seq: wp.seq, dist: d };
    }
    return best;
  }, [missionType, waypoints, vehicle?.position?.lat, vehicle?.position?.lng]);

  const inAutoMode = currentMode === 'AUTO' || currentMode.startsWith('AUTO ');

  // ArduPilot AUTO mode REQUIRES TAKEOFF (cmd=22) as first mission item after HOME.
  // Without it AUTO mode init fails with "Missing Takeoff Cmd".
  const hasTakeoffCmd = useMemo(() =>
    waypoints.some(w => Number(w.command) === 22),
    [waypoints]
  );

  const insertTakeoffAtStart = () => {
    // Insert TAKEOFF at position 0 with home coords and 10m altitude
    const homeLat = Number(vehicle?.home?.lat || 0);
    const homeLng = Number(vehicle?.home?.lng || 0);
    insertWaypointAt(0, { command: 22, frame: 3, alt: 10, lat: homeLat, lng: homeLng });
  };

  // Pre-flight checklist for mission start
  const preflightChecks = useMemo(() => {
    if (missionType !== 'MISSION') return [];
    return [
      { label: 'Connected',    ok: !!vehicle?.status },
      { label: 'GPS lock',     ok: Number(vehicle?.status?.gps_fix ?? 0) >= 3 },
      { label: 'Home set',     ok: !!vehicle?.home?.valid },
      { label: 'TAKEOFF cmd',  ok: hasTakeoffCmd },
      { label: 'Waypoints',    ok: waypoints.length > 0 },
      { label: 'Armed',        ok: !!vehicle?.status?.armed },
      { label: 'AUTO mode',    ok: inAutoMode },
    ];
  }, [missionType, vehicle, hasTakeoffCmd, waypoints.length, inAutoMode]);

  const canStartMission = !loading && waypoints.length > 0 && !!vehicle?.status?.armed && inAutoMode && hasTakeoffCmd;

  return (
    <div className="flight-planner">
      {surveyOpen && missionType === 'MISSION' && (
        <SurveyGridPanel
          seed={surveySeed || undefined}
          replaceWaypoints={replaceWaypoints}
          appendWaypoints={appendWaypoints}
          onClose={() => { setSurveyOpen(false); setSurveyFromNav(null); }}
        />
      )}

      {/* Hidden file input for load */}
      <input ref={fileInputRef} type="file" accept=".waypoints,.txt" style={{ display: 'none' }} onChange={handleLoadFile} />

      {/* Primary toolbar */}
      <div className="mission-toolbar">
        <select className="status-search" style={{ width: 170, height: 36 }} value={missionType} onChange={e => setMissionType(e.target.value)} disabled={loading}>
          <option value="MISSION">MISSION</option>
          <option value="FENCE">FENCE</option>
          <option value="RALLY">RALLY</option>
        </select>
        <button className="btn-toolbar" onClick={handleRead} disabled={loading} title="Download mission from drone">
          <DownloadCloud size={16} /> Read
        </button>
        <button className="btn-toolbar primary" onClick={handleWrite} disabled={loading || waypoints.length === 0} title="Upload mission to drone">
          <UploadCloud size={16} /> Write
        </button>
        <button className="btn-toolbar danger" onClick={clearMission} disabled={loading} title="Clear all waypoints">
          <Trash2 size={16} /> Clear
        </button>
        {missionType === 'MISSION' && (
          <button type="button" className="btn-toolbar" onClick={() => setSurveyOpen(true)} disabled={loading} title="Generate survey grid">
            <Grid3x3 size={16} /> Survey grid
          </button>
        )}
        <button className="btn-toolbar" onClick={handleSaveFile} disabled={loading} title="Save to .waypoints file">
          <Save size={16} /> Save File
        </button>
        <button className="btn-toolbar" onClick={() => fileInputRef.current?.click()} disabled={loading} title="Load from .waypoints file">
          <FolderOpen size={16} /> Load File
        </button>
        <button className="btn-toolbar" onClick={handleZoomToFit} disabled={!waypoints.length} title="Zoom map to fit all waypoints">
          <ZoomIn size={16} /> Zoom Fit
        </button>
        {validationWarnings.length > 0 && (missionType === 'MISSION' || missionType === 'FENCE') && (
          <button className="btn-toolbar" style={{ color: '#f59e0b', borderColor: '#f59e0b' }} onClick={() => setShowValidation(v => !v)} title={`${missionType} validation warnings`}>
            <AlertTriangle size={16} /> {validationWarnings.length} Warning{validationWarnings.length > 1 ? 's' : ''}
          </button>
        )}
        {statusMsg && <span className="status-msg">{statusMsg}</span>}
        {transferStatus && (
          <span className="status-msg" style={{ marginLeft: 10 }}>
            XFER: {transferStatus.direction || '-'} {transferStatus.phase || 'IDLE'}
            {' '}| {transferStatus.current ?? 0}/{transferStatus.total ?? 0}
            {transferStatus.ok === false ? ` | ERROR: ${transferStatus.error || 'failed'}` : ''}
          </span>
        )}
        {missionType === 'FENCE' && (
          <span className="status-msg" style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 0 }}>
            <span style={{ opacity: 0.85 }}>Polygon:</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="radio" name="fencePolyMode" checked={fencePolygonMode === 'INCLUSION'} onChange={() => setFencePolygonMode('INCLUSION')} disabled={loading} />
              Inclusion ({FENCE_CMD_INCLUSION})
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="radio" name="fencePolyMode" checked={fencePolygonMode === 'EXCLUSION'} onChange={() => setFencePolygonMode('EXCLUSION')} disabled={loading} />
              Exclusion ({FENCE_CMD_EXCLUSION})
            </label>
            <span>
              Fence: {fenceStatus?.enabled ? 'ENABLED' : (fenceEnabled ? 'ENABLED' : 'DISABLED')}
              {' '}| Action: {fenceStatus?.action ?? fenceAction}
              {' '}| {fencePolygons.length === 0
                ? 'No polygons'
                : fencePolygons.map((p, i) => {
                    const label = p.cmd === FENCE_CMD_EXCLUSION ? 'Excl' : 'Incl';
                    const warn = p.items.length < 3 ? '⚠' : '';
                    return `${warn}${label}(${p.items.length}pts)`;
                  }).join(' + ')
              }
            </span>
          </span>
        )}
      </div>

      {/* Validation warnings panel */}
      {showValidation && validationWarnings.length > 0 && (
        <div className="mission-toolbar" style={{ background: 'rgba(245,158,11,0.1)', borderColor: '#f59e0b', height: 'auto', flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '8px 12px' }}>
          {validationWarnings.map((w, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#fbbf24' }}>
              <AlertTriangle size={13} /> {w}
            </div>
          ))}
        </div>
      )}

      {/* Action message row */}
      {actionMsg && (
        <div className="mission-toolbar" style={{ minHeight: 44, height: 'auto', gap: 10 }}>
          <span className="status-msg">{actionMsg}</span>
        </div>
      )}

      {/* Mission control row */}
      {missionType === 'MISSION' && (
        <div className="mission-toolbar" style={{ minHeight: 52, height: 'auto', gap: 10, flexWrap: 'wrap' }}>
          <span className="status-msg" style={{ fontWeight: 600 }}>
            WP: {missionSeq >= 0 ? missionSeq : '—'} / {Math.max((missionPlannedTotal || waypoints.length) - 1, 0)}
          </span>
          <span className="status-msg">Mode: {currentMode}</span>
          {!hasTakeoffCmd && waypoints.length > 0 && (
            <button
              className="btn-toolbar"
              style={{ background: 'rgba(239,68,68,0.15)', borderColor: '#ef4444', color: '#fca5a5' }}
              onClick={insertTakeoffAtStart}
              title="ArduPilot AUTO mode requires TAKEOFF as first mission item — click to auto-insert"
            >
              ⚠ Insert TAKEOFF
            </button>
          )}
          <button className="btn-toolbar" onClick={() => setMode('GUIDED')} disabled={loading}>Set GUIDED</button>
          <button className="btn-toolbar" onClick={() => setMode('AUTO')} disabled={loading}>Set AUTO</button>
          <button
            className="btn-toolbar primary"
            onClick={startMission}
            disabled={!canStartMission}
            title={!canStartMission
              ? preflightChecks.filter(c => !c.ok).map(c => `✗ ${c.label}`).join(', ')
              : 'Start mission execution'}
          >
            Start Mission
          </button>
          {/* Pre-flight checklist */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {preflightChecks.map(c => (
              <span key={c.label} style={{
                fontSize: 10, padding: '2px 6px', borderRadius: 4,
                background: c.ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                color: c.ok ? '#4ade80' : '#f87171',
                border: `1px solid ${c.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                fontWeight: 600,
              }}>
                {c.ok ? '✓' : '✗'} {c.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Fence config row */}
      {missionType === 'FENCE' && (
        <div className="mission-toolbar" style={{ height: 'auto', minHeight: 54, gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={!!fenceForm.enabled} onChange={e => setFenceForm(s => ({ ...s, enabled: e.target.checked }))} disabled={loading} />
            Enable
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Action
            <select className="status-search" style={{ width: 110, height: 34 }} value={fenceForm.action} onChange={e => setFenceForm(s => ({ ...s, action: Number(e.target.value) }))} disabled={loading}>
              <option value={0}>Report</option>
              <option value={1}>RTL</option>
              <option value={2}>Land</option>
              <option value={3}>Brake</option>
            </select>
          </label>
          {[['radius', 'Radius m'], ['alt_max', 'Alt Max'], ['alt_min', 'Alt Min']].map(([k, label]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {label}
              <input type="number" className="status-search" style={{ width: 90, height: 34 }} value={fenceForm[k]}
                onChange={e => setFenceForm(s => ({ ...s, [k]: Number(e.target.value) }))} disabled={loading} />
            </label>
          ))}
          <button className="btn-toolbar primary" onClick={applyFenceConfig} disabled={loading}>Apply Fence Config</button>
          <span className="status-msg" style={{ opacity: 0.75, fontSize: 11 }}>
            Draw polygon → pick inclusion/exclusion → Write → Enable → Apply Config
          </span>
        </div>
      )}

      {/* Rally row */}
      {missionType === 'RALLY' && (
        <div className="mission-toolbar" style={{ minHeight: 50, height: 'auto', gap: 10, flexWrap: 'wrap' }}>
          <span className="status-msg">Rally: click map to place emergency landing points, then Write.</span>
          {nearestRally ? (
            <span className="status-msg">Nearest rally: #{nearestRally.seq} at ~{Math.round(nearestRally.dist)} m</span>
          ) : (
            <span className="status-msg">Nearest rally: unavailable</span>
          )}
        </div>
      )}

      {/* Help row */}
      <div className="mission-toolbar" style={{ minHeight: 40, height: 'auto', gap: 10 }}>
        <span className="status-msg" style={{ fontSize: 11, opacity: 0.7 }}>
          READ downloads {missionType} from vehicle. WRITE uploads to vehicle. Save/Load uses .waypoints file (QGC WPL 110). Right-click map for commands.
        </span>
      </div>

      {/* Split view */}
      <div className="planner-split">
        <div className="planner-left">
          <WaypointTable />
        </div>
        <div className="planner-right">
          <MapEditor />
        </div>
      </div>
    </div>
  );
};

export default FlightPlanner;
