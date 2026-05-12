import React from 'react';

const rowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '8px 10px',
  borderBottom: '1px solid var(--border-color)',
  fontSize: 13,
};

const passFail = (ok, passText = 'PASS', failText = 'FAIL') => ({
  label: ok ? passText : failText,
  color: ok ? '#22c55e' : '#ef4444',
});

const PreFlightTab = ({ vehicleState }) => {
  if (!vehicleState) return <div className="tab-empty">No telemetry. Connect to vehicle.</div>;

  const gpsFix = Number(vehicleState.status?.gps_fix ?? 0);
  const sats = Number(vehicleState.status?.satellites ?? 0);
  const hdop = Number(vehicleState.status?.gps_hdop ?? 0);
  const batteryPct = Number(vehicleState.battery?.remaining ?? 0);
  const batteryV = Number(vehicleState.battery?.voltage ?? 0);
  const ekfFlags = Number(vehicleState.ekf_status?.flags ?? 0);
  const sensorHealth = Number(vehicleState.status?.sensors_health ?? 0);
  const sensorPresent = Number(vehicleState.status?.sensors_present ?? 0);

  const checks = [
    {
      name: 'GPS Lock',
      value: `Fix ${gpsFix} / ${sats} sats`,
      ...passFail(gpsFix >= 3 && sats >= 6),
    },
    {
      name: 'GPS Quality',
      value: hdop > 0 ? `HDOP ${hdop.toFixed(2)}` : 'HDOP N/A',
      ...passFail(hdop > 0 && hdop <= 2.5, 'GOOD', 'POOR'),
    },
    {
      name: 'EKF Ready',
      value: `Flags 0x${ekfFlags.toString(16).toUpperCase()}`,
      ...passFail(ekfFlags !== 0),
    },
    {
      name: 'Sensor Health',
      value: `healthy bits: 0x${sensorHealth.toString(16).toUpperCase()}`,
      ...passFail(sensorPresent === 0 || sensorHealth !== 0),
    },
    {
      name: 'Battery',
      value: `${batteryV.toFixed(1)}V / ${batteryPct}%`,
      ...passFail(batteryPct >= 20 && batteryV >= 10.5, 'OK', 'LOW'),
    },
    {
      name: 'Arming State',
      value: vehicleState.status?.armed ? 'Armed' : 'Disarmed',
      ...passFail(!vehicleState.status?.armed, 'SAFE', 'ARMED'),
    },
  ];

  return (
    <div style={{ height: '100%', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 6 }}>
      {checks.map((c) => (
        <div key={c.name} style={rowStyle}>
          <div>
            <div style={{ fontWeight: 600 }}>{c.name}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{c.value}</div>
          </div>
          <span style={{ color: c.color, fontWeight: 700 }}>{c.label}</span>
        </div>
      ))}
    </div>
  );
};

export default PreFlightTab;

