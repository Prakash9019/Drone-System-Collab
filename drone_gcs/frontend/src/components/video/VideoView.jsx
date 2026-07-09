import React, { useEffect, useRef, useState } from 'react';
import useVideoStore, { FIT_TO_CSS } from '../../store/useVideoStore';
import { VideoClient } from '../../utils/webrtcClient';
import VideoCanvas from './VideoCanvas';

const VideoView = () => {
  const videoRef = useRef(null);
  const clientRef = useRef(null);
  const containerRef = useRef(null);
  const settings = useVideoStore((s) => s.settings);
  const state = useVideoStore((s) => s.state);
  const fetchState = useVideoStore((s) => s.fetchState);
  const [connState, setConnState] = useState('idle');
  const [error, setError] = useState('');
  // Client-side rendering choice only (not persisted to backend settings) — the
  // backend already serves both /ws/video/signaling (WebRTC) and /ws/video/raw
  // (WebCodecs) simultaneously off the same pipeline, so switching here doesn't
  // touch the video_source/stream config at all.
  const [renderMode, setRenderMode] = useState('webrtc');

  // Poll backend state every 2 s — cheap and saves a second WS just for state
  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, 2000);
    return () => clearInterval(id);
  }, [fetchState]);

  useEffect(() => {
    if (renderMode !== 'webrtc') return;
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
  }, [renderMode, settings.video_source, settings.stream_enabled, settings.rtsp_url, settings.udp_port, settings.tcp_url, settings.low_latency_mode]);

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
      {renderMode === 'webrtc' ? (
        <>
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
              // Audit fix (gap #4): QGC's `disablePixelAspectRatio` fact forces a
              // capsfilter PAR=1/1 in its GStreamer pipeline. Our <video> element has no
              // backend decode step to correct, so the equivalent here is overriding the
              // browser's automatic PAR handling with an explicit CSS aspect-ratio when
              // the user has configured one; otherwise fall back to the stream's own
              // intrinsic (PAR-corrected) size.
              ...(settings.disable_pixel_aspect_ratio && settings.aspect_ratio > 0
                ? { aspectRatio: String(settings.aspect_ratio) }
                : {}),
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
        </>
      ) : (
        <VideoCanvas grid={settings.grid_lines} />
      )}
      <RenderModeToggle mode={renderMode} onChange={setRenderMode} />
      {renderMode === 'webrtc' && <StatusBar state={state} connState={connState} error={error} />}
    </div>
  );
};

const RenderModeToggle = ({ mode, onChange }) => (
  <button
    onClick={() => onChange(mode === 'webrtc' ? 'webcodecs' : 'webrtc')}
    title="Switch between WebRTC (adaptive, jitter-buffered) and WebCodecs (raw NAL, lowest latency) rendering — both are served by the same backend pipeline simultaneously"
    style={{
      position: 'absolute',
      top: 8,
      right: 8,
      background: 'rgba(0,0,0,0.55)',
      color: '#e5e7eb',
      border: '1px solid #374151',
      borderRadius: 4,
      padding: '4px 8px',
      fontFamily: 'monospace',
      fontSize: 11,
      cursor: 'pointer',
    }}
  >
    {mode === 'webrtc' ? 'WebRTC ▸ switch to WebCodecs' : 'WebCodecs ▸ switch to WebRTC'}
  </button>
);

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
