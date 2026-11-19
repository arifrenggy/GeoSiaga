export const config = {
  runtime: 'edge',
};

/**
 * Serverless: Status Tingkat Aktivitas Gunung Api Real-Time
 * Sumber resmi: PVMBG / MAGMA Indonesia (ESDM) — halaman publik
 * https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas
 *
 * API internal MAGMA membutuhkan token (tidak publik), sehingga endpoint ini
 * membaca tabel status resmi dari halaman publik di atas lalu mem-parsing-nya.
 * Saat MAGMA tidak dapat dihubungi, endpoint mengembalikan 503 secara JUJUR.
 */

const MAGMA_URL = 'https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas';

// Simpan status terakhir ke disk agar peta tidak kosong saat MAGMA sedang mati.
// Hanya aktif di server mandiri (Node); di edge/Vercel fungsi ini tidak dijalankan.
const CACHE_FILE = 'data/volcanoes-cache.json';

// MAGMA menolak permintaan dari IP pusat data (Railway, AWS, dsb) walau bisa dibuka
// dari jaringan rumah di Indonesia. Karena itu dipakai jalur cadangan pembaca halaman.
const PROXY_URL = 'https://r.jina.ai/';
const BATAS_WAKTU_MS = 12000;

async function ambilHalaman(url, tambahanHeader = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'GeoSiaga/1.2 (monitoring lingkungan)',
      'Accept': 'text/html',
      ...tambahanHeader
    },
    signal: AbortSignal.timeout(BATAS_WAKTU_MS)
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.text();
}

async function simpanCache(data) {
  try {
    if (!globalThis.process?.versions?.node) return;
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = path.dirname(CACHE_FILE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(data), 'utf8');
  } catch { /* cache bersifat pelengkap, kegagalan tidak menghentikan respons */ }
}

async function bacaCache() {
  try {
    if (!globalThis.process?.versions?.node) return null;
    const fs = await import('node:fs/promises');
    const isi = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(isi);
  } catch { return null; }
}

async function gagal(error, status) {
  const cache = await bacaCache();
  if (cache?.statuses && Object.keys(cache.statuses).length > 0) {
    return json(
      {
        available: true,
        stale: true,
        source: 'PVMBG / MAGMA Indonesia (ESDM)',
        sourceUrl: MAGMA_URL,
        fetchedAt: cache.fetchedAt,
        catatan: 'Sumber resmi sedang tidak dapat dihubungi, menampilkan data terakhir yang tersimpan.',
        statuses: cache.statuses
      },
      200,
      'public, max-age=60'
    );
  }
  return json({ available: false, error }, status);
}

async function inti(request) {
  try {
    let html = null;
    let jalur = 'langsung';
    let galat = null;

    // Jalur 1: sambungan langsung ke MAGMA
    try {
      html = await ambilHalaman(MAGMA_URL);
    } catch (e) {
      galat = e.message;
    }

    // Jalur 2: pembaca halaman pihak ketiga bila jalur langsung ditolak
    if (!html) {
      try {
        html = await ambilHalaman(PROXY_URL + MAGMA_URL, { 'X-Return-Format': 'html' });
        jalur = 'cadangan';
      } catch (e) {
        return gagal(`MAGMA tidak dapat dihubungi (langsung: ${galat}; cadangan: ${e.message})`, 502);
      }
    }

    const statuses = parseMagmaStatusTable(html);

    if (!statuses || Object.keys(statuses).length === 0) {
      return gagal('Format halaman MAGMA berubah / tabel status tidak ditemukan', 502);
    }

    await simpanCache({ fetchedAt: new Date().toISOString(), statuses });

    return json(
      {
        available: true,
        source: 'PVMBG / MAGMA Indonesia (ESDM)',
        sourceUrl: MAGMA_URL,
        fetchedAt: new Date().toISOString(),
        jalur,
        statuses // { "Nama Gunung": 1..4 }
      },
      200,
      'public, max-age=60, stale-while-revalidate=120'
    );
  } catch (err) {
    return gagal(`Gagal menghubungi MAGMA ESDM: ${err.message}`, 503);
  }
}

function parseMagmaStatusTable(html) {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return null;

  const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const levelMap = { 'IV': 4, 'III': 3, 'II': 2, 'I': 1 };
  const statuses = {};
  let currentLevel = null;

  for (const row of rows) {
    const plain = row
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

    // Baris header seksi: "Level IV (Awas) ..." / "Level III (Siaga) ..."
    const levelMatch = plain.match(/^Level\s+(IV|III|II|I)\b/i);
    if (levelMatch) {
      currentLevel = levelMap[levelMatch[1].toUpperCase()];
      continue;
    }

    // Baris data gunung api: "Anak Krakatau - Lampung Lihat laporan"
    if (currentLevel !== null && plain.includes('-') && !/^Tingkat/i.test(plain) && !plain.match(/^\d+$/)) {
      const namePart = plain.split(' - ')[0].split(' Lihat')[0].trim();
      if (namePart && namePart.length > 2 && !namePart.match(/^(Hasil|Tingkat)/i)) {
        statuses[namePart] = currentLevel;
      }
    }
  }

  return statuses;
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
// Cache 60 detik agar jalur cadangan tidak dipanggil terus-menerus
// ---------------------------------------------------------------
const CACHE_MS_VOLCANO = 60 * 1000;
const CACHE_HEADER_VOLCANO = 'public, max-age=60, stale-while-revalidate=120';
const memVulkan = { payload: null, at: 0, promise: null };

export default async function handler(request) {
  if (memVulkan.payload && Date.now() - memVulkan.at < CACHE_MS_VOLCANO) {
    return json(memVulkan.payload, 200, CACHE_HEADER_VOLCANO);
  }

  if (!memVulkan.promise) {
    memVulkan.promise = (async () => {
      const res = await inti(request);
      return { status: res.status, body: await res.json() };
    })().finally(() => { memVulkan.promise = null; });
  }

  const { status, body } = await memVulkan.promise;
  if (status === 200) {
    memVulkan.payload = body;
    memVulkan.at = Date.now();
  }
  return json(body, status, status === 200 ? CACHE_HEADER_VOLCANO : 'no-store');
}
