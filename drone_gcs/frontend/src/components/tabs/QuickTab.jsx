import React from 'react';
import { TelemetryRegistry } from '../../utils/TelemetryRegistry';

const QuickTab = ({ vehicleState }) => {
  if (!vehicleState) {
    return (
      <div className="tab-empty">
        <span>No telemetry. Connect to vehicle.</span>
      </div>
    );
  }

  const displayKeys = [
    'altitude', 'groundspeed',
    'distToWp', 'yaw',
    'verticalSpeed', 'distToMav',
    'battery', 'gpsFix',
    'satellites',
  ];

  return (
    <div className="quick-tab-grid">
      {displayKeys.map(key => {
        const config = TelemetryRegistry[key];
        if (!config) return null;
        return (
          <div key={key} className="telemetry-cell">
            <div className="telemetry-label">{config.label}</div>
            <div className="telemetry-value" style={{ color: config.color }}>
              {config.getValue(vehicleState)}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default QuickTab;
