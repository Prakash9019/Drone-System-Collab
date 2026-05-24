import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import useTelemetryStore, { selectPrimaryVehicle } from '../store/useTelemetryStore';
import useMissionStore, { FENCE_CMD_INCLUSION, FENCE_CMD_EXCLUSION } from '../store/useMissionStore';
import { loadMapPrefs, saveMapPrefs } from '../utils/mapPreferences';

const API_URL = 'http://localhost:8080';

const DEFAULT_FALLBACK = { lng: 78.4867, lat: 17.385 }; /* Hyderabad-ish if nothing else */

function headingDegFromVehicle(v) {
  const h = Number(v?.velocity?.heading);
  if (Number.isFinite(h) && h >= 0 && h <= 360) return h;
  const yaw = v?.attitude?.yaw;
  if (yaw == null || Number.isNaN(Number(yaw))) return 0;
  const deg = ((Number(yaw) * 180) / Math.PI) % 360;
  return deg < 0 ? deg + 360 : deg;
}

// Mission Planner–style quadcopter top-down icon. Body + 4 motor pods + forward arrow.
// Drawn pointing north (0°); maplibre rotates with setRotation(heading).
// No percent units inside the SVG (they'd collide with data: URI percent-encoding).
const DRONE_SVG_RAW = '<svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">'
  + '<line x1="22" y1="22" x2="7" y2="7" stroke="#facc15" stroke-width="3" stroke-linecap="round"/>'
  + '<line x1="22" y1="22" x2="37" y2="7" stroke="#facc15" stroke-width="3" stroke-linecap="round"/>'
  + '<line x1="22" y1="22" x2="7" y2="37" stroke="#ef4444" stroke-width="3" stroke-linecap="round"/>'
  + '<line x1="22" y1="22" x2="37" y2="37" stroke="#ef4444" stroke-width="3" stroke-linecap="round"/>'
  + '<circle cx="7" cy="7" r="5.5" fill="#1e293b" stroke="#facc15" stroke-width="1.8"/>'
  + '<circle cx="37" cy="7" r="5.5" fill="#1e293b" stroke="#facc15" stroke-width="1.8"/>'
  + '<circle cx="7" cy="37" r="5.5" fill="#1e293b" stroke="#ef4444" stroke-width="1.8"/>'
  + '<circle cx="37" cy="37" r="5.5" fill="#1e293b" stroke="#ef4444" stroke-width="1.8"/>'
  + '<polygon points="22,2 27,11 22,9 17,11" fill="#22c55e" stroke="#ffffff" stroke-width="0.9"/>'
  + '<rect x="16.5" y="16.5" width="11" height="11" rx="2" fill="#0f172a" stroke="#ffffff" stroke-width="1.6"/>'
  + '<circle cx="22" cy="22" r="2" fill="#60a5fa"/>'
  + '</svg>';
const DRONE_SVG_URI = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(DRONE_SVG_RAW);

const MapView = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);
  const homeMarker = useRef(null);
  const trailRef = useRef([]);
  const otherVehicleMarkersRef = useRef(new Map());
  const adsbMarkersRef = useRef(new Map());
  const rallyMarkersRef = useRef([]);
  const waypointMarkersRef = useRef([]);
  const userPausedFollowRef = useRef(false);
  const programmaticMoveRef = useRef(false);
  // Smooth-interpolation state for the primary vehicle marker.
  // Telemetry arrives at 10 Hz; we tween to the target position at 60 fps so movement looks continuous.
  const markerAnimRef = useRef({ lng: null, lat: null, hdg: 0, targetLng: null, targetLat: null, targetHdg: 0, lastTargetAt: 0, raf: 0 });

  const navigate = useNavigate();
  const vehicle = useTelemetryStore(selectPrimaryVehicle);
  const telemetry = useTelemetryStore((s) => s.telemetry);
  const primarySysId = useTelemetryStore((s) => s.primarySysId);
  const adsbTracks = useTelemetryStore((s) => s.adsbTracks);
  const connectionState = useTelemetryStore((s) => s.connectionState);
  const sendShortcutCommand = useTelemetryStore((s) => s.sendShortcutCommand);
  const missionType = useMissionStore((s) => s.missionType);
  const addMissionWaypoint = useMissionStore((s) => s.addWaypoint);
  const insertWaypointAt = useMissionStore((s) => s.insertWaypointAt);
  const removeWaypoint = useMissionStore((s) => s.removeWaypoint);
  const selectedSeq = useMissionStore((s) => s.selectedSeq);
  const waypoints = useMissionStore((s) => s.waypoints);
  const _fenceSaved = useMissionStore((s) => s._fenceSaved);
  const _rallySaved = useMissionStore((s) => s._rallySaved);
  const _missionSaved = useMissionStore((s) => s._missionSaved);

  const primaryMapKey = useMemo(() => {
    if (primarySysId != null && primarySysId !== '') return String(primarySysId);
    if (vehicle?.sysid != null) return String(vehicle.sysid);
    return null;
  }, [primarySysId, vehicle?.sysid]);

  // GPS validity is driven *only* by MAVLink telemetry. No fallback, no browser geo, no cached prefs.
  // The marker is hidden until we have a real fix from GLOBAL_POSITION_INT with non-zero coordinates
  // AND a GPS fix type ≥ 2 from GPS_RAW_INT (3D fix preferred). This is the same rule Mission Planner
  // uses before it starts drawing the vehicle on the map.
  const rawLat = Number(vehicle?.position?.lat);
  const rawLng = Number(vehicle?.position?.lng);
  const gpsFix = Number(vehicle?.status?.gps_fix ?? 0);
  const positionValid = Number.isFinite(rawLat) && Number.isFinite(rawLng)
    && !(rawLat === 0 && rawLng === 0)
    && Math.abs(rawLat) <= 90 && Math.abs(rawLng) <= 180
    && gpsFix >= 2;
  const lat = positionValid ? rawLat : null;
  const lng = positionValid ? rawLng : null;
  const heading = useMemo(() => positionValid ? headingDegFromVehicle(vehicle) : 0, [vehicle, positionValid]);
  // One-shot "center map on first valid telemetry" flag. Saved prefs only seed the IDLE view;
  // once real telemetry arrives we jumpTo the vehicle and never bounce back.
  const firstFixCenteredRef = useRef(false);

  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, latLng: null });
  const [mapStyleLoaded, setMapStyleLoaded] = useState(false);
  const [showFenceOverlay, setShowFenceOverlay] = useState(true);
  const [showMissionRoute, setShowMissionRoute] = useState(true);
  const [showRallyOverlay, setShowRallyOverlay] = useState(true);
  const [mapBanner, setMapBanner] = useState('');
  const [geoNote, setGeoNote] = useState('');
  const [autoFollowVehicle, setAutoFollowVehicle] = useState(() => {
    const p = loadMapPrefs();
    return p.autoFollowVehicle !== false;
  });

  const persistView = useCallback(() => {
    if (!map.current) return;
    const c = map.current.getCenter();
    saveMapPrefs({
      center: [c.lng, c.lat],
      zoom: map.current.getZoom(),
      autoFollowVehicle,
    });
  }, [autoFollowVehicle]);

  const resumeFollowVehicle = useCallback(() => {
    userPausedFollowRef.current = false;
    setAutoFollowVehicle(true);
    saveMapPrefs({ autoFollowVehicle: true });
  }, []);

  const goToMyLocation = useCallback(() => {
    if (!map.current || !navigator.geolocation) {
      setGeoNote('Geolocation not available');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        programmaticMoveRef.current = true;
        map.current.jumpTo({ center: [longitude, latitude], zoom: Math.max(map.current.getZoom(), 15) });
        saveMapPrefs({ center: [longitude, latitude], zoom: map.current.getZoom() });
        setGeoNote('');
        setTimeout(() => {
          programmaticMoveRef.current = false;
        }, 400);
      },
      (err) => setGeoNote(err.message || 'Location denied'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  }, []);

  useEffect(() => {
    if (map.current) return;

    const prefs = loadMapPrefs();
    let initial = DEFAULT_FALLBACK;
    let initialZoom = 11;
    if (prefs.center && prefs.center.length === 2) {
      initial = { lng: prefs.center[0], lat: prefs.center[1] };
      if (prefs.zoom) initialZoom = prefs.zoom;
    }

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [initial.lng, initial.lat],
      zoom: initialZoom,
      pitch: 45,
      attributionControl: false,
    });

    const attachUserGestureHandlers = () => {
      const markUser = () => {
        if (programmaticMoveRef.current) return;
        userPausedFollowRef.current = true;
      };
      map.current.on('dragstart', markUser);
      map.current.on('rotatestart', markUser);
      map.current.on('pitchstart', markUser);
      map.current.on('wheel', markUser);
    };
    attachUserGestureHandlers();

    const el = document.createElement('div');
    // Hidden by default — only flips to visible after a valid GPS fix arrives from MAVLink.
    // Hyderabad-or-saved fallback never positions the drone marker; it only seeds the map view.
    el.style.cssText = 'width:48px;height:48px;display:none;align-items:center;justify-content:center;filter:drop-shadow(0 0 6px rgba(96,165,250,0.95));pointer-events:none;';
    el.innerHTML = DRONE_SVG_RAW;
    el.title = 'Vehicle (waiting for GPS lock)';

    // Park the marker at the initial map center so MapLibre has *somewhere* to attach the DOM
    // element. setLngLat is required before addTo, but the element is display:none so it is
    // invisible to the user. Once telemetry arrives, the position-update effect calls setLngLat
    // with real coordinates *and* flips the element to display:flex.
    marker.current = new maplibregl.Marker({ element: el, rotationAlignment: 'map', anchor: 'center' })
      .setLngLat([initial.lng, initial.lat])
      .addTo(map.current);

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.current.on('moveend', () => {
      if (!programmaticMoveRef.current) persistView();
    });

    map.current.on('load', () => {
      if (!map.current.getSource('flight-trail')) {
        map.current.addSource('flight-trail', {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: [] },
          },
        });
        map.current.addLayer({
          id: 'flight-trail',
          type: 'line',
          source: 'flight-trail',
          paint: {
            'line-color': '#38bdf8',
            'line-width': 2,
            'line-opacity': 0.85,
          },
        });
      }

      map.current.addSource('mv-fence-fill', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.current.addLayer({
        id: 'mv-fence-fill', type: 'fill', source: 'mv-fence-fill',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': ['match', ['get', 'fenceType'], 'exclusion', '#ef4444', '#22c55e'],
          'fill-opacity': 0.18,
        }
      });
      map.current.addLayer({
        id: 'mv-fence-outline', type: 'line', source: 'mv-fence-fill',
        paint: {
          'line-color': ['match', ['get', 'fenceType'], 'exclusion', '#f87171', '#10b981'],
          'line-width': 2,
          'line-dasharray': [4, 2],
        }
      });
      map.current.addSource('mv-mission-route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } }
      });
      map.current.addLayer({
        id: 'mv-mission-route', type: 'line', source: 'mv-mission-route',
        paint: { 'line-color': '#3b82f6', 'line-width': 2, 'line-dasharray': [4, 2] }
      });
      setMapStyleLoaded(true);
    });

    map.current.on('contextmenu', (e) => {
      e.originalEvent.preventDefault();
      setContextMenu({
        visible: true,
        x: e.point.x,
        y: e.point.y,
        latLng: e.lngLat,
      });
    });

    map.current.on('click', () => {
      setContextMenu((prev) => ({ ...prev, visible: false }));
    });

    // Browser geolocation only seeds the IDLE map view (operator-side convenience).
    // It NEVER positions the vehicle marker, and it must not steal centering from real
    // telemetry — if a MAVLink fix has already landed, skip the geo jump entirely.
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (firstFixCenteredRef.current) return;
          const { latitude, longitude } = pos.coords;
          programmaticMoveRef.current = true;
          map.current.jumpTo({ center: [longitude, latitude], zoom: Math.max(initialZoom, 14) });
          saveMapPrefs({ center: [longitude, latitude], zoom: map.current.getZoom() });
          setGeoNote('');
          setTimeout(() => { programmaticMoveRef.current = false; }, 400);
        },
        () => {
          setGeoNote('Using saved or default map center (location permission denied or unavailable).');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    } else {
      setGeoNote('Geolocation not supported by this browser.');
    }
  }, [persistView]);

  const isConnected = connectionState === 'CONNECTED' || connectionState === 'ACTIVE';

  useEffect(() => {
    if (!map.current || !marker.current) return;

    const el = marker.current.getElement();

    // Telemetry invalid / no GPS lock → hide the marker, stop interpolation, clear trail head.
    // We never place the drone at fallback / saved / browser coords — Mission Planner only renders
    // the vehicle once GLOBAL_POSITION_INT has been received with a real fix.
    if (!positionValid) {
      if (el && el.style.display !== 'none') {
        el.style.display = 'none';
        el.title = 'Vehicle (waiting for GPS lock)';
      }
      const a = markerAnimRef.current;
      a.lng = null; a.lat = null; a.targetLng = null; a.targetLat = null;
      if (a.raf) { cancelAnimationFrame(a.raf); a.raf = 0; }
      return;
    }

    // First real fix this session → expose the marker, jump map to the actual vehicle location
    // (overriding any saved/cached/browser center), and seed the interpolator.
    if (el && el.style.display === 'none') {
      el.style.display = 'flex';
      el.title = 'Vehicle';
    }
    if (!firstFixCenteredRef.current && map.current.isStyleLoaded()) {
      firstFixCenteredRef.current = true;
      programmaticMoveRef.current = true;
      map.current.jumpTo({ center: [lng, lat], zoom: Math.max(map.current.getZoom(), 16) });
      setTimeout(() => { programmaticMoveRef.current = false; }, 200);
    }

    const anim = markerAnimRef.current;
    const now = performance.now();
    if (anim.lng == null || anim.lat == null) {
      anim.lng = lng; anim.lat = lat; anim.hdg = heading || 0;
      marker.current.setLngLat([lng, lat]).setRotation(anim.hdg);
    }
    anim.targetLng = lng;
    anim.targetLat = lat;
    anim.targetHdg = heading || 0;
    anim.lastTargetAt = now;

    // Append to flight trail (decimated) — uses the target sample, not interpolated frames.
    const coords = trailRef.current;
    const prev = coords[coords.length - 1];
    const moved = !prev || Math.abs(prev[0] - lng) > 1e-6 || Math.abs(prev[1] - lat) > 1e-6;
    if (moved) {
      coords.push([lng, lat]);
      if (coords.length > 1500) coords.splice(0, coords.length - 1500);
      const src = map.current.getSource('flight-trail');
      if (src) {
        src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
      }
    }

    const follow = autoFollowVehicle && !userPausedFollowRef.current && isConnected && map.current.isStyleLoaded();
    if (follow) {
      programmaticMoveRef.current = true;
      map.current.easeTo({ center: [lng, lat], duration: 600, essential: true });
      setTimeout(() => { programmaticMoveRef.current = false; }, 700);
    }

    // Start the rAF interpolator if not already running.
    if (!anim.raf) {
      const step = () => {
        const a = markerAnimRef.current;
        if (a.targetLng == null) { a.raf = 0; return; }
        // Time-based easing: cover ~100 ms (one telemetry frame) with critically-damped tween.
        const k = 0.22; // higher = snappier
        a.lng += (a.targetLng - a.lng) * k;
        a.lat += (a.targetLat - a.lat) * k;
        // Shortest-arc heading interp.
        let dh = ((a.targetHdg - a.hdg + 540) % 360) - 180;
        a.hdg = (a.hdg + dh * k + 360) % 360;
        if (marker.current) {
          marker.current.setLngLat([a.lng, a.lat]);
          marker.current.setRotation(a.hdg);
        }
        a.raf = requestAnimationFrame(step);
      };
      anim.raf = requestAnimationFrame(step);
    }
  }, [lat, lng, heading, autoFollowVehicle, isConnected]);

  // Cancel the rAF on unmount.
  useEffect(() => () => {
    const a = markerAnimRef.current;
    if (a.raf) { cancelAnimationFrame(a.raf); a.raf = 0; }
  }, []);

  // On disconnect, re-arm the "center on first fix" flag and clear the trail so the next
  // session starts clean instead of stitching a line from the previous session's last point.
  useEffect(() => {
    if (connectionState === 'DISCONNECTED' || connectionState === 'CONNECTING') {
      firstFixCenteredRef.current = false;
      trailRef.current = [];
      if (map.current?.isStyleLoaded()) {
        const src = map.current.getSource('flight-trail');
        if (src) src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
      }
    }
  }, [connectionState]);

  useEffect(() => {
    if (!map.current) return;
    const h = vehicle?.home;
    const valid = h?.valid && h.lat !== 0 && h.lng !== 0 && Math.abs(h.lat) <= 90 && Math.abs(h.lng) <= 180;

    if (!valid) {
      if (homeMarker.current) {
        homeMarker.current.remove();
        homeMarker.current = null;
      }
      return;
    }

    if (!homeMarker.current) {
      // House-shape SVG, smaller than the vehicle, so the drone is always the prominent marker.
      const el = document.createElement('div');
      el.style.cssText = 'width:22px;height:22px;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0.92;';
      el.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">'
          + '<path d="M3 11 L11 3 L19 11 L19 19 L13 19 L13 14 L9 14 L9 19 L3 19 Z" fill="#16a34a" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>'
          + '<rect x="9.5" y="14" width="3" height="5" fill="#052e16"/>'
        + '</svg>';
      el.title = `Home (${h.lat?.toFixed(6)}, ${h.lng?.toFixed(6)})`;
      homeMarker.current = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([h.lng, h.lat]).addTo(map.current);
    } else {
      homeMarker.current.setLngLat([h.lng, h.lat]);
    }
  }, [vehicle?.home]);

  useEffect(() => {
    if (!map.current) return;
    const seen = new Set();
    const tel = telemetry || {};
    for (const [id, data] of Object.entries(tel)) {
      if (primaryMapKey && id === primaryMapKey) continue;
      const plat = data?.position?.lat;
      const plng = data?.position?.lng;
      if (plat == null || plng == null) continue;
      if (Math.abs(plat) > 90 || Math.abs(plng) > 180) continue;
      if (plat === 0 && plng === 0) continue;
      seen.add(id);
      let mk = otherVehicleMarkersRef.current.get(id);
      if (!mk) {
        const el = document.createElement('div');
        el.style.width = '22px';
        el.style.height = '22px';
        el.style.backgroundImage =
          'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'%23f97316\' stroke=\'%231e293b\' stroke-width=\'1.5\'><path d=\'M12 2L22 20L12 17L2 20L12 2Z\'/></svg>")';
        el.style.backgroundSize = 'contain';
        el.title = `Vehicle SYS${id}`;
        mk = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat([plng, plat]).addTo(map.current);
        otherVehicleMarkersRef.current.set(id, mk);
      } else {
        mk.setLngLat([plng, plat]);
        mk.setRotation(headingDegFromVehicle(data));
      }
    }
    for (const [id, mk] of otherVehicleMarkersRef.current.entries()) {
      if (!seen.has(id)) {
        mk.remove();
        otherVehicleMarkersRef.current.delete(id);
      }
    }
  }, [telemetry, primaryMapKey]);

  useEffect(() => {
    if (!map.current) return;
    const seen = new Set();
    for (const t of adsbTracks || []) {
      const icao = t?.icao;
      const tlat = t?.lat;
      const tlng = t?.lng;
      if (icao == null || tlat == null || tlng == null) continue;
      if (Math.abs(tlat) > 90 || Math.abs(tlng) > 180) continue;
      seen.add(icao);
      let mk = adsbMarkersRef.current.get(icao);
      const title = [t.callsign, `ICAO ${icao}`, t.alt_m != null ? `${Math.round(t.alt_m)}m` : '']
        .filter(Boolean)
        .join(' · ');
      if (!mk) {
        const el = document.createElement('div');
        el.style.width = '12px';
        el.style.height = '12px';
        el.style.backgroundColor = '#fb923c';
        el.style.border = '2px solid #fff';
        el.style.borderRadius = '50%';
        el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.45)';
        el.title = title || `ICAO ${icao}`;
        mk = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
          .setLngLat([tlng, tlat])
          .addTo(map.current);
        adsbMarkersRef.current.set(icao, mk);
      } else {
        mk.setLngLat([tlng, tlat]);
        const el = mk.getElement && mk.getElement();
        if (el) el.title = title || `ICAO ${icao}`;
        const rot = typeof t.heading === 'number' ? t.heading : 0;
        mk.setRotation(rot);
      }
    }
    for (const [icao, mk] of adsbMarkersRef.current.entries()) {
      if (!seen.has(icao)) {
        mk.remove();
        adsbMarkersRef.current.delete(icao);
      }
    }
  }, [adsbTracks]);

  // ─── Fence overlay (Data tab) — multi-polygon with per-type colors ─────────
  useEffect(() => {
    if (!map.current || !mapStyleLoaded) return;
    const src = map.current.getSource('mv-fence-fill');
    if (!src) return;
    const verts = missionType === 'FENCE' ? waypoints : (_fenceSaved || []);
    if (!showFenceOverlay || verts.length === 0) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    // Build polygon groups matching MP Fence.LocationToFence grouping logic
    const groups = [];
    let current = null;
    verts.forEach(wp => {
      const type = Number(wp.command) === FENCE_CMD_EXCLUSION ? 'exclusion' : 'inclusion';
      if (!current || current.type !== type) {
        if (current) groups.push(current);
        current = { type, coords: [] };
      }
      current.coords.push([wp.lng, wp.lat]);
    });
    if (current) groups.push(current);

    const features = groups.flatMap(g => {
      if (g.coords.length < 3) return [];
      return [{ type: 'Feature', properties: { fenceType: g.type },
        geometry: { type: 'Polygon', coordinates: [[...g.coords, g.coords[0]]] } }];
    });
    src.setData({ type: 'FeatureCollection', features });
  }, [waypoints, missionType, _fenceSaved, showFenceOverlay, mapStyleLoaded]);

  // ─── Mission route overlay (Data tab) — always shows from saved buffer ──────
  useEffect(() => {
    if (!map.current || !mapStyleLoaded) return;
    const src = map.current.getSource('mv-mission-route');
    if (!src) return;
    // Show mission route regardless of active tab — use active waypoints when in MISSION mode,
    // otherwise use the saved mission buffer (so switching to FENCE tab doesn't hide route)
    const missionVerts = missionType === 'MISSION' ? waypoints : (_missionSaved || []);
    const coords = missionVerts.filter(wp => wp.lat && wp.lng && !(wp.lat === 0 && wp.lng === 0)).map(wp => [wp.lng, wp.lat]);
    src.setData({
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: showMissionRoute && coords.length > 1 ? coords : [] }
    });
  }, [waypoints, missionType, _missionSaved, showMissionRoute, mapStyleLoaded]);

  // ─── Rally point markers (Data tab) ──────────────────────────────────────
  useEffect(() => {
    if (!map.current || !mapStyleLoaded) return;
    rallyMarkersRef.current.forEach(m => m.remove());
    rallyMarkersRef.current = [];
    if (!showRallyOverlay) return;
    const verts = missionType === 'RALLY' ? waypoints : (_rallySaved || []);
    verts.forEach((wp, i) => {
      if (!wp.lat || !wp.lng) return;
      const el = document.createElement('div');
      el.className = 'mv-rally-marker';
      el.title = `Rally ${i + 1}`;
      const mk = new maplibregl.Marker({ element: el }).setLngLat([wp.lng, wp.lat]).addTo(map.current);
      rallyMarkersRef.current.push(mk);
    });
  }, [waypoints, missionType, _rallySaved, showRallyOverlay, mapStyleLoaded]);

  // ─── Mission waypoint markers with active-waypoint highlighting ──────────
  useEffect(() => {
    if (!map.current || !mapStyleLoaded) return;
    waypointMarkersRef.current.forEach(m => m.remove());
    waypointMarkersRef.current = [];
    if (!showMissionRoute) return;

    const missionVerts = missionType === 'MISSION' ? waypoints : (_missionSaved || []);
    const activeSeq = Number(vehicle?.mission?.current_seq ?? -1);

    missionVerts.forEach((wp) => {
      if (!wp.lat || !wp.lng || (wp.lat === 0 && wp.lng === 0)) return;
      const isActive = wp.seq === activeSeq && activeSeq >= 0;
      const cmd = Number(wp.command);
      const isTakeoff = cmd === 22;
      const isLand = cmd === 21;
      const isRtl = cmd === 20;
      const bgColor = isActive ? '#22c55e' : isTakeoff ? '#f59e0b' : isLand || isRtl ? '#ef4444' : '#3b82f6';
      const size = isActive ? 26 : 18;

      const el = document.createElement('div');
      el.style.cssText = [
        `width:${size}px`, `height:${size}px`, `border-radius:50%`,
        `background:${bgColor}`, `border:2px solid ${isActive ? '#fff' : 'rgba(255,255,255,0.7)'}`,
        `display:flex`, `align-items:center`, `justify-content:center`,
        `font-size:${isActive ? 10 : 9}px`, `font-weight:bold`, `color:#fff`,
        `box-shadow:${isActive ? `0 0 0 4px rgba(34,197,94,0.35)` : '0 1px 4px rgba(0,0,0,0.5)'}`,
        `transition:all 0.25s ease`, `cursor:default`,
      ].join(';');
      el.textContent = wp.seq;
      el.title = `WP${wp.seq} cmd=${cmd} alt=${wp.alt}m${isActive ? ' ◀ ACTIVE' : ''}`;

      const mk = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([wp.lng, wp.lat])
        .addTo(map.current);
      waypointMarkersRef.current.push(mk);
    });
  }, [waypoints, missionType, _missionSaved, vehicle?.mission?.current_seq, showMissionRoute, mapStyleLoaded]);

  const runMapApi = async (label, fn) => {
    setMapBanner('');
    try {
      const res = await fn();
      if (res?.accepted === false) {
        setMapBanner(`${label}: ${res.mav_result_text || 'rejected'}${res.reason ? ` (${res.reason})` : ''}`);
      } else if (res?.status === 'failed') {
        setMapBanner(`${label}: failed`);
      } else {
        setMapBanner(`${label}: OK`);
      }
    } catch (e) {
      const d = e.details || e.response?.data;
      setMapBanner(`${label}: ${typeof d === 'string' ? d : d?.detail || d?.error || e.message || 'error'}`);
    }
    setContextMenu({ visible: false, x: 0, y: 0, latLng: null });
  };

  const ctx = contextMenu.latLng;

  const menuStyle = {
    padding: '8px 16px',
    cursor: 'pointer',
    color: '#f8fafc',
    fontSize: '13px',
    borderBottom: '1px solid #334155',
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mapContainer} className="map-container" />

      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          zIndex: 50,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          maxWidth: 220,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button
            type="button"
            className="btn-toolbar"
            style={{ fontSize: 11, padding: '4px 8px' }}
            onClick={goToMyLocation}
            title="Center on browser location"
          >
            My location
          </button>
          <button
            type="button"
            className="btn-toolbar"
            style={{ fontSize: 11, padding: '4px 8px' }}
            onClick={() => {
              if (!map.current || !positionValid) return;
              programmaticMoveRef.current = true;
              map.current.easeTo({ center: [lng, lat], zoom: Math.max(map.current.getZoom(), 15), duration: 800 });
              setTimeout(() => {
                programmaticMoveRef.current = false;
              }, 900);
            }}
            disabled={!positionValid}
            title={positionValid ? 'Center on primary vehicle' : 'No GPS fix yet'}
          >
            Go to vehicle
          </button>
        </div>
        <label
          style={{
            fontSize: 11,
            color: '#e2e8f0',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={autoFollowVehicle}
            onChange={(e) => {
              const v = e.target.checked;
              setAutoFollowVehicle(v);
              saveMapPrefs({ autoFollowVehicle: v });
              if (v) userPausedFollowRef.current = false;
            }}
          />
          Auto-follow vehicle
        </label>
        {(!autoFollowVehicle || userPausedFollowRef.current) && (
          <button
            type="button"
            className="btn-toolbar primary"
            style={{ fontSize: 11, padding: '4px 8px' }}
            onClick={resumeFollowVehicle}
          >
            Resume follow
          </button>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
          {[
            ['Fence', showFenceOverlay, setShowFenceOverlay],
            ['Mission', showMissionRoute, setShowMissionRoute],
            ['Rally', showRallyOverlay, setShowRallyOverlay],
          ].map(([label, checked, setter]) => (
            <label key={label} style={{ fontSize: 10, color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={checked} onChange={e => setter(e.target.checked)} />
              {label}
            </label>
          ))}
        </div>
        {geoNote && <div style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.3 }}>{geoNote}</div>}
        {mapBanner && <div style={{ fontSize: 11, color: '#fcd34d', lineHeight: 1.3 }}>{mapBanner}</div>}
      </div>

      {contextMenu.visible && ctx && (
        <div
          className="context-menu"
          style={{
            position: 'absolute',
            top: contextMenu.y,
            left: contextMenu.x,
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '6px',
            padding: '4px 0',
            zIndex: 100,
            boxShadow: '0 8px 24px rgba(0,0,0,0.55)',
            minWidth: 200,
          }}
        >
          {missionType === 'MISSION' && (
            <>
              <div
                style={menuStyle}
                onClick={() => {
                  addMissionWaypoint(ctx.lat, ctx.lng, 50);
                  setMapBanner('Waypoint added to planner mission (switch to Flight Planner to edit).');
                  setContextMenu({ visible: false, x: 0, y: 0, latLng: null });
                }}
              >
                Add waypoint (planner)
              </div>
              <div
                style={menuStyle}
                onClick={() => {
                  const idx = selectedSeq == null ? 0 : selectedSeq + 1;
                  insertWaypointAt(idx, { lat: ctx.lat, lng: ctx.lng, alt: 50, command: 16 });
                  setMapBanner(`Waypoint inserted at row ${idx + 1}.`);
                  setContextMenu({ visible: false, x: 0, y: 0, latLng: null });
                }}
              >
                Insert waypoint
              </div>
            </>
          )}
          <div
            style={menuStyle}
            onClick={() =>
              runMapApi('Guided target', () =>
                axios.post(`${API_URL}/api/flyto`, { lat: ctx.lat, lng: ctx.lng, alt: 50 }).then((r) => r.data)
              )
            }
          >
            Set guided target (fly to)
          </div>
          <div
            style={menuStyle}
            onClick={() =>
              runMapApi('Set home', () =>
                axios.post(`${API_URL}/api/vehicle/set_home`, { lat: ctx.lat, lng: ctx.lng, alt: 0 }).then((r) => r.data)
              )
            }
          >
            Set home here
          </div>
          <div
            style={menuStyle}
            onClick={() => runMapApi('RTL', () => sendShortcutCommand('rtl'))}
          >
            RTL (command)
          </div>
          {(missionType === 'FENCE' || missionType === 'MISSION') && (
            <div
              style={menuStyle}
              onClick={() =>
                runMapApi('Fence vertex', async () => {
                  useMissionStore.getState().setMissionType('FENCE');
                  useMissionStore.getState().addWaypoint(ctx.lat, ctx.lng, 0);
                  return { status: 'ok' };
                })
              }
            >
              Add fence point
            </div>
          )}
          {(missionType === 'RALLY' || missionType === 'MISSION') && (
            <div
              style={menuStyle}
              onClick={() => {
                useMissionStore.getState().setMissionType('RALLY');
                useMissionStore.getState().addWaypoint(ctx.lat, ctx.lng, 50);
                setMapBanner('Rally point added.');
                setContextMenu({ visible: false, x: 0, y: 0, latLng: null });
              }}
            >
              Add rally point
            </div>
          )}
          <div
            style={menuStyle}
            onClick={() =>
              runMapApi('ROI', () =>
                axios.post(`${API_URL}/api/vehicle/roi`, { lat: ctx.lat, lng: ctx.lng, alt: 50 }).then((r) => r.data)
              )
            }
          >
            Set ROI here
          </div>
          <div
            style={menuStyle}
            onClick={() =>
              runMapApi('Clear ROI', () => axios.post(`${API_URL}/api/vehicle/roi/clear`).then((r) => r.data))
            }
          >
            Clear ROI
          </div>
          <div
            style={menuStyle}
            onClick={() => {
              navigate('/planner', { state: { openSurvey: true, centerLat: ctx.lat, centerLng: ctx.lng } });
              setContextMenu({ visible: false, x: 0, y: 0, latLng: null });
              setMapBanner('Opening Flight Planner — survey grid…');
            }}
          >
            Survey grid…
          </div>
          <div
            style={{ ...menuStyle, borderBottom: 'none', color: '#f87171' }}
            onClick={() => {
              if (selectedSeq == null) {
                setMapBanner('Select a waypoint in Flight Planner, then use delete there.');
                setContextMenu({ visible: false, x: 0, y: 0, latLng: null });
                return;
              }
              removeWaypoint(selectedSeq);
              setMapBanner('Removed selected waypoint from planner.');
              setContextMenu({ visible: false, x: 0, y: 0, latLng: null });
            }}
          >
            Delete selected waypoint
          </div>
          <div
            style={{ ...menuStyle, borderBottom: 'none' }}
            onClick={() => setContextMenu({ visible: false, x: 0, y: 0, latLng: null })}
          >
            Cancel
          </div>
        </div>
      )}
    </div>
  );
};

export default MapView;
