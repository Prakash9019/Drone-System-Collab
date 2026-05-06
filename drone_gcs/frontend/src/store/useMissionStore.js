import { create } from 'zustand';

const useMissionStore = create((set, get) => ({
  waypoints: [],

  setWaypoints: (wps) => set({ waypoints: wps }),

  addWaypoint: (lat, lng, alt = 50) => {
    const wps = get().waypoints;
    const seq = wps.length;
    
    // Default to NAV_WAYPOINT (16)
    const newWp = {
      seq: seq,
      frame: 3, // MAV_FRAME_GLOBAL_RELATIVE_ALT
      command: 16, // NAV_WAYPOINT
      current: seq === 0 ? 1 : 0,
      autocontinue: 1,
      param1: 0,
      param2: 0,
      param3: 0,
      param4: 0,
      lat: lat,
      lng: lng,
      alt: alt
    };

    set({ waypoints: [...wps, newWp] });
  },

  updateWaypointAlt: (seq, newAlt) => {
    set((state) => ({
      waypoints: state.waypoints.map(wp => 
        wp.seq === seq ? { ...wp, alt: parseFloat(newAlt) || 0 } : wp
      )
    }));
  },

  removeWaypoint: (seq) => {
    set((state) => {
      // Filter out the deleted one and re-index the sequence
      const filtered = state.waypoints.filter(wp => wp.seq !== seq);
      return {
        waypoints: filtered.map((wp, index) => ({
          ...wp,
          seq: index,
          current: index === 0 ? 1 : 0
        }))
      };
    });
  },

  clearMission: () => set({ waypoints: [] })
}));

export default useMissionStore;
