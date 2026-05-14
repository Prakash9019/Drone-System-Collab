import React from 'react';
import { 
  selectAttitudeDisplay, 
  selectStaleTelemetry, 
  selectNormalizedTelemetry 
} from '../telemetry/telemetrySelectors';

const AdvancedHUD = ({ vehicleState, operational }) => {
  const attitudeDisplay = selectAttitudeDisplay(vehicleState);
  const staleData = selectStaleTelemetry(vehicleState);
  const normalizedData = selectNormalizedTelemetry(vehicleState);

  const isDisconnected = !vehicleState;
  const isStale = staleData.any_stale && !isDisconnected;
  const isLinkDead = !staleData.link_live && !isDisconnected;

  const { velocity = {}, status = {}, position = {}, battery = {} } = vehicleState || {};
  
  // Math for CSS transformations
  const rollDeg = attitudeDisplay.roll_deg;
  const pitchDeg = attitudeDisplay.pitch_deg;
  
  // 1 degree of pitch = 3px of vertical movement in the CSS
  const pitchOffset = pitchDeg * 3;

  const yawDeg = attitudeDisplay.yaw_deg;
  // Heading calculation for the top compass ribbon (fallback to yaw if heading is missing)
  const heading = Number.isFinite(velocity.heading) ? Number(velocity.heading) : (yawDeg ?? 0);
  // If compass ribbon is e.g. 3600px wide (10px per degree), offset is -heading * 10
  const compassOffset = -(heading * 10) + 1800;
  const headingText = isDisconnected ? '---°' : `${Math.round(heading)}°`;
  const isArmed = Boolean(status.armed);
  const isFailsafe = Boolean(status.failsafe);

  const ekfHealth = normalizedData?.ekf?.health || 'OK';

  const getGpsText = (fix) => {
    if (isDisconnected) return 'No Telemetry';
    if (fix >= 3) return '3D';
    if (fix === 2) return '2D';
    return 'No Fix';
  };

  const cssTransition = 'transform 0.1s linear';

  return (
    <div className={`advanced-hud ${isDisconnected ? 'disconnected' : ''} ${isStale ? 'stale' : ''}`}>
      {/* 1. Compass Ribbon (Top) */}
      <div className="hud-compass-container" style={{ opacity: isDisconnected ? 0.5 : 1 }}>
        <div 
          className="hud-compass-ribbon"
          style={{ 
            transform: `translateX(${compassOffset}px)`,
            transition: cssTransition
          }}
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
      <div className="hud-horizon-clip" style={{ opacity: isDisconnected ? 0.5 : 1 }}>
        <div 
          className="hud-horizon-bg"
          style={{
            transform: `rotate(${-rollDeg}deg) translateY(${pitchOffset}px)`,
            transition: cssTransition
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
        <div className="hud-tape-left" style={{ opacity: isDisconnected ? 0.5 : 1 }}>
          <div className="tape-label">AS</div>
          <div className="tape-val">{isDisconnected ? '--' : (velocity.airspeed || 0).toFixed(1)}</div>
          <div className="tape-label">GS</div>
          <div className="tape-val">{isDisconnected ? '--' : (velocity.groundspeed || 0).toFixed(1)}</div>
        </div>

        {/* Right: Altitude */}
        <div className="hud-tape-right" style={{ opacity: isDisconnected ? 0.5 : 1 }}>
          <div className="tape-label">ALT</div>
          <div className="tape-val">{isDisconnected ? '--' : (position.alt_rel || 0).toFixed(1)}</div>
        </div>

        {/* Status Text overlay */}
        <div className="hud-status-text">
          {isDisconnected && (
            <div className="disconnected-text" style={{ color: 'red', fontWeight: 'bold' }}>DISCONNECTED</div>
          )}
          {isLinkDead && !isDisconnected && (
            <div className="stale-text" style={{ color: 'orange', fontWeight: 'bold' }}>LINK DEAD</div>
          )}
          {isStale && !isLinkDead && !isDisconnected && (
            <div className="stale-text" style={{ color: 'orange', fontWeight: 'bold' }}>STALE TELEMETRY</div>
          )}
          {isFailsafe && (
            <div className="failsafe-text" style={{ color: 'red', fontWeight: 'bold' }}>FAILSAFE</div>
          )}
          {!isDisconnected && (
            <>
              <div className={`armed-text ${status.armed ? 'armed' : 'disarmed'}`}>
                {isArmed ? 'ARMED' : 'DISARMED'}
              </div>
              <div className="mode-text">{status.mode || 'UNKNOWN'}</div>
              {operational?.label && (
                <div className="mode-text" style={{ fontSize: 11, opacity: 0.9 }}>
                  {operational.label}
                </div>
              )}
            </>
          )}
        </div>
        
        {/* Bottom Banner */}
        <div className="hud-bottom-banner" style={{ opacity: isDisconnected ? 0.5 : 1 }}>
          Bat1 {isDisconnected ? '--' : (battery.voltage || 0).toFixed(2)}v {isDisconnected ? '--' : (battery.current || 0).toFixed(1)}A {isDisconnected ? '--' : battery.remaining || 0}% 
          {" "}GPS: {getGpsText(status.gps_fix)}
          {" "}EKF: <span style={{ color: ekfHealth === 'BAD' ? 'red' : ekfHealth === 'WARN' ? 'orange' : 'inherit' }}>{isDisconnected ? '--' : ekfHealth}</span>
        </div>
      </div>
    </div>
  );
};

export default AdvancedHUD;
