import React, { useMemo, useState } from 'react';
import { TelemetryRegistry } from '../../utils/TelemetryRegistry';

const LS_KEY = 'drone_gcs_quick_tab_keys';
const DEFAULT_KEYS = [
  'altitude', 'groundspeed',
  'missionSeq', 'distToWp',
  'verticalSpeed', 'distToMav',
  'battery', 'gpsFix',
  'satellites', 'gpsHdop',
];

function loadKeys() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length) {
      return parsed.filter((k) => TelemetryRegistry[k]);
    }
  } catch {
    // ignore localStorage parse errors
  }
  return DEFAULT_KEYS;
}

const QuickTab = ({ vehicleState }) => {
  const [displayKeys, setDisplayKeys] = useState(loadKeys);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  // Hooks must run unconditionally — never place hooks after an early return.
  const allKeys = useMemo(() => Object.keys(TelemetryRegistry), []);

  if (!vehicleState) {
    return (
      <div className="tab-empty">
        <span>No telemetry. Connect to vehicle.</span>
      </div>
    );
  }

  const persist = (next) => {
    setDisplayKeys(next);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    } catch {
      // ignore storage failures
    }
  };

  const toggleKey = (key) => {
    const has = displayKeys.includes(key);
    const next = has
      ? displayKeys.filter((k) => k !== key)
      : [...displayKeys, key];
    if (next.length === 0) return;
    persist(next);
  };

  const resetDefaults = () => persist(DEFAULT_KEYS);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border-color)' }}>
        <button className="btn-toolbar" type="button" onClick={() => setCustomizeOpen((v) => !v)}>
          {customizeOpen ? 'Hide widgets' : 'Customize widgets'}
        </button>
        {customizeOpen && (
          <button className="btn-toolbar" type="button" onClick={resetDefaults}>
            Reset defaults
          </button>
        )}
      </div>
      {customizeOpen && (
        <div className="quick-widget-picker">
          {allKeys.map((key) => (
            <label key={key} className="quick-widget-option">
              <input
                type="checkbox"
                checked={displayKeys.includes(key)}
                onChange={() => toggleKey(key)}
              />
              <span>{TelemetryRegistry[key].label}</span>
            </label>
          ))}
        </div>
      )}
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
    </div>
  );
};

export default QuickTab;
