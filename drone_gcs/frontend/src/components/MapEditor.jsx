import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import axios from 'axios';
import useMissionStore, {
  FENCE_CMD_INCLUSION,
  FENCE_CMD_EXCLUSION,
} from '../store/useMissionStore';
import useTelemetryStore, { selectPrimaryVehicle } from '../store/useTelemetryStore';
import { loadMapPrefs, saveMapPrefs } from '../utils/mapPreferences';

const API_URL = 'http://localhost:8080';

// Haversine distance in metres
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1))*Math.cos(toR(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Marker colour per MAVLink command
function markerColor(cmdNum, isCurrent) {
  if (isCurrent) return '#10b981';
  switch (Number(cmdNum)) {
    case 5001: return '#22c55e'; // FENCE inclusion — green
    case 5002: return '#ef4444'; // FENCE exclusion — red
    case 22: return '#f59e0b';   // TAKEOFF — amber
    case 21: return '#ef4444';   // LAND — red
    case 20: return '#f97316';   // RTL — orange
    case 17: case 18: case 19: return '#8b5cf6'; // LOITER — purple
    case 201: return '#0ea5e9';  // ROI — cyan
    case 206: case 203: return '#10b981'; // camera — green
    default: return '#3b82f6';   // waypoint — blue
  }
}

// Group consecutive fence vertices of the same type into polygon objects (matches MP Fence.LocationToFence)
function buildFenceGroups(waypoints) {
  const groups = [];
  let current = null;
  waypoints.forEach(wp => {
    const type = Number(wp.command) === FENCE_CMD_EXCLUSION ? 'exclusion' : 'inclusion';
    if (!current || current.type !== type) {
      if (current) groups.push(current);
      current = { type, coords: [] };
    }
    current.coords.push([wp.lng, wp.lat]);
  });
  if (current) groups.push(current);
  return groups;
}

// Inline SVG for the drone arrow marker (triangle pointing north, rotates with heading)
const DRONE_SVG_URL = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">' +
  '<polygon points="16,1 30,30 16,24 2,30" fill="%233b82f6" stroke="%23ffffff" stroke-width="2" stroke-linejoin="round"/>' +
  '</svg>'
)}`;

const MapEditor = () => {
  const navigate = useNavigate();
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markers = useRef([]);
  const distMarkers = useRef([]);
  const homeMarkerRef = useRef(null);
  const droneMarkerRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);

  const waypoints = useMissionStore((state) => state.waypoints);
  const missionType = useMissionStore((state) => state.missionType);
  const fencePolygonMode = useMissionStore((state) => state.fencePolygonMode);
  const addWaypoint = useMissionStore((state) => state.addWaypoint);
  const insertWaypointAt = useMissionStore((state) => state.insertWaypointAt);
  const updateWaypointField = useMissionStore((state) => state.updateWaypointField);
  const removeWaypoint = useMissionStore((state) => state.removeWaypoint);
  const selectedSeq = useMissionStore((state) => state.selectedSeq);
  const missionCurrentSeq = useMissionStore((state) => state.missionCurrentSeq);
  const selectWaypoint = useMissionStore((state) => state.selectWaypoint);
  const setMapInstance = useMissionStore((state) => state.setMapInstance);

  const rawVehicle = useTelemetryStore(s =>
    (s.connectionState === 'DISCONNECTED' || !s.connected) ? null : selectPrimaryVehicle(s)
  );
  const vehicleHome = useMemo(() => rawVehicle?.home ?? null, [rawVehicle]);
  const vehicleMapState = useMemo(() => {
    if (!rawVehicle) return null;
    const pos = rawVehicle.position || {};
    const status = rawVehicle.status || {};
    const isNullIsland = pos.lat === 0.0 && pos.lng === 0.0;
    const hasValidGps = !isNullIsland || (status.gps_fix >= 3);
    const heading = rawVehicle.velocity?.heading ?? null;
    const attitudeYaw = rawVehicle.attitude?.yaw != null
      ? (rawVehicle.attitude.yaw * 180 / Math.PI) : 0;
    let finalHeading = heading;
    if (finalHeading == null || finalHeading < 0) {
      let yawDeg = attitudeYaw;
      while (yawDeg < 0) yawDeg += 360;
      while (yawDeg >= 360) yawDeg -= 360;
      finalHeading = yawDeg;
    }
    return {
      position: hasValidGps ? { lat: pos.lat, lng: pos.lng } : null,
      heading: finalHeading,
    };
  }, [rawVehicle]);

  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, lat: null, lng: null });
  const [selectedMarkerSeq, setSelectedMarkerSeq] = useState(null);
  const [plannerBanner, setPlannerBanner] = useState('');
  // AutoPan follows HOME (preferred) else the vehicle. Persisted in mapPreferences
  // so it survives reloads. Auto-disables when the user drags the map so we don't
  // fight their interaction — the toggle re-enables.
  const [autoPan, setAutoPan] = useState(() => loadMapPrefs().autoPan !== false);
  const lastAutoCenterRef = useRef(null);

  // ─── Map init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (map.current) return;

    const prefs = loadMapPrefs();
    let center = [-122.4194, 37.7749];
    let zoom = 16;
    if (prefs.center && prefs.center.length === 2) {
      center = [prefs.center[0], prefs.center[1]];
      if (prefs.zoom) zoom = prefs.zoom;
    }

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center,
      zoom,
      attributionControl: false,
    });

    setMapInstance(map.current);

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          map.current.jumpTo({
            center: [pos.coords.longitude, pos.coords.latitude],
            zoom: Math.max(zoom, 14),
          });
          saveMapPrefs({ center: [pos.coords.longitude, pos.coords.latitude], zoom: map.current.getZoom() });
        },
        () => {},
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
      );
    }

    map.current.on('moveend', () => {
      const c = map.current.getCenter();
      saveMapPrefs({ center: [c.lng, c.lat], zoom: map.current.getZoom() });
    });

    // User drag turns off AutoPan — we don't want the map to keep snapping back
    // while they're manually positioning. Toggle button re-enables it.
    map.current.on('dragstart', (e) => {
      // originalEvent is only present for user-initiated drags, not for our easeTo() calls.
      if (e?.originalEvent) {
        setAutoPan((prev) => {
          if (prev) saveMapPrefs({ autoPan: false });
          return false;
        });
      }
    });

    map.current.on('load', () => {
      map.current.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } }
      });
      map.current.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#10b981', 'line-width': 4, 'line-dasharray': [2, 2] }
      });

      map.current.addSource('fence-area', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      // Polygon fill — only applies to closed polygon features (≥3 pts)
      map.current.addLayer({
        id: 'fence-fill',
        type: 'fill',
        source: 'fence-area',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': ['match', ['get', 'fenceType'], 'exclusion', '#ef4444', '#22c55e'],
          'fill-opacity': 0.18,
        }
      });
      // Outline — applies to both Polygon outlines and partial LineString previews
      map.current.addLayer({
        id: 'fence-outline',
        type: 'line',
        source: 'fence-area',
        paint: {
          'line-color': ['match', ['get', 'fenceType'], 'exclusion', '#f87171', '#10b981'],
          'line-width': 2,
          'line-dasharray': [3, 2],
        }
      });

      setMapReady(true);
    });

    map.current.on('click', (e) => {
      addWaypoint(e.lngLat.lat, e.lngLat.lng, missionType === 'FENCE' ? 0 : 50);
      setContextMenu({ visible: false, x: 0, y: 0, lat: null, lng: null });
    });

    map.current.on('contextmenu', (e) => {
      e.originalEvent.preventDefault();
      setContextMenu({ visible: true, x: e.point.x, y: e.point.y, lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');
  }, [addWaypoint, missionType, setMapInstance]);

  // ─── Live drone marker (rotating arrow, matches heading) ─────────────────
  useEffect(() => {
    if (!map.current || !mapReady) return;
    const pos = vehicleMapState?.position;
    const heading = vehicleMapState?.heading ?? 0;

    if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) {
      if (!droneMarkerRef.current) {
        const el = document.createElement('div');
        el.style.cssText = `width:32px;height:32px;background-image:url('${DRONE_SVG_URL}');background-size:contain;background-repeat:no-repeat;`;
        el.title = `Vehicle: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
        droneMarkerRef.current = new maplibregl.Marker({
          element: el,
          rotationAlignment: 'map',
          anchor: 'center',
        }).setLngLat([pos.lng, pos.lat]).addTo(map.current);
      } else {
        droneMarkerRef.current.setLngLat([pos.lng, pos.lat]);
      }
      droneMarkerRef.current.setRotation(heading);
    } else {
      if (droneMarkerRef.current) {
        droneMarkerRef.current.remove();
        droneMarkerRef.current = null;
      }
    }
  }, [vehicleMapState, mapReady]);

  // ─── Home marker ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map.current) return;
    if (homeMarkerRef.current) { homeMarkerRef.current.remove(); homeMarkerRef.current = null; }
    const lat = Number(vehicleHome?.lat);
    const lng = Number(vehicleHome?.lng);
    if (vehicleHome?.valid && Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
      const el = document.createElement('div');
      el.className = 'home-marker';
      el.title = `Home: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      el.innerHTML = '🏠';
      homeMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([lng, lat])
        .addTo(map.current);
    }
  }, [vehicleHome?.lat, vehicleHome?.lng, vehicleHome?.valid]);

  // ─── AutoPan: keep the map centred on HOME (preferred) or the vehicle ─────
  // Rule: HOME wins when valid (operators usually want to see the launch area).
  // When neither is available we leave the map where it is. We use easeTo with
  // a short duration so the pan is visible but not jarring. We track the last
  // auto-issued centre and skip if it's within ~3m to avoid jitter on noisy GPS.
  useEffect(() => {
    if (!map.current || !mapReady || !autoPan) return;
    const homeValid = !!(vehicleHome?.valid)
      && Number.isFinite(Number(vehicleHome.lat))
      && Number.isFinite(Number(vehicleHome.lng))
      && !(vehicleHome.lat === 0 && vehicleHome.lng === 0);
    const pos = vehicleMapState?.position;
    const target = homeValid
      ? { lat: Number(vehicleHome.lat), lng: Number(vehicleHome.lng) }
      : (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng) ? pos : null);
    if (!target) return;
    const last = lastAutoCenterRef.current;
    if (last) {
      // ~1e-5 deg ≈ 1.1 m; skip if we'd move less than ~3 m to avoid jitter.
      const dLat = Math.abs(last.lat - target.lat);
      const dLng = Math.abs(last.lng - target.lng);
      if (dLat < 3e-5 && dLng < 3e-5) return;
    }
    lastAutoCenterRef.current = target;
    map.current.easeTo({ center: [target.lng, target.lat], duration: 350, essential: true });
  }, [autoPan, mapReady, vehicleHome?.lat, vehicleHome?.lng, vehicleHome?.valid,
      vehicleMapState?.position?.lat, vehicleMapState?.position?.lng]);

  // ─── Waypoint markers + route + distance labels ───────────────────────────
  useEffect(() => {
    if (!map.current) return;

    markers.current.forEach(m => m.remove());
    markers.current = [];
    distMarkers.current.forEach(m => m.remove());
    distMarkers.current = [];

    const coordinates = [];

    waypoints.forEach((wp, index) => {
      coordinates.push([wp.lng, wp.lat]);

      const cmdNum = Number(wp.command);
      const isCurrent = missionCurrentSeq === wp.seq;
      const isSelected = selectedSeq === wp.seq || selectedMarkerSeq === wp.seq;
      const color = markerColor(cmdNum, isCurrent);

      const el = document.createElement('div');
      el.className = 'waypoint-marker';
      el.innerHTML = `<span>${index}</span>`;
      el.style.backgroundColor = color;
      el.style.color = 'white';
      el.style.width = '24px';
      el.style.height = '24px';
      el.style.borderRadius = '50%';
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.fontSize = '12px';
      el.style.fontWeight = 'bold';
      el.style.border = `2px solid ${isSelected ? '#fff' : 'rgba(255,255,255,0.6)'}`;
      el.style.cursor = 'pointer';
      el.style.boxShadow = isSelected ? `0 0 0 3px ${color}` : 'none';

      const marker = new maplibregl.Marker(el, { draggable: true })
        .setLngLat([wp.lng, wp.lat])
        .addTo(map.current);

      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        updateWaypointField(wp.seq, 'lat', lngLat.lat);
        updateWaypointField(wp.seq, 'lng', lngLat.lng);
      });

      el.onclick = (event) => {
        event.stopPropagation();
        selectWaypoint(wp.seq);
        setSelectedMarkerSeq(wp.seq);
      };

      markers.current.push(marker);
    });

    // Distance labels between consecutive waypoints
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      if (!a.lat || !a.lng || !b.lat || !b.lng) continue;
      const d = distM(a.lat, a.lng, b.lat, b.lng);
      if (d < 1) continue;
      const label = d >= 1000 ? `${(d / 1000).toFixed(1)}km` : `${Math.round(d)}m`;
      const midLat = (a.lat + b.lat) / 2;
      const midLng = (a.lng + b.lng) / 2;
      const el = document.createElement('div');
      el.className = 'wp-dist-label';
      el.textContent = label;
      const dm = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([midLng, midLat])
        .addTo(map.current);
      distMarkers.current.push(dm);
    }

    // Route line: mission/rally only — fence uses dedicated layers below
    if (map.current.getSource('route')) {
      map.current.getSource('route').setData({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: missionType === 'FENCE' ? [] : coordinates }
      });
    }

    // Fence: render each polygon group independently with per-type color (matches MP WPOverlay)
    if (map.current.getSource('fence-area')) {
      if (missionType === 'FENCE' && waypoints.length > 0) {
        const fenceGroups = buildFenceGroups(waypoints);
        const features = fenceGroups.flatMap(g => {
          if (g.coords.length === 0) return [];
          if (g.coords.length > 2) {
            // Closed polygon (≥3 pts) — rendered with fill + outline
            return [{ type: 'Feature', properties: { fenceType: g.type },
              geometry: { type: 'Polygon', coordinates: [[...g.coords, g.coords[0]]] } }];
          }
          // Partial polygon (<3 pts) — rendered as dashed line preview only
          return [{ type: 'Feature', properties: { fenceType: g.type },
            geometry: { type: 'LineString', coordinates: g.coords } }];
        });
        map.current.getSource('fence-area').setData({ type: 'FeatureCollection', features });
      } else {
        map.current.getSource('fence-area').setData({ type: 'FeatureCollection', features: [] });
      }
    }

  }, [waypoints, missionType, missionCurrentSeq, selectedSeq, selectedMarkerSeq, updateWaypointField, selectWaypoint]);

  const closeContextMenu = () => setContextMenu({ visible: false, x: 0, y: 0, lat: null, lng: null });

  const addCommand = (command) => {
    if (contextMenu.lat === null || contextMenu.lng === null) return;
    insertWaypointAt(waypoints.length, {
      command,
      lat: contextMenu.lat,
      lng: contextMenu.lng,
      alt: command === 21 || missionType === 'FENCE' ? 0 : 50,
    });
    closeContextMenu();
  };

  const fenceVertexCommand =
    missionType === 'FENCE'
      ? (fencePolygonMode === 'EXCLUSION' ? FENCE_CMD_EXCLUSION : FENCE_CMD_INCLUSION)
      : 16;

  const insertHere = () => {
    if (contextMenu.lat === null || contextMenu.lng === null) return;
    const idx = selectedSeq == null ? waypoints.length : selectedSeq + 1;
    insertWaypointAt(idx, {
      lat: contextMenu.lat,
      lng: contextMenu.lng,
      alt: missionType === 'FENCE' ? 0 : 50,
      command: fenceVertexCommand,
    });
    closeContextMenu();
  };

  const deleteSelected = () => {
    if (selectedSeq != null) removeWaypoint(selectedSeq);
    closeContextMenu();
  };

  const runVehicle = async (label, fn) => {
    setPlannerBanner('');
    try {
      const res = await fn();
      if (res?.accepted === false) {
        setPlannerBanner(`${label}: ${res.mav_result_text || 'rejected'}`);
      } else if (res?.status === 'failed') {
        setPlannerBanner(`${label}: failed`);
      } else {
        setPlannerBanner(`${label}: OK`);
      }
    } catch (e) {
      const d = e.response?.data;
      setPlannerBanner(`${label}: ${d?.detail || d?.error || e.message}`);
    }
    closeContextMenu();
    setTimeout(() => setPlannerBanner(''), 5000);
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {plannerBanner && (
        <div className="map-banner">
          {plannerBanner}
        </div>
      )}
      {/* AutoPan toggle — sits in the top-left so it doesn't overlap maplibre's
          NavigationControl (top-right). Clicking it also re-centres on whichever
          target is current (HOME or vehicle). */}
      <button
        type="button"
        onClick={() => {
          const next = !autoPan;
          setAutoPan(next);
          saveMapPrefs({ autoPan: next });
          if (next) {
            // Force a recentre by clearing the dedupe ref. The effect will run.
            lastAutoCenterRef.current = null;
          }
        }}
        title={autoPan
          ? 'AutoPan ON — map follows HOME or vehicle. Click to disable, or drag to pause.'
          : 'AutoPan OFF — click to re-enable following.'}
        style={{
          position: 'absolute', top: 10, left: 10, zIndex: 105,
          width: 34, height: 34, borderRadius: 6,
          border: '1px solid ' + (autoPan ? '#10b981' : 'var(--border-color)'),
          background: autoPan ? 'rgba(16,185,129,0.18)' : 'var(--bg-panel)',
          color: autoPan ? '#34d399' : 'var(--text-secondary)',
          cursor: 'pointer', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0,
        }}
        aria-pressed={autoPan}
        aria-label="Toggle AutoPan"
      >
        {/* Crosshair glyph — readable on both background colours */}
        ⊕
      </button>
      <div ref={mapContainer} className="map-container" />
      {contextMenu.visible && (
        <div className="context-menu" style={{ position: 'absolute', top: contextMenu.y, left: contextMenu.x, zIndex: 110 }}>
          <div onClick={insertHere}>
            {missionType === 'FENCE' ? 'Insert Fence Vertex' : 'Insert WP after selected'}
          </div>
          {missionType === 'MISSION' && (
            <>
              <div onClick={() => {
                if (contextMenu.lat == null) return;
                insertWaypointAt(waypoints.length, { lat: contextMenu.lat, lng: contextMenu.lng, alt: 50, command: 16 });
                closeContextMenu();
              }}>
                Add waypoint at end
              </div>
              <div onClick={() => runVehicle('Set home', () =>
                axios.post(`${API_URL}/api/vehicle/set_home`, { lat: contextMenu.lat, lng: contextMenu.lng, alt: 0 }).then(r => r.data)
              )}>
                Set home here
              </div>
              <div onClick={() => runVehicle('Guided target', () =>
                axios.post(`${API_URL}/api/flyto`, { lat: contextMenu.lat, lng: contextMenu.lng, alt: 50 }).then(r => r.data)
              )}>
                Set guided target
              </div>
              <div onClick={() => runVehicle('RTL', () =>
                axios.post(`${API_URL}/api/command/rtl`).then(r => r.data)
              )}>
                RTL (vehicle)
              </div>
              <div onClick={() => runVehicle('ROI', () =>
                axios.post(`${API_URL}/api/vehicle/roi`, { lat: contextMenu.lat, lng: contextMenu.lng, alt: 50 }).then(r => r.data)
              )}>
                Set ROI here
              </div>
              <div onClick={() => runVehicle('Clear ROI', () =>
                axios.post(`${API_URL}/api/vehicle/roi/clear`).then(r => r.data)
              )}>
                Clear ROI
              </div>
              <div onClick={() => {
                if (contextMenu.lat == null) return;
                navigate('/planner', { state: { openSurvey: true, centerLat: contextMenu.lat, centerLng: contextMenu.lng } });
                closeContextMenu();
              }}>
                Survey grid…
              </div>
            </>
          )}
          {missionType !== 'FENCE' && (
            <>
              <div className="context-menu-sep" />
              <div onClick={() => addCommand(22)}>Insert TAKEOFF</div>
              <div onClick={() => addCommand(21)}>Insert LAND</div>
              <div onClick={() => addCommand(20)}>Insert RTL</div>
              <div onClick={() => addCommand(17)}>Insert LOITER UNLIM</div>
              <div onClick={() => addCommand(18)}>Insert LOITER TURNS</div>
              <div onClick={() => addCommand(19)}>Insert LOITER TIME</div>
              <div onClick={() => addCommand(82)}>Insert SPLINE WP (82)</div>
              <div onClick={() => addCommand(201)}>Insert ROI</div>
              <div onClick={() => addCommand(177)}>Insert DO_JUMP</div>
              <div onClick={() => addCommand(178)}>Insert DO CHANGE SPEED</div>
              <div onClick={() => addCommand(206)}>Insert CAM_TRIGG_DIST</div>
            </>
          )}
          <div className="context-menu-sep" />
          <div className="context-menu-danger" onClick={deleteSelected}>Delete Selected WP</div>
          <div onClick={closeContextMenu}>Cancel</div>
        </div>
      )}
    </div>
  );
};

export default MapEditor;
