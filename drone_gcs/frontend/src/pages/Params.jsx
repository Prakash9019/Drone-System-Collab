import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Search, RefreshCw, Save } from 'lucide-react';
import useTelemetryStore from '../store/useTelemetryStore';

const Params = () => {
  const telemetry = useTelemetryStore((state) => state.telemetry);
  const vehicle = telemetry['1'] || {};
  const parameters = vehicle.parameters || {};

  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [editValues, setEditValues] = useState({});

  const handleRefresh = async () => {
    setLoading(true);
    try {
      await axios.post('http://localhost:8080/api/parameters/refresh');
    } catch (err) {
      console.error('Failed to request parameters', err);
    }
    // Note: parameters populate over time via telemetry stream
    setTimeout(() => setLoading(false), 2000);
  };

  const handleSave = async (paramId) => {
    const val = editValues[paramId];
    if (val === undefined) return;
    
    try {
      await axios.post('http://localhost:8080/api/parameters/set', {
        param_id: paramId,
        param_value: parseFloat(val)
      });
      // Clear edit state after saving
      setEditValues(prev => {
        const next = { ...prev };
        delete next[paramId];
        return next;
      });
    } catch (err) {
      console.error('Failed to set parameter', err);
    }
  };

  const filteredParams = Object.entries(parameters).filter(([key]) => 
    key.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="flight-planner" style={{ padding: '20px', backgroundColor: 'var(--bg-panel)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Vehicle Parameters</h2>
        <button className="btn-toolbar" onClick={handleRefresh} disabled={loading}>
          <RefreshCw size={18} className={loading ? "spin" : ""} />
          {loading ? 'Requesting...' : 'Fetch All'}
        </button>
      </div>

      <div style={{ position: 'relative', marginBottom: '20px' }}>
        <Search size={18} style={{ position: 'absolute', left: '10px', top: '10px', color: 'var(--text-secondary)' }} />
        <input 
          type="text" 
          placeholder="Search parameters..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{
            width: '100%',
            padding: '10px 10px 10px 35px',
            backgroundColor: 'var(--bg-dark)',
            border: '1px solid var(--border-color)',
            color: 'white',
            borderRadius: '6px'
          }}
        />
      </div>

      <div className="waypoint-table-container" style={{ height: 'calc(100vh - 200px)', overflowY: 'auto' }}>
        <table className="waypoint-table">
          <thead>
            <tr>
              <th>Parameter ID</th>
              <th>Current Value</th>
              <th>New Value</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {filteredParams.length === 0 ? (
              <tr>
                <td colSpan="4" style={{ textAlign: 'center', padding: '20px' }}>No parameters found. Click Fetch All.</td>
              </tr>
            ) : (
              filteredParams.map(([key, val]) => (
                <tr key={key}>
                  <td style={{ fontWeight: 'bold' }}>{key}</td>
                  <td>{val}</td>
                  <td>
                    <input 
                      type="number"
                      className="alt-input"
                      style={{ width: '100px' }}
                      value={editValues[key] !== undefined ? editValues[key] : ''}
                      onChange={(e) => setEditValues({ ...editValues, [key]: e.target.value })}
                      placeholder={String(val)}
                    />
                  </td>
                  <td>
                    <button 
                      className="btn-toolbar primary" 
                      style={{ padding: '4px 12px' }}
                      onClick={() => handleSave(key)}
                      disabled={editValues[key] === undefined || editValues[key] === ''}
                    >
                      <Save size={14} /> Save
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Params;
