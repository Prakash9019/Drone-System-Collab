import React, { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const MapView = ({ lat, lng, heading }) => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);

  useEffect(() => {
    if (map.current) return; // initialize map only once

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [lng || -122.4194, lat || 37.7749],
      zoom: 16,
      pitch: 45,
      attributionControl: false
    });

    // Create a custom drone marker icon using a simple div for now
    const el = document.createElement('div');
    el.style.width = '30px';
    el.style.height = '30px';
    el.style.backgroundImage = 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'%233b82f6\' stroke=\'white\' stroke-width=\'2\'><path d=\'M12 2L22 20L12 17L2 20L12 2Z\'/></svg>")';
    el.style.backgroundSize = 'contain';
    
    marker.current = new maplibregl.Marker(el)
      .setLngLat([lng || -122.4194, lat || 37.7749])
      .addTo(map.current);
      
    // Navigation controls
    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');

  }, [lat, lng]);

  // Update marker when props change
  useEffect(() => {
    if (!map.current || !marker.current) return;
    
    if (lat !== 0 && lng !== 0) {
      marker.current.setLngLat([lng, lat]);
      marker.current.setRotation(heading || 0);
      
      // Auto-pan if map is initialized
      if (map.current.isStyleLoaded()) {
        map.current.flyTo({ center: [lng, lat], speed: 0.5 });
      }
    }
  }, [lat, lng, heading]);

  return <div ref={mapContainer} className="map-container" />;
};

export default MapView;
