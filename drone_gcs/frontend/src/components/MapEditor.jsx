import React, { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import useMissionStore from '../store/useMissionStore';

const MapEditor = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markers = useRef([]);
  const waypoints = useMissionStore((state) => state.waypoints);
  const addWaypoint = useMissionStore((state) => state.addWaypoint);

  useEffect(() => {
    if (map.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [-122.4194, 37.7749],
      zoom: 16,
      attributionControl: false
    });

    map.current.on('load', () => {
      // Add source for the path line
      map.current.addSource('route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: []
          }
        }
      });

      // Add layer to draw the line
      map.current.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': '#10b981',
          'line-width': 4,
          'line-dasharray': [2, 2]
        }
      });
    });

    map.current.on('click', (e) => {
      addWaypoint(e.lngLat.lat, e.lngLat.lng, 50);
    });

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');
  }, [addWaypoint]);

  // Update map when waypoints change
  useEffect(() => {
    if (!map.current) return;

    // Clear old markers
    markers.current.forEach(m => m.remove());
    markers.current = [];

    const coordinates = [];

    waypoints.forEach((wp, index) => {
      coordinates.push([wp.lng, wp.lat]);

      // Create a marker for each waypoint
      const el = document.createElement('div');
      el.className = 'waypoint-marker';
      el.innerHTML = `<span>${index}</span>`;
      el.style.backgroundColor = index === 0 ? '#f59e0b' : '#3b82f6';
      el.style.color = 'white';
      el.style.width = '24px';
      el.style.height = '24px';
      el.style.borderRadius = '50%';
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.fontSize = '12px';
      el.style.fontWeight = 'bold';
      el.style.border = '2px solid white';
      el.style.cursor = 'pointer';

      const marker = new maplibregl.Marker(el)
        .setLngLat([wp.lng, wp.lat])
        .addTo(map.current);
      
      markers.current.push(marker);
    });

    // Update the line path
    if (map.current.getSource('route')) {
      map.current.getSource('route').setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: coordinates
        }
      });
    }

  }, [waypoints]);

  return <div ref={mapContainer} className="map-container" />;
};

export default MapEditor;
