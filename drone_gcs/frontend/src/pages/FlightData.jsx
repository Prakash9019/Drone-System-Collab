import React, { useState } from 'react';
import useTelemetryStore from '../store/useTelemetryStore';
import AdvancedHUD from '../components/AdvancedHUD';
import TelemetryGrid from '../components/TelemetryGrid';
import MapView from '../components/MapView';

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
  const telemetry        = useTelemetryStore(s => s.telemetry);
  const wsConnected      = useTelemetryStore(s => s.connected);
  const connectionState  = useTelemetryStore(s => s.connectionState);
  const connectInFlight  = useTelemetryStore(s => s.connectRequestInFlight);
  const startConnection  = useTelemetryStore(s => s.startConnection);
  const stopConnection   = useTelemetryStore(s => s.stopConnection);
  const sendShortcutCommand = useTelemetryStore(s => s.sendShortcutCommand);

  const vehicle = telemetry['1'];
  const connState = connectionState || vehicle?.connection_state || 'DISCONNECTED';
  const stateColor = STATE_COLORS[connState] || '#6b7280';
  const isActive = connState === 'ACTIVE' || connState === 'CONNECTED';

  const [busy, setBusy] = useState(false);
  const [connMsg, setConnMsg] = useState('');

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
          <span title="Battery">{vehicle?.battery?.voltage?.toFixed(1) ?? '--'}V · {vehicle?.battery?.remaining ?? '--'}%</span>
          <span title="Mode">{vehicle?.status?.mode || '--'}</span>
          <span title="WS">{wsConnected ? '🟢 WS' : '🔴 WS'}</span>
        </div>

        {/* Controls */}
        <div className="conn-controls">
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
        </div>
      </div>

      {/* ── Main Layout ──────────────────────────────────────────────── */}
      <div className="mp-layout" style={{ flex: 1 }}>

        {/* Left Sidebar */}
        <div className="mp-sidebar">
          <div className="mp-hud-section">
            <AdvancedHUD vehicleState={vehicle} />
          </div>
          <div className="mp-data-section">
            <TelemetryGrid vehicleState={vehicle} />
          </div>
        </div>

        {/* Map */}
        <div className="mp-map-section">
          <MapView />
          {isActive && (
            <div className="quick-actions">
              <button
                className={`btn-action ${vehicle?.status?.armed ? 'btn-disarm' : 'btn-arm'}`}
                onClick={() => sendShortcutCommand(vehicle?.status?.armed ? 'disarm' : 'arm')}
              >
                {vehicle?.status?.armed ? 'DISARM' : 'ARM'}
              </button>
              <button className="btn-action btn-rtl" onClick={() => sendShortcutCommand('rtl')}>RTL</button>
            </div>
          )}
        </div>

      </div>
    </div>
  );
};

export default FlightData;
