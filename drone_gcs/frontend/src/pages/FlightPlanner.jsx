import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { useLocation, useNavigate } from 'react-router-dom';
import useMissionStore, { FENCE_CMD_INCLUSION, FENCE_CMD_EXCLUSION } from '../store/useMissionStore';
import useTelemetryStore, { selectPrimaryVehicle } from '../store/useTelemetryStore';
import MapEditor from '../components/MapEditor';
import WaypointTable from '../components/WaypointTable';
import SurveyGridPanel from '../components/SurveyGridPanel';
import { UploadCloud, DownloadCloud, Trash2, Grid3x3 } from 'lucide-react';

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

const FlightPlanner = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const waypoints = useMissionStore((state) => state.waypoints);
  const missionType = useMissionStore((state) => state.missionType);
  const setMissionType = useMissionStore((state) => state.setMissionType);
  const fencePolygonMode = useMissionStore((state) => state.fencePolygonMode);
  const setFencePolygonMode = useMissionStore((state) => state.setFencePolygonMode);
  const setWaypoints = useMissionStore((state) => state.setWaypoints);
  const clearMission = useMissionStore((state) => state.clearMission);
  const replaceWaypoints = useMissionStore((state) => state.replaceWaypoints);
  const appendWaypoints = useMissionStore((state) => state.appendWaypoints);
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
  const [fenceForm, setFenceForm] = useState({
    enabled: false,
    action: 0,
    radius: 100.0,
    alt_max: 120.0,
    alt_min: 0.0,
  });

  const vehicle = useTelemetryStore(selectPrimaryVehicle) || {};
  const sendShortcutCommand = useTelemetryStore((s) => s.sendShortcutCommand);
  const setFlightMode = useTelemetryStore((s) => s.setFlightMode);
  const fenceEnabled = Number(vehicle?.parameters?.FENCE_ENABLE ?? 0);
  const fenceAction = Number(vehicle?.parameters?.FENCE_ACTION ?? 0);
  const currentMode = String(vehicle?.status?.mode || 'UNKNOWN').toUpperCase();
  const missionSeq = Number(vehicle?.mission?.current_seq ?? -1);

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

  useEffect(() => {
    setMissionCurrentSeq(missionSeq);
  }, [missionSeq, setMissionCurrentSeq]);

  useEffect(() => {
    if (transferStatus?.mission_type === 'MISSION' && Number(transferStatus?.total) >= 0) {
      setMissionPlannedTotal(Number(transferStatus.total));
    }
  }, [transferStatus, setMissionPlannedTotal]);

  useEffect(() => {
    let stopped = false;
    const run = () => {
      axios.get(`${API_URL}/api/mission/transfer/status`).then((r) => {
        if (!stopped) setTransferStatus(r.data || null);
      }).catch(() => {
        if (!stopped) setTransferStatus(null);
      });
    };
    run();
    const t = setInterval(run, 900);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  const buildMissionItemsForType = (items) => {
    if (missionType === 'FENCE') {
      const totalVertices = items.length;
      const defaultCmd =
        fencePolygonMode === 'EXCLUSION' ? FENCE_CMD_EXCLUSION : FENCE_CMD_INCLUSION;
      return items.map((wp, idx) => {
        const c = Number(wp.command);
        const command =
          c === FENCE_CMD_INCLUSION || c === FENCE_CMD_EXCLUSION ? c : defaultCmd;
        return {
          ...wp,
          seq: idx,
          frame: 3,
          command,
          param1: totalVertices,
          alt: 0,
        };
      });
    }
    if (missionType === 'RALLY') {
      return items.map((wp, idx) => ({
        ...wp,
        seq: idx,
        frame: 3,
        command: 5100, // MAV_CMD_NAV_RALLY_POINT
      }));
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
        const cmds = loaded.map((i) => Number(i.command));
        if (cmds.every((c) => c === FENCE_CMD_EXCLUSION))
          setFencePolygonMode('EXCLUSION');
        else if (
          cmds.every(
            (c) => c === FENCE_CMD_INCLUSION || c === 0 || Number.isNaN(c)
          )
        )
          setFencePolygonMode('INCLUSION');
      }
      setStatusMsg(`Successfully read ${loaded.length} ${missionType} items from vehicle.`);
    } catch (err) {
      console.error(err);
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
      console.error(err);
      setStatusMsg(extractErrText(err, 'Failed to upload mission.'));
    } finally {
      setLoading(false);
    }
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
      } catch {
        setFenceStatus(null);
      }
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
      console.error(err);
      setStatusMsg(extractErrText(err, 'Failed to apply fence configuration.'));
    } finally {
      setLoading(false);
    }
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
      if (!best || d < best.dist) best = { seq: wp.seq, dist: d, lat: wp.lat, lng: wp.lng };
    }
    return best;
  }, [missionType, waypoints, vehicle?.position?.lat, vehicle?.position?.lng]);

  const inAutoMode = currentMode === 'AUTO' || currentMode.startsWith('AUTO ');
  const canStartMission =
    !loading &&
    waypoints.length > 0 &&
    !!vehicle?.status?.armed &&
    inAutoMode;

  return (
    <div className="flight-planner">
      {surveyOpen && missionType === 'MISSION' && (
        <SurveyGridPanel
          seed={surveySeed || undefined}
          replaceWaypoints={replaceWaypoints}
          appendWaypoints={appendWaypoints}
          onClose={() => {
            setSurveyOpen(false);
            setSurveyFromNav(null);
          }}
        />
      )}
      {/* Toolbar */}
      <div className="mission-toolbar">
        <select
          className="status-search"
          style={{ width: 170, height: 36 }}
          value={missionType}
          onChange={(e) => setMissionType(e.target.value)}
          disabled={loading}
        >
          <option value="MISSION">MISSION</option>
          <option value="FENCE">FENCE</option>
          <option value="RALLY">RALLY</option>
        </select>
        <button className="btn-toolbar" onClick={handleRead} disabled={loading}>
          <DownloadCloud size={18} />
          Read
        </button>
        <button className="btn-toolbar primary" onClick={handleWrite} disabled={loading || waypoints.length === 0}>
          <UploadCloud size={18} />
          Write
        </button>
        <button className="btn-toolbar danger" onClick={clearMission} disabled={loading}>
          <Trash2 size={18} />
          Clear
        </button>
        {missionType === 'MISSION' && (
          <button
            type="button"
            className="btn-toolbar"
            onClick={() => setSurveyOpen(true)}
            disabled={loading}
            title="Generate lawnmower survey grid"
          >
            <Grid3x3 size={18} />
            Survey grid
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
          <>
            <span className="status-msg" style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 0 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ opacity: 0.85 }}>Polygon:</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontWeight: fencePolygonMode === 'INCLUSION' ? 600 : 400 }}>
                  <input
                    type="radio"
                    name="fencePolyMode"
                    checked={fencePolygonMode === 'INCLUSION'}
                    onChange={() => setFencePolygonMode('INCLUSION')}
                    disabled={loading}
                  />
                  Inclusion ({FENCE_CMD_INCLUSION})
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontWeight: fencePolygonMode === 'EXCLUSION' ? 600 : 400 }}>
                  <input
                    type="radio"
                    name="fencePolyMode"
                    checked={fencePolygonMode === 'EXCLUSION'}
                    onChange={() => setFencePolygonMode('EXCLUSION')}
                    disabled={loading}
                  />
                  Exclusion ({FENCE_CMD_EXCLUSION})
                </label>
              </span>
              <span>
                Fence: {fenceStatus?.enabled ? 'ENABLED' : (fenceEnabled ? 'ENABLED' : 'DISABLED')}
                {' '}| Action: {fenceStatus?.action ?? fenceAction}
                {' '}| Vertices: {waypoints.length}
              </span>
            </span>
          </>
        )}
      </div>
      {actionMsg && (
        <div className="mission-toolbar" style={{ minHeight: 44, height: 'auto', gap: 10 }}>
          <span className="status-msg">{actionMsg}</span>
        </div>
      )}
      {missionType === 'MISSION' && (
        <div className="mission-toolbar" style={{ minHeight: 52, height: 'auto', gap: 10, flexWrap: 'wrap' }}>
          <span className="status-msg" style={{ fontWeight: 600 }}>
            Mission progress: WP {missionSeq >= 0 ? missionSeq : '—'} / {Math.max((missionPlannedTotal || waypoints.length) - 1, 0)}
          </span>
          <span className="status-msg">Mode: {currentMode}</span>
          <button className="btn-toolbar" onClick={() => setMode('AUTO')} disabled={loading}>Set AUTO</button>
          <button className="btn-toolbar" onClick={() => setMode('GUIDED')} disabled={loading}>Set GUIDED</button>
          <button className="btn-toolbar primary" onClick={startMission} disabled={!canStartMission}>Start Mission</button>
          <span className="status-msg" style={{ opacity: 0.86 }}>
            {" Flow: Read -> edit -> Write -> ARM -> TAKEOFF -> AUTO -> Start Mission"}
          </span>
          <span className="status-msg" style={{ opacity: 0.86 }}>
            Checklist:
            {' '}[{vehicle?.status?.armed ? 'ARMED' : 'NOT ARMED'}]
            {' '}[{inAutoMode ? 'AUTO' : `MODE=${currentMode}`}]
            {' '}[{waypoints.length > 0 ? 'MISSION LOADED' : 'NO MISSION'}]
          </span>
        </div>
      )}
      {missionType === 'FENCE' && (
        <div className="mission-toolbar" style={{ height: 'auto', minHeight: 54, gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={!!fenceForm.enabled}
              onChange={(e) => setFenceForm((s) => ({ ...s, enabled: e.target.checked }))}
              disabled={loading}
            />
            Enable
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Action
            <select
              className="status-search"
              style={{ width: 110, height: 34 }}
              value={fenceForm.action}
              onChange={(e) => setFenceForm((s) => ({ ...s, action: Number(e.target.value) }))}
              disabled={loading}
            >
              <option value={0}>Report</option>
              <option value={1}>RTL</option>
              <option value={2}>Land</option>
              <option value={3}>Brake</option>
            </select>
          </label>
          {[
            ['radius', 'Radius m'],
            ['alt_max', 'Alt Max'],
            ['alt_min', 'Alt Min'],
          ].map(([k, label]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {label}
              <input
                type="number"
                className="status-search"
                style={{ width: 110, height: 34 }}
                value={fenceForm[k]}
                onChange={(e) => setFenceForm((s) => ({ ...s, [k]: Number(e.target.value) }))}
                disabled={loading}
              />
            </label>
          ))}
          <button className="btn-toolbar primary" onClick={applyFenceConfig} disabled={loading}>
            Apply Fence Config
          </button>
          <span className="status-msg" style={{ opacity: 0.86 }}>
            {"Fence workflow: draw polygon on map -> pick inclusion/exclusion -> Write -> Enable + action -> Apply Fence Config"}
          </span>
        </div>
      )}
      {missionType === 'RALLY' && (
        <div className="mission-toolbar" style={{ minHeight: 50, height: 'auto', gap: 10, flexWrap: 'wrap' }}>
          <span className="status-msg">
            {" Rally workflow: add emergency landing points on map/table -> Write to vehicle."}
          </span>
          {nearestRally ? (
            <span className="status-msg">
              Nearest rally: #{nearestRally.seq} at ~{Math.round(nearestRally.dist)} m
            </span>
          ) : (
            <span className="status-msg">Nearest rally: unavailable (need vehicle position + rally points)</span>
          )}
        </div>
      )}
      <div className="mission-toolbar" style={{ minHeight: 44, height: 'auto', gap: 10 }}>
        <span className="status-msg">
          READ downloads current {missionType} from vehicle into map/table. WRITE uploads current edited {missionType} to vehicle.
        </span>
      </div>

      {/* Split View */}
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
