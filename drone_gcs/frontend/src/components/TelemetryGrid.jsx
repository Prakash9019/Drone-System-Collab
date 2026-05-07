import React from 'react';
import { TelemetryRegistry } from '../utils/TelemetryRegistry';

const TelemetryGrid = ({ vehicleState }) => {
  if (!vehicleState) return null;

  // We are replicating the Mission Planner Quick tab layout here
  const displayKeys = [
    'altitude', 'groundspeed', 
    'distToWp', 'yaw', 
    'verticalSpeed', 'distToMav'
  ];

  return (
    <div className="telemetry-grid-container">
      {/* Tabs placeholder */}
      <div className="telemetry-tabs">
        <span className="tab active">Quick</span>
        <span className="tab">Actions</span>
        <span className="tab">Messages</span>
        <span className="tab">Gauges</span>
        <span className="tab">Status</span>
      </div>
      
      {/* Grid Content */}
      <div className="telemetry-grid">
        {displayKeys.map(key => {
          const config = TelemetryRegistry[key];
          if (!config) return null;
          return (
            <div key={key} className="telemetry-cell">
              <div className="telemetry-label">{config.label}</div>
              <div 
                className="telemetry-value" 
                style={{ color: config.color }}
              >
                {config.getValue(vehicleState)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TelemetryGrid;
