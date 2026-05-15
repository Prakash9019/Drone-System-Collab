import React, { useEffect, useRef, useState } from 'react';
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
    case 22: return '#f59e0b';   // TAKEOFF — amber
    case 21: return '#ef4444';   // LAND — red
    case 20: return '#f97316';   // RTL — orange
    case 17: case 18: case 19: return '#8b5cf6'; // LOITER — purple
    case 201: return '#0ea5e9';  // ROI — cyan
    case 206: case 203: return '#10b981'; // camera — green
    default: return '#3b82f6';   // waypoint — blue
  }
}

const MapEditor = () => {
  const navigate = useNavigate();
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markers = useRef([]);
  const distMarkers = useRef([]);
  const homeMarkerRef = useRef(null);

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

  const vehicleHome = useTelemetryStore(s => selectPrimaryVehicle(s)?.home);
  const vehiclePos = useTelemetryStore(s => selectPrimaryVehicle(s)?.position);

  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, lat: null, lng: null });
  const [selectedMarkerSeq, setSelectedMarkerSeq] = useState(null);
  const [plannerBanner, setPlannerBanner] = useState('');

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
        data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } }
      });
      map.current.addLayer({
        id: 'fence-fill',
        type: 'fill',
        source: 'fence-area',
        paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.18 }
      });

      // Vehicle position dot
      map.current.addSource('vehicle-dot', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.current.addLayer({
        id: 'vehicle-dot',
        type: 'circle',
        source: 'vehicle-dot',
        paint: {
          'circle-radius': 8,
          'circle-color': '#22c55e',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
        }
      });
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

  // ─── Vehicle position dot ─────────────────────────────────────────────────
  useEffect(() => {
    if (!map.current || !map.current.isStyleLoaded()) return;
    const src = map.current.getSource('vehicle-dot');
    if (!src) return;
    const lat = Number(vehiclePos?.lat);
    const lng = Number(vehiclePos?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
      src.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }]
      });
    } else {
      src.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [vehiclePos?.lat, vehiclePos?.lng]);

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

    // Update route line
    if (map.current.getSource('route')) {
      const routeCoords = missionType === 'FENCE' && coordinates.length > 2
        ? [...coordinates, coordinates[0]]
        : coordinates;
      map.current.getSource('route').setData({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: routeCoords }
      });
    }

    // Fence fill polygon
    if (map.current.getSource('fence-area')) {
      map.current.getSource('fence-area').setData({
        type: 'Feature', properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: missionType === 'FENCE' && coordinates.length > 2 ? [[...coordinates, coordinates[0]]] : []
        }
      });
    }

    // Fence colour logic
    if (missionType === 'FENCE' && coordinates.length > 2 && map.current.getLayer('fence-fill')) {
      const cmds = waypoints.map((w) => Number(w.command));
      const hasInc = cmds.some((c) => c === FENCE_CMD_INCLUSION);
      const hasExc = cmds.some((c) => c === FENCE_CMD_EXCLUSION);
      const fill = hasExc && !hasInc ? '#ef4444' : hasExc && hasInc ? '#f97316' : '#22c55e';
      const line = hasExc && !hasInc ? '#f87171' : hasExc && hasInc ? '#fb923c' : '#10b981';
      map.current.setPaintProperty('fence-fill', 'fill-color', fill);
      if (map.current.getLayer('route')) map.current.setPaintProperty('route', 'line-color', line);
    } else if (map.current.getLayer('route')) {
      map.current.setPaintProperty('route', 'line-color', '#10b981');
      if (map.current.getLayer('fence-fill'))
        map.current.setPaintProperty('fence-fill', 'fill-color', '#22c55e');
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
                axios.post(`${API_URL}/api/shortcuts/rtl`).then(r => r.data)
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
