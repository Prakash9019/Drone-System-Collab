import React, { useState } from 'react';
import QuickTab from './tabs/QuickTab';
import ActionsTab from './tabs/ActionsTab';
import MessagesTab from './tabs/MessagesTab';
import StatusTab from './tabs/StatusTab';
import PreFlightTab from './tabs/PreFlightTab';
import ServoTab from './tabs/ServoTab';
import AdvancedHUD from './AdvancedHUD';

const TABS = ['Quick', 'Actions', 'Messages', 'PreFlight', 'Gauges', 'Status', 'Servo'];

const TelemetryGrid = ({ vehicleState }) => {
  const [activeTab, setActiveTab] = useState('Quick');

  const renderTab = () => {
    switch (activeTab) {
      case 'Quick':
        return <QuickTab vehicleState={vehicleState} />;
      case 'Actions':
        return <ActionsTab vehicleState={vehicleState} />;
      case 'Messages':
        return <MessagesTab vehicleState={vehicleState} />;
      case 'PreFlight':
        return <PreFlightTab vehicleState={vehicleState} />;
      case 'Gauges':
        // Reuse the AdvancedHUD in tab form as the Gauges instrument panel
        return (
          <div style={{ height: '100%', padding: '8px', boxSizing: 'border-box' }}>
            <AdvancedHUD vehicleState={vehicleState} />
          </div>
        );
      case 'Status':
        return <StatusTab vehicleState={vehicleState} />;
      case 'Servo':
        return <ServoTab vehicleState={vehicleState} />;
      default:
        return null;
    }
  };

  return (
    <div className="telemetry-grid-container">
      <div className="telemetry-tabs">
        {TABS.map(tab => (
          <span
            key={tab}
            className={`tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </span>
        ))}
      </div>
      <div className="telemetry-tab-content">
        {renderTab()}
      </div>
    </div>
  );
};

export default TelemetryGrid;
