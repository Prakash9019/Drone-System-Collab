import React, { useRef, useState, useEffect } from 'react';
import axios from 'axios';
import { Search, RefreshCw, Save, Upload, Download, GitCompare } from 'lucide-react';
import useTelemetryStore from '../store/useTelemetryStore';
import { selectParameterSyncState, selectGroupedParameters, filterParameters, PARAMETER_CATEGORIES } from '../telemetry/parameterSelectors';

const Params = () => {
  const syncStateInfo = useTelemetryStore(selectParameterSyncState);
  const paramEntriesRaw = useTelemetryStore((state) => selectGroupedParameters(state, paramMeta, favorites));
  const refreshParameterStatus = useTelemetryStore((state) => state.refreshParameterStatus);
  const loadParameterCache = useTelemetryStore((state) => state.loadParameterCache);

  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [editValues, setEditValues] = useState({});
  const [category, setCategory] = useState('ALL');
  const [sortBy, setSortBy] = useState('name');
  const [rowStart, setRowStart] = useState(0);
  const [opMsg, setOpMsg] = useState('');
  const importRef = useRef(null);
  const importParamRef = useRef(null);
  const diffLeftRef = useRef(null);
  const diffRightRef = useRef(null);
  const [paramMeta, setParamMeta] = useState({});
  const [twoParamResult, setTwoParamResult] = useState(null);
  const [favorites, setFavorites] = useState(() => {
    try {
      const raw = localStorage.getItem('drone_gcs_param_favorites');
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  });

  const persistFavorites = (nextSet) => {
    setFavorites(nextSet);
    try {
      localStorage.setItem('drone_gcs_param_favorites', JSON.stringify([...nextSet]));
    } catch {
      // ignore storage errors
    }
  };

  const toggleFavorite = (paramId) => {
    const next = new Set(favorites);
    if (next.has(paramId)) next.delete(paramId);
    else next.add(paramId);
    persistFavorites(next);
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      await axios.post('http://localhost:8080/api/parameters/refresh');
      await refreshParameterStatus();
    } catch (err) {
      console.error('Failed to request parameters', err);
    }
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
      setEditValues(prev => {
        const next = { ...prev };
        delete next[paramId];
        return next;
      });
    } catch (err) {
      console.error('Failed to set parameter', err);
    }
  };

  const handleExport = async () => {
    try {
      const res = await axios.get('http://localhost:8080/api/parameters/export');
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `params-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setOpMsg(`Exported ${res.data?.count || 0} params`);
    } catch (err) {
      setOpMsg(`Export failed: ${err.message}`);
    }
  };

  const handleExportParam = async () => {
    try {
      const res = await axios.get('http://localhost:8080/api/parameters/export.param', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `parameters-${Date.now()}.param`;
      a.click();
      URL.revokeObjectURL(url);
      setOpMsg('Exported Mission Planner / ArduPilot .param file');
    } catch (err) {
      setOpMsg(`Export .param failed: ${err.message}`);
    }
  };

  const openImport = () => importRef.current?.click();

  const parseImportFile = async (file) => {
    const txt = await file.text();
    const json = JSON.parse(txt);
    return json?.parameters || json || {};
  };

  const handleImport = async (evt) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    try {
      const parameters = await parseImportFile(file);
      const res = await axios.post('http://localhost:8080/api/parameters/import', { parameters });
      setOpMsg(`Import ${res.data?.status}: ok=${res.data?.ok}, failed=${res.data?.failed}`);
    } catch (err) {
      setOpMsg(`Import failed: ${err.message}`);
    } finally {
      evt.target.value = '';
    }
  };

  const handleCompare = async (evt) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    try {
      const parameters = await parseImportFile(file);
      const res = await axios.post('http://localhost:8080/api/parameters/compare', { parameters });
      setOpMsg(`Compare done: ${res.data?.count || 0} differences`);
    } catch (err) {
      setOpMsg(`Compare failed: ${err.message}`);
    } finally {
      evt.target.value = '';
    }
  };

  const handleImportParam = async (evt) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const res = await axios.post('http://localhost:8080/api/parameters/import/param', { text });
      setOpMsg(
        `.param import ${res.data?.status}: ok=${res.data?.ok}, failed=${res.data?.failed} (parsed ${res.data?.parsed ?? '—'})`
      );
    } catch (err) {
      const d = err.response?.data?.detail;
      setOpMsg(typeof d === 'string' ? d : err.response?.data?.error || err.message || 'Import .param failed');
    } finally {
      evt.target.value = '';
    }
  };

  const handleCompareParam = async (evt) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const res = await axios.post('http://localhost:8080/api/parameters/compare/param', { text });
      setOpMsg(`.param compare: ${res.data?.count || 0} differences (parsed ${res.data?.parsed ?? '—'})`);
    } catch (err) {
      const d = err.response?.data?.detail;
      setOpMsg(typeof d === 'string' ? d : err.response?.data?.error || err.message || 'Compare .param failed');
    } finally {
      evt.target.value = '';
    }
  };

  const runTwoParamDiff = async () => {
    const fa = diffLeftRef.current?.files?.[0];
    const fb = diffRightRef.current?.files?.[0];
    if (!fa || !fb) {
      setOpMsg('Choose file A and file B (.param).');
      return;
    }
    try {
      const a = await fa.text();
      const b = await fb.text();
      const res = await axios.post('http://localhost:8080/api/parameters/diff/two-param', { a, b });
      setTwoParamResult(res.data);
      setOpMsg(
        `Two-file diff: ${res.data?.count ?? 0} rows (parsed A=${res.data?.parsed_left}, B=${res.data?.parsed_right})`
      );
    } catch (err) {
      setTwoParamResult(null);
      const d = err.response?.data?.detail;
      setOpMsg(typeof d === 'string' ? d : err.response?.data?.error || err.message || 'Two-file diff failed');
    }
  };

  useEffect(() => {
    axios.get('http://localhost:8080/api/parameters/metadata')
      .then((r) => setParamMeta(r.data?.params || {}))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setInterval(() => refreshParameterStatus().catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [refreshParameterStatus]);

  const filteredParams = filterParameters(paramEntriesRaw, category, searchTerm, favorites, sortBy);

  const pageSize = 120;
  const visibleParams = filteredParams.slice(rowStart, rowStart + pageSize);

  const { isDisconnected, isStale, syncState, received, reported, missing, progressPercent, cacheLoaded, cacheSource } = syncStateInfo;

  return (
    <div className="flight-planner" style={{ padding: '20px', backgroundColor: 'var(--bg-panel)' }}>
      {isDisconnected && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <h1 style={{ color: 'red', fontWeight: 'bold' }}>DISCONNECTED</h1>
        </div>
      )}
      
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <h2>Vehicle Parameters</h2>
          {isStale && <span style={{ backgroundColor: 'orange', color: 'black', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold' }}>STALE</span>}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn-toolbar" onClick={handleRefresh} disabled={loading || isDisconnected}>
            <RefreshCw size={18} className={loading ? "spin" : ""} />
            {loading ? 'Requesting...' : 'Fetch All'}
          </button>
          <button className="btn-toolbar" onClick={() => refreshParameterStatus()}>Sync Status</button>
          <button className="btn-toolbar" onClick={() => loadParameterCache(3600)} disabled={isDisconnected}>Load Cache</button>
          <button className="btn-toolbar" onClick={handleExport} disabled={isDisconnected}><Download size={16} /> JSON</button>
          <button className="btn-toolbar" onClick={handleExportParam} disabled={isDisconnected}><Download size={16} /> .param</button>
          <button className="btn-toolbar" onClick={openImport} disabled={isDisconnected}><Upload size={16} /> JSON</button>
          <button type="button" className="btn-toolbar" onClick={() => importParamRef.current?.click()} disabled={isDisconnected}>
            <Upload size={16} /> .param
          </button>
          <label className={`btn-toolbar ${isDisconnected ? 'disabled' : ''}`} style={{ cursor: isDisconnected ? 'default' : 'pointer' }}>
            <GitCompare size={16} /> JSON
            <input type="file" accept=".json" style={{ display: 'none' }} onChange={handleCompare} disabled={isDisconnected} />
          </label>
          <label className={`btn-toolbar ${isDisconnected ? 'disabled' : ''}`} style={{ cursor: isDisconnected ? 'default' : 'pointer' }}>
            <GitCompare size={16} /> .param
            <input type="file" accept=".param,.txt" style={{ display: 'none' }} onChange={handleCompareParam} disabled={isDisconnected} />
          </label>
          <input ref={importRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImport} />
          <input ref={importParamRef} type="file" accept=".param,.txt" style={{ display: 'none' }} onChange={handleImportParam} />
        </div>
      </div>
      {opMsg && <div style={{ marginBottom: 10, color: 'var(--text-secondary)', fontSize: 12 }}>{opMsg}</div>}
      <div style={{ marginBottom: '10px', color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: '12px' }}>
        Sync: {syncState} | {received}/{reported} | Missing: {missing} | Progress: {progressPercent}%
        {" "} | Cache: {cacheLoaded ? `YES(${cacheSource || 'disk'})` : 'NO'}
      </div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
        <select className="status-search" value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 180 }}>
          <option value="ALL">ALL Categories</option>
          {Object.keys(PARAMETER_CATEGORIES).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="status-search" value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ width: 140 }}>
          <option value="name">Sort: Name</option>
          <option value="value">Sort: Value</option>
        </select>
        <button className="btn-toolbar" onClick={() => setRowStart((v) => Math.max(0, v - pageSize))}>Prev</button>
        <button className="btn-toolbar" onClick={() => setRowStart((v) => Math.min(Math.max(filteredParams.length - pageSize, 0), v + pageSize))}>Next</button>
        <span style={{ alignSelf: 'center', fontFamily: 'monospace', fontSize: '12px' }}>
          Showing {Math.min(filteredParams.length, rowStart + 1)}-{Math.min(filteredParams.length, rowStart + pageSize)} / {filteredParams.length}
        </span>
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
              <th>Fav</th>
              <th>Parameter ID</th>
              <th>Units</th>
              <th>Description</th>
              <th>Current Value</th>
              <th>New Value</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {filteredParams.length === 0 ? (
              <tr>
                <td colSpan="7" style={{ textAlign: 'center', padding: '20px' }}>No parameters found. Click Fetch All.</td>
              </tr>
            ) : (
              visibleParams.map(([key, val, m]) => {
                return (
                <tr key={key}>
                  <td style={{ textAlign: 'center' }}>
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={() => toggleFavorite(key)}
                      title={favorites.has(key) ? 'Unpin favorite' : 'Pin favorite'}
                    >
                      <span style={{ color: favorites.has(key) ? '#fbbf24' : '#64748b' }}>
                        {favorites.has(key) ? '★' : '☆'}
                      </span>
                    </button>
                  </td>
                  <td style={{ fontWeight: 'bold' }}>{key}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{m.units != null && m.units !== '' ? m.units : '—'}</td>
                  <td style={{ fontSize: 12, maxWidth: 260, color: 'var(--text-secondary)' }} title={m.description}>{m.description || '—'}</td>
                  <td style={{ fontFamily: 'monospace' }}>{val}</td>
                  <td>
                    <input 
                      type="number"
                      className="alt-input"
                      value={editValues[key] !== undefined ? editValues[key] : ''}
                      onChange={(e) => setEditValues({ ...editValues, [key]: e.target.value })}
                      placeholder={String(val)}
                      disabled={isDisconnected}
                      style={{
                        width: '120px',
                        backgroundColor: editValues[key] !== undefined ? 'rgba(245,158,11,0.15)' : undefined,
                        borderColor: editValues[key] !== undefined ? 'var(--accent-yellow)' : 'var(--border-color)',
                      }}
                    />
                  </td>
                  <td>
                    <button 
                      className="btn-toolbar primary" 
                      style={{ padding: '4px 12px' }}
                      onClick={() => handleSave(key)}
                      disabled={editValues[key] === undefined || editValues[key] === '' || isDisconnected}
                    >
                      <Save size={14} /> Save
                    </button>
                  </td>
                </tr>
              );
              })
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border-color)' }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Offline: compare two .param files</h3>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, maxWidth: 720 }}>
          No MAVLink link required. Useful for diffing two vehicle exports or a bench file against a flight log extract.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <label className="btn-toolbar" style={{ cursor: 'pointer' }}>
            File A
            <input ref={diffLeftRef} type="file" accept=".param,.txt" style={{ display: 'none' }} />
          </label>
          <label className="btn-toolbar" style={{ cursor: 'pointer' }}>
            File B
            <input ref={diffRightRef} type="file" accept=".param,.txt" style={{ display: 'none' }} />
          </label>
          <button type="button" className="btn-toolbar primary" onClick={runTwoParamDiff}>
            Compare A vs B
          </button>
        </div>
        {twoParamResult?.diffs?.length > 0 && (
          <div style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--border-color)', borderRadius: 6 }}>
            <table className="waypoint-table">
              <thead>
                <tr>
                  <th>Param</th>
                  <th>Left (A)</th>
                  <th>Right (B)</th>
                </tr>
              </thead>
              <tbody>
                {twoParamResult.diffs.slice(0, 250).map((d) => (
                  <tr key={d.param_id}>
                    <td style={{ fontWeight: 600 }}>{d.param_id}</td>
                    <td style={{ fontFamily: 'monospace' }}>{d.left == null ? '—' : String(d.left)}</td>
                    <td style={{ fontFamily: 'monospace' }}>{d.right == null ? '—' : String(d.right)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {twoParamResult.diffs.length > 250 && (
              <div style={{ padding: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
                Showing first 250 of {twoParamResult.diffs.length} differences.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Params;
