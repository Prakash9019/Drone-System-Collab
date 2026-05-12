import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { Activity, Map, Monitor, Settings, PlaneTakeoff, CircleHelp } from 'lucide-react';
import useTelemetryStore from './store/useTelemetryStore';
import FlightData from './pages/FlightData';
import FlightPlanner from './pages/FlightPlanner';
import Setup from './pages/Setup';
import Simulation from './pages/Simulation';
import OSDEditor from './pages/OSDEditor';
import Help from './pages/Help';
import './index.css';

function App() {
  const connect = useTelemetryStore((s) => s.connect);
  const ws = useTelemetryStore((s) => s.ws);
  const connectionState = useTelemetryStore((s) => s.connectionState);
  const wsLive = !!(ws && ws.readyState === 1);
  const mavLinked =
    wsLive &&
    (connectionState === 'CONNECTED' || connectionState === 'ACTIVE');

  useEffect(() => {
    connect();
  }, [connect]);

  const statusColor =
    mavLinked ? 'var(--accent-green)' : wsLive ? 'var(--accent-orange)' : 'var(--accent-red)';
  const mavlinkLine = wsLive ? `MAVLink ${connectionState || '—'}` : 'No browser feed';

  return (
    <Router>
      <div className="app-container">
        {/* Sidebar */}
        <div className="sidebar">
          <h1>DRONE GCS</h1>
          
          <div
            style={{
              padding: '0 20px 10px',
              fontSize: '0.8rem',
              color: statusColor,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
            title={
              wsLive
                ? 'WebSocket telemetry stream + last MAVLink state from gateway'
                : 'Open Flight Data → Connect after the Node gateway is running.'
            }
          >
            <div
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                flexShrink: 0,
                backgroundColor: statusColor,
              }}
            />
            <span style={{ lineHeight: 1.3 }}>
              {!wsLive && 'Offline'}
              {wsLive && (
                <>
                  Stream OK
                  <br />
                  {mavlinkLine}
                </>
              )}
            </span>
          </div>

          <nav>
            <NavLink to="/flight-data" className={({isActive}) => isActive ? "nav-item active" : "nav-item"}>
              <Activity size={20} />
              Flight Data
            </NavLink>
            <NavLink to="/planner" className={({isActive}) => isActive ? "nav-item active" : "nav-item"}>
              <Map size={20} />
              Flight Planner
            </NavLink>
            <NavLink to="/setup" className={({isActive}) => isActive ? "nav-item active" : "nav-item"}>
              <Settings size={20} />
              Setup
            </NavLink>
            <NavLink to="/simulation" className={({isActive}) => isActive ? "nav-item active" : "nav-item"}>
              <PlaneTakeoff size={20} />
              Simulation
            </NavLink>
            <NavLink to="/osd" className={({isActive}) => isActive ? "nav-item active" : "nav-item"}>
              <Monitor size={20} />
              OSD
            </NavLink>
            <NavLink to="/help" className={({isActive}) => isActive ? "nav-item active" : "nav-item"}>
              <CircleHelp size={20} />
              Help
            </NavLink>
          </nav>
        </div>

        {/* Main Content */}
        <div className="main-content">
          <Routes>
            <Route path="/" element={<Navigate to="/flight-data" replace />} />
            <Route path="/flight-data" element={<FlightData />} />
            <Route path="/planner" element={<FlightPlanner />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/simulation" element={<Simulation />} />
            <Route path="/osd" element={<OSDEditor />} />
            <Route path="/help" element={<Help />} />
          </Routes>
        </div>
      </div>
    </Router>
  );
}

export default App;
