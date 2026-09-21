import { INDONESIA_VOLCANOES, VOLCANO_STATUS_LEVELS } from '../utils/volcanoes.js';
import { calculateDistance } from '../utils/geo.js';
import { apiCache } from '../utils/apiCache.js';

/**
 * Layanan Monitoring Vulkanologi & Gunung Api
 *
 * Koordinat/radius bahaya: database referensi statis (di utils/volcanoes.js).
 * STATUS AKTIVITAS: real-time dari PVMBG / MAGMA ESDM via serverless /api/volcanoes.
 *
 * JUJUR: sebelum status live termuat (atau saat MAGMA tidak dapat dihubungi),
 * semua gunung tampil dengan status "Tidak Diketahui" — BUKAN tebakan.
 */

const STATUS_CACHE_KEY = 'magma_volcano_status_v1';

let liveStatusMap = null; // { "nama ternormalisasi": level 1..4 }
let statusVersion = 0; // naik setiap kali status live termuat -> invalidasi cache perhitungan

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^gunung\s+/, '')
    .replace(/^g\.\s*/, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

/**
 * Ambil status aktivitas gunung api terkini dari MAGMA ESDM (via /api/volcanoes).
 * Hasil di-cache 60 menit. Aman dipanggil berulang (idempotent).
 */
export async function refreshVolcanoStatuses(force = false) {
  const cached = apiCache.get(STATUS_CACHE_KEY);
  if (cached && !force) {
    liveStatusMap = cached;
    return { ok: true, stale: true };
  }

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 10000) : null;

    const res = await fetch('/api/volcanoes', {
      headers: { 'Accept': 'application/json' },
      signal: controller ? controller.signal : undefined
    });
    if (timeoutId) clearTimeout(timeoutId);

    if (!res.ok) {
      let msg = `Endpoint status gunung api merespons ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch { /* ignore */ }
      return { ok: false, error: msg };
    }

    const data = await res.json();
    if (!data?.available || !data?.statuses) {
      return { ok: false, error: data?.error || 'Status MAGMA tidak tersedia.' };
    }

    liveStatusMap = data.statuses;
    statusVersion += 1; // cache perhitungan lama (status unknown) otomatis tak terpakai
    apiCache.set(STATUS_CACHE_KEY, data.statuses, 60 * 60 * 1000); // 1 jam
    return { ok: true, source: data.source, fetchedAt: data.fetchedAt };
  } catch (err) {
    return { ok: false, error: `Gagal menghubungi /api/volcanoes: ${err.message}` };
  }
}

function resolveStatusLevel(volcanoName) {
  if (!liveStatusMap || Object.keys(liveStatusMap).length === 0) return 0;

  const target = normalizeName(volcanoName);
  if (!target) return 0;

  // 1. Cocok persis
  if (liveStatusMap[target] !== undefined) return liveStatusMap[target];

  // 2. Cocok sebagian (mis. "Merapi" vs "Gunung Marapi" — bedakan dengan seluruh kata)
  for (const [magmaName, level] of Object.entries(liveStatusMap)) {
    const mag = normalizeName(magmaName);
    if (!mag) continue;
    // hindari salah pasang "Marapi" != "Merapi": hanya cocokkan frasa utuh
    const targetWords = target.split(/\s+/);
    const magWords = mag.split(/\s+/);
    const isSamePhrase = (mag === target) ||
      (targetWords.length > 1 && magWords.length > 1 && (
        target.endsWith(mag) || mag.endsWith(target)
      ));
    if (isSamePhrase) return level;
  }

  // 3. Tidak terdaftar di tabel MAGMA → tidak diketahui (bukan asumsi normal)
  return 0;
}

/**
 * Gunung api terdekat + status live MAGMA. Bersifat sinkron: status live
 * harus dimuat dulu dengan refreshVolcanoStatuses() (dipanggil App.jsx saat mount).
 */
export function getNearbyVolcanoes(lat, lon, maxRadiusKm = 250) {
  if (!lat || !lon) return { nearest: null, list: [], alertCount: 0 };

  const safeLat = Number(lat) || -6.2088;
  const safeLon = Number(lon) || 106.8456;
  const cacheKey = `volcano_v${statusVersion}_${safeLat.toFixed(2)}_${safeLon.toFixed(2)}`;
  const cached = apiCache.get(cacheKey);
  if (cached) return cached;

  const volcanoesWithDistance = INDONESIA_VOLCANOES.map((v) => {
    const distanceKm = Math.round(calculateDistance(lat, lon, v.lat, v.lon) * 10) / 10;
    const statusLevel = resolveStatusLevel(v.name);
    const status = VOLCANO_STATUS_LEVELS[statusLevel] || VOLCANO_STATUS_LEVELS[0];
    const isInsideDangerZone = distanceKm <= v.dangerRadiusKm;
    const isCautionZone = distanceKm <= v.dangerRadiusKm * 4;

    return {
      ...v,
      distanceKm,
      statusLevel,
      status,
      isInsideDangerZone,
      isCautionZone
    };
  }).sort((a, b) => a.distanceKm - b.distanceKm);

  const nearest = volcanoesWithDistance[0] || null;
  const nearbyList = volcanoesWithDistance.filter((v) => v.distanceKm <= maxRadiusKm);
  const alertCount = INDONESIA_VOLCANOES.filter((v) => resolveStatusLevel(v.name) >= 3).length;

  const result = {
    nearest,
    nearbyList,
    allVolcanoes: volcanoesWithDistance,
    alertCount
  };

  apiCache.set(cacheKey, result, 10 * 60 * 1000);
  return result;
}
