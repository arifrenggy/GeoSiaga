/**
 * GeoSiaga — basis URL endpoint proxy.
 *
 * Saat aplikasi dihosting statis (tanpa server Node), endpoint proxy
 * /api/* dialihkan ke backend function eksternal melalui VITE_API_BASE.
 * Tanpa VITE_API_BASE, perilaku default tetap relative /api/* (self-hosted Node).
 */
const BASE = import.meta.env.VITE_API_BASE || '';
const MAP = {
  '/api/hotspots': 'geosiagaHotspots',
  '/api/volcanoes': 'geosiagaVolcanoes',
  '/api/badge': 'geosiagaBadge',
};

export function apiEndpoint(path) {
  if (BASE && MAP[path]) return `${BASE}/functions/${MAP[path]}`;
  return path;
}
