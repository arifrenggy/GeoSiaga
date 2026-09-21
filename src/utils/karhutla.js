import { calculateDistance } from './geo.js';

/**
 * Kategori Tingkat Kemudahan Terjadinya Kebakaran (FDRS - BMKG Standard)
 */
export const FDRS_LEVELS = {
  LOW: {
    code: 'AMAN',
    label: 'Aman / Rendah',
    desc: 'Kondisi tanah & vegetasi basah/lembab. Sangat kecil kemungkinan terjadi kebakaran hutan & lahan.',
    color: '#10b981',
    bg: '#ecfdf5'
  },
  MODERATE: {
    code: 'SEDANG',
    label: 'Sedang / Waspada',
    desc: 'Serasah dan alang-alang mulai mengering. Potensi kebakaran sedang jika ada pemicu api luar ruangan.',
    color: '#eab308',
    bg: '#fefce8'
  },
  HIGH: {
    code: 'TINGGI',
    label: 'Tinggi / Rawan',
    desc: 'Daun kering & semak belukar sangat mudah tersulut api. Api cepat membesar & sulit dipadamkan.',
    color: '#f97316',
    bg: '#fff7ed'
  },
  EXTREME: {
    code: 'EKSTREM',
    label: 'Sangat Rawan / Ekstrem',
    desc: 'Lahan gambut & hutan sangat kering. Bahaya karhutla ekstrem, potensi kabut asap tebal meluas.',
    color: '#ef4444',
    bg: '#fef2f2'
  }
};

/**
 * Estimasi tingkat kerawanan kebakaran lahan dari parameter cuaca LOKAL real-time
 * (suhu, kelembapan, angin, curah hujan — data Open-Meteo).
 *
 * CATATAN JUJUR: ini adalah ESTIMASI berbasis skor, bukan indeks FDRS resmi BMKG
 * (data FDRS BMKG tidak tersedia secara publik per-kota). Akurasi indikatif.
 */
export function calculateFdrs(weatherData) {
  if (!weatherData?.current) return FDRS_LEVELS.LOW;

  const current = weatherData.current;
  const temp = Number(current.temp ?? current.temperature ?? current.temperature_2m ?? 30);
  const humidity = Number(current.humidity ?? current.relative_humidity_2m ?? 75);
  const windSpeed = Number(current.windSpeed ?? current.wind_speed_10m ?? 10);
  const precip = Number(current.precipitation ?? current.precip ?? 0);

  let score = 0;

  if (temp >= 35) score += 40;
  else if (temp >= 32) score += 30;
  else if (temp >= 29) score += 15;
  else score += 5;

  if (humidity <= 45) score += 40;
  else if (humidity <= 60) score += 25;
  else if (humidity <= 75) score += 10;
  else score += 0;

  if (windSpeed >= 20) score += 20;
  else if (windSpeed >= 12) score += 10;
  else score += 5;

  if (precip > 5) score -= 45;
  else if (precip > 1) score -= 25;

  let level = FDRS_LEVELS.LOW;
  if (score >= 70) level = FDRS_LEVELS.EXTREME;
  else if (score >= 50) level = FDRS_LEVELS.HIGH;
  else if (score >= 30) level = FDRS_LEVELS.MODERATE;

  return level;
}

/**
 * Format label koordinat hotspot satelit: "1.48°N, 101.99°E"
 */
export function formatHotspotLabel(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) return 'Lokasi tidak diketahui';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lon).toFixed(2)}°${ew}`;
}

/**
 * Hitung jarak hotspot SATELIT REAL-TIME (NASA FIRMS) ke koordinat pengguna.
 * Data hotspot datang dari /api/hotspots — TIDAK ADA LAGI DATA PALSU HARDCODE.
 * Jika data tidak tersedia, hasilnya available: false dan UI menampilkan status jujur.
 */
export function getNearbyHotspots(hotspots, userLat, userLon, maxRadiusKm = 400) {
  const list = Array.isArray(hotspots) ? hotspots : [];

  if (!userLat || !userLon || list.length === 0) {
    return { nearest: null, nearbyList: [], allHotspots: [], totalInIndo: 0 };
  }

  const withDist = list
    .map((h) => ({
      ...h,
      locationLabel: formatHotspotLabel(h.lat, h.lon),
      distanceKm: Math.round(calculateDistance(userLat, userLon, h.lat, h.lon) * 10) / 10
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const nearest = withDist[0] || null;
  const nearbyList = withDist.filter((h) => h.distanceKm <= maxRadiusKm);

  return {
    nearest,
    nearbyList,
    allHotspots: withDist,
    totalInIndo: list.length
  };
}

/**
 * Evaluasi Status Kabut Asap Terkini (Cross-Correlation Titik Panas & Kualitas Udara)
 */
export function getHazeStatus(nearestHotspot, aqi = 0, pm25 = 0) {
  const isVeryNear = Boolean(nearestHotspot && nearestHotspot.distanceKm <= 50);
  const isNearby = Boolean(nearestHotspot && nearestHotspot.distanceKm <= 150);
  const isElevatedAir = Number(aqi) >= 60 || Number(pm25) >= 20;
  const isHazeActive = Boolean(isVeryNear || (isNearby && isElevatedAir));

  return {
    isHazeActive,
    isVeryNear,
    isNearby,
    isElevatedAir
  };
}
