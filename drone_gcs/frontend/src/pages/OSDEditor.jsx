import React, { useEffect, useState } from 'react';
import axios from 'axios';

const API = 'http://localhost:8080/api/osd/profiles';

const defaultPayload = {
  name: 'Default OSD',
  grid_cols: 30,
  grid_rows: 16,
  widgets: [
    { widget_type: 'battery', x: 1, y: 1, size: 1, visible: true },
    { widget_type: 'gps', x: 20, y: 1, size: 1, visible: true },
    { widget_type: 'altitude', x: 1, y: 14, size: 1, visible: true },
  ],
};

const OSDEditor = () => {
  const [profiles, setProfiles] = useState({});
  const [profileId, setProfileId] = useState('default');
  const [payload, setPayload] = useState(JSON.stringify(defaultPayload, null, 2));

  const refresh = async () => {
    const res = await axios.get(API);
    setProfiles(res.data?.profiles || {});
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  const save = async () => {
    let parsed = {};
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    await axios.post(API, { profile_id: profileId, payload: parsed });
    await refresh();
  };

  const load = (id) => {
    setProfileId(id);
    setPayload(JSON.stringify(profiles[id], null, 2));
  };

  const remove = async (id) => {
    await axios.delete(`${API}/${encodeURIComponent(id)}`);
    await refresh();
  };

  return (
    <div className="flight-planner" style={{ padding: 20 }}>
      <h2 style={{ marginBottom: 12 }}>OSD Profiles (Editor Shell)</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input className="status-search" value={profileId} onChange={(e) => setProfileId(e.target.value)} placeholder="profile id" />
        <button className="btn-toolbar primary" onClick={save}>Save Profile</button>
      </div>
      <textarea
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        style={{ width: '100%', height: 260, background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: 10, fontFamily: 'monospace', fontSize: 12 }}
      />
      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {Object.keys(profiles).length === 0 ? (
          <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>No OSD profiles saved.</span>
        ) : Object.keys(profiles).map((id) => (
          <div key={id} style={{ display: 'flex', gap: 4 }}>
            <button className="btn-toolbar" onClick={() => load(id)}>{id}</button>
            <button className="btn-toolbar danger" onClick={() => remove(id)}>x</button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default OSDEditor;
