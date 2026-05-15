import React, { useMemo, useState } from 'react';
import { TelemetryRegistry } from '../../utils/TelemetryRegistry';

const LS_KEY = 'drone_gcs_quick_tab_keys_v2';
const DEFAULT_KEYS = [
  'altitude', 'groundspeed', 'airspeed', 'heading',
  'missionSeq', 'distToWp', 'verticalSpeed', 'distToMav',
  'battery', 'gpsFix', 'satellites', 'gpsHdop',
  'throttle', 'roll', 'pitch', 'timeInAir',
];

function loadKeys() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length) {
      return parsed.filter((k) => TelemetryRegistry[k]);
    }
  } catch {
    // ignore
  }
  return DEFAULT_KEYS;
}

// Group registry keys by their group field
const ALL_GROUPS = (() => {
  const groups = {};
  Object.entries(TelemetryRegistry).forEach(([key, cfg]) => {
    const g = cfg.group || 'Other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(key);
  });
  return groups;
})();

const QuickTab = ({ vehicleState }) => {
  const [displayKeys, setDisplayKeys] = useState(loadKeys);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [groupFilter, setGroupFilter] = useState('All');
  const allKeys = useMemo(() => Object.keys(TelemetryRegistry), []);
  const allGroupNames = useMemo(() => ['All', ...Object.keys(ALL_GROUPS)], []);

  // Always render — use vehicleState or null (shows defaults from registry getValue)
  const stateArg = vehicleState || null;

  const persist = (next) => {
    setDisplayKeys(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
  };

  const toggleKey = (key) => {
    const has = displayKeys.includes(key);
    const next = has ? displayKeys.filter(k => k !== key) : [...displayKeys, key];
    if (next.length === 0) return;
    persist(next);
  };

  const resetDefaults = () => persist(DEFAULT_KEYS);

  const visibleKeys = groupFilter === 'All'
    ? allKeys
    : (ALL_GROUPS[groupFilter] || []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div className="quick-toolbar">
        <button className="btn-toolbar" type="button" onClick={() => setCustomizeOpen(v => !v)}>
          {customizeOpen ? 'Done' : '⚙ Customize'}
        </button>
        {customizeOpen && (
          <button className="btn-toolbar" type="button" onClick={resetDefaults}>
            Reset
          </button>
        )}
        {!vehicleState && (
          <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 'auto' }}>
            Not connected — showing defaults
          </span>
        )}
      </div>

      {/* Customize panel */}
      {customizeOpen && (
        <div className="quick-customize-panel">
          {/* Group filter tabs */}
          <div className="quick-group-tabs">
            {allGroupNames.map(g => (
              <button
                key={g}
                className={`quick-group-tab ${groupFilter === g ? 'active' : ''}`}
                onClick={() => setGroupFilter(g)}
              >
                {g}
              </button>
            ))}
          </div>
          <div className="quick-widget-picker">
            {visibleKeys.map((key) => (
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
        </div>
      )}

      {/* Telemetry cells grid — always visible */}
      <div className="quick-tab-grid">
        {displayKeys.map(key => {
          const cfg = TelemetryRegistry[key];
          if (!cfg) return null;
          const val = cfg.getValue(stateArg);
          return (
            <div key={key} className="telemetry-cell">
              <div className="telemetry-label">{cfg.label}</div>
              <div
                className="telemetry-value"
                style={{ color: vehicleState ? cfg.color : '#4b5563' }}
              >
                {val}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default QuickTab;
