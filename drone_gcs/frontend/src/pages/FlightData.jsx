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
  const attitude = vehicle.attitude || { roll: 0, pitch: 0, yaw: 0 };

  const handleCommand = async (cmd) => {
    try {
      await axios.post(`http://localhost:8080/api/command/${cmd}`);
    } catch (err) {
      console.error('Command failed', err);
    }
  };

  const handleModeChange = async (e) => {
    try {
      await axios.post('http://localhost:8080/api/mode', { mode: e.target.value });
    } catch (err) {
      console.error('Mode change failed', err);
    }
  };

  // Artificial horizon math
  const rollDeg = (attitude.roll * 180) / Math.PI;
  const pitchDeg = (attitude.pitch * 180) / Math.PI;
  // Translate 1 degree of pitch to 2px of vertical movement
  const pitchOffset = pitchDeg * 2;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      {/* Telemetry Ribbon */}
      <div className="telemetry-ribbon">
        <div className="metric">
          <span className="metric-label">Mode</span>
          <select 
            value={status.mode} 
            onChange={handleModeChange}
            className="mode-select"
          >
            <option value={status.mode}>{status.mode}</option>
            <option value="STABILIZE">STABILIZE</option>
            <option value="GUIDED">GUIDED</option>
            <option value="LOITER">LOITER</option>
            <option value="AUTO">AUTO</option>
          </select>
        </div>
        <div className="metric">
          <span className="metric-label">Status</span>
          <span className={`metric-value ${status.armed ? 'danger' : 'safe'}`}>
            {status.armed ? 'ARMED' : 'DISARMED'}
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Heading</span>
          <span className="metric-value">{velocity.heading}°</span>
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

      {/* Map & HUD Layer */}
      <div style={{ flex: 1, position: 'relative', display: 'flex' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <MapView lat={position.lat} lng={position.lng} heading={velocity.heading} />
          
          {/* Artificial Horizon Overlay */}
          <div className="hud-container">
            <div className="hud-horizon-clip">
              <div 
                className="hud-horizon-bg"
                style={{
                  transform: `rotate(${-rollDeg}deg) translateY(${pitchOffset}px)`
                }}
              >
                <div className="hud-sky"></div>
                <div className="hud-ground"></div>
                <div className="hud-pitch-lines">
                   {/* CSS lines for pitch would go here */}
                </div>
              </div>
              {/* Fixed crosshair */}
              <div className="hud-crosshair"></div>
            </div>
            <div className="hud-readouts">
              <span>R: {rollDeg.toFixed(1)}°</span>
              <span>P: {pitchDeg.toFixed(1)}°</span>
            </div>
          </div>
          
          {/* Quick Actions overlay */}
          <div className="quick-actions">
            <button 
              className={`btn-action ${status.armed ? 'btn-disarm' : 'btn-arm'}`}
              onClick={() => handleCommand(status.armed ? 'disarm' : 'arm')}
            >
              {status.armed ? 'DISARM' : 'ARM'}
            </button>
            <button className="btn-action primary" onClick={() => handleCommand('takeoff')}>
              TAKEOFF
            </button>
            <button className="btn-action primary" onClick={() => handleCommand('land')}>
              LAND
            </button>
            <button className="btn-action btn-rtl" onClick={() => handleCommand('rtl')}>
              RTL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FlightData;
