import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { Activity, Map, Settings, PlaneTakeoff } from 'lucide-react';
import useTelemetryStore from './store/useTelemetryStore';
import FlightData from './pages/FlightData';
import FlightPlanner from './pages/FlightPlanner';
import './index.css';

function App() {
  const { connect, connected } = useTelemetryStore();

  useEffect(() => {
    connect();
  }, [connect]);

  return (
    <Router>
      <div className="app-container">
        {/* Sidebar */}
        <div className="sidebar">
          <h1>DRONE GCS</h1>
          
          <div style={{ padding: '0 20px 10px', fontSize: '0.8rem', color: connected ? 'var(--accent-green)' : 'var(--accent-red)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: connected ? 'var(--accent-green)' : 'var(--accent-red)' }} />
            {connected ? 'LINK ACTIVE' : 'NO LINK'}
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
          </nav>
        </div>

        {/* Main Content */}
        <div className="main-content">
          <Routes>
            <Route path="/" element={<Navigate to="/flight-data" replace />} />
            <Route path="/flight-data" element={<FlightData />} />
            <Route path="/planner" element={<FlightPlanner />} />
            <Route path="/setup" element={<div style={{padding: '20px'}}><h2>Setup & Tuning</h2></div>} />
          </Routes>
        </div>
      </div>
    </Router>
  );
}

export default App;
