import React, { useEffect, useState } from 'react';
import axios from 'axios';

const API = 'http://localhost:8080/api/simulation';
const LS_SITL_CMD = 'drone_gcs_sitl_cmd';

const Simulation = () => {
  const [vehicle, setVehicle] = useState('ArduCopter');
  const [model, setModel] = useState('quad');
  const [home, setHome] = useState('');
  const [speedup, setSpeedup] = useState(1);
  const [wipe, setWipe] = useState(false);
  const [sitlCmd, setSitlCmd] = useState(() => {
    try {
      return localStorage.getItem(LS_SITL_CMD) || '';
    } catch {
      return '';
    }
  });
  const [status, setStatus] = useState({ state: 'STOPPED' });
  const [logs, setLogs] = useState([]);
  const [profiles, setProfiles] = useState({});
  const [profileName, setProfileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [simVehicleProbe, setSimVehicleProbe] = useState(null);
  const [caps, setCaps] = useState(null);
  const [extraSimArgs, setExtraSimArgs] = useState('');
  const [appendMavOut, setAppendMavOut] = useState(true);
  const [autoConnect, setAutoConnect] = useState(true);
  const [autoConnectDelay, setAutoConnectDelay] = useState(3.5);
  const [mavlinkConn, setMavlinkConn] = useState('udp:127.0.0.1:14550');

  const refresh = async () => {
    const res = await axios.get(`${API}/status`);
    setStatus(res.data);
    const logRes = await axios.get(`${API}/logs`, { params: { limit: 120 } });
    setLogs(logRes.data?.lines || []);
    const profileRes = await axios.get(`${API}/profiles`);
    setProfiles(profileRes.data?.profiles || {});
  };

  useEffect(() => {
    refresh().catch(() => {});
    const t = setInterval(() => refresh().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LS_SITL_CMD, sitlCmd);
    } catch {
      /* ignore */
    }
  }, [sitlCmd]);

  useEffect(() => {
    let cancelled = false;
    axios
      .get(`${API}/sim_vehicle`, { params: { sitl_cmd: sitlCmd || undefined } })
      .then((res) => {
        if (!cancelled) setSimVehicleProbe(res.data);
      })
      .catch(() => {
        if (!cancelled) setSimVehicleProbe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sitlCmd]);

  useEffect(() => {
    let cancelled = false;
    axios
      .get(`${API}/capabilities`, { params: { sitl_cmd: sitlCmd || undefined } })
      .then((res) => {
        if (!cancelled) setCaps(res.data);
      })
      .catch(() => {
        if (!cancelled) setCaps(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sitlCmd]);

  const run = async (action) => {
    setBusy(true);
    try {
      if (action === 'start') {
        await axios.post(`${API}/start`, {
          vehicle,
          model,
          home,
          speedup,
          wipe,
          sitl_cmd: sitlCmd,
          extra_sim_args: extraSimArgs,
          append_default_mavproxy_out: appendMavOut,
          auto_connect: autoConnect,
          auto_connect_delay_s: autoConnectDelay,
          mavlink_connection_string: mavlinkConn,
        });
      } else {
        await axios.post(`${API}/${action}`);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async () => {
    if (!profileName.trim()) return;
    await axios.post(`${API}/profiles`, {
      name: profileName.trim(),
      config: {
        vehicle,
        model,
        home,
        speedup,
        wipe,
        sitl_cmd: sitlCmd,
        extra_sim_args: extraSimArgs,
        append_default_mavproxy_out: appendMavOut,
        auto_connect: autoConnect,
        auto_connect_delay_s: autoConnectDelay,
        mavlink_connection_string: mavlinkConn,
      },
    });
    await refresh();
  };

  const loadProfile = async (name) => {
    const cfg = profiles[name];
    if (!cfg) return;
    setVehicle(cfg.vehicle || 'ArduCopter');
    setModel(cfg.model || 'quad');
    setHome(cfg.home || '');
    setSpeedup(Number(cfg.speedup || 1));
    setWipe(Boolean(cfg.wipe));
    setSitlCmd(cfg.sitl_cmd || '');
    setExtraSimArgs(cfg.extra_sim_args || '');
    setAppendMavOut(cfg.append_default_mavproxy_out !== false);
    setAutoConnect(cfg.auto_connect !== false);
    setAutoConnectDelay(Number(cfg.auto_connect_delay_s ?? 3.5));
    setMavlinkConn(cfg.mavlink_connection_string || 'udp:127.0.0.1:14550');
  };

  const deleteProfile = async (name) => {
    await axios.delete(`${API}/profiles/${encodeURIComponent(name)}`);
    await refresh();
  };

  return (
    <div className="flight-planner" style={{ padding: 20 }}>
      <h2 style={{ marginBottom: 14 }}>Simulation (SITL)</h2>
      <details
        style={{
          marginBottom: 14,
          fontSize: 12,
          color: 'var(--text-secondary)',
          padding: '8px 12px',
          borderRadius: 6,
          border: '1px solid var(--border-color)',
          background: 'var(--bg-dark)',
        }}
      >
        <summary style={{ cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 600 }}>
          Phase C — Multi-SITL / swarm (manual orchestration)
        </summary>
        <ul style={{ margin: '10px 0 0 18px', lineHeight: 1.55 }}>
          <li>
            Run additional <code>sim_vehicle.py</code> instances with distinct <code>--sysid</code> values and non-overlapping
            MAVLink outputs (for example <code>--out udp:127.0.0.1:14551</code> for a second vehicle).
          </li>
          <li>
            Point this GCS at a MAVProxy or router that merges streams, or switch the connection string between instances when
            testing; the Flight Data map shows every vehicle on the link plus ADS-B traffic when available.
          </li>
          <li>
            Reference:{' '}
            <a href="https://ardupilot.org/dev/docs/sitl-simulator-software-in-the-loop.html" target="_blank" rel="noreferrer">
              ArduPilot SITL documentation
            </a>
            .
          </li>
        </ul>
      </details>
      {caps && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            marginBottom: 12,
            padding: 10,
            background: 'var(--bg-panel)',
            borderRadius: 6,
            border: '1px solid var(--border-color)',
            lineHeight: 1.5,
          }}
        >
          <strong>Orchestration</strong> (Mission Planner–style): start process → optional MAVProxy <code>--out</code> →{' '}
          optional auto-connect link. Platform: <code>{caps.platform}</code> / <code>{caps.machine}</code>.
          Default home (MP): <code>{caps.default_sitl_home}</code>
          <button
            type="button"
            className="btn-toolbar"
            style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }}
            onClick={() => setHome((h) => h || caps.default_sitl_home)}
          >
            Use default home
          </button>
          <div style={{ marginTop: 8 }}>
            <span style={{ opacity: 0.85 }}>No full clone:</span> {caps.no_clone_options?.[0]}
          </div>
          <div style={{ marginTop: 4, fontSize: 11, wordBreak: 'break-all' }}>
            Docker: {caps.docker_hint}
          </div>
        </div>
      )}
      <div className="actions-grid" style={{ maxWidth: 900, marginBottom: 12 }}>
        <select className="status-search" value={vehicle} onChange={(e) => setVehicle(e.target.value)}>
          {['ArduCopter', 'ArduPlane', 'ArduRover', 'ArduHeli', 'ArduBoat'].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="status-search" value={model} onChange={(e) => setModel(e.target.value)}>
          {['quad', 'hexa', 'plane', 'rover', 'vtol'].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input
          className="status-search"
          style={{ minWidth: 220 }}
          placeholder="Home lat,lng,alt,hdg (optional)"
          value={home}
          onChange={(e) => setHome(e.target.value)}
        />
        <input className="status-search" type="number" min="1" max="20" value={speedup} onChange={(e) => setSpeedup(Number(e.target.value))} />
        <input
          className="status-search"
          style={{ minWidth: 280, flex: '1 1 280px' }}
          placeholder="/path/to/ardupilot/Tools/autotest/sim_vehicle.py"
          value={sitlCmd}
          onChange={(e) => setSitlCmd(e.target.value)}
          title="Optional. If empty, the server searches ARDUPILOT_HOME, ~/ardupilot, ~/ArduPilot, SITL_CMD, and parent folders of this project."
        />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <input
          className="status-search"
          style={{ flex: '2 1 320px', minWidth: 200 }}
          placeholder='Extra sim_vehicle args (e.g. --console --map)'
          value={extraSimArgs}
          onChange={(e) => setExtraSimArgs(e.target.value)}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={appendMavOut} onChange={(e) => setAppendMavOut(e.target.checked)} />
          Add <code style={{ fontSize: 11 }}>--out udp:127.0.0.1:14550</code> if missing
        </label>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={autoConnect} onChange={(e) => setAutoConnect(e.target.checked)} />
          Auto-connect GCS after start
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          Delay (s)
          <input
            type="number"
            className="status-search"
            style={{ width: 72 }}
            step={0.5}
            min={0.5}
            max={60}
            value={autoConnectDelay}
            onChange={(e) => setAutoConnectDelay(Number(e.target.value))}
            disabled={!autoConnect}
          />
        </label>
        <input
          className="status-search"
          style={{ flex: '1 1 200px', minWidth: 180 }}
          placeholder="MAVLink URL for auto-connect"
          value={mavlinkConn}
          onChange={(e) => setMavlinkConn(e.target.value)}
          disabled={!autoConnect}
        />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.45 }}>
        {simVehicleProbe?.found ? (
          <span style={{ color: 'var(--accent-green)' }}>
            sim_vehicle.py found → {simVehicleProbe.script}
            {simVehicleProbe.ardupilot_root ? ` (cwd: ${simVehicleProbe.ardupilot_root})` : ''}
          </span>
        ) : (
          <span>
            No <code style={{ fontSize: 11 }}>sim_vehicle.py</code> detected yet. Clone ArduPilot (
            <a href="https://ardupilot.org/dev/docs/where-to-get-the-code.html" target="_blank" rel="noreferrer">
              docs
            </a>
            ), then either set env <code style={{ fontSize: 11 }}>ARDUPILOT_HOME</code> to the repo root, or paste the full path to{' '}
            <code style={{ fontSize: 11 }}>Tools/autotest/sim_vehicle.py</code> above (saved in this browser).
            {simVehicleProbe?.searched_total ? ` Server checked ${simVehicleProbe.searched_total} paths.` : ''}
          </span>
        )}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <input type="checkbox" checked={wipe} onChange={(e) => setWipe(e.target.checked)} />
        Wipe Parameters on Start
      </label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input className="status-search" placeholder="Profile name" value={profileName} onChange={(e) => setProfileName(e.target.value)} />
        <button className="btn-toolbar" onClick={saveProfile} disabled={busy || !profileName.trim()}>Save Profile</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {Object.keys(profiles).length === 0 ? (
          <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>No simulation profiles yet.</span>
        ) : (
          Object.keys(profiles).map((name) => (
            <div key={name} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button className="btn-toolbar" onClick={() => loadProfile(name)}>{name}</button>
              <button className="btn-toolbar danger" onClick={() => deleteProfile(name)}>x</button>
            </div>
          ))
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button className="btn-toolbar primary" disabled={busy} onClick={() => run('start')}>Start Simulation</button>
        <button className="btn-toolbar" disabled={busy} onClick={() => run('reset')}>Reset Simulation</button>
        <button className="btn-toolbar danger" disabled={busy} onClick={() => run('stop')}>Stop Simulation</button>
      </div>
      <div style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
        State: {status.state} | Running: {String(status.running)} | PID: {status.pid || '--'}<br />
        Last Error: {status.last_error || '--'}
      </div>
      <div style={{ marginTop: 14, background: '#080d14', border: '1px solid var(--border-color)', borderRadius: 6, padding: 8, maxHeight: 220, overflowY: 'auto' }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>SITL Logs</div>
        {logs.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>No logs yet.</div>
        ) : logs.map((line, idx) => (
          <div key={idx} style={{ fontFamily: 'monospace', fontSize: 11, color: '#cbd5e1', lineHeight: 1.5 }}>{line}</div>
        ))}
      </div>
    </div>
  );
};

export default Simulation;
