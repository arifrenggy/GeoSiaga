import { apiCache } from '../utils/apiCache.js';
import { calculateFdrs, getNearbyHotspots } from '../utils/karhutla.js';

/**
 * Layanan data Karhutla (Kebakaran Hutan & Lahan)
 *
 * - FDRS: estimasi kerawanan dari cuaca lokal real-time (Open-Meteo)
 * - Hotspot satelit: REAL-TIME dari NASA FIRMS via serverless /api/hotspots
 *   (membutuhkan FIRMS_MAP_KEY di environment Vercel)
 *
 * JUJUR: saat data satelit tidak tersedia (key belum diset / NASA down),
 * hasil available=false — TIDAK MENAMPILKAN DATA PALSU.
 */
export async function fetchKarhutlaData(lat, lon, weatherData, forceRefresh = false) {
  const safeLat = Number(lat) || -6.2088;
  const safeLon = Number(lon) || 106.8456;
  const cacheKey = `karhutla_${safeLat.toFixed(2)}_${safeLon.toFixed(2)}`;

  if (!forceRefresh) {
    const cached = apiCache.get(cacheKey);
    if (cached) return cached;
  }

  // FDRS selalu bisa dihitung dari data cuaca
  const fdrs = calculateFdrs(weatherData);

  let satellite = { available: false, hotspots: [], totalDetected: 0, error: null, lastSync: null };

  try {
    const res = await fetch('/api/hotspots', {
      headers: { 'Accept': 'application/json' },
      signal: typeof AbortSignal !== 'undefined' ? AbortSignal.timeout(10000) : undefined
    });

    if (res.ok) {
      const data = await res.json();
      if (data?.available && Array.isArray(data.hotspots)) {
        satellite = {
          available: true,
          hotspots: data.hotspots,
          totalDetected: data.totalDetected || data.hotspots.length,
          error: null,
          lastSync: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
        };
      } else {
        satellite.error = data?.error || 'Data hotspot satelit tidak tersedia saat ini.';
      }
    } else {
      let msg = `Endpoint hotspot merespons status ${res.status}`;
      try {
        const errBody = await res.json();
        if (errBody?.error) msg = errBody.error;
      } catch { /* ignore */ }
      satellite.error = msg;
    }
  } catch (err) {
    satellite.error = `Gagal mengambil data hotspot satelit: ${err.message}`;
  }

  const hotspotInfo = getNearbyHotspots(satellite.hotspots, safeLat, safeLon);

  const result = {
    available: satellite.available,
    error: satellite.error,
    totalDetected: satellite.totalDetected,
    lastSync: satellite.lastSync,
    fdrs,
    nearest: hotspotInfo.nearest,
    nearbyList: hotspotInfo.nearbyList,
    allHotspots: hotspotInfo.allHotspots,
    totalInIndo: hotspotInfo.totalInIndo
  };

  apiCache.set(cacheKey, result, 5 * 60 * 1000); // 5 menit TTL
  return result;
}
