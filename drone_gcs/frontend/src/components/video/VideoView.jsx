import React, { useEffect, useRef, useState } from 'react';
import useVideoStore, { FIT_TO_CSS } from '../../store/useVideoStore';
import { VideoClient } from '../../utils/webrtcClient';

const VideoView = () => {
  const videoRef = useRef(null);
  const clientRef = useRef(null);
  const containerRef = useRef(null);
  const settings = useVideoStore((s) => s.settings);
  const state = useVideoStore((s) => s.state);
  const fetchState = useVideoStore((s) => s.fetchState);
  const [connState, setConnState] = useState('idle');
  const [error, setError] = useState('');

  // Poll backend state every 2 s — cheap and saves a second WS just for state
  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, 2000);
    return () => clearInterval(id);
  }, [fetchState]);

  useEffect(() => {
    if (settings.video_source === 'DISABLED' || !settings.stream_enabled) {
      if (clientRef.current) {
        clientRef.current.close();
        clientRef.current = null;
      }
      setConnState('disabled');
      return;
    }
    const client = new VideoClient({
      onTrack: (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // Hint zero playout delay for low-latency FPV
          videoRef.current.play().catch(() => {});
        }
        setConnState('connected');
        setError('');
      },
      onState: (s) => setConnState(s),
      onError: (msg) => setError(msg),
    });
    clientRef.current = client;
    client.connect().catch((e) => setError(String(e)));
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [settings.video_source, settings.stream_enabled, settings.rtsp_url, settings.udp_port, settings.tcp_url, settings.low_latency_mode]);

  const handleDoubleClick = () => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  const fitMode = FIT_TO_CSS[settings.video_fit] || 'contain';
  const showPlaceholder =
    settings.video_source === 'DISABLED' || !settings.stream_enabled || connState !== 'connected';

  return (
    <div
      ref={containerRef}
      onDoubleClick={handleDoubleClick}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: '#000',
        overflow: 'hidden',
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{
          width: '100%',
          height: '100%',
          objectFit: fitMode,
          display: showPlaceholder ? 'none' : 'block',
        }}
      />
      {showPlaceholder && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#9ca3af',
            fontFamily: 'monospace',
            fontSize: 14,
            textAlign: 'center',
            padding: 20,
          }}
        >
          {settings.video_source === 'DISABLED' || !settings.stream_enabled
            ? 'Video disabled — configure a source below'
            : `Connecting… (${connState})`}
        </div>
      )}
      {settings.grid_lines && !showPlaceholder && <GridOverlay />}
      <StatusBar state={state} connState={connState} error={error} />
    </div>
  );
};

const GridOverlay = () => (
  <svg
    style={{ position: 'absolute', inset: 0, pointerEvents: 'none', width: '100%', height: '100%' }}
    viewBox="0 0 100 100"
    preserveAspectRatio="none"
  >
    {[33.33, 66.66].map((p) => (
      <React.Fragment key={p}>
        <line x1={p} y1={0} x2={p} y2={100} stroke="rgba(255,255,255,0.35)" strokeWidth={0.2} />
        <line x1={0} y1={p} x2={100} y2={p} stroke="rgba(255,255,255,0.35)" strokeWidth={0.2} />
      </React.Fragment>
    ))}
  </svg>
);

const StatusBar = ({ state, connState, error }) => (
  <div
    style={{
      position: 'absolute',
      top: 8,
      left: 8,
      background: 'rgba(0,0,0,0.55)',
      color: '#e5e7eb',
      padding: '4px 8px',
      borderRadius: 4,
      fontFamily: 'monospace',
      fontSize: 11,
      pointerEvents: 'none',
    }}
  >
    {error
      ? `⚠ ${error}`
      : `${connState} · ${state.encoding || '—'} · peers=${state.peer_count || 0}${state.last_buffer_age_s != null ? ` · age=${state.last_buffer_age_s}s` : ''}`}
  </div>
);

export default VideoView;
