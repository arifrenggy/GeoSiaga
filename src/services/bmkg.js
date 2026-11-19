import { apiCache } from '../utils/apiCache.js';

export async function fetchLatestEarthquake(forceRefresh = false) {
  const cacheKey = 'bmkg_autogempa';

  if (!forceRefresh) {
    const cached = apiCache.get(cacheKey);
    if (cached) return cached;
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 5000) : null;

  try {
    const res = await fetch('https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json', {
      headers: { 'Accept': 'application/json' },
      signal: controller ? controller.signal : undefined
    });
    if (!res.ok) throw new Error(`BMKG Error: ${res.status}`);
    const data = await res.json();
    const gempa = data?.Infogempa?.gempa;
    // JUJUR: tanpa data gempa valid, kembalikan cache lama atau null (bukan gempa palsu)
    if (!gempa) return apiCache.get(cacheKey) || null;

    const [latStr, lonStr] = gempa.Coordinates ? gempa.Coordinates.split(',') : [0, 0];
    const formatted = {
      date: gempa.Tanggal || '',
      time: gempa.Jam || '',
      dateTime: `${gempa.Tanggal || ''} ${gempa.Jam || ''}`.trim(),
      lat: parseFloat(latStr) || 0,
      lon: parseFloat(lonStr) || 0,
      magnitude: parseFloat(gempa.Magnitude) || 0,
      depth: gempa.Kedalaman || '-',
      wilayah: gempa.Wilayah || 'Wilayah Indonesia',
      potensi: gempa.Potensi || 'Tidak berpotensi tsunami',
      dirasakan: gempa.Dirasakan || '-',
      shakemap: gempa.Shakemap ? `https://data.bmkg.go.id/DataMKG/TEWS/${gempa.Shakemap}` : null
    };

    apiCache.set(cacheKey, formatted, 60 * 1000);
    return formatted;
  } catch (error) {
    console.warn('Gagal memuat gempa terkini BMKG:', error.message);
    return apiCache.get(cacheKey) || null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function fetchRecentEarthquakes(forceRefresh = false) {
  const cacheKey = 'bmkg_gempaterkini';

  if (!forceRefresh) {
    const cached = apiCache.get(cacheKey);
    if (cached) return cached;
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 5000) : null;

  try {
    const res = await fetch('https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json', {
      headers: { 'Accept': 'application/json' },
      signal: controller ? controller.signal : undefined
    });
    if (!res.ok) throw new Error(`BMKG Error: ${res.status}`);
    const data = await res.json();
    const list = data?.Infogempa?.gempa || [];
    
    const formatted = list.map((g, idx) => {
      const [latStr, lonStr] = g.Coordinates ? g.Coordinates.split(',') : [0, 0];
      return {
        id: `quake-${idx}-${g.Tanggal}-${g.Jam}`,
        date: g.Tanggal || '',
        time: g.Jam || '',
        dateTime: `${g.Tanggal || ''} ${g.Jam || ''}`.trim(),
        lat: parseFloat(latStr) || 0,
        lon: parseFloat(lonStr) || 0,
        magnitude: parseFloat(g.Magnitude) || 0,
        depth: g.Kedalaman || '-',
        wilayah: g.Wilayah || 'Indonesia',
        potensi: g.Potensi || 'Tidak berpotensi tsunami'
      };
    });

    apiCache.set(cacheKey, formatted, 60 * 1000);
    return formatted;
  } catch (error) {
    console.warn('Gagal memuat daftar gempa BMKG:', error.message);
    return apiCache.get(cacheKey) || [];
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// --- Katalog lengkap: gabungkan umpan BMKG (gempa dirasakan) dengan USGS ---
// BMKG hanya menerbitkan 15 gempa terakhir yang dirasakan (umumnya M5+), sehingga
// gempa kecil di sekitar Sumba tidak muncul. USGS punya katalog lebih lengkap.

const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function waktuBmkgKeEpoch(tanggal, jam) {
  // "18 Nov 2026" + "11:41:32 WIB" -> epoch (WIB = UTC+7)
  const t = String(tanggal || '').trim().split(/\s+/);
  const j = String(jam || '').trim().split(':');
  if (t.length < 3) return null;
  const bulan = BULAN.indexOf(t[1]);
  if (bulan < 0) return null;
  const hari = Number.parseInt(t[0], 10);
  const tahun = Number.parseInt(t[2], 10);
  const jamN = Number.parseInt(j[0], 10) || 0;
  const menitN = Number.parseInt(j[1], 10) || 0;
  const detikN = Number.parseInt(j[2], 10) || 0;
  if (!hari || !tahun) return null;
  return Date.UTC(tahun, bulan, hari, jamN - 7, menitN, detikN);
}

function epochKeWib(epoch) {
  const d = new Date(epoch + 7 * 3600 * 1000);
  const tanggal = `${d.getUTCDate()} ${BULAN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const jam = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return { tanggal, jam: `${jam} WIB` };
}

function jarakKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function fetchUsgsEarthquakes(forceRefresh = false) {
  const cacheKey = 'usgs_gempa_indonesia';
  if (!forceRefresh) {
    const cached = apiCache.get(cacheKey);
    if (cached) return cached;
  }

  const mulai = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const url =
    'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time' +
    `&starttime=${mulai}` +
    '&minlatitude=-11.5&maxlatitude=6.5&minlongitude=94&maxlongitude=141.5' +
    '&minmagnitude=4.0';

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`USGS Error: ${res.status}`);
    const fitur = (await res.json())?.features || [];
    const daftar = fitur.map((f) => {
      const p = f.properties || {};
      const [lon, lat, kedalaman] = f.geometry?.coordinates || [0, 0, 0];
      const wib = epochKeWib(p.time);
      return {
        id: `usgs-${f.id}`,
        date: wib.tanggal,
        time: wib.jam,
        dateTime: `${wib.tanggal} ${wib.jam}`,
        epoch: p.time,
        lat,
        lon,
        magnitude: Number(p.mag) || 0,
        depth: `${Math.round(Number(kedalaman) || 0)} km`,
        wilayah: p.place || 'Indonesia',
        potensi: 'Tidak berpotensi tsunami',
        sumber: 'USGS'
      };
    });
    apiCache.set(cacheKey, daftar, 5 * 60 * 1000);
    return daftar;
  } catch (error) {
    console.warn('Gagal memuat katalog USGS:', error.message);
    return apiCache.get(cacheKey) || [];
  }
}

export async function fetchAllEarthquakes(forceRefresh = false) {
  const [bmkg, usgs] = await Promise.all([
    fetchRecentEarthquakes(forceRefresh).catch(() => []),
    fetchUsgsEarthquakes(forceRefresh).catch(() => [])
  ]);

  const gabungan = bmkg.map((q) => ({
    ...q,
    epoch: waktuBmkgKeEpoch(q.date, q.time),
    sumber: 'BMKG'
  }));

  // Buang gempa USGS yang sebenarnya sama dengan catatan BMKG (waktu & magnitudo mirip)
  for (const u of usgs) {
    const kembar = gabungan.some((b) => {
      if (!b.epoch || !u.epoch) return false;
      const selisihMenit = Math.abs(b.epoch - u.epoch) / 60000;
      const selisihMag = Math.abs(b.magnitude - u.magnitude);
      return selisihMenit <= 10 && selisihMag <= 0.4 && jarakKm(b.lat, b.lon, u.lat, u.lon) <= 100;
    });
    if (!kembar) gabungan.push(u);
  }

  gabungan.sort((a, b) => (b.epoch || 0) - (a.epoch || 0));
  return gabungan;
}
