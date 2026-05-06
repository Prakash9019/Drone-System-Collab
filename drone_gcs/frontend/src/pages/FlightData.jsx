import React from 'react';
import useTelemetryStore from '../store/useTelemetryStore';
import MapView from '../components/MapView';
import axios from 'axios';

const FlightData = () => {
  const telemetry = useTelemetryStore((state) => state.telemetry);
  
  // We assume single vehicle (id 1) for this dashboard view
  const vehicle = telemetry['1'] || {};
  
  const status = vehicle.status || { mode: 'UNKNOWN', armed: false };
  const position = vehicle.position || { lat: 0, lng: 0, alt_amsl: 0, alt_rel: 0 };
  const velocity = vehicle.velocity || { groundspeed: 0, heading: 0 };
  const battery = vehicle.battery || { voltage: 0, remaining: 0 };

  const handleCommand = async (cmd) => {
    try {
      await axios.post(`http://localhost:8080/api/command/${cmd}`);
    } catch (err) {
      console.error('Command failed', err);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      {/* Telemetry Ribbon */}
      <div className="telemetry-ribbon">
        <div className="metric">
          <span className="metric-label">Mode</span>
          <span className="metric-value" style={{ color: 'var(--accent-blue)' }}>{status.mode}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Status</span>
          <span className={`metric-value ${status.armed ? 'danger' : 'safe'}`}>
            {status.armed ? 'ARMED' : 'DISARMED'}
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Altitude (Rel)</span>
          <span className="metric-value">{position.alt_rel.toFixed(1)} m</span>
        </div>
        <div className="metric">
          <span className="metric-label">Ground Speed</span>
          <span className="metric-value">{velocity.groundspeed.toFixed(1)} m/s</span>
        </div>
        <div className="metric">
          <span className="metric-label">Battery</span>
          <span className={`metric-value ${battery.remaining < 20 ? 'danger' : 'safe'}`}>
            {battery.voltage.toFixed(1)}V ({battery.remaining}%)
          </span>
        </div>
      </div>

      {/* Map Layer */}
      <div style={{ flex: 1, position: 'relative' }}>
        <MapView lat={position.lat} lng={position.lng} heading={velocity.heading} />
        
        {/* Quick Actions overlay */}
        <div className="quick-actions">
          <button 
            className={`btn-action ${status.armed ? 'btn-disarm' : 'btn-arm'}`}
            onClick={() => handleCommand(status.armed ? 'disarm' : 'arm')}
          >
            {status.armed ? 'DISARM' : 'ARM'}
          </button>
          <button className="btn-action btn-rtl" onClick={() => handleCommand('rtl')}>
            RTL
          </button>
        </div>
      </div>
    </div>
  );
};

export default FlightData;
