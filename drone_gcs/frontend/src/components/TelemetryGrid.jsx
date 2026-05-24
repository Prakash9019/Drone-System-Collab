import React, { useState } from 'react';
import QuickTab from './tabs/QuickTab';
import ActionsTab from './tabs/ActionsTab';
import MessagesTab from './tabs/MessagesTab';
import StatusTab from './tabs/StatusTab';
import PreFlightTab from './tabs/PreFlightTab';
import ServoTab from './tabs/ServoTab';
import GaugesTab from './tabs/GaugesTab';
import AuxTab from './tabs/AuxTab';
import ReplayTab from './tabs/ReplayTab';

const TABS = [
  { id: 'Quick',    label: 'Quick' },
  { id: 'Actions',  label: 'Actions' },
  { id: 'Messages', label: 'Messages' },
  { id: 'PreFlight',label: 'PreFlight' },
  { id: 'Gauges',   label: 'Gauges' },
  { id: 'Status',   label: 'Status' },
  { id: 'Servo',    label: 'Servo' },
  { id: 'AUX',      label: 'AUX' },
  { id: 'Replay',   label: 'Replay' },
];

const TelemetryGrid = ({ vehicleState }) => {
  const [activeTab, setActiveTab] = useState('Quick');

  const renderTab = () => {
    switch (activeTab) {
      case 'Quick':     return <QuickTab vehicleState={vehicleState} />;
      case 'Actions':   return <ActionsTab vehicleState={vehicleState} />;
      case 'Messages':  return <MessagesTab vehicleState={vehicleState} />;
      case 'PreFlight': return <PreFlightTab vehicleState={vehicleState} />;
      case 'Gauges':    return <GaugesTab vehicleState={vehicleState} />;
      case 'Status':    return <StatusTab vehicleState={vehicleState} />;
      case 'Servo':     return <ServoTab vehicleState={vehicleState} />;
      case 'AUX':       return <AuxTab vehicleState={vehicleState} />;
      case 'Replay':    return <ReplayTab />;
      default:          return null;
    }
  };

  return (
    <div className="telemetry-grid-container">
      <div className="telemetry-tabs">
        {TABS.map(tab => (
          <span
            key={tab.id}
            className={`tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
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
