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

export default async function handler(request) {
  const MAP_KEY = process.env.FIRMS_MAP_KEY;

  if (!MAP_KEY) {
    return json(
      { available: false, error: 'FIRMS_MAP_KEY belum diset di environment. Daftar gratis di https://firms.modaps.eosdis.nasa.gov/api/map_key/' },
      503
    );
  }

  try {
    // Bounding box Indonesia (Sumatera s.d. Papua), data 24 jam terakhir
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/VIIRS_SNPP_NRT/94.5,-11.5,141.5,7.5/1`;
    const res = await fetch(url, { headers: { 'Accept': 'text/csv' } });

    if (!res.ok) {
      return json({ available: false, error: `NASA FIRMS merespons status ${res.status}` }, 502);
    }

    const csv = await res.text();
    const hotspots = parseFirmsCsv(csv);

    return json(
      {
        available: true,
        source: 'NASA FIRMS VIIRS SNPP NRT',
        sourceUrl: 'https://firms.modaps.eosdis.nasa.gov/',
        fetchedAt: new Date().toISOString(),
        v: 2, // format kompak: baris = [lat, lon, tanggal, waktu, satelitIdx, keyakinan, frp, brightness]
        totalDetected: hotspots.totalDetected, // total baris mentah 24 jam terakhir
        satellites: hotspots.satellites,
        hotspots: hotspots.rows // seluruh hasil filter confidence, tanpa batas jumlah
      },
      200,
      'public, max-age=900' // cache 15 menit di edge, hemat kuota NASA
    );
  } catch (err) {
    return json({ available: false, error: `Gagal menghubungi NASA FIRMS: ${err.message}` }, 503);
  }
}

function parseFirmsCsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2 || !lines[0].startsWith('latitude')) {
    return { totalDetected: 0, rows: [] };
  }

  const headers = lines[0].split(',');
  const idx = (name) => headers.indexOf(name);
  const iLat = idx('latitude');
  const iLon = idx('longitude');
  const iDate = idx('acq_date');
  const iTime = idx('acq_time');
  const iSat = idx('satellite');
  const iConf = idx('confidence');
  const iBright = Math.max(idx('bright_ti4'), idx('brightness')); // VIIRS: bright_ti4, MODIS: brightness (Kelvin)
  const iFrp = Math.max(idx('frp_mw'), idx('frp')); // VIIRS: frp_mw (MW), MODIS: frp (MW)

  const all = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < headers.length) continue;

    const conf = (cols[iConf] || 'l').trim().toLowerCase(); // l=rendah, n=sedang, h=tinggi
    all.push({
      lat: parseFloat(cols[iLat]),
      lon: parseFloat(cols[iLon]),
      acqDate: cols[iDate],
      acqTime: cols[iTime],
      satellite: { 'N': 'VIIRS SNPP', 'NPP': 'VIIRS SNPP', 'JPSS-1': 'VIIRS NOAA-20' }[cols[iSat]] || cols[iSat] || 'VIIRS SNPP',
      confidenceRaw: conf,
      confidence: conf === 'h' ? 'Tinggi' : conf === 'n' ? 'Sedang' : 'Rendah',
      brightnessK: iBright >= 0 ? Math.round(parseFloat(cols[iBright]) * 10) / 10 : null,
      frpMw: iFrp >= 0 ? Math.round(parseFloat(cols[iFrp]) * 10) / 10 : null
    });
  }

  // Hanya tampilkan deteksi bermutu sedang & tinggi, urut dari radiasi api terkuat.
  // Seluruh hasil filter dikirim (tanpa batas jumlah) agar sesuai data resmi NASA FIRMS.
  const filtered = all
    .filter((h) => h.confidenceRaw !== 'l')
    .sort((a, b) => (b.frpMw || 0) - (a.frpMw || 0));

  // Format kompak: koordinat 4 desimal (presisi ~11 m), satelit jadi indeks
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
    h.confidenceRaw === 'h' ? 2 : 1,
    h.frpMw,
    h.brightnessK
  ]);

  return { totalDetected: all.length, rows, satellites };
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
