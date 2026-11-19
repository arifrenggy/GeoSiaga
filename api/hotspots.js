export const config = {
  runtime: 'edge',
};

/**
 * Serverless: Titik Panas (Hotspot) Karhutla Real-Time
 * Sumber: NASA FIRMS VIIRS SNPP NRT (https://firms.modaps.eosdis.nasa.gov/)
 * Membutuhkan environment variable FIRMS_MAP_KEY (registrasi gratis di
 * https://firms.modaps.eosdis.nasa.gov/api/map_key/)
 *
 * Tanpa MAP_KEY atau saat NASA FIRMS tidak dapat dihubungi, endpoint mengembalikan
 * status 503 + alasan secara JUJUR (tidak ada data palsu).
 */

async function inti(request) {
  const MAP_KEY = process.env.FIRMS_MAP_KEY;

  if (!MAP_KEY) {
    return json(
      { available: false, error: 'FIRMS_MAP_KEY belum diset di environment. Daftar gratis di https://firms.modaps.eosdis.nasa.gov/api/map_key/' },
      503
    );
  }

  try {
    // Bounding box Indonesia (Sumatera s.d. Papua), data 24 jam terakhir.
    // Beberapa produk satelit digabung karena tiap produk bisa kosong sementara
    // (VIIRS kadang tidak mengembalikan baris walau MODIS ada), agar peta tidak
    // tampil kosong padahal deteksi resmi tersedia.
    const BBOX = '94.5,-11.5,141.5,7.5';
    // Jendela hari: NASA FIRMS menunda sebagian data NRT, sehingga 1 hari sering kosong.
    // Default 3 hari (bisa diatur lewat HOTSPOT_DAYS, maksimal 5 sesuai batas API).
    const DAYS = Math.min(5, Math.max(1, parseInt(process.env.HOTSPOT_DAYS || '3', 10) || 3));
    const SOURCES = [
      { id: 'VIIRS_NOAA21_NRT', label: 'VIIRS NOAA-21' },
      { id: 'VIIRS_SNPP_NRT', label: 'VIIRS SNPP' },
      { id: 'VIIRS_NOAA20_NRT', label: 'VIIRS NOAA-20' },
      { id: 'MODIS_NRT', label: 'MODIS Terra/Aqua' }
    ];

    const results = await Promise.all(
      SOURCES.map(async (src) => {
        const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/${src.id}/${BBOX}/${DAYS}`;
        try {
          const r = await fetch(url, { headers: { 'Accept': 'text/csv' } });
          if (!r.ok) return { ...src, ok: false, error: `status ${r.status}`, rows: [] };
          const csv = await r.text();
          return { ...src, ok: true, rows: parseFirmsCsv(csv) };
        } catch (e) {
          return { ...src, ok: false, error: e.message, rows: [] };
        }
      })
    );

    const aktif = results.filter((r) => r.ok && r.rows.length > 0);
    if (aktif.length === 0) {
      const alasan = results.map((r) => `${r.label}: ${r.error || 'tidak ada deteksi'}`).join('; ');
      return json(
        { available: false, error: `NASA FIRMS tidak mengembalikan data (${alasan})` },
        502
      );
    }

    // Gabungkan semua sumber, buang duplikat titik yang sama dari satelit berbeda
    const mentah = aktif.flatMap((r) => r.rows);
    const unik = new Map();
    for (const h of mentah) {
      const key = `${h.lat.toFixed(3)}|${h.lon.toFixed(3)}|${h.acqDate}|${h.acqTime}`;
      const ada = unik.get(key);
      // simpan yang keyakinannya lebih tinggi / FRP lebih besar
      if (!ada || (h.confidenceRaw === 'h' && ada.confidenceRaw !== 'h') || (h.frpMw || 0) > (ada.frpMw || 0)) {
        unik.set(key, h);
      }
    }
    const hotspots = [...unik.values()];

    const compact = compactRows(hotspots);

    return json(
      {
        available: true,
        source: aktif.map((r) => r.label).join(' + '),
        sourceUrl: 'https://firms.modaps.eosdis.nasa.gov/',
        fetchedAt: new Date().toISOString(),
        v: 2,
        totalDetected: mentah.length,
        days: DAYS,
        jumlah: hotspots.length,
        perKeyakinan: {
          tinggi: hotspots.filter((h) => h.confidenceRaw === 'h').length,
          sedang: hotspots.filter((h) => h.confidenceRaw === 'n').length,
          rendah: hotspots.filter((h) => h.confidenceRaw === 'l').length
        },
        sources: results.map((r) => ({ id: r.id, label: r.label, deteksi: r.rows.length, ok: r.ok })),
        satellites: compact.satellites,
        hotspots: compact.rows
      },
      200,
      'public, max-age=60, stale-while-revalidate=120'
    );
  } catch (err) {
    return json({ available: false, error: `Gagal menghubungi NASA FIRMS: ${err.message}` }, 503);
  }
}

function parseFirmsCsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2 || !lines[0].startsWith('latitude')) return [];

  const headers = lines[0].split(',').map((h) => h.trim());
  const idx = (name) => headers.indexOf(name);
  const iLat = idx('latitude');
  const iLon = idx('longitude');
  const iDate = idx('acq_date');
  const iTime = idx('acq_time');
  const iSat = idx('satellite');
  const iConf = idx('confidence');
  const iBright = Math.max(idx('bright_ti4'), idx('brightness'));
  const iFrp = Math.max(idx('frp'), idx('frp_mw'));

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < headers.length) continue;

    const lat = parseFloat(cols[iLat]);
    const lon = parseFloat(cols[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const conf = normalizeConfidence(cols[iConf]);
    out.push({
      lat,
      lon,
      acqDate: cols[iDate],
      acqTime: (cols[iTime] || '').padStart(4, '0'),
      satellite: mapSatellite(cols[iSat]),
      confidenceRaw: conf,
      brightnessK: iBright >= 0 ? Math.round(parseFloat(cols[iBright]) * 10) / 10 : null,
      frpMw: iFrp >= 0 ? Math.round(parseFloat(cols[iFrp]) * 10) / 10 : null
    });
  }
  return out;
}

// VIIRS memakai huruf (l/n/h), MODIS memakai angka 0-100
function normalizeConfidence(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'h' || v === 'high') return 'h';
  if (v === 'n' || v === 'nominal') return 'n';
  if (v === 'l' || v === 'low') return 'l';
  const num = parseFloat(v);
  if (Number.isFinite(num)) return num >= 80 ? 'h' : num >= 30 ? 'n' : 'l';
  return 'l';
}

function mapSatellite(raw) {
  const v = String(raw || '').trim();
  const map = { 'N': 'VIIRS SNPP', 'NPP': 'VIIRS SNPP', 'JPSS-1': 'VIIRS NOAA-20', '1': 'VIIRS NOAA-20' };
  return map[v] || v || 'VIIRS SNPP';
}

// Saring mutu sedang & tinggi, urutkan dari radiasi api terkuat, lalu padatkan
function compactRows(all) {
  const filtered = all
    .filter((h) => h.confidenceRaw !== 'l')
    .sort((a, b) => (b.frpMw || 0) - (a.frpMw || 0));

  const satellites = [];
  const satIndex = (name) => {
    let i = satellites.indexOf(name);
    if (i === -1) { satellites.push(name); i = satellites.length - 1; }
    return i;
  };

  const rows = filtered.map((h) => [
    Math.round(h.lat * 10000) / 10000,
    Math.round(h.lon * 10000) / 10000,
    h.acqDate,
    h.acqTime,
    satIndex(h.satellite),
    h.confidenceRaw === 'h' ? 2 : h.confidenceRaw === 'n' ? 1 : 0,
    h.frpMw,
    h.brightnessK
  ]);

  return { totalFiltered: filtered.length, rows, satellites };
}

function json(body, status = 200, cacheControl = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': cacheControl
    }
  });
}

// ---------------------------------------------------------------
// Cache 60 detik + single-flight: berapa pun pengunjungnya, NASA
// hanya dipanggil sekali per menit sehingga kuota tidak jebol.
// Hasil terakhir juga disimpan ke volume sebagai cadangan.
// ---------------------------------------------------------------
const CACHE_MS = 60 * 1000;
const CACHE_HEADER = 'public, max-age=60, stale-while-revalidate=120';
const BERKAS_CACHE = 'data/hotspots-cache.json';
const mem = { payload: null, at: 0, promise: null };

async function simpanDisk(payload) {
  try {
    if (!globalThis.process?.versions?.node) return;
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(path.dirname(BERKAS_CACHE), { recursive: true });
    await fs.writeFile(BERKAS_CACHE, JSON.stringify(payload), 'utf8');
  } catch { /* cadangan bersifat pelengkap */ }
}

async function bacaDisk() {
  try {
    if (!globalThis.process?.versions?.node) return null;
    const fs = await import('node:fs/promises');
    return JSON.parse(await fs.readFile(BERKAS_CACHE, 'utf8'));
  } catch { return null; }
}

export default async function handler(request) {
  if (mem.payload && Date.now() - mem.at < CACHE_MS) {
    return json(mem.payload, 200, CACHE_HEADER);
  }

  if (!mem.promise) {
    mem.promise = (async () => {
      const res = await inti(request);
      return { status: res.status, body: await res.json() };
    })().finally(() => { mem.promise = null; });
  }

  const { status, body } = await mem.promise;

  if (status === 200) {
    mem.payload = body;
    mem.at = Date.now();
    await simpanDisk(body);
    return json(body, 200, CACHE_HEADER);
  }

  // Sumber gagal: sajikan hasil terakhir yang tersimpan, tandai sebagai data lama
  const cadangan = await bacaDisk();
  if (cadangan) {
    return json(
      { ...cadangan, stale: true, catatan: 'Sumber sedang tidak dapat dihubungi, menampilkan data terakhir yang tersimpan.' },
      200,
      'public, max-age=60'
    );
  }
  return json(body, status, 'no-store');
}
