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
  const [terkini, dirasakan, usgs, emsc] = await Promise.all([
    fetchRecentEarthquakes(forceRefresh).catch(() => []),
    fetchFeltEarthquakes(forceRefresh).catch(() => []),
    fetchUsgsEarthquakes(forceRefresh).catch(() => []),
    fetchEmscEarthquakes(forceRefresh).catch(() => [])
  ]);

  const gabungan = [];

  // Masukkan berurutan sesuai prioritas; yang sudah terwakili tidak dimasukkan lagi.
  const masukkan = (daftar) => {
    for (const q of daftar) {
      const epoch = q.epoch ?? waktuBmkgKeEpoch(q.date, q.time);
      if (!epoch) continue;
      const kembar = gabungan.some((b) => {
        const selisihMenit = Math.abs(b.epoch - epoch) / 60000;
        const selisihMag = Math.abs(b.magnitude - q.magnitude);
        return selisihMenit <= 10 && selisihMag <= 0.5 && jarakKm(b.lat, b.lon, q.lat, q.lon) <= 120;
      });
      if (!kembar) gabungan.push({ ...q, epoch });
    }
  };

  masukkan(terkini.map((q) => ({ ...q, sumber: 'BMKG' })));
  masukkan(dirasakan);
  masukkan(emsc);
  masukkan(usgs);

  gabungan.sort((a, b) => (b.epoch || 0) - (a.epoch || 0));
  return gabungan;
}

// --- EMSC: katalog gempa kecil (M1+) yang tidak diterbitkan BMKG maupun USGS ---
export async function fetchEmscEarthquakes(forceRefresh = false) {
  const cacheKey = 'emsc_gempa_indonesia';
  if (!forceRefresh) {
    const cached = apiCache.get(cacheKey);
    if (cached) return cached;
  }

  const mulai = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 19);
  const url =
    'https://www.seismicportal.eu/fdsnws/event/1/query?format=json&limit=500' +
    `&start=${mulai}` +
    '&minlatitude=-11.5&maxlatitude=6.5&minlongitude=94&maxlongitude=141.5' +
    '&minmagnitude=1.0';

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`EMSC Error: ${res.status}`);
    const fitur = (await res.json())?.features || [];
    const daftar = fitur.map((f) => {
      const p = f.properties || {};
      const [lon, lat, kedalaman] = f.geometry?.coordinates || [0, 0, 0];
      const epoch = Date.parse(p.time);
      const wib = epochKeWib(epoch);
      return {
        id: `emsc-${p.source_id || p.unid || `${lat}_${lon}_${p.time}`}`,
        date: wib.tanggal,
        time: wib.jam,
        dateTime: `${wib.tanggal} ${wib.jam}`,
        epoch,
        lat,
        lon,
        magnitude: Number(p.mag) || 0,
        depth: `${Math.round(Number(kedalaman) || 0)} km`,
        wilayah: p.flynn_region || 'Indonesia',
        potensi: 'Tidak berpotensi tsunami',
        sumber: 'EMSC'
      };
    });
    apiCache.set(cacheKey, daftar, 5 * 60 * 1000);
    return daftar;
  } catch (error) {
    console.warn('Gagal memuat katalog EMSC:', error.message);
    return apiCache.get(cacheKey) || [];
  }
}

// --- BMKG: gempa yang dirasakan (memuat gempa kecil M2-M4) ---
export async function fetchFeltEarthquakes(forceRefresh = false) {
  const cacheKey = 'bmkg_gempadirasakan';
  if (!forceRefresh) {
    const cached = apiCache.get(cacheKey);
    if (cached) return cached;
  }

  try {
    const res = await fetch('https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`BMKG Error: ${res.status}`);
    const list = (await res.json())?.Infogempa?.gempa || [];
    const daftar = list.map((g, idx) => {
      const [latStr, lonStr] = g.Coordinates ? g.Coordinates.split(',') : [0, 0];
      return {
        id: `felt-${idx}-${g.Tanggal}-${g.Jam}`,
        date: g.Tanggal || '',
        time: g.Jam || '',
        dateTime: `${g.Tanggal || ''} ${g.Jam || ''}`.trim(),
        epoch: waktuBmkgKeEpoch(g.Tanggal, g.Jam),
        lat: parseFloat(latStr) || 0,
        lon: parseFloat(lonStr) || 0,
        magnitude: parseFloat(g.Magnitude) || 0,
        depth: g.Kedalaman || '-',
        wilayah: g.Wilayah || 'Indonesia',
        potensi: g.Potensi || 'Tidak berpotensi tsunami',
        dirasakan: g.Dirasakan || '',
        sumber: 'BMKG'
      };
    });
    apiCache.set(cacheKey, daftar, 2 * 60 * 1000);
    return daftar;
  } catch (error) {
    console.warn('Gagal memuat gempa dirasakan BMKG:', error.message);
    return apiCache.get(cacheKey) || [];
  }
}
