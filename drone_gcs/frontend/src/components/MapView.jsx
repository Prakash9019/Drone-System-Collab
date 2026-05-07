import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import axios from 'axios';
import useTelemetryStore from '../store/useTelemetryStore';

const MapView = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);
  
  const telemetry = useTelemetryStore((state) => state.telemetry);
  const vehicle = telemetry['1'];
  
  const lat = vehicle?.position?.lat || 0;
  const lng = vehicle?.position?.lng || 0;
  const heading = vehicle?.velocity?.heading || 0;

  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, latLng: null });

  useEffect(() => {
    if (map.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [-122.4194, 37.7749],
      zoom: 16,
      pitch: 45,
      attributionControl: false
    });

    const el = document.createElement('div');
    el.style.width = '30px';
    el.style.height = '30px';
    el.style.backgroundImage = 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'%233b82f6\' stroke=\'white\' stroke-width=\'2\'><path d=\'M12 2L22 20L12 17L2 20L12 2Z\'/></svg>")';
    el.style.backgroundSize = 'contain';
    
    marker.current = new maplibregl.Marker(el)
      .setLngLat([-122.4194, 37.7749])
      .addTo(map.current);
      
    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');

    // Context menu logic
    map.current.on('contextmenu', (e) => {
      e.originalEvent.preventDefault();
      setContextMenu({
        visible: true,
        x: e.point.x,
        y: e.point.y,
        latLng: e.lngLat
      });
    });

    map.current.on('click', () => {
      setContextMenu(prev => ({ ...prev, visible: false }));
    });

  }, []);

  useEffect(() => {
    if (!map.current || !marker.current) return;
    
    if (lat !== 0 && lng !== 0) {
      marker.current.setLngLat([lng, lat]);
      marker.current.setRotation(heading || 0);
      
      if (!map.current.isUserInteracting && map.current.isStyleLoaded()) {
        map.current.flyTo({ center: [lng, lat], speed: 0.2 });
      }
    }
  }, [lat, lng, heading]);

  const handleFlyToHere = async () => {
    if (!contextMenu.latLng) return;
    try {
      // Mission Planner sends MAV_CMD_DO_SET_MODE (Guided) then SET_POSITION_TARGET_GLOBAL_INT
      // But for phase 1, we can create a new route in node backend /api/flyto
      await axios.post('http://localhost:8080/api/flyto', {
        lat: contextMenu.latLng.lat,
        lng: contextMenu.latLng.lng,
        alt: 50 // Default 50m relative alt for Fly To
      });
      setContextMenu({ visible: false, x: 0, y: 0, latLng: null });
    } catch (e) {
      console.error("Fly To Here failed", e);
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mapContainer} className="map-container" />
      
      {contextMenu.visible && (
        <div 
          className="context-menu" 
          style={{
            position: 'absolute', 
            top: contextMenu.y, 
            left: contextMenu.x,
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '5px 0',
            zIndex: 100,
            boxShadow: '0 4px 6px rgba(0,0,0,0.5)'
          }}
        >
          <div 
            onClick={handleFlyToHere}
            style={{ padding: '8px 16px', cursor: 'pointer', color: '#f8fafc', fontSize: '14px' }}
            onMouseOver={(e) => e.currentTarget.style.background = '#3b82f6'}
            onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Fly To Here
          </div>
          <div 
            onClick={() => setContextMenu(prev => ({...prev, visible: false}))}
            style={{ padding: '8px 16px', cursor: 'pointer', color: '#f8fafc', fontSize: '14px' }}
            onMouseOver={(e) => e.currentTarget.style.background = '#334155'}
            onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Cancel
          </div>
        </div>
      )}
    </div>
  );
};

export default MapView;
