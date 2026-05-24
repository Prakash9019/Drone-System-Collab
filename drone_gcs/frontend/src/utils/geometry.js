// Lightweight geometry helpers for the Flight Planner.
//
// Used by FlightPlanner.jsx fence diagnostics + preflight validation to answer
// "is HOME inside the inclusion polygon?" without paying the cost of a Turf import.
//
// All polygons are arrays of { lat, lng } points (or [lng, lat] tuples).
// "Containment" uses the standard even-odd ray-casting test, which is fine for
// the small, simple polygons users draw for geofences (no self-intersections).

const R_EARTH = 6371000;
const D2R = Math.PI / 180;

// ─────────────────────────────────────────────────────────────────────────────
// Point-in-polygon: ray casting from the test point along +lng (east). Counts
// how many polygon edges cross the ray; odd = inside, even = outside.
//
// Edge case: a point exactly on an edge is treated as "inside" (we err on the
// side of telling the user "you're inside" so we don't false-alarm on a fence
// drawn snug against home).
// ─────────────────────────────────────────────────────────────────────────────
export function pointInPolygon(lat, lng, polygon) {
  if (!polygon || polygon.length < 3) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    const lati = Number(pi.lat);
    const lngi = Number(pi.lng);
    const latj = Number(pj.lat);
    const lngj = Number(pj.lng);
    const intersects =
      ((lati > lat) !== (latj > lat)) &&
      (lng < ((lngj - lngi) * (lat - lati)) / (latj - lati + 1e-30) + lngi);
    if (intersects) inside = !inside;
  }
  return inside;
}

// Haversine distance in metres — short enough that we keep our own copy
// instead of pulling in mapShared.js (which also has a distance helper buried
// in the marker code).
export function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * D2R;
  const dLng = (lng2 - lng1) * D2R;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLng / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Convert the raw waypoint list (from useMissionStore) into an array of
// polygons grouped by inclusion vs exclusion command. Returns:
//   [{ type: 'inclusion'|'exclusion', points: [{lat,lng}, ...] }, ...]
//
// Mirrors mapShared.buildFenceGroups but produces {lat,lng} pairs instead of
// [lng,lat] tuples (which is what the maplibre layer wants but the
// pointInPolygon math here doesn't).
export function fencePolygonsFromWaypoints(waypoints, INC_CMD = 5001, EXC_CMD = 5002) {
  const polys = [];
  let cur = null;
  for (const wp of waypoints || []) {
    const c = Number(wp.command);
    const type = c === EXC_CMD ? 'exclusion' : 'inclusion';
    if (!cur || cur.type !== type) {
      if (cur) polys.push(cur);
      cur = { type, points: [] };
    }
    cur.points.push({ lat: Number(wp.lat), lng: Number(wp.lng) });
  }
  if (cur) polys.push(cur);
  return polys.filter(p => p.points.length >= 3);
}
