// TelemetryRegistry.js
// Maps user-friendly telemetry labels to strict vehicleState normalized paths.
// This ensures the UI is loosely coupled to the exact MAVLink structure.

function haversineM(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

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
  missionSeq: {
    label: "Mission seq",
    getValue: (state) => {
      const s = state.mission?.current_seq;
      return s == null || s < 0 ? "—" : String(s);
    },
    color: "var(--accent-red)",
  },
  distToWp: {
    label: "Dist to WP (m)",
    getValue: (state) => {
      const d = state.navigation?.wp_dist;
      return d == null || d < 0 ? "—" : Number(d).toFixed(1);
    },
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
    label: "Dist to home (m)",
    getValue: (state) => {
      if (!state.home?.valid) return "—";
      const d = haversineM(
        state.position?.lat,
        state.position?.lng,
        state.home.lat,
        state.home.lng
      );
      return d == null ? "—" : d.toFixed(1);
    },
    color: "var(--accent-blue)",
  },
  gpsHdop: {
    label: "GPS HDOP",
    getValue: (state) => {
      const h = state.status?.gps_hdop;
      if (h == null || h <= 0) return "—";
      return h.toFixed(2);
    },
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
