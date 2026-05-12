import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import useTelemetryStore, { selectPrimaryVehicle } from '../store/useTelemetryStore';
import AdvancedHUD from '../components/AdvancedHUD';
import TelemetryGrid from '../components/TelemetryGrid';
import MapView from '../components/MapView';
import MissionExecutionPanel from '../components/MissionExecutionPanel';
import { deriveOperationalPhase } from '../utils/operationalState';
import useMissionStore from '../store/useMissionStore';

const API_URL = 'http://localhost:8080';

const STATIC_CONN_VALUES = ['auto', 'udp:127.0.0.1:14550', 'tcp:127.0.0.1:5760', '/dev/tty.SIYI-6801129585'];

const STATE_COLORS = {
  ACTIVE:            '#10b981',
  CONNECTED:         '#3b82f6',
  CONNECTING:        '#f59e0b',
  WAITING_FOR_HEARTBEAT: '#f59e0b',
  RECONNECTING:      '#f97316',
  HEARTBEAT_LOST:    '#ef4444',
  DISCONNECTED:      '#6b7280',
};

const FlightData = () => {
  const wsConnected      = useTelemetryStore(s => s.connected);
  const connectionState  = useTelemetryStore(s => s.connectionState);
  const connectInFlight  = useTelemetryStore(s => s.connectRequestInFlight);
  const startConnection  = useTelemetryStore(s => s.startConnection);
  const stopConnection   = useTelemetryStore(s => s.stopConnection);
  const sendShortcutCommand = useTelemetryStore((s) => s.sendShortcutCommand);
  const connectionConfig = useTelemetryStore((s) => s.connectionConfig);
  const setConnectionConfig = useTelemetryStore((s) => s.setConnectionConfig);
  const vehiclesRoster = useTelemetryStore((s) => s.vehiclesRoster);
  const primarySysId = useTelemetryStore((s) => s.primarySysId);
  const selectPrimaryVehicleSysId = useTelemetryStore((s) => s.selectPrimaryVehicleSysId);
  const adsbTracks = useTelemetryStore((s) => s.adsbTracks);
  const commandStatus = useTelemetryStore((s) => s.commandStatus);
  const commandHistory = useTelemetryStore((s) => s.commandHistory);
  const operationalHistory = useTelemetryStore((s) => s.operationalHistory);
  const setFlightMode = useTelemetryStore((s) => s.setFlightMode);
  const missionPlannedTotal = useMissionStore((s) => s.missionPlannedTotal);

  const vehicle = useTelemetryStore(selectPrimaryVehicle);
  const connState = connectionState || vehicle?.connection_state || 'DISCONNECTED';
  const stateColor = STATE_COLORS[connState] || '#6b7280';
  const isActive = connState === 'ACTIVE' || connState === 'CONNECTED';

  const [busy, setBusy] = useState(false);
  const [connMsg, setConnMsg] = useState('');
  const [vehBusy, setVehBusy] = useState(false);
  const [flightModes, setFlightModes] = useState([]);
  const [modeApplying, setModeApplying] = useState(false);
  const [cmdBanner, setCmdBanner] = useState('');
  const [takeoffAltM, setTakeoffAltM] = useState(10);
  const CUSTOM_LINK = '__custom__';
  const [serialPorts, setSerialPorts] = useState([]);
  const operational = useMemo(
    () => deriveOperationalPhase({ connectionState: connState, vehicle }),
    [connState, vehicle]
  );
  const armBusy = commandStatus?.arm?.state === 'pending' || commandStatus?.disarm?.state === 'pending';
  const takeoffBusy = commandStatus?.takeoff?.state === 'pending';
  const rtlBusy = commandStatus?.rtl?.state === 'pending';
  const landBusy = commandStatus?.land?.state === 'pending';

  const presetConnSet = useMemo(() => {
    const s = new Set(STATIC_CONN_VALUES);
    for (const p of serialPorts) {
      if (p?.device) s.add(p.device);
    }
    return s;
  }, [serialPorts]);

  const connStr = useMemo(() => {
    const cs = connectionConfig.connection_string;
    if (cs && presetConnSet.has(cs)) return cs;
    return CUSTOM_LINK;
  }, [connectionConfig.connection_string, presetConnSet]);

  useEffect(() => {
    if (!isActive) {
      setFlightModes([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await axios.get(`${API_URL}/api/vehicle/flight_modes`);
        if (!cancelled && Array.isArray(res.data?.modes)) {
          setFlightModes(res.data.modes);
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isActive]);

  useEffect(() => {
    if (isActive) return undefined;
    const run = () => {
      axios
        .get(`${API_URL}/api/connection/ports`)
        .then((r) => setSerialPorts(Array.isArray(r.data?.ports) ? r.data.ports : []))
        .catch(() => setSerialPorts([]));
    };
    run();
    const t = setInterval(run, 5000);
    return () => clearInterval(t);
  }, [isActive]);

  const modeOptions = useMemo(() => {
    const cur = vehicle?.status?.mode;
    const s = new Set(flightModes);
    if (cur && cur !== 'UNKNOWN' && !String(cur).startsWith('UNKNOWN(')) s.add(cur);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [flightModes, vehicle?.status?.mode]);

  const applyFlightMode = async (modeName) => {
    if (!modeName || !isActive) return;
    setModeApplying(true);
    setCmdBanner('');
    try {
      await setFlightMode(modeName);
      setCmdBanner(`Mode → ${modeName}`);
    } catch (e) {
      const d = e.response?.data;
      setCmdBanner(
        typeof d?.detail === 'string' ? d.detail : d?.error || e.message || 'Mode change failed'
      );
    } finally {
      setModeApplying(false);
    }
  };

  const runShortcut = async (name, body = null) => {
    setCmdBanner('');
    try {
      const data = await sendShortcutCommand(name, body);
      if (data.accepted === false) {
        setCmdBanner(
          `${String(name).toUpperCase()}: ${data.mav_result_text || 'failed'}${data.reason ? ` (${data.reason})` : ''}`
        );
      } else {
        setCmdBanner(`${String(name).toUpperCase()}: ${data.mav_result_text || 'OK'}`);
      }
    } catch (e) {
      const d = e.details || e.response?.data;
      setCmdBanner(
        typeof d?.detail === 'string' ? d.detail : d?.error || e.message || 'Command failed'
      );
    }
  };

  const applyPrimaryVehicle = async (e) => {
    const v = e.target.value;
    if (!v || !isActive) return;
    setVehBusy(true);
    setCmdBanner('');
    try {
      await selectPrimaryVehicleSysId(Number(v));
      setCmdBanner(`Primary vehicle → SYS ${v}`);
    } catch (err) {
      const d = err.response?.data?.detail;
      setCmdBanner(typeof d === 'string' ? d : d?.error || err.message || 'Select vehicle failed');
    } finally {
      setVehBusy(false);
    }
  };

  const handleConnect = async () => {
    setBusy(true);
    setConnMsg('Connecting...');
    try {
      await startConnection();
      setConnMsg('');
    } catch {
      setConnMsg('Connect failed.');
    }
    setBusy(false);
  };

  const handleDisconnect = async () => {
    setBusy(true);
    setConnMsg('Disconnecting...');
    try {
      await stopConnection();
      setConnMsg('');
    } catch {
      setConnMsg('Disconnect failed.');
    }
    setBusy(false);
  };

  // Heartbeat age
  const hbAge = vehicle?.last_heartbeat
    ? `${Math.round(Date.now() / 1000 - vehicle.last_heartbeat)}s`
    : '--';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Connection Ribbon ────────────────────────────────────────── */}
      <div className="connection-ribbon">
        {/* Status pill */}
        <div className="conn-status-pill" style={{ background: stateColor }}>
          <span className={`conn-dot ${isActive ? 'pulse' : ''}`} />
          {connState}
        </div>

        {/* Stats */}
        <div className="conn-stats">
          <span title="Heartbeat age">HB: {hbAge}</span>
          <span title="Packet loss">Loss: {(vehicle?.link_status?.packet_loss_percent ?? 0).toFixed(1)}%</span>
          <span title="GPS Fix">GPS: {vehicle?.status?.gps_fix ?? 0}D / {vehicle?.status?.satellites ?? 0} sats</span>
          <span title="Horizontal dilution (from GPS_RAW_INT eph)">
            HDOP: {vehicle?.status?.gps_hdop > 0 ? Number(vehicle.status.gps_hdop).toFixed(2) : '—'}
          </span>
          <span title="Mission current sequence (MISSION_CURRENT)">
            WP: {vehicle?.mission?.current_seq != null && vehicle.mission.current_seq >= 0 ? vehicle.mission.current_seq : '—'}
          </span>
          <span title="Battery">{vehicle?.battery?.voltage?.toFixed(1) ?? '--'}V · {vehicle?.battery?.remaining ?? '--'}%</span>
          <span title="Mode">{vehicle?.status?.mode || '--'}</span>
          <span title="Operational phase">{operational.label}</span>
          <span title="ADS-B traffic (MAVLink ADSB_VEHICLE)">ADSB: {adsbTracks?.length ?? 0}</span>
          <span title="WS">{wsConnected ? '🟢 WS' : '🔴 WS'}</span>
        </div>

        {/* Controls */}
        <div className="conn-controls">
          <select
            value={connStr}
            onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM_LINK) {
                setConnectionConfig({ connection_string: connectionConfig.connection_string || '' });
              } else {
                setConnectionConfig({ connection_string: v });
              }
            }}
            disabled={busy || connectInFlight || isActive}
            className="status-search"
            style={{ width: 200, height: 34 }}
          >
            <option value="auto">AUTO</option>
            <option value="udp:127.0.0.1:14550">UDP SITL</option>
            <option value="tcp:127.0.0.1:5760">TCP SITL</option>
            <option value="/dev/tty.SIYI-6801129585">Bluetooth Serial</option>
            {serialPorts.length > 0 && (
              <optgroup label="Detected serial">
                {serialPorts.map((p) => (
                  <option key={p.device} value={p.device}>
                    {p.device}
                    {p.description ? ` — ${String(p.description).slice(0, 36)}` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            <option value={CUSTOM_LINK}>Custom…</option>
          </select>
          {connStr === CUSTOM_LINK && (
            <input
              type="text"
              placeholder="udp:14550 / COM3 / dev path"
              value={
                connectionConfig.connection_string &&
                !presetConnSet.has(connectionConfig.connection_string)
                  ? connectionConfig.connection_string
                  : ''
              }
              onChange={(e) => setConnectionConfig({ connection_string: e.target.value })}
              disabled={busy || connectInFlight || isActive}
              className="status-search"
              style={{ width: 220, height: 34 }}
            />
          )}
          <select
            value={connectionConfig.baudrate}
            onChange={(e) => setConnectionConfig({ baudrate: Number(e.target.value) })}
            disabled={busy || connectInFlight || isActive}
            className="status-search"
            style={{ width: 110, height: 34 }}
          >
            {[9600, 57600, 115200, 230400, 460800, 921600].map((baud) => (
              <option key={baud} value={baud}>{baud}</option>
            ))}
          </select>
          {connMsg && <span className="conn-msg">{connMsg}</span>}
          <button
            className="btn-conn connect"
            onClick={handleConnect}
            disabled={busy || connectInFlight || isActive || connState === 'CONNECTING' || connState === 'WAITING_FOR_HEARTBEAT' || connState === 'RECONNECTING'}
          >
            CONNECT
          </button>
          <button
            className="btn-conn disconnect"
            onClick={handleDisconnect}
            disabled={busy || connectInFlight || connState === 'DISCONNECTED'}
          >
            DISCONNECT
          </button>
          {isActive && modeOptions.length > 0 && (
            <select
              className="status-search"
              style={{ width: 130, height: 34, marginLeft: 8 }}
              value={vehicle?.status?.mode && modeOptions.includes(vehicle.status.mode) ? vehicle.status.mode : ''}
              disabled={modeApplying}
              title="Set flight mode (ArduPilot custom_mode)"
              onChange={(e) => {
                const v = e.target.value;
                if (v) applyFlightMode(v);
              }}
            >
              <option value="" disabled>
                Mode…
              </option>
              {modeOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
          {isActive && vehiclesRoster.length > 0 && (
            <select
              className="status-search"
              style={{ width: 140, height: 34, marginLeft: 8 }}
              value={primarySysId != null && primarySysId !== '' ? String(primarySysId) : ''}
              disabled={vehBusy}
              title="Primary vehicle for commands, parameters, and mission"
              onChange={applyPrimaryVehicle}
            >
              {vehiclesRoster.map((v) => (
                <option key={v.sysid} value={String(v.sysid)}>
                  SYS{v.sysid} {v.mode && v.mode !== 'UNKNOWN' ? `· ${v.mode}` : ''}
                  {v.is_primary ? ' ★' : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {cmdBanner && (
        <div
          role="status"
          style={{
            padding: '6px 16px',
            fontSize: 12,
            color: '#e2e8f0',
            background: '#0f172a',
            borderBottom: '1px solid #334155',
          }}
        >
          {cmdBanner}
        </div>
      )}

      {/* ── Main Layout ──────────────────────────────────────────────── */}
      <div className="mp-layout" style={{ flex: 1 }}>

        {/* Left Sidebar */}
        <div className="mp-sidebar">
          <div className="mp-hud-section">
            <AdvancedHUD vehicleState={vehicle} operational={operational} />
          </div>
          <div className="mp-data-section">
            <TelemetryGrid vehicleState={vehicle} />
            <MissionExecutionPanel
              operational={operational}
              operationalHistory={operationalHistory}
              commandStatus={commandStatus}
              commandHistory={commandHistory}
              missionSeq={Number(vehicle?.mission?.current_seq ?? -1)}
              missionTotal={missionPlannedTotal}
            />
          </div>
        </div>

        {/* Map */}
        <div className="mp-map-section">
          <MapView />
          {isActive && (
            <div className="quick-actions">
              <button
                className={`btn-action ${vehicle?.status?.armed ? 'btn-disarm' : 'btn-arm'}`}
                type="button"
                onClick={() => runShortcut(vehicle?.status?.armed ? 'disarm' : 'arm')}
                disabled={armBusy}
              >
                {vehicle?.status?.armed ? 'DISARM' : 'ARM'}
              </button>
              <button
                className="btn-action"
                type="button"
                onClick={() => runShortcut('takeoff', { altitude_m: takeoffAltM })}
                disabled={!vehicle?.status?.armed || takeoffBusy}
                title="MAV_CMD_NAV_TAKEOFF"
              >
                {takeoffBusy ? 'TAKEOFF…' : 'TAKEOFF'}
              </button>
              <input
                type="number"
                min={2}
                max={200}
                value={takeoffAltM}
                onChange={(e) => setTakeoffAltM(Math.max(2, Number(e.target.value) || 10))}
                className="alt-input"
                style={{ width: 72, height: 34 }}
                title="Takeoff altitude (m)"
              />
              <button className="btn-action btn-rtl" type="button" onClick={() => runShortcut('rtl')} disabled={rtlBusy}>
                {rtlBusy ? 'RTL…' : 'RTL'}
              </button>
              <button className="btn-action" type="button" onClick={() => runShortcut('land')} disabled={landBusy}>
                {landBusy ? 'LAND…' : 'LAND'}
              </button>
            </div>
          )}
        </div>

      </div>
    </div>
  );
};

export default FlightData;
