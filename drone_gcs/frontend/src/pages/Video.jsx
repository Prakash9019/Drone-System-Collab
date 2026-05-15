import React from 'react';
import VideoView from '../components/video/VideoView';
import VideoSettingsPanel from '../components/video/VideoSettingsPanel';

const Video = () => {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: '1fr auto',
        gap: 12,
        height: '100%',
        padding: 12,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ background: '#000', borderRadius: 6, overflow: 'hidden', minHeight: 320 }}>
        <VideoView />
      </div>
      <VideoSettingsPanel />
    </div>
  );
};

export default Video;
