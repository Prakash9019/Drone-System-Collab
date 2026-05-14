import { create } from 'zustand';

const FENCE_CMD_INCLUSION = 5001;
const FENCE_CMD_EXCLUSION = 5002;

const useMissionStore = create((set, get) => ({
  waypoints: [],
  selectedSeq: null,
  missionCurrentSeq: -1,
  missionPlannedTotal: 0,
  missionType: 'MISSION',
  /** 'INCLUSION' | 'EXCLUSION' — new fence vertices use MAV_CMD_NAV_FENCE_POLYGON_VERTEX_* */
  fencePolygonMode: 'INCLUSION',

  setWaypoints: (wps) => set({ waypoints: wps, selectedSeq: wps.length ? 0 : null, missionPlannedTotal: wps.length }),
  setMissionCurrentSeq: (seq) => set({ missionCurrentSeq: Number.isFinite(Number(seq)) ? Number(seq) : -1 }),
  setMissionPlannedTotal: (n) => set({ missionPlannedTotal: Math.max(0, Number(n) || 0) }),
  setMissionType: (missionType) => set({ missionType }),
  setFencePolygonMode: (mode) => set({ fencePolygonMode: mode }),
  selectWaypoint: (seq) => set({ selectedSeq: seq }),

  _reindex: (wps) => wps.map((wp, index) => ({ ...wp, seq: index, current: index === 0 ? 1 : 0 })),

  addWaypoint: (lat, lng, alt = 50) => {
    const wps = get().waypoints;
    const seq = wps.length;
    const missionType = get().missionType;
    const fenceMode = get().fencePolygonMode;
    const fenceCmd =
      missionType === 'FENCE'
        ? (fenceMode === 'EXCLUSION' ? FENCE_CMD_EXCLUSION : FENCE_CMD_INCLUSION)
        : null;
    
    // Default to NAV_WAYPOINT (16)
    const newWp = {
      seq: seq,
      frame: 3, // MAV_FRAME_GLOBAL_RELATIVE_ALT
      command: fenceCmd ?? (missionType === 'RALLY' ? 5100 : 16),
      current: seq === 0 ? 1 : 0,
      autocontinue: 1,
      param1: 0,
      param2: 0,
      param3: 0,
      param4: 0,
      lat: lat,
      lng: lng,
      alt: missionType === 'FENCE' ? 0 : alt
    };

    set({ waypoints: [...wps, newWp], selectedSeq: seq });
  },

  updateWaypointAlt: (seq, newAlt) => {
    set((state) => ({
      waypoints: state.waypoints.map(wp => 
        wp.seq === seq ? { ...wp, alt: parseFloat(newAlt) || 0 } : wp
      )
    }));
  },

  updateWaypointField: (seq, field, value) => {
    const numericFields = new Set([
      'command', 'frame', 'current', 'autocontinue',
      'param1', 'param2', 'param3', 'param4',
      'lat', 'lng', 'alt'
    ]);
    set((state) => ({
      waypoints: state.waypoints.map((wp) => {
        if (wp.seq !== seq) return wp;
        const parsed = numericFields.has(field) ? Number(value) : value;
        return { ...wp, [field]: Number.isNaN(parsed) ? wp[field] : parsed };
      })
    }));
  },

  insertWaypointAt: (index, waypoint) => {
    set((state) => {
      const fenceDefaultCmd =
        state.missionType === 'FENCE'
          ? (state.fencePolygonMode === 'EXCLUSION' ? FENCE_CMD_EXCLUSION : FENCE_CMD_INCLUSION)
          : 16;
      const next = [...state.waypoints];
      next.splice(index, 0, {
        seq: 0,
        frame: 3,
        command: fenceDefaultCmd,
        current: 0,
        autocontinue: 1,
        param1: 0,
        param2: 0,
        param3: 0,
        param4: 0,
        lat: 0,
        lng: 0,
        alt: state.missionType === 'FENCE' ? 0 : 50,
        ...waypoint,
      });
      const reindexed = state._reindex(next);
      return { waypoints: reindexed, selectedSeq: index };
    });
  },

  removeWaypoint: (seq) => {
    set((state) => {
      const filtered = state.waypoints.filter(wp => wp.seq !== seq);
      const reindexed = state._reindex(filtered);
      return {
        waypoints: reindexed,
        selectedSeq: reindexed.length ? Math.max(0, Math.min(seq, reindexed.length - 1)) : null
      };
    });
  },

  moveWaypoint: (seq, direction) => {
    set((state) => {
      const arr = [...state.waypoints];
      const from = arr.findIndex((wp) => wp.seq === seq);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= arr.length) return state;
      [arr[from], arr[to]] = [arr[to], arr[from]];
      const reindexed = state._reindex(arr);
      return { waypoints: reindexed, selectedSeq: to };
    });
  },

  clearMission: () => set({ waypoints: [], selectedSeq: null, missionCurrentSeq: -1, missionPlannedTotal: 0 }),

  /** Replace mission with generated items (seq renumbered). */
  replaceWaypoints: (items) =>
    set((state) => {
      const base = (items || []).map((wp, idx) => ({
        frame: 3,
        command: 16,
        current: idx === 0 ? 1 : 0,
        autocontinue: 1,
        param1: 0,
        param2: 0,
        param3: 0,
        param4: 0,
        lat: 0,
        lng: 0,
        alt: 50,
        ...wp,
        seq: idx,
      }));
      return { waypoints: base, selectedSeq: base.length ? 0 : null, missionPlannedTotal: base.length };
    }),

  /** Append generated items after current mission. */
  appendWaypoints: (items) =>
    set((state) => {
      const wps = state.waypoints;
      const start = wps.length;
      const added = (items || []).map((wp, i) => ({
        frame: 3,
        command: 16,
        current: 0,
        autocontinue: 1,
        param1: 0,
        param2: 0,
        param3: 0,
        param4: 0,
        lat: 0,
        lng: 0,
        alt: 50,
        ...wp,
        seq: start + i,
      }));
      const merged = [...wps, ...added];
      const next = state._reindex(merged);
      return { waypoints: next, selectedSeq: start, missionPlannedTotal: next.length };
    }),
}));

export { FENCE_CMD_INCLUSION, FENCE_CMD_EXCLUSION };
export { selectMapMissionOverlay } from '../telemetry/mapSelectors';

export default useMissionStore;
