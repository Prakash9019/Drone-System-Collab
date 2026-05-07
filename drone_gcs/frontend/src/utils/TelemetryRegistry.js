// TelemetryRegistry.js
// Maps user-friendly telemetry labels to strict vehicleState normalized paths.
// This ensures the UI is loosely coupled to the exact MAVLink structure.

export const TelemetryRegistry = {
  altitude: {
    label: "Altitude (m)",
    getValue: (state) => state.position?.alt_rel?.toFixed(2) || "0.00",
    color: "var(--accent-red)",
  },
  groundspeed: {
    label: "GroundSpeed (m/s)",
    getValue: (state) => state.velocity?.groundspeed?.toFixed(2) || "0.00",
    color: "var(--accent-orange)",
  },
  distToWp: {
    label: "Dist to WP (m)",
    // Placeholder until mission active WP tracking is implemented
    getValue: (state) => "0.00", 
    color: "var(--accent-red)",
  },
  yaw: {
    label: "Yaw (deg)",
    getValue: (state) => {
      if (state.attitude?.yaw === undefined) return "0.00";
      // Convert rad to deg and ensure 0-360
      let deg = state.attitude.yaw * (180 / Math.PI);
      if (deg < 0) deg += 360;
      return deg.toFixed(2);
    },
    color: "var(--accent-green)",
  },
  verticalSpeed: {
    label: "Vertical Speed (m/s)",
    getValue: (state) => state.velocity?.climb?.toFixed(2) || "0.00",
    color: "var(--accent-yellow)",
  },
  distToMav: {
    label: "DistToMAV (m)",
    // Placeholder until home location distance is computed
    getValue: (state) => "0.00",
    color: "var(--accent-blue)",
  },
  battery: {
    label: "Battery",
    getValue: (state) => {
      const v = state.battery?.voltage?.toFixed(1) || "0.0";
      const pct = state.battery?.remaining || 0;
      return `${v}V (${pct}%)`;
    },
    color: "white",
  },
  gpsFix: {
    label: "GPS Fix",
    getValue: (state) => state.status?.gps_fix || 0,
    color: "white",
  },
  satellites: {
    label: "Satellites",
    getValue: (state) => state.status?.satellites || 0,
    color: "white",
  }
};
