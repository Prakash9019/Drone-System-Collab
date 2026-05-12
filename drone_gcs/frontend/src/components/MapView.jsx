import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import useTelemetryStore, { selectPrimaryVehicle } from '../store/useTelemetryStore';
import useMissionStore from '../store/useMissionStore';
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

const MapView = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);
  const homeMarker = useRef(null);
  const trailRef = useRef([]);
  const otherVehicleMarkersRef = useRef(new Map());
  const adsbMarkersRef = useRef(new Map());
  const userPausedFollowRef = useRef(false);
  const programmaticMoveRef = useRef(false);

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

  const primaryMapKey = useMemo(() => {
    if (primarySysId != null && primarySysId !== '') return String(primarySysId);
    if (vehicle?.sysid != null) return String(vehicle.sysid);
    return null;
  }, [primarySysId, vehicle?.sysid]);

  const lat = vehicle?.position?.lat || 0;
  const lng = vehicle?.position?.lng || 0;
  const heading = useMemo(() => headingDegFromVehicle(vehicle), [vehicle]);

  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, latLng: null });
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
    el.style.width = '30px';
    el.style.height = '30px';
    el.style.backgroundImage =
      'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'%233b82f6\' stroke=\'white\' stroke-width=\'2\'><path d=\'M12 2L22 20L12 17L2 20L12 2Z\'/></svg>")';
    el.style.backgroundSize = 'contain';

    marker.current = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
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

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          programmaticMoveRef.current = true;
          map.current.jumpTo({ center: [longitude, latitude], zoom: Math.max(initialZoom, 14) });
          saveMapPrefs({ center: [longitude, latitude], zoom: map.current.getZoom() });
          setGeoNote('');
          setTimeout(() => {
            programmaticMoveRef.current = false;
          }, 400);
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

    if (lat !== 0 && lng !== 0) {
      marker.current.setLngLat([lng, lat]);
      marker.current.setRotation(heading || 0);
      const coords = trailRef.current;
      const prev = coords[coords.length - 1];
      const moved = !prev || Math.abs(prev[0] - lng) > 1e-6 || Math.abs(prev[1] - lat) > 1e-6;
      if (moved) {
        coords.push([lng, lat]);
        if (coords.length > 1500) coords.splice(0, coords.length - 1500);
      }
      const src = map.current.getSource('flight-trail');
      if (src) {
        src.setData({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: coords },
        });
      }

      const follow =
        autoFollowVehicle &&
        !userPausedFollowRef.current &&
        isConnected &&
        map.current.isStyleLoaded();
      if (follow) {
        programmaticMoveRef.current = true;
        map.current.easeTo({ center: [lng, lat], duration: 600, essential: true });
        setTimeout(() => {
          programmaticMoveRef.current = false;
        }, 700);
      }
    }
  }, [lat, lng, heading, autoFollowVehicle, isConnected]);

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
      const el = document.createElement('div');
      el.style.width = '20px';
      el.style.height = '20px';
      el.style.borderRadius = '50%';
      el.style.backgroundColor = '#22c55e';
      el.style.border = '2px solid #fff';
      el.style.boxShadow = '0 1px 4px rgba(0,0,0,0.5)';
      el.title = `Home (${h.lat?.toFixed(6)}, ${h.lng?.toFixed(6)})`;
      homeMarker.current = new maplibregl.Marker({ element: el }).setLngLat([h.lng, h.lat]).addTo(map.current);
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
              if (!map.current || lat === 0 || lng === 0) return;
              programmaticMoveRef.current = true;
              map.current.easeTo({ center: [lng, lat], zoom: Math.max(map.current.getZoom(), 15), duration: 800 });
              setTimeout(() => {
                programmaticMoveRef.current = false;
              }, 900);
            }}
            disabled={lat === 0 || lng === 0}
            title="Center on primary vehicle"
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
