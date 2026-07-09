import React, { useEffect, useRef, useState } from 'react';
import { WebCodecsClient } from '../../utils/webcodecsDecoder';

// WebCodecs fallback renderer — <canvas> fed by raw NAL units over /ws/video/raw.
// Backend counterpart: python_service/video_service/raw_ws_sender.py. Selected via
// the "Low-latency (WebCodecs)" toggle in VideoView.jsx instead of the default
// WebRTC <video> path.
const VideoCanvas = ({ style, grid }) => {
  const canvasRef = useRef(null);
  const clientRef = useRef(null);
  const [connState, setConnState] = useState('idle');
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    if (typeof window.VideoDecoder === 'undefined') {
      setUnsupported(true);
      return;
    }
    const client = new WebCodecsClient({
      canvas: canvasRef.current,
      onState: setConnState,
      onError: setError,
    });
    clientRef.current = client;
    client.connect().catch((e) => setError(String(e)));
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, []);

  if (unsupported) {
    return (
      <div style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontFamily: 'monospace', fontSize: 13, textAlign: 'center', padding: 20 }}>
        WebCodecs isn't supported in this browser — switch back to the WebRTC video path.
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', ...style }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', background: '#000' }} />
      {connState !== 'connected' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontFamily: 'monospace', fontSize: 13 }}>
          {error ? `⚠ ${error}` : `Connecting (WebCodecs)… (${connState})`}
        </div>
      )}
      {grid && connState === 'connected' && <GridOverlay />}
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

export default VideoCanvas;
