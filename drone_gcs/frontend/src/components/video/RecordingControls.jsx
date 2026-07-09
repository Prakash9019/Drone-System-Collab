import React from 'react';
import useVideoStore from '../../store/useVideoStore';

const fmtElapsed = (s) => {
  if (s == null) return '00:00';
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
};

// Audit fix (gap #4): QGC's `showRecControl` fact (VideoSettings.h:23) hides this
// entire control cluster when disabled — the plan named it in prose but never wired
// it into the settings port. Wired here.
const RecordingControls = () => {
  const settings = useVideoStore((s) => s.settings);
  const state = useVideoStore((s) => s.state);
  const active = state.active;
  const recording = state.recording || { active: false, elapsed_s: null };
  const startRecording = useVideoStore((s) => s.startRecording);
  const stopRecording = useVideoStore((s) => s.stopRecording);
  const takeSnapshot = useVideoStore((s) => s.takeSnapshot);
  const loading = useVideoStore((s) => s.loading);

  if (!settings.show_rec_control) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {recording.active && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f87171', fontFamily: 'monospace', fontSize: 12 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', animation: 'pulse 1.5s infinite' }} />
          REC {fmtElapsed(recording.elapsed_s)}
        </span>
      )}
      <button
        onClick={recording.active ? stopRecording : startRecording}
        disabled={loading || !active}
        title={!active ? 'Start the video stream first' : undefined}
        style={btnStyle(recording.active ? '#ef4444' : '#374151', !active)}
      >
        {recording.active ? '■ Stop' : '● Record'}
      </button>
      <button
        onClick={takeSnapshot}
        disabled={loading || !active}
        style={btnStyle('#374151', !active)}
      >
        📷 Snapshot
      </button>
    </div>
  );
};

const btnStyle = (bg, disabled) => ({
  background: bg,
  color: '#fff',
  border: 'none',
  padding: '6px 12px',
  borderRadius: 4,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  fontSize: 12,
  fontWeight: 600,
});

export default RecordingControls;
