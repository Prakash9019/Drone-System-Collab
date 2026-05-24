// Shared map helpers — single source of truth for logic previously duplicated across
// MapView (Data tab), MapEditor (Plan tab), and FlightPlanner.jsx.
//
// Centralising these prevents the two map screens from drifting apart on:
//   * how a vehicle's heading is derived from velocity vs attitude
//   * how a consecutive run of fence vertices becomes a polygon group
//   * how the home-position house marker is rendered
//
// None of these helpers touch component state; they are pure-ish (mapShared.createHomeMarker
// hits the DOM but otherwise has no side effects).

import maplibregl from 'maplibre-gl';
import { FENCE_CMD_EXCLUSION } from '../store/useMissionStore';

// ─────────────────────────────────────────────────────────────────────────────
// Heading derivation — MAVLink VFR_HUD / GLOBAL_POSITION_INT prefer velocity.heading
// (deg, [0..360)). When invalid (e.g. on the ground with no GPS course), fall back to
// the EKF attitude yaw (radians) wrapped into degrees.
//
// Returns a number in [0..360). Never NaN.
// ─────────────────────────────────────────────────────────────────────────────
export function deriveHeadingDeg(vehicle) {
  const h = Number(vehicle?.velocity?.heading);
  if (Number.isFinite(h) && h >= 0 && h <= 360) return h;
  const yaw = vehicle?.attitude?.yaw;
  if (yaw == null || Number.isNaN(Number(yaw))) return 0;
  let deg = ((Number(yaw) * 180) / Math.PI) % 360;
  if (deg < 0) deg += 360;
  return deg;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mission Planner Fence.LocationToFence grouping: walk the vertex list and break
// off a new group whenever the command (inclusion vs exclusion) changes. The result
// matches what the autopilot stores on board.
//
// Input  : ordered array of waypoint-like { command, lat, lng }
// Output : [{ type: 'inclusion'|'exclusion', coords: [[lng,lat], ...] }, ...]
// ─────────────────────────────────────────────────────────────────────────────
export function buildFenceGroups(vertices) {
  const groups = [];
  let current = null;
  for (const wp of vertices || []) {
    const type = Number(wp.command) === FENCE_CMD_EXCLUSION ? 'exclusion' : 'inclusion';
    if (!current || current.type !== type) {
      if (current) groups.push(current);
      current = { type, coords: [] };
    }
    current.coords.push([wp.lng, wp.lat]);
  }
  if (current) groups.push(current);
  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// Waypoint marker colour by MAVLink command. The "active waypoint" highlight
// (green) overrides the per-command colour and is applied by the caller.
// Kept here so both screens render identical colours for the same command.
// ─────────────────────────────────────────────────────────────────────────────
export function waypointMarkerColor(cmdNum, isCurrent) {
  if (isCurrent) return '#10b981';
  switch (Number(cmdNum)) {
    case 5001: return '#22c55e'; // FENCE inclusion — green
    case 5002: return '#ef4444'; // FENCE exclusion — red
    case 22:   return '#f59e0b'; // NAV_TAKEOFF — amber
    case 21:   return '#ef4444'; // NAV_LAND — red
    case 20:   return '#f97316'; // NAV_RTL — orange
    case 17:
    case 18:
    case 19:   return '#8b5cf6'; // LOITER_{UNLIM, TURNS, TIME} — purple
    case 201:  return '#0ea5e9'; // DO_SET_ROI_LOCATION — cyan
    case 203:
    case 206:  return '#10b981'; // camera commands — green
    default:   return '#3b82f6'; // NAV_WAYPOINT and unknown — blue
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Home marker — green house SVG. Use this on both Data and Plan maps so they
// look identical. Returns a maplibregl.Marker bound to (lng, lat) or null when
// the home is invalid.
//
// The caller owns marker lifecycle (we don't track refs here).
// ─────────────────────────────────────────────────────────────────────────────
const HOME_SVG = ''
  + '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">'
  + '<path d="M3 11 L11 3 L19 11 L19 19 L13 19 L13 14 L9 14 L9 19 L3 19 Z" fill="#16a34a" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>'
  + '<rect x="9.5" y="14" width="3" height="5" fill="#052e16"/>'
  + '</svg>';

export function isValidHome(home) {
  if (!home) return false;
  const lat = Number(home.lat);
  const lng = Number(home.lng);
  if (!home.valid) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return true;
}

export function createHomeMarker(map, home) {
  if (!map || !isValidHome(home)) return null;
  const el = document.createElement('div');
  el.className = 'home-marker';
  el.style.cssText = 'width:22px;height:22px;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0.92;';
  el.innerHTML = HOME_SVG;
  el.title = `Home (${Number(home.lat).toFixed(6)}, ${Number(home.lng).toFixed(6)})`;
  return new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([Number(home.lng), Number(home.lat)])
    .addTo(map);
}
