'use client';

/**
 * EarthquakeMap.js
 * Leaflet-powered interactive earthquake map.
 * Dynamically imported (no SSR) to avoid window/document errors.
 */

import { useEffect, useRef } from 'react';

const MAG_COLOR = (m) => {
  if (m >= 8)   return '#fca5a5';
  if (m >= 7)   return '#f87171';
  if (m >= 6)   return '#ef4444';
  if (m >= 5)   return '#f97316';
  if (m >= 4)   return '#eab308';
  if (m >= 2.5) return '#84cc16';
  return '#22c55e';
};

// Radius scales with magnitude (exponential feel)
const MAG_RADIUS = (m) => Math.max(4, Math.pow(1.8, m) * 0.5);

export default function EarthquakeMap({ earthquakes = [], onSelect, selected }) {
  const mapRef       = useRef(null);
  const leafletRef   = useRef(null);
  const markersRef   = useRef([]);
  const containerRef = useRef(null);

  // Initialize map
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (mapRef.current) return; // already initialized

    import('leaflet').then((L) => {
      leafletRef.current = L;

      // Fix default icon path issue in Next.js
      delete L.Icon.Default.prototype._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      });

      const map = L.map(containerRef.current, {
        center:          [20, 0],
        zoom:            2,
        minZoom:         2,
        maxZoom:         18,
        zoomControl:     true,
        attributionControl: true,
      });

      // Dark tile layer
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> | CartoDB',
        subdomains:  'abcd',
        maxZoom:     20,
      }).addTo(map);

      mapRef.current = map;

      // Cleanup on unmount
      return () => {
        map.remove();
        mapRef.current = null;
      };
    });
  }, []);

  // Update markers when earthquakes change
  useEffect(() => {
    const L   = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;

    // Remove old markers
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    earthquakes.forEach(eq => {
      const [lng, lat] = eq.location?.coordinates || [];
      if (!lat || !lng) return;

      const color  = MAG_COLOR(eq.magnitude);
      const radius = MAG_RADIUS(eq.magnitude || 2);
      const isSelected = selected?.eventId === eq.eventId;

      const circle = L.circleMarker([lat, lng], {
        radius:      isSelected ? radius * 1.6 : radius,
        fillColor:   color,
        color:       isSelected ? '#fff' : color,
        weight:      isSelected ? 2 : 1,
        opacity:     1,
        fillOpacity: isSelected ? 0.9 : 0.65,
      });

      const timeStr = new Date(eq.time).toLocaleString();
      circle.bindPopup(`
        <div style="font-family:'Space Mono',monospace;background:#0d0f1a;color:#e2e5f5;padding:12px;border-radius:8px;min-width:200px;border:1px solid ${color}33;">
          <div style="font-size:20px;font-weight:800;color:${color};margin-bottom:4px;">M${eq.magnitude?.toFixed(1)}</div>
          <div style="font-size:12px;margin-bottom:8px;color:#8b90b8;">${eq.place || 'Unknown'}</div>
          <div style="font-size:11px;color:#4a5082;">🕐 ${timeStr}</div>
          <div style="font-size:11px;color:#4a5082;">🌊 Depth: ${eq.depth ?? '—'} km</div>
          <div style="font-size:11px;color:#4a5082;">⚠️ Risk: ${eq.riskScore}/100</div>
          ${eq.tsunami ? '<div style="color:#ef4444;font-size:11px;margin-top:4px;">🌊 TSUNAMI WARNING</div>' : ''}
        </div>
      `, {
        className:    'dark-popup',
        maxWidth:     260,
      });

      circle.on('click', () => onSelect?.(eq));
      circle.addTo(map);
      markersRef.current.push(circle);
    });
  }, [earthquakes, selected]);

  return (
    <>
      <style>{`
        .dark-popup .leaflet-popup-content-wrapper {
          background: transparent !important;
          box-shadow: 0 8px 32px rgba(0,0,0,0.8) !important;
          border-radius: 10px !important;
          padding: 0 !important;
        }
        .dark-popup .leaflet-popup-tip { background: #0d0f1a !important; }
        .dark-popup .leaflet-popup-content { margin: 0 !important; }
        .leaflet-control-zoom a {
          background: #13162b !important;
          color: #8b90b8 !important;
          border-color: #252840 !important;
        }
        .leaflet-control-zoom a:hover {
          background: #1a1d35 !important;
          color: #e2e5f5 !important;
        }
        .leaflet-control-attribution {
          background: rgba(7,8,16,0.8) !important;
          color: #4a5082 !important;
          font-size: 9px !important;
        }
        .leaflet-control-attribution a { color: #4a5082 !important; }
      `}</style>
      <div ref={containerRef} style={{ width: '100%', height: '100%', minHeight: 400 }} />
    </>
  );
}