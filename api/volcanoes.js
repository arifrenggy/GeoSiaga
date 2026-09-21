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

export default async function handler(request) {
  try {
    const res = await fetch(MAGMA_URL, {
      headers: {
        'User-Agent': 'GeoSiaga/1.0 (monitoring lingkungan; +https://geosiaga.vercel.app)',
        'Accept': 'text/html'
      }
    });

    if (!res.ok) {
      return json({ available: false, error: `MAGMA ESDM merespons status ${res.status}` }, 502);
    }

    const html = await res.text();
    const statuses = parseMagmaStatusTable(html);

    if (!statuses || Object.keys(statuses).length === 0) {
      return json({ available: false, error: 'Format halaman MAGMA berubah / tabel status tidak ditemukan' }, 502);
    }

    return json(
      {
        available: true,
        source: 'PVMBG / MAGMA Indonesia (ESDM)',
        sourceUrl: MAGMA_URL,
        fetchedAt: new Date().toISOString(),
        statuses // { "Nama Gunung": 1..4 }
      },
      200,
      'public, max-age=3600' // cache edge 1 jam, status gunung api jarang berubah
    );
  } catch (err) {
    return json({ available: false, error: `Gagal menghubungi MAGMA ESDM: ${err.message}` }, 503);
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
