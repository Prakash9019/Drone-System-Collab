import React from 'react';

const AdvancedHUD = ({ vehicleState, operational }) => {
  if (!vehicleState) return <div className="advanced-hud placeholder">No Telemetry</div>;

  const { attitude = {}, velocity = {}, status = {}, position = {}, battery = {} } = vehicleState;
  
  // Math for CSS transformations
  const rollDeg = (attitude.roll * 180) / Math.PI || 0;
  const pitchDeg = (attitude.pitch * 180) / Math.PI || 0;
  
  // 1 degree of pitch = 3px of vertical movement in the CSS
  const pitchOffset = pitchDeg * 3;

  const yawDeg = Number.isFinite(attitude.yaw) ? ((attitude.yaw * 180) / Math.PI + 360) % 360 : null;
  // Heading calculation for the top compass ribbon (fallback to yaw if heading is missing)
  const heading = Number.isFinite(velocity.heading) ? Number(velocity.heading) : (yawDeg ?? 0);
  // If compass ribbon is e.g. 3600px wide (10px per degree), offset is -heading * 10
  const compassOffset = -(heading * 10) + 1800;
  const headingText = `${Math.round(heading)}°`;
  const isArmed = Boolean(status.armed);

  return (
    <div className="advanced-hud">
      {/* 1. Compass Ribbon (Top) */}
      <div className="hud-compass-container">
        <div 
          className="hud-compass-ribbon"
          style={{ transform: `translateX(${compassOffset}px)` }}
        >
          {/* We create a repeating pattern of degrees for the compass ribbon in CSS */}
        </div>
        <div className="hud-compass-marker">▼</div>
        <div className="hud-compass-readout">
          <span className="hud-heading">{headingText}</span>
          <span className={`hud-arm-dot ${isArmed ? 'armed' : 'disarmed'}`} title={isArmed ? 'Vehicle armed' : 'Vehicle disarmed'} />
        </div>
      </div>

      {/* 2. Artificial Horizon Layer */}
      <div className="hud-horizon-clip">
        <div 
          className="hud-horizon-bg"
          style={{
            transform: `rotate(${-rollDeg}deg) translateY(${pitchOffset}px)`
          }}
        >
          <div className="hud-sky"></div>
          <div className="hud-ground"></div>
          <div className="hud-pitch-ladder">
            {/* Simple CSS lines for pitch ladder */}
            <div className="pitch-line pl-10"><span>10</span></div>
            <div className="pitch-line pl-0"><span>0</span></div>
            <div className="pitch-line pl--10"><span>-10</span></div>
          </div>
        </div>
      </div>

      {/* 3. Fixed HUD Overlays (Crosshair, Text) */}
      <div className="hud-overlay">
        {/* Center Crosshair */}
        <div className="hud-center-crosshair"></div>
        
        {/* Left: Airspeed */}
        <div className="hud-tape-left">
          <div className="tape-label">AS</div>
          <div className="tape-val">{(velocity.airspeed || 0).toFixed(1)}</div>
          <div className="tape-label">GS</div>
          <div className="tape-val">{(velocity.groundspeed || 0).toFixed(1)}</div>
        </div>

        {/* Right: Altitude */}
        <div className="hud-tape-right">
          <div className="tape-label">ALT</div>
          <div className="tape-val">{(position.alt_rel || 0).toFixed(1)}</div>
        </div>

        {/* Status Text overlay */}
        <div className="hud-status-text">
          <div className={`armed-text ${status.armed ? 'armed' : 'disarmed'}`}>
            {isArmed ? 'ARMED' : 'DISARMED'}
          </div>
          <div className="mode-text">{status.mode}</div>
          {operational?.label && (
            <div className="mode-text" style={{ fontSize: 11, opacity: 0.9 }}>
              {operational.label}
            </div>
          )}
        </div>
        
        {/* Bottom Banner */}
        <div className="hud-bottom-banner">
          Bat1 {(battery.voltage || 0).toFixed(2)}v {(battery.current || 0).toFixed(1)}A {battery.remaining || 0}% 
          {" "}GPS: {status.gps_fix >= 3 ? '3D' : 'No Fix'}
        </div>
      </div>
    </div>
  );
};

export default AdvancedHUD;
