import React, { useEffect, useState } from 'react';
import useVideoStore from '../../store/useVideoStore';

const SOURCES = [
  { value: 'DISABLED', label: 'Disabled' },
  { value: 'RTSP', label: 'RTSP Stream' },
  { value: 'UDP_H264', label: 'UDP H.264 (RTP)' },
  { value: 'UDP_H265', label: 'UDP H.265 (RTP)' },
  { value: 'TCP_MPEGTS', label: 'TCP MPEG-TS' },
  { value: 'UDP_MPEGTS', label: 'UDP MPEG-TS' },
];

const FITS = [
  { value: 'FIT_HEIGHT', label: 'Fit Height' },
  { value: 'FIT_WIDTH', label: 'Fit Width' },
  { value: 'FILL', label: 'Fill (crop)' },
  { value: 'NO_CROP', label: 'No Crop' },
];

const FORMATS = ['MP4', 'MKV', 'MOV'];

const VideoSettingsPanel = () => {
  const settings = useVideoStore((s) => s.settings);
  const fetchSettings = useVideoStore((s) => s.fetchSettings);
  const patchSettings = useVideoStore((s) => s.patchSettings);
  const startVideo = useVideoStore((s) => s.startVideo);
  const stopVideo = useVideoStore((s) => s.stopVideo);
  const state = useVideoStore((s) => s.state);
  const banner = useVideoStore((s) => s.banner);
  const loading = useVideoStore((s) => s.loading);

  // Local editable copies for text inputs so typing isn't network-coupled
  const [rtspUrl, setRtspUrl] = useState(settings.rtsp_url);
  const [rtspUsername, setRtspUsername] = useState(settings.rtsp_username ?? '');
  const [rtspPassword, setRtspPassword] = useState(settings.rtsp_password ?? '');
  const [tcpUrl, setTcpUrl] = useState(settings.tcp_url);
  const [udpPort, setUdpPort] = useState(settings.udp_port);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    setRtspUrl(settings.rtsp_url);
    setRtspUsername(settings.rtsp_username ?? '');
    setRtspPassword(settings.rtsp_password ?? '');
    setTcpUrl(settings.tcp_url);
    setUdpPort(settings.udp_port);
  }, [settings.rtsp_url, settings.rtsp_username, settings.rtsp_password, settings.tcp_url, settings.udp_port]);

  const labelStyle = { display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 };
  const inputStyle = {
    width: '100%',
    padding: '6px 8px',
    background: '#111827',
    color: '#e5e7eb',
    border: '1px solid #374151',
    borderRadius: 4,
    fontSize: 13,
  };
  const rowStyle = { display: 'flex', gap: 12, marginBottom: 12 };
  const colStyle = { flex: 1 };

  return (
    <div
      style={{
        background: '#1f2937',
        color: '#e5e7eb',
        padding: 16,
        borderRadius: 6,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, letterSpacing: 0.4 }}>VIDEO SOURCE</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={startVideo}
            disabled={loading || state.active}
            style={btnStyle(state.active ? '#374151' : '#10b981')}
          >
            Start
          </button>
          <button
            onClick={stopVideo}
            disabled={loading || !state.active}
            style={btnStyle(state.active ? '#ef4444' : '#374151')}
          >
            Stop
          </button>
        </div>
      </div>

      {banner && (
        <div
          style={{
            background: '#7f1d1d',
            color: '#fecaca',
            padding: 8,
            borderRadius: 4,
            marginBottom: 12,
            fontSize: 12,
          }}
        >
          {banner}
          {state.fail_count > 0 && (
            <span style={{ marginLeft: 8, opacity: 0.7 }}>
              (retry #{state.fail_count})
            </span>
          )}
        </div>
      )}

      <div style={rowStyle}>
        <div style={colStyle}>
          <label style={labelStyle}>Source</label>
          <select
            style={inputStyle}
            value={settings.video_source}
            onChange={(e) => patchSettings({ video_source: e.target.value })}
          >
            {SOURCES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <div style={colStyle}>
          <label style={labelStyle}>Fit</label>
          <select
            style={inputStyle}
            value={settings.video_fit}
            onChange={(e) => patchSettings({ video_fit: e.target.value })}
          >
            {FITS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
      </div>

      {settings.video_source === 'RTSP' && (
        <>
          <div style={rowStyle}>
            <div style={colStyle}>
              <label style={labelStyle}>RTSP URL</label>
              <input
                style={inputStyle}
                value={rtspUrl}
                placeholder="rtsp://192.168.1.10:8554/stream"
                onChange={(e) => setRtspUrl(e.target.value)}
                onBlur={() => rtspUrl !== settings.rtsp_url && patchSettings({ rtsp_url: rtspUrl })}
              />
            </div>
          </div>
          <div style={rowStyle}>
            <div style={colStyle}>
              <label style={labelStyle}>Username (optional)</label>
              <input
                style={inputStyle}
                value={rtspUsername}
                placeholder="leave blank if not required"
                onChange={(e) => setRtspUsername(e.target.value)}
                onBlur={() => rtspUsername !== (settings.rtsp_username ?? '') && patchSettings({ rtsp_username: rtspUsername })}
              />
            </div>
            <div style={colStyle}>
              <label style={labelStyle}>Password (optional)</label>
              <input
                style={inputStyle}
                type="password"
                value={rtspPassword}
                placeholder="leave blank if not required"
                onChange={(e) => setRtspPassword(e.target.value)}
                onBlur={() => rtspPassword !== (settings.rtsp_password ?? '') && patchSettings({ rtsp_password: rtspPassword })}
              />
            </div>
          </div>
        </>
      )}

      {(settings.video_source === 'UDP_H264' ||
        settings.video_source === 'UDP_H265' ||
        settings.video_source === 'UDP_MPEGTS') && (
        <div style={rowStyle}>
          <div style={{ width: 160 }}>
            <label style={labelStyle}>UDP Port</label>
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={65535}
              value={udpPort}
              onChange={(e) => setUdpPort(Number(e.target.value))}
              onBlur={() => udpPort !== settings.udp_port && patchSettings({ udp_port: udpPort })}
            />
          </div>
        </div>
      )}

      {settings.video_source === 'TCP_MPEGTS' && (
        <div style={rowStyle}>
          <div style={colStyle}>
            <label style={labelStyle}>TCP URL</label>
            <input
              style={inputStyle}
              value={tcpUrl}
              placeholder="tcp://192.168.1.10:5000"
              onChange={(e) => setTcpUrl(e.target.value)}
              onBlur={() => tcpUrl !== settings.tcp_url && patchSettings({ tcp_url: tcpUrl })}
            />
          </div>
        </div>
      )}

      <div style={rowStyle}>
        <Toggle
          label="Low-latency mode"
          checked={settings.low_latency_mode}
          onChange={(v) => patchSettings({ low_latency_mode: v })}
        />
        <Toggle
          label="Stream enabled"
          checked={settings.stream_enabled}
          onChange={(v) => patchSettings({ stream_enabled: v })}
        />
        <Toggle
          label="Grid lines"
          checked={settings.grid_lines}
          onChange={(v) => patchSettings({ grid_lines: v })}
        />
        {settings.video_source === 'RTSP' && (
          <Toggle
            label="Force TCP transport"
            checked={settings.rtsp_tcp_transport ?? false}
            onChange={(v) => patchSettings({ rtsp_tcp_transport: v })}
          />
        )}
      </div>

      <div style={rowStyle}>
        <div style={colStyle}>
          <label style={labelStyle}>Timeout (s)</label>
          <input
            style={inputStyle}
            type="number"
            min={2}
            max={60}
            value={settings.stream_timeout_s}
            onChange={(e) => patchSettings({ stream_timeout_s: Number(e.target.value) })}
          />
        </div>
        <div style={colStyle}>
          <label style={labelStyle}>Recording format</label>
          <select
            style={inputStyle}
            value={settings.recording_format}
            onChange={(e) => patchSettings({ recording_format: e.target.value })}
          >
            {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
};

const btnStyle = (bg) => ({
  background: bg,
  color: '#fff',
  border: 'none',
  padding: '6px 14px',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.5,
});

const Toggle = ({ label, checked, onChange }) => (
  <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, fontSize: 13, cursor: 'pointer' }}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span>{label}</span>
  </label>
);

export default VideoSettingsPanel;
