import React from 'react';

const ServoTab = ({ vehicleState }) => {
  const channels = (vehicleState?.servo_output?.channels) || {};
  const keys = Object.keys(channels)
    .map((k) => Number(k))
    .filter((k) => !Number.isNaN(k))
    .sort((a, b) => a - b);

  if (!keys.length) {
    return (
      <div style={{ padding: '16px 12px', color: '#4b5563', fontSize: 13 }}>
        {vehicleState ? 'No SERVO_OUTPUT_RAW data yet.' : 'Not connected — connect vehicle to see servo outputs.'}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: 8,
      }}
    >
      {keys.map((ch) => {
        const pwm = Number(channels[ch]);
        const valid = pwm > 700 && pwm < 2400;
        return (
          <div
            key={ch}
            style={{
              border: '1px solid var(--border-color)',
              borderRadius: 6,
              padding: '8px 10px',
              background: 'var(--bg-panel)',
            }}
          >
            <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>SERVO {ch}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: valid ? '#22c55e' : '#f59e0b' }}>
              {pwm}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>PWM</div>
          </div>
        );
      })}
    </div>
  );
};

export default ServoTab;

