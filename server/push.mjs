/**
 * GeoSiaga Peringatan Dini — Push Notification berbasis daerah
 *
 * - Warga mendaftar dari aplikasi (izin notifikasi + pilih kota)
 * - Server memantau sumber data bencana secara berkala:
 *     1. Gempa BMKG (M >= 5, dirasakan / signifikan) -> sesuai radius dari kota warga
 *     2. Potensi tsunami -> siaran ke SEMUA pendaftar
 *     3. Hujan sangat lebat (Open-Meteo) per kota pendaftar
 *     4. Karhutla (NASA FIRMS) jika >= 3 titik api dalam 50 km dari kota
 * - Notifikasi dikirim sebagai Web Push dengan pola getar alarm
 *
 * Penyimpanan sederhana berbasis file (portabel, tanpa database):
 *   data/push-subscribers.json  - daftar langganan
 *   data/push-state.json         - dedup (id kejadian yang sudah dikirim)
 */

import webpush from 'web-push';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
const SUBS_FILE = join(DATA_DIR, 'push-subscribers.json');
const STATE_FILE = join(DATA_DIR, 'push-state.json');

function vapidPublicKey() { return process.env.VAPID_PUBLIC_KEY || ''; }
function vapidPrivateKey() { return process.env.VAPID_PRIVATE_KEY || ''; }
function vapidSubject() { return process.env.VAPID_SUBJECT || 'mailto:admin@geosiaga.id'; }

// Konfigurasi PUSH_* dibaca saat watcher dijalankan (setelah .env dimuat),
// bukan saat modul diimpor — supaya nilai dari .env benar-benar terbaca.
function intervalMenit() {
  const raw = String(process.env.PUSH_CHECK_INTERVAL_MIN || '').trim();
  const v = Number.parseInt(raw, 10) || 5;
  if (raw && String(v) !== raw) {
    console.log(`[push] PUSH_CHECK_INTERVAL_MIN="${raw}" tidak valid -> pakai ${v} menit`);
  }
  return v;
}

export function _configTest() {
  return {
    menit: intervalMenit(),
    status: statusConfig(),
    jamHarian: dailyHour()
  };
}

// --- Penyimpanan file ---
async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  const { rename } = await import('node:fs/promises');
  await rename(tmp, file);
}

async function loadSubscribers() {
  const data = await readJson(SUBS_FILE, { subscribers: [] });
  return data.subscribers || [];
}

async function saveSubscribers(subs) {
  await writeJson(SUBS_FILE, { subscribers: subs, updatedAt: new Date().toISOString() });
}

async function loadState() {
  return readJson(STATE_FILE, { sentQuakes: [], lastRainWarn: {}, lastKarhutlaWarn: {} });
}

async function saveState(state) {
  await writeJson(STATE_FILE, state);
}

// --- Geodesi ---
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Radius dampak gempa menurut magnitudo (km)
export function affectedRadiusKm(magnitude) {
  return Math.min(800, Math.max(150, 100 + (magnitude - 4) * 150));
}

// --- Handler HTTP (Web Request/Response standar, sama dengan function Vercel) ---
export async function pushPublicKeyHandler() {
  return new Response(JSON.stringify({ publicKey: vapidPublicKey() || null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export async function pushSubscribeHandler(request) {
  try {
    const body = await request.json();
    const { subscription, city } = body || {};
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return new Response(JSON.stringify({ error: 'Subscription tidak valid.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
    if (!city?.name || typeof city.lat !== 'number' || typeof city.lon !== 'number') {
      return new Response(JSON.stringify({ error: 'Data kota tidak lengkap (name, lat, lon).' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const subs = await loadSubscribers();
    const idx = subs.findIndex((s) => s.endpoint === subscription.endpoint);
    const record = {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      city: { name: city.name, province: city.province || '', lat: city.lat, lon: city.lon },
      updatedAt: new Date().toISOString()
    };
    if (idx >= 0) subs[idx] = record;
    else subs.push(record);
    await saveSubscribers(subs);

    return new Response(JSON.stringify({ ok: true, total: subs.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}

function payloadUjiAlarm() {
  return {
    title: '🚨 UJI ALARM DARURAT GeoSiaga',
    body: 'Ini notifikasi uji manual. Alarm akan berbunyi terus sampai Anda menekan Hentikan Alarm.',
    tag: 'uji-alarm',
    url: '/?alarm=1',
    vibrate: ALARM_VIBRATE,
    requireInteraction: true,
    urgent: true,
    level: 'urgent'
  };
}

export async function pushTestHandler(request) {
  // kirim uji alarm darurat ke semua langganan — tanpa perlu restart server
  const subs = await loadSubscribers();
  if (subs.length === 0) {
    return new Response(JSON.stringify({ ok: false, pesan: 'Belum ada langganan' }), {
      status: 404, headers: { 'Content-Type': 'application/json' }
    });
  }
  let ok = 0;
  for (const sub of subs) {
    const sukses = await sendPush(sub, payloadUjiAlarm(), 600);
    if (sukses) ok++;
    ulangiAlarmDarurat(sub, payloadUjiAlarm());
  }
  console.log(`[push] Uji manual: terkirim ${ok} dari ${subs.length} langganan`);
  return new Response(JSON.stringify({ ok: true, terkirim: ok, total: subs.length }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}

export async function pushUnsubscribeHandler(request) {
  try {
    const body = await request.json();
    if (!body?.endpoint) {
      return new Response(JSON.stringify({ error: 'endpoint wajib diisi' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
    const subs = (await loadSubscribers()).filter((s) => s.endpoint !== body.endpoint);
    await saveSubscribers(subs);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}

// --- Pengiriman push ---
let webpushReady = false;

function ensureWebpush() {
  if (webpushReady) return true;
  const pub = vapidPublicKey();
  const priv = vapidPrivateKey();
  if (!pub || !priv) {
    console.log('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY belum diset — push dimatikan');
    return false;
  }
  webpush.setVapidDetails(vapidSubject(), pub, priv);
  webpushReady = true;
  return true;
}

async function sendPush(sub, payload, ttlSeconds = 3600) {
  if (!ensureWebpush()) return false;
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload),
      // TTL: berapa lama pesan boleh mengantre saat perangkat offline (detik).
      // Gempa 1 jam, hujan/karhutla 6 jam, tsunami 6 jam — supaya peringatan
      // kedaluwarsa tidak muncul sebagai "baru" saat sinyal kembali.
      { TTL: ttlSeconds }
    );
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      // Langganan kedaluwarsa — hapus
      const subs = (await loadSubscribers()).filter((s) => s.endpoint !== sub.endpoint);
      await saveSubscribers(subs);
      console.log('[push] Langganan kedaluwarsa dihapus');
    } else if (err.statusCode === 429) {
      console.log('[push] Rate limit dari push service, coba lagi nanti');
    } else {
      // 400/403 biasanya langganan sudah tidak valid (browser ganti kunci / uninstall)
      let host = '?';
      try { host = new URL(sub.endpoint).host; } catch {}
      console.error(`[push] Gagal kirim (HTTP ${err.statusCode ?? '?'} ke ${host}): ${err.message}`);
      if (err.statusCode === 400 || err.statusCode === 403) {
        const subs = (await loadSubscribers()).filter((x) => x.endpoint !== sub.endpoint);
        await saveSubscribers(subs);
        console.log('[push] Langganan tidak valid dihapus. Silakan buka aplikasi dan aktifkan notifikasi lagi.');
      }
    }
    return false;
  }
}

const ALARM_VIBRATE = [500, 200, 500, 200, 500, 200, 500];

// --- Pemeriksa 1: Gempa BMKG ---
export function buildQuakePayloads(quake, subscriber) {
  const payloads = [];
  const distance = haversineKm(subscriber.city.lat, subscriber.city.lon, quake.lat, quake.lon);
  const m = quake.magnitude;

  const tsunami = quake.potensi && !/tidak berpotensi/i.test(quake.potensi);
  if (tsunami) {
    payloads.push({
      title: `⚠️ PERINGATAN TSUNAMI — Gempa M${m.toFixed(1)}`,
      body: `${quake.wilayah} • Kedalaman ${quake.depth} • ${quake.potensi}. Segera menjauhi pantai dan menuju tempat tinggi! (${Math.round(distance)} km dari ${subscriber.city.name})`,
      tag: `tsunami-${quake.id}`,
      url: '/?alarm=1',
      vibrate: ALARM_VIBRATE,
      requireInteraction: true,
      urgent: true,
      level: 'urgent'
    });
  }

  payloads.push({
    title: `🚨 Gempa M${m.toFixed(1)} — ${quake.wilayah}`,
    body: `Kedalaman ${quake.depth} • ${Math.round(distance)} km dari ${subscriber.city.name}${subscriber.city.province ? `, ${subscriber.city.province}` : ''} • ${quake.potensi || ''}`.trim(),
    tag: `gempa-${quake.id}`,
    url: m >= 6 ? '/?alarm=1' : '/',
    vibrate: ALARM_VIBRATE,
    requireInteraction: true,
    urgent: m >= 6,
    level: m >= 6 ? 'urgent' : 'alert'
  });

  return payloads;
}

async function fetchFeltQuakes() {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json', {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`BMKG ${res.status}`);
    const data = await res.json();
    return (data?.Infogempa?.gempa || []).map((g) => {
      const [latStr, lonStr] = (g.Coordinates || '0,0').split(',');
      return {
        id: `${g.Tanggal}_${g.Jam}_${g.Coordinates}`,
        tanggal: g.Tanggal,
        jam: g.Jam,
        lat: parseFloat(latStr) || 0,
        lon: parseFloat(lonStr) || 0,
        magnitude: parseFloat(g.Magnitude) || 0,
        depth: g.Kedalaman || '-',
        wilayah: g.Wilayah || 'Indonesia',
        potensi: g.Potensi || 'Tidak berpotensi tsunami',
        dirasakan: g.Dirasakan || '-'
      };
    });
  } finally {
    clearTimeout(t);
  }
}

export async function checkEarthquakes(state, send = sendPush) {
  const quakes = await fetchFeltQuakes();
  const subs = await loadSubscribers();
  if (subs.length === 0) return 0;

  let sent = 0;
  for (const q of quakes) {
    if (q.magnitude < 5) continue; // gempa dirasakan kecil tidak disiarkan
    if (state.sentQuakes.includes(q.id)) continue;

    const radius = affectedRadiusKm(q.magnitude);
    const tsunami = q.potensi && !/tidak berpotensi/i.test(q.potensi);

    for (const sub of subs) {
      const dist = haversineKm(sub.city.lat, sub.city.lon, q.lat, q.lon);
      if (dist <= radius || tsunami) {
        for (const payload of buildQuakePayloads(q, sub)) {
          await send(sub, payload, payload.tag.startsWith('tsunami-') ? 21600 : 3600);
          ulangiAlarmDarurat(sub, payload, send);
          sent++;
        }
      }
    }
    state.sentQuakes.push(q.id);
  }

  // Simpan hanya 200 id terakhir
  state.sentQuakes = state.sentQuakes.slice(-200);
  return sent;
}

// --- Pemeriksa 2: Hujan sangat lebat per kota ---
async function fetchMaxHourlyRain(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation&forecast_days=1`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const data = await res.json();
    const times = data?.hourly?.time || [];
    const rain = data?.hourly?.precipitation || [];
    const now = new Date();
    let max = 0;
    for (let i = 0; i < times.length; i++) {
      const d = new Date(times[i]);
      if (d >= now && d.getTime() - now.getTime() <= 6 * 3600 * 1000) {
        max = Math.max(max, rain[i] || 0);
      }
    }
    return max; // mm/jam maksimum 6 jam ke depan
  } finally {
    clearTimeout(t);
  }
}

export async function checkHeavyRain(state, send = sendPush) {
  const subs = await loadSubscribers();
  if (subs.length === 0) return 0;

  // Grup per kota unik (hindari fetch berulang)
  const cities = new Map();
  for (const s of subs) {
    const key = `${s.city.name}_${s.city.lat.toFixed(2)}_${s.city.lon.toFixed(2)}`;
    if (!cities.has(key)) cities.set(key, { city: s.city, subs: [] });
    cities.get(key).subs.push(s);
  }

  const THRESHOLD_MM = 10; // mm/jam
  const COOLDOWN_MS = 6 * 3600 * 1000;
  let sent = 0;

  for (const [key, group] of cities) {
    const last = state.lastRainWarn[key] || 0;
    if (Date.now() - last < COOLDOWN_MS) continue;

    const maxRain = await fetchMaxHourlyRain(group.city.lat, group.city.lon);
    if (maxRain >= THRESHOLD_MM) {
      for (const sub of group.subs) {
        await send(sub, {
          title: `🌧️ Peringatan Hujan Sangat Lebat — ${group.city.name}`,
          body: `Prakiraan hujan ekstrem hingga ${maxRain} mm/jam dalam 6 jam ke depan. Waspada banjir/longsor, hindari bantaran sungai dan titik rawan.`,
          tag: `hujan-${key}`,
          url: '/',
          vibrate: ALARM_VIBRATE,
          requireInteraction: true
        }, 21600);
        sent++;
      }
      state.lastRainWarn[key] = Date.now();
    }
  }
  return sent;
}

// --- Pemeriksa 3: Bakal hujan di kota warga (prakiraan) ---
async function fetchRainOutlook(lat, lon) {
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_probability,precipitation&forecast_days=1&timezone=Asia%2FMakassar`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const h = (await res.json())?.hourly || {};
    const jamSekarang = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours(); // WITA
    const minProb = Number.parseInt(String(process.env.PUSH_RAIN_PROB || '').trim(), 10) || 60;
    for (let i = 0; i < (h.time || []).length; i++) {
      const jam = Number.parseInt(String(h.time[i]).slice(11, 13), 10);
      if (jam < jamSekarang) continue;
      const prob = h.precipitation_probability?.[i] ?? 0;
      const mm = h.precipitation?.[i] ?? 0;
      if (prob >= minProb || mm >= 0.5) {
        return { jam: String(h.time[i]).slice(11, 16), prob: Math.max(prob, mm >= 0.5 ? 70 : 0) };
      }
    }
  } catch { return null; }
  return null;
}

export async function checkRainIncoming(state, send = sendPush) {
  const subs = await loadSubscribers();
  if (subs.length === 0) return 0;
  const cities = new Map();
  for (const s of subs) {
    const key = `${s.city.name}_${s.city.lat.toFixed(2)}_${s.city.lon.toFixed(2)}`;
    if (!cities.has(key)) cities.set(key, { city: s.city, subs: [] });
    cities.get(key).subs.push(s);
  }
  const COOLDOWN_MS = 4 * 3600 * 1000; // jangan spam lebih dari sekali 4 jam per kota
  let sent = 0;
  for (const [key, group] of cities) {
    const last = state.lastRainStart?.[key] || 0;
    if (Date.now() - last < COOLDOWN_MS) continue;
    const out = await fetchRainOutlook(group.city.lat, group.city.lon);
    if (!out) continue;
    for (const sub of group.subs) {
      const ok = await send(sub, {
        title: `🌧️ Bakal Hujan di ${group.city.name}`,
        body: `Prakiraan hujan mulai sekitar pukul ${out.jam} WITA (peluang ${out.prob}%). Siapkan payung dan hati-hati jalan licin.`,
        tag: `hujan-mulai-${key}`,
        url: '/',
        vibrate: [300, 100, 300],
        requireInteraction: false
      }, 14400);
      if (ok) sent++;
    }
    state.lastRainStart = state.lastRainStart || {};
    state.lastRainStart[key] = Date.now();
  }
  return sent;
}

// --- Pemeriksa 4: Kualitas udara berubah (segar / tidak sehat) ---
async function fetchCityAqi(lat, lon) {
  try {
    const res = await fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=european_aqi`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const aqi = (await res.json())?.current?.european_aqi;
    if (aqi == null) return null;
    const label = aqi <= 20 ? 'Baik' : aqi <= 40 ? 'Cukup' : aqi <= 60 ? 'Sedang' : aqi <= 80 ? 'Tidak sehat' : aqi <= 100 ? 'Sangat tidak sehat' : 'Berbahaya';
    return { aqi: Math.round(aqi), label };
  } catch { return null; }
}

export async function checkAir(state, send = sendPush) {
  const subs = await loadSubscribers();
  if (subs.length === 0) return 0;
  const cities = new Map();
  for (const s of subs) {
    const key = `${s.city.name}_${s.city.lat.toFixed(2)}_${s.city.lon.toFixed(2)}`;
    if (!cities.has(key)) cities.set(key, { city: s.city, subs: [] });
    cities.get(key).subs.push(s);
  }
  const COOLDOWN_MS = 6 * 3600 * 1000;
  const batasBuruk = Number.parseInt(String(process.env.PUSH_AIR_BAD || '').trim(), 10) || 60;
  let sent = 0;
  state.lastAir = state.lastAir || {};
  for (const [key, group] of cities) {
    const prev = state.lastAir[key];
    if (prev && Date.now() - prev.ts < COOLDOWN_MS) continue;
    const air = await fetchCityAqi(group.city.lat, group.city.lon);
    if (!air) continue;
    const burukSekarang = air.aqi >= batasBuruk;
    const segarSekarang = air.label === 'Baik';
    const catBaru = burukSekarang ? 'buruk' : segarSekarang ? 'segar' : 'sedang';
    if (prev && prev.cat === catBaru) continue; // hanya saat kategori berubah
    let payload = null;
    if (burukSekarang) {
      payload = {
        title: `😷 Udara Tidak Sehat di ${group.city.name}`,
        body: `Indeks kualitas udara AQI ${air.aqi} (${air.label}). Batasi aktivitas di luar ruangan dan gunakan masker bila perlu.`,
        tag: `udara-buruk-${key}`
      };
    } else if (segarSekarang) {
      payload = {
        title: `🍃 Udara Segar di ${group.city.name}`,
        body: `Indeks kualitas udara AQI ${air.aqi} (${air.label}). Waktu yang tepat untuk aktivitas dan olahraga di luar ruangan.`,
        tag: `udara-segar-${key}`
      };
    }
    if (payload) {
      for (const sub of group.subs) {
        const ok = await send(sub, {
          ...payload,
          url: '/',
          vibrate: [300, 100, 300],
          requireInteraction: false
        }, 10800);
        if (ok) sent++;
      }
    }
    state.lastAir[key] = { cat: catBaru, ts: Date.now() };
  }
  return sent;
}

// --- Pemeriksa 5: Karhutla dekat kota (NASA FIRMS) ---
async function fetchFirmsHotspots() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return [];
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/94.5,-11.5,141.5,7.5/1`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return [];
    const csv = await res.text();
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return [];
    const cols = lines[0].split(',');
    const iLat = cols.indexOf('latitude');
    const iLon = cols.indexOf('longitude');
    const iConf = cols.indexOf('confidence');
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const v = lines[i].split(',');
      out.push({ lat: parseFloat(v[iLat]), lon: parseFloat(v[iLon]), conf: v[iConf] });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

export async function checkWildfires(state, send = sendPush) {
  if (!process.env.FIRMS_MAP_KEY) return 0;
  const subs = await loadSubscribers();
  if (subs.length === 0) return 0;

  const hotspots = await fetchFirmsHotspots();
  if (hotspots.length === 0) return 0;

  const COOLDOWN_MS = 12 * 3600 * 1000;
  let sent = 0;

  for (const sub of subs) {
    const key = `${sub.city.name}_${sub.city.lat.toFixed(2)}_${sub.city.lon.toFixed(2)}`;
    const last = state.lastKarhutlaWarn[key] || 0;
    if (Date.now() - last < COOLDOWN_MS) continue;

    const near = hotspots.filter(
      (h) => h.conf === 'h' && haversineKm(sub.city.lat, sub.city.lon, h.lat, h.lon) <= 50
    );
    if (near.length >= 3) {
      await send(sub, {
        title: `🔥 Titik Api Aktif Dekat ${sub.city.name}`,
        body: `${near.length} titik api satelit (kepercayaan tinggi) terdeteksi dalam radius 50 km. Waspada asap dan kebakaran lahan.`,
        tag: `karhutla-${key}`,
        url: '/',
        vibrate: ALARM_VIBRATE,
        requireInteraction: false
      }, 21600);
      sent++;
      state.lastKarhutlaWarn[key] = Date.now();
    }
  }
  return sent;
}

let dailyTimer = null;
let reportTimer = null;

// --- Alarm darurat berbunyi berulang otomatis (tanpa pengaturan apa pun di HP) ---
function alarmRepeatConfig() {
  const n = Number.parseInt(String(process.env.PUSH_ALARM_REPEAT ?? '').trim(), 10);
  return {
    count: Number.isFinite(n) ? n : 4, // 0 = matikan pengulangan
    sec: Number.parseInt(String(process.env.PUSH_ALARM_REPEAT_SEC ?? '').trim(), 10) || 40,
  };
}

function ulangiAlarmDarurat(sub, payload, send = sendPush) {
  if (!payload.urgent || !payload.tag) return;
  const { count, sec } = alarmRepeatConfig();
  if (count <= 0) return;
  const ttl = payload.tag.startsWith('tsunami-') ? 21600 : 3600;
  console.log(`[push] Alarm "${payload.tag}" akan dibunyikan ulang ${count}x tiap ${sec} detik`);
  for (let i = 1; i <= count; i++) {
    setTimeout(() => {
      send(sub, { ...payload, renotify: true }, ttl);
    }, i * sec * 1000);
  }
}

// --- Laporan harian GeoSiaga (dikirim setiap hari walau tidak ada bencana) ---
const DAILY_TZ_OFFSET_MIN = 8 * 60; // WITA = UTC+8

function dailyHour() {
  return Number.parseInt(String(process.env.PUSH_DAILY_HOUR || '').trim(), 10) || 7; // 07:00 WITA default
}

export function buildDailyDigest(sub, info) {
  const { city } = sub;
  const bagian = [];
  if (info.weather) {
    bagian.push(`${info.weather.desc}. Suhu ${info.weather.temp}`);
  }
  if (info.quake) {
    bagian.push(`Gempa terakhir: ${info.quake}`);
  }
  if (info.udara) {
    bagian.push(`Kualitas udara: ${info.udara}`);
  }
  bagian.push(info.hazard ? `⚠️ ${info.hazard}` : 'Tidak ada peringatan aktif di wilayah Anda.');
  return {
    title: `📋 Laporan Berkala GeoSiaga — ${city.name}`,
    body: `${bagian.join(' • ').replace(/\.$/, '')}. Kondisi ${info.hazard ? 'WASPADA' : 'aman hari ini'}.`,
    tag: `laporan-${new Date().toISOString().slice(0, 13)}`,
    url: '/',
    vibrate: [200, 100, 200],
    requireInteraction: false,
    daily: true,
    level: 'info'
  };
}

async function fetchCityWeather(city) {
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current=temperature_2m,weather_code,precipitation_probability`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const cur = (await res.json())?.current || {};
    return { temp: `${Math.round(cur.temperature_2m ?? 0)}°C`, desc: deskripsiCuaca(cur.weather_code) };
  } catch {
    return null;
  }
}

function deskripsiCuaca(code) {
  if (code >= 61 && code <= 67) return 'Potensi hujan hari ini';
  if (code >= 80 && code <= 82) return 'Hujan lokal';
  if (code >= 95) return 'Ada badai/angin kencang';
  if (code >= 2 && code <= 3) return 'Berawan';
  return 'Cuaca relatif cerah';
}

async function labelUdara(aqi) {
  if (aqi <= 20) return 'Baik';
  if (aqi <= 40) return 'Cukup';
  if (aqi <= 60) return 'Sedang';
  if (aqi <= 80) return 'Tidak sehat';
  if (aqi <= 100) return 'Sangat tidak sehat';
  return 'Berbahaya';
}

export async function fetchCityAir(city) {
  try {
    const res = await fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${city.lat}&longitude=${city.lon}&current=european_aqi,pm10`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const cur = (await res.json())?.current || {};
    if (cur.european_aqi == null) return null;
    return `AQI ${Math.round(cur.european_aqi)} (${await labelUdara(cur.european_aqi)})`;
  } catch {
    return null;
  }
}

async function sendDailyDigest() {
  const subs = await loadSubscribers();
  if (subs.length === 0) return 0;
  let sent = 0;
  for (const sub of subs) {
    try {
      const [weather, udara] = await Promise.all([fetchCityWeather(sub.city), fetchCityAir(sub.city)]);
      let quakeInfo = null;
      try {
        const quakes = await fetchFeltQuakes();
        const q = quakes && quakes[0];
        if (q) quakeInfo = `M${q.magnitude.toFixed(1)} ${q.wilayah} (${q.tanggal})`;
      } catch { quakeInfo = null; }
      const payload = buildDailyDigest(sub, { weather, quake: quakeInfo, udara, hazard: null });
      const ok = await sendPush(sub, payload, 21600);
      if (ok) sent++;
    } catch (err) {
      console.error('[push] Laporan harian gagal untuk', sub.city?.name, err.message);
    }
  }
  console.log(`[push] Laporan harian terkirim ke ${sent} langganan`);
  return sent;
}

function statusConfig() {
  return {
    mode: String(process.env.PUSH_STATUS_MODE || 'daily').trim().toLowerCase(),
    first: Number.parseInt(String(process.env.PUSH_FIRST_STATUS_MIN || '').trim(), 10) || 3,
    min: Number.parseInt(String(process.env.PUSH_STATUS_MIN_MIN || '').trim(), 10) || 45,
    max: Number.parseInt(String(process.env.PUSH_STATUS_MAX_MIN || '').trim(), 10) || 240,
  };
}

// kirim satu topik spesifik sebagai notifikasi tersendiri
async function kirimTopik(topik) {
  const subs = await loadSubscribers();
  if (subs.length === 0) return 0;
  let sent = 0;
  const stamp = new Date().toISOString().slice(0, 13); // per jam: notif beda terlihat "baru"
  for (const sub of subs) {
    let payload = null;
    if (topik === 'cuaca') {
      const w = await fetchCityWeather(sub.city);
      if (w) payload = {
        title: `🌦️ Cuaca Saat Ini — ${sub.city.name}`,
        body: `${w.desc}. Suhu ${w.temp}.`,
        tag: `cuaca-${stamp}`
      };
    } else if (topik === 'udara') {
      const a = await fetchCityAqi(sub.city.lat, sub.city.lon);
      if (a) payload = {
        title: `🍃 Kualitas Udara — ${sub.city.name}`,
        body: `AQI ${a.aqi} (${a.label}).`,
        tag: `udara-${stamp}`
      };
    } else if (topik === 'gempa') {
      try {
        const q = (await fetchFeltQuakes())[0];
        if (q) payload = {
          title: `🌎 Gempa Terakhir Terdeteksi`,
          body: `M${q.magnitude.toFixed(1)} — ${q.wilayah} (${q.tanggal}). ${q.potensi || ''}`.trim(),
          tag: `gempa-status-${stamp}`
        };
      } catch { payload = null; }
    }
    if (payload) {
      const ok = await sendPush(sub, {
        ...payload, url: '/', vibrate: [200, 100, 200], requireInteraction: false
      }, 10800);
      if (ok) sent++;
    }
  }
  return sent;
}

function jadwalkanStatusAcak() {
  // laporan status satu-topik, di waktu acak — bukan jam tetap, bukan gabungan
  const cfg = statusConfig();
  const acak = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const TOPIK = ['cuaca', 'udara', 'gempa'];
  const tick = async () => {
    const topik = TOPIK[Math.floor(Math.random() * TOPIK.length)];
    await kirimTopik(topik).catch(() => {});
    const menit = acak(cfg.min, cfg.max);
    dailyTimer = setTimeout(tick, menit * 60 * 1000);
    console.log(`[push] Notifikasi topik "${topik}" terkirim; berikutnya dalam ${menit} menit`);
  };
  dailyTimer = setTimeout(tick, cfg.first * 60 * 1000);
  console.log(`[push] Mode status acak aktif: laporan pertama dalam ${cfg.first} menit, lalu acak ${cfg.min}-${cfg.max} menit`);

  // laporan gabungan (cuaca + gempa + udara) terkirim rutin tiap jam — notif tersendiri
  const everyRaw = String(process.env.PUSH_REPORT_EVERY_MIN ?? '').trim();
  const every = Number.parseInt(everyRaw, 10);
  if (every !== 0) {
    const menit = every || 60;
    const reportTick = async () => {
      await sendDailyDigest().catch(() => {});
      reportTimer = setTimeout(reportTick, menit * 60 * 1000);
    };
    reportTimer = setTimeout(reportTick, menit * 60 * 1000);
    console.log(`[push] Laporan gabungan rutin: tiap ${menit} menit`);
  }
}

function jadwalkanLaporanHarian(state) {
  if (dailyTimer) return; // jadwal harian hanya dibuat sekali
  if (statusConfig().mode === 'random') { jadwalkanStatusAcak(); return; }
  const now = new Date();
  const lokal = new Date(now.getTime() + (DAILY_TZ_OFFSET_MIN + now.getTimezoneOffset()) * 60000);
  const jamHarian = dailyHour();
  const target = new Date(lokal);
  target.setHours(jamHarian, 0, 0, 0);
  if (lokal >= target) target.setDate(target.getDate() + 1);
  const tglHariIni = lokal.toISOString().slice(0, 10);
  if (state.lastDailyDigest !== tglHariIni && (jamHarian * 60 - (lokal.getHours() * 60 + lokal.getMinutes())) <= 15) {
    // sudah lewat jadwal hari ini & belum terkirim -> kirim sekarang
    state.lastDailyDigest = tglHariIni;
    sendDailyDigest().catch(() => {});
  }
  let ms = target - lokal;
  const tick = () => {
    const st = new Date();
    const l = new Date(st.getTime() + (DAILY_TZ_OFFSET_MIN + st.getTimezoneOffset()) * 60000);
    const hari = l.toISOString().slice(0, 10);
    if (hari !== state.lastDailyDigest) {
      state.lastDailyDigest = hari;
      sendDailyDigest().catch(() => {});
    }
    dailyTimer = setTimeout(tick, 24 * 3600 * 1000);
  };
  dailyTimer = setTimeout(tick, ms);
  console.log(`[push] Laporan harian dijadwalkan pukul ${String(dailyHour()).padStart(2, '0')}:00 WITA`);
}

// --- Mode uji alarm (PUSH_TEST_ALARM=1): kirim notifikasi darurat percobaan saat server mulai ---
async function kirimUjiAlarm() {
  const subs = await loadSubscribers();
  if (subs.length === 0) { console.log('[push] Uji alarm: belum ada langganan'); return; }
  let ok = 0;
  for (const sub of subs) {
    const sukses = await sendPush(sub, payloadUjiAlarm(), 600);
    if (sukses) ok++;
    ulangiAlarmDarurat(sub, payloadUjiAlarm());
  }
  console.log(`[push] Uji alarm: terkirim ${ok} dari ${subs.length} langganan`);
  if (ok < subs.length) {
    console.log('[push] Ada langganan gagal terkirim — lihat log di atas. Biasanya perlu berlangganan ulang dari aplikasi.');
  }
  console.log('[push] CATATAN: PUSH_TEST_ALARM masih 1 — uji akan dikirim ulang tiap server restart. Set 0 setelah selesai menguji.');
}

// --- Loop pemantauan ---
let watcherTimer = null;

export function startPushWatcher() {
  if (watcherTimer) return;
  if (!ensureWebpush()) {
    console.log('[push] Notifikasi dinonaktifkan. Set VAPID_PUBLIC_KEY & VAPID_PRIVATE_KEY untuk mengaktifkan.');
    return;
  }

  const run = async () => {
    const state = await loadState();
    try {
      const n1 = await checkEarthquakes(state);
      const n2 = await checkHeavyRain(state);
      const n3 = await checkWildfires(state);
      const n4 = await checkRainIncoming(state);
      const n5 = await checkAir(state);
      jadwalkanLaporanHarian(state);
      if (n1 + n2 + n3 + n4 + n5 > 0) {
        console.log(`[push] Terkirim: ${n1} gempa, ${n2} hujan lebat, ${n3} karhutla, ${n4} bakal-hujan, ${n5} udara`);
      }
    } catch (err) {
      console.error('[push] Kesalahan pemantauan:', err.message);
    } finally {
      await saveState(state);
    }
  };

  run();
  const menit = intervalMenit();
  watcherTimer = setInterval(run, menit * 60 * 1000);
  console.log(`[push] Pemantau bencana aktif (cek tiap ${menit} menit)`);
  if (process.env.PUSH_TEST_ALARM === '1') kirimUjiAlarm();
}

export function stopPushWatcher() {
  if (watcherTimer) clearInterval(watcherTimer);
  watcherTimer = null;
}
