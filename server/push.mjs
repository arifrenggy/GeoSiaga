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

const RAW_CHECK_MIN = String(process.env.PUSH_CHECK_INTERVAL_MIN || '').trim();
const CHECK_INTERVAL_MIN = Number.parseInt(RAW_CHECK_MIN, 10) || 5;
if (RAW_CHECK_MIN && String(CHECK_INTERVAL_MIN) !== RAW_CHECK_MIN) {
  console.log(`[push] PUSH_CHECK_INTERVAL_MIN="${RAW_CHECK_MIN}" tidak valid -> pakai ${CHECK_INTERVAL_MIN} menit`);
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
    const sukses = await sendPush(sub, {
      title: '🚨 UJI ALARM DARURAT GeoSiaga',
      body: 'Ini notifikasi uji manual. Alarm akan berbunyi terus sampai Anda menekan Hentikan Alarm.',
      tag: 'uji-alarm',
      url: '/?alarm=1',
      vibrate: ALARM_VIBRATE,
      requireInteraction: true,
      urgent: true,
      level: 'urgent'
    }, 600);
    if (sukses) ok++;
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

// --- Pemeriksa 3: Karhutla dekat kota (NASA FIRMS) ---
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

// --- Laporan harian GeoSiaga (dikirim setiap hari walau tidak ada bencana) ---
const DAILY_HOUR = Number(process.env.PUSH_DAILY_HOUR) || 7; // 07:00 WITA default
const DAILY_TZ_OFFSET_MIN = 8 * 60; // WITA = UTC+8

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
    title: `🌤️ Laporan Harian GeoSiaga — ${city.name}`,
    body: `${bagian.join(' • ').replace(/\.$/, '')}. Kondisi ${info.hazard ? 'WASPADA' : 'aman hari ini'}.`,
    tag: `harian-${new Date().toISOString().slice(0, 10)}`,
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

const STATUS_MODE = String(process.env.PUSH_STATUS_MODE || 'daily').trim().toLowerCase();
const STATUS_FIRST_MIN = Number.parseInt(String(process.env.PUSH_FIRST_STATUS_MIN || '').trim(), 10) || 3;
const STATUS_MIN_MIN = Number.parseInt(String(process.env.PUSH_STATUS_MIN_MIN || '').trim(), 10) || 45;
const STATUS_MAX_MIN = Number.parseInt(String(process.env.PUSH_STATUS_MAX_MIN || '').trim(), 10) || 240;

function jadwalkanStatusAcak() {
  // laporan status berkala di waktu acak — bukan jam tetap
  const acak = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const tick = async () => {
    await sendDailyDigest().catch(() => {});
    const menit = acak(STATUS_MIN_MIN, STATUS_MAX_MIN);
    dailyTimer = setTimeout(tick, menit * 60 * 1000);
    console.log(`[push] Status berkala berikutnya dalam ${menit} menit`);
  };
  dailyTimer = setTimeout(tick, STATUS_FIRST_MIN * 60 * 1000);
  console.log(`[push] Mode status acak aktif: laporan pertama dalam ${STATUS_FIRST_MIN} menit, lalu acak ${STATUS_MIN_MIN}-${STATUS_MAX_MIN} menit`);
}

function jadwalkanLaporanHarian(state) {
  if (dailyTimer) return; // jadwal harian hanya dibuat sekali
  if (STATUS_MODE === 'random') { jadwalkanStatusAcak(); return; }
  const now = new Date();
  const lokal = new Date(now.getTime() + (DAILY_TZ_OFFSET_MIN + now.getTimezoneOffset()) * 60000);
  const target = new Date(lokal);
  target.setHours(DAILY_HOUR, 0, 0, 0);
  if (lokal >= target) target.setDate(target.getDate() + 1);
  const tglHariIni = lokal.toISOString().slice(0, 10);
  if (state.lastDailyDigest !== tglHariIni && (DAILY_HOUR * 60 - (lokal.getHours() * 60 + lokal.getMinutes())) <= 15) {
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
  console.log(`[push] Laporan harian dijadwalkan pukul ${String(DAILY_HOUR).padStart(2, '0')}:00 WITA`);
}

// --- Mode uji alarm (PUSH_TEST_ALARM=1): kirim notifikasi darurat percobaan saat server mulai ---
async function kirimUjiAlarm() {
  const subs = await loadSubscribers();
  if (subs.length === 0) { console.log('[push] Uji alarm: belum ada langganan'); return; }
  let ok = 0;
  for (const sub of subs) {
    const sukses = await sendPush(sub, {
      title: '🚨 UJI ALARM DARURAT GeoSiaga',
      body: 'Ini notifikasi uji. Alarm akan berbunyi terus sampai Anda menekan Hentikan Alarm.',
      tag: 'uji-alarm',
      url: '/?alarm=1',
      vibrate: ALARM_VIBRATE,
      requireInteraction: true,
      urgent: true,
      level: 'urgent'
    }, 600);
    if (sukses) ok++;
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
      jadwalkanLaporanHarian(state);
      if (n1 + n2 + n3 > 0) {
        console.log(`[push] Terkirim: ${n1} gempa, ${n2} hujan, ${n3} karhutla`);
      }
    } catch (err) {
      console.error('[push] Kesalahan pemantauan:', err.message);
    } finally {
      await saveState(state);
    }
  };

  run();
  watcherTimer = setInterval(run, CHECK_INTERVAL_MIN * 60 * 1000);
  console.log(`[push] Pemantau bencana aktif (cek tiap ${CHECK_INTERVAL_MIN} menit)`);
  if (process.env.PUSH_TEST_ALARM === '1') kirimUjiAlarm();
}

export function stopPushWatcher() {
  if (watcherTimer) clearInterval(watcherTimer);
  watcherTimer = null;
}
