export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation tidak didukung oleh peramban ini.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        });
      },
      (err) => {
        reject(err);
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  });
}

export function calculateDistance(lat1, lon1, lat2, lon2) {
  const nLat1 = Number(lat1);
  const nLon1 = Number(lon1);
  const nLat2 = Number(lat2);
  const nLon2 = Number(lon2);

  if (isNaN(nLat1) || isNaN(nLon1) || isNaN(nLat2) || isNaN(nLon2)) return 0;

  const R = 6371; // Radius bumi dalam KM
  const dLat = ((nLat2 - nLat1) * Math.PI) / 180;
  const dLon = ((nLon2 - nLon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((nLat1 * Math.PI) / 180) *
      Math.cos((nLat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

export const INDONESIA_BOUNDS = {
  center: [-2.5489, 118.0149],
  zoom: 5
};

/**
 * Nama tempat dari koordinat (reverse geocoding) via OpenStreetMap Nominatim.
 * Mendukung kampung/desa yang tidak ada di daftar kota — dipakai saat GPS aktif.
 * Gratis; panggilan dibatasi per ketentuan pemakaian Nominatim (low volume OK).
 * @returns {Promise<{name: string, detail: string}|null>}
 */
export async function reverseGeocode(lat, lon) {
  try {
    const url =
      'https://nominatim.openstreetmap.org/reverse?format=jsonv2' +
      '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon) +
      '&zoom=13&accept-language=id';
    const res = await fetch(url, {
      signal: typeof AbortSignal !== 'undefined' ? AbortSignal.timeout(5000) : undefined
    });
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data?.address || {};
    const village =
      addr.village || addr.town || addr.city || addr.hamlet ||
      addr.suburb || addr.municipality || data?.name || null;
    if (!village) return null;
    const detail = [addr.village || addr.town || addr.city, addr.municipality, addr.region || addr.state]
      .filter(Boolean).filter((x, i, a) => a.indexOf(x) === i)
      .join(', ');
    return { name: village, detail: detail || data?.display_name || village };
  } catch {
    return null; // jaringan buruk / timeout: pemanggil pakai fallback
  }
}
