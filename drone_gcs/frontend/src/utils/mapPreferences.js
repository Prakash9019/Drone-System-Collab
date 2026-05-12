const KEY = 'drone_gcs_map_prefs_v1';

/** @returns {{ center?: [number, number], zoom?: number, autoFollowVehicle?: boolean }} */
export function loadMapPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return {};
    return o;
  } catch {
    return {};
  }
}

/** @param {Record<string, unknown>} patch */
export function saveMapPrefs(patch) {
  try {
    const prev = loadMapPrefs();
    localStorage.setItem(KEY, JSON.stringify({ ...prev, ...patch }));
  } catch {
    /* ignore */
  }
}
