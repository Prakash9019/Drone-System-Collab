import React, { useState } from 'react';
import axios from 'axios';
import useTelemetryStore from '../store/useTelemetryStore';
import AdvancedHUD from '../components/AdvancedHUD';
import TelemetryGrid from '../components/TelemetryGrid';
import MapView from '../components/MapView';

const FlightData = () => {
  const telemetry = useTelemetryStore((state) => state.telemetry);
  
  // Using sysid 1 for now
  const vehicle = telemetry['1']; 
  
  const [commanding, setCommanding] = useState(false);

  const handleCommand = async (cmd) => {
    setCommanding(true);
    try {
      await axios.post('http://localhost:8080/api/command', { command: cmd });
    } catch (e) {
      console.error(e);
    }
    setTimeout(() => setCommanding(false), 1000);
  }; 
  // Throttle updates to 10Hz by picking only necessary data from store

  return (
    <div className="mp-layout">
      {/* Left Sidebar */}
      <div className="mp-sidebar">
        
        {/* HUD Section */}
        <div className="mp-hud-section">
          <AdvancedHUD vehicleState={vehicle} />
        </div>
        
        {/* Telemetry Grid Section */}
        <div className="mp-data-section">
          <TelemetryGrid vehicleState={vehicle} />
        </div>
        
      </div>
      
      {/* Right Map */}
      <div className="mp-map-section">
        {/* We will add context menu logic inside MapView shortly */}
        <MapView />
        
        {/* Map Overlays like Quick Actions if we want them here, 
            or they could be moved to the Action tab in TelemetryGrid */}
        {vehicle && vehicle.connection_state === 'ACTIVE' && (
          <div className="quick-actions">
            <button 
              className={`btn-action ${vehicle.status?.armed ? 'btn-disarm' : 'btn-arm'}`}
              onClick={() => handleCommand(vehicle.status?.armed ? 400 : 400)}
            >
              {vehicle.status?.armed ? 'DISARM' : 'ARM'}
            </button>
            <button className="btn-action" style={{backgroundColor: 'white', color: 'black'}} onClick={() => handleCommand(22)}>Takeoff</button>
            <button className="btn-action" style={{backgroundColor: 'white', color: 'black'}} onClick={() => handleCommand(21)}>Land</button>
            <button className="btn-action btn-rtl" onClick={() => handleCommand(20)}>RTL</button>
          </div>
        )}
      </div>
    </div>
  );
};

export default FlightData;
