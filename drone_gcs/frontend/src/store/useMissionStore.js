import { create } from 'zustand';

const FENCE_CMD_INCLUSION = 5001;
const FENCE_CMD_EXCLUSION = 5002;

const useMissionStore = create((set, get) => ({
  waypoints: [],
  selectedSeq: null,
  missionCurrentSeq: -1,
  missionPlannedTotal: 0,
  missionType: 'MISSION',
  fencePolygonMode: 'INCLUSION',
  _undoStack: [],
  mapInstance: null,
  _missionSaved: [],
  _fenceSaved: [],
  _rallySaved: [],

  setMapInstance: (map) => set({ mapInstance: map }),

  setWaypoints: (wps) => set({ waypoints: wps, selectedSeq: wps.length ? 0 : null, missionPlannedTotal: wps.length }),
  setMissionCurrentSeq: (seq) => set({ missionCurrentSeq: Number.isFinite(Number(seq)) ? Number(seq) : -1 }),
  setMissionPlannedTotal: (n) => set({ missionPlannedTotal: Math.max(0, Number(n) || 0) }),
  setMissionType: (missionType) => set((state) => {
    const slotMap = { MISSION: '_missionSaved', FENCE: '_fenceSaved', RALLY: '_rallySaved' };
    const currentSlot = slotMap[state.missionType];
    const targetSlot = slotMap[missionType];
    const savedWaypoints = state[targetSlot] || [];
    return {
      missionType,
      [currentSlot]: state.waypoints,
      waypoints: savedWaypoints,
      selectedSeq: savedWaypoints.length ? 0 : null,
    };
  }),
  setFencePolygonMode: (mode) => set({ fencePolygonMode: mode }),
  selectWaypoint: (seq) => set({ selectedSeq: seq }),

  _reindex: (wps) => wps.map((wp, index) => ({ ...wp, seq: index, current: index === 0 ? 1 : 0 })),

  undoLastAction: () => {
    const stack = get()._undoStack;
    if (!stack.length) return;
    const prev = stack[stack.length - 1];
    set(state => ({
      waypoints: prev,
      _undoStack: state._undoStack.slice(0, -1),
      selectedSeq: prev.length
        ? (state.selectedSeq != null ? Math.min(state.selectedSeq, prev.length - 1) : 0)
        : null,
    }));
  },

  addWaypoint: (lat, lng, alt = 50) => {
    const snapshot = get().waypoints;
    const seq = snapshot.length;
    const missionType = get().missionType;
    const fenceMode = get().fencePolygonMode;
    const fenceCmd = missionType === 'FENCE'
      ? (fenceMode === 'EXCLUSION' ? FENCE_CMD_EXCLUSION : FENCE_CMD_INCLUSION)
      : null;
    const newWp = {
      seq,
      frame: 3,
      command: fenceCmd ?? (missionType === 'RALLY' ? 5100 : 16),
      current: seq === 0 ? 1 : 0,
      autocontinue: 1,
      param1: 0, param2: 0, param3: 0, param4: 0,
      lat, lng,
      alt: missionType === 'FENCE' ? 0 : alt,
    };
    // Re-index every mutation so seq always matches array index.
    // Without this, a later refactor that inserts mid-array via addWaypoint
    // would silently desync seq numbers from positions in the WP table.
    set(state => ({
      _undoStack: [...state._undoStack.slice(-19), snapshot],
      waypoints: state._reindex([...snapshot, newWp]),
      selectedSeq: seq,
    }));
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
    const snapshot = get().waypoints;
    set((state) => {
      const fenceDefaultCmd = state.missionType === 'FENCE'
        ? (state.fencePolygonMode === 'EXCLUSION' ? FENCE_CMD_EXCLUSION : FENCE_CMD_INCLUSION)
        : 16;
      const next = [...state.waypoints];
      next.splice(index, 0, {
        seq: 0,
        frame: 3,
        command: fenceDefaultCmd,
        current: 0,
        autocontinue: 1,
        param1: 0, param2: 0, param3: 0, param4: 0,
        lat: 0, lng: 0,
        alt: state.missionType === 'FENCE' ? 0 : 50,
        ...waypoint,
      });
      const reindexed = state._reindex(next);
      return {
        _undoStack: [...state._undoStack.slice(-19), snapshot],
        waypoints: reindexed,
        selectedSeq: index,
      };
    });
  },

  removeWaypoint: (seq) => {
    const snapshot = get().waypoints;
    set((state) => {
      const filtered = state.waypoints.filter(wp => wp.seq !== seq);
      const reindexed = state._reindex(filtered);
      return {
        _undoStack: [...state._undoStack.slice(-19), snapshot],
        waypoints: reindexed,
        selectedSeq: reindexed.length ? Math.max(0, Math.min(seq, reindexed.length - 1)) : null,
      };
    });
  },

  moveWaypoint: (seq, direction) => {
    const snapshot = get().waypoints;
    set((state) => {
      const arr = [...state.waypoints];
      const from = arr.findIndex((wp) => wp.seq === seq);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= arr.length) return state;
      [arr[from], arr[to]] = [arr[to], arr[from]];
      const reindexed = state._reindex(arr);
      return {
        _undoStack: [...state._undoStack.slice(-19), snapshot],
        waypoints: reindexed,
        selectedSeq: to,
      };
    });
  },

  clearMission: () => set({ waypoints: [], selectedSeq: null, missionCurrentSeq: -1, missionPlannedTotal: 0, _undoStack: [] }),

  replaceWaypoints: (items) =>
    set((state) => {
      const snapshot = state.waypoints;
      const base = (items || []).map((wp, idx) => ({
        frame: 3,
        command: 16,
        current: idx === 0 ? 1 : 0,
        autocontinue: 1,
        param1: 0, param2: 0, param3: 0, param4: 0,
        lat: 0, lng: 0, alt: 50,
        ...wp,
        seq: idx,
      }));
      return {
        _undoStack: [...state._undoStack.slice(-19), snapshot],
        waypoints: base,
        selectedSeq: base.length ? 0 : null,
        missionPlannedTotal: base.length,
      };
    }),

  appendWaypoints: (items) =>
    set((state) => {
      const snapshot = state.waypoints;
      const start = state.waypoints.length;
      const added = (items || []).map((wp, i) => ({
        frame: 3, command: 16, current: 0, autocontinue: 1,
        param1: 0, param2: 0, param3: 0, param4: 0,
        lat: 0, lng: 0, alt: 50,
        ...wp,
        seq: start + i,
      }));
      const merged = [...state.waypoints, ...added];
      const next = state._reindex(merged);
      return {
        _undoStack: [...state._undoStack.slice(-19), snapshot],
        waypoints: next,
        selectedSeq: start,
        missionPlannedTotal: next.length,
      };
    }),
}));

// Keep per-type slots in sync with the active waypoints buffer as edits happen
useMissionStore.subscribe((state, prev) => {
  if (state.waypoints === prev.waypoints) return;
  const slotMap = { MISSION: '_missionSaved', FENCE: '_fenceSaved', RALLY: '_rallySaved' };
  const slotKey = slotMap[state.missionType];
  if (slotKey && state[slotKey] !== state.waypoints) {
    useMissionStore.setState({ [slotKey]: state.waypoints });
  }
});

export { FENCE_CMD_INCLUSION, FENCE_CMD_EXCLUSION };
export { selectMapMissionOverlay } from '../telemetry/mapSelectors';

export default useMissionStore;
