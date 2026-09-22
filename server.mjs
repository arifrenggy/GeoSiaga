/**
 * Server GeoSiaga — Node.js mandiri, jalankan di hosting mana pun
 * (Railway, Render, VPS, Docker, dsb.) tanpa Vercel.
 *
 * - Menyajikan hasil build frontend (folder dist/)
 * - Menjalankan API function yang sama dengan Vercel (Web Request/Response standar)
 * - Membaca FIRMS_MAP_KEY dari environment atau file .env
 *
 * Menjalankan:
 *   npm run build
 *   npm start
 * Port: process.env.PORT || 3000
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import hotspotsHandler from './api/hotspots.js';
import volcanoesHandler from './api/volcanoes.js';
import widgetHandler from './api/widget.js';
import badgeHandler from './api/badge.js';
import {
  pushPublicKeyHandler,
  pushSubscribeHandler,
  pushUnsubscribeHandler,
  startPushWatcher
} from './server/push.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = resolve(__dirname, 'dist');
const PORT = Number(process.env.PORT) || 3000;

// --- Muat .env manual (tanpa dependency) ---
async function loadDotEnv() {
  try {
    const raw = await readFile(join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
    console.log('[server] .env dimuat');
  } catch {
    console.log('[server] .env tidak ada / tidak terbaca — pakai environment variable saja');
  }
}

// --- Router API: function yang sama persis dengan versi Vercel ---
const API_ROUTES = {
  '/api/hotspots': hotspotsHandler,
  '/api/volcanoes': volcanoesHandler,
  '/api/widget': widgetHandler,
  '/api/badge': badgeHandler,
  '/api/push/public-key': pushPublicKeyHandler,
  '/api/push/subscribe': pushSubscribeHandler,
  '/api/push/unsubscribe': pushUnsubscribeHandler
  // '/api/og' hanya tersedia di Vercel (butuh @vercel/og)
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

async function serveStatic(pathname, res) {
  // Lindungi dari path traversal
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST_DIR, safePath);

  try {
    const st = await stat(filePath);
    if (st.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // Bukan file -> fallback SPA ke index.html
    filePath = join(DIST_DIR, 'index.html');
  }

  try {
    const data = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

async function handleApi(handler, req, res) {
  // Bangun Web Request standar dari IncomingMessage Node (termasuk body POST)
  const rawBody = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: rawBody && rawBody.length ? rawBody : undefined
  });

  const response = await handler(request);
  const body = Buffer.from(await response.arrayBuffer());
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);

  try {
    // 1. API function
    const handler = API_ROUTES[pathname];
    if (handler) {
      await handleApi(handler, req, res);
      return;
    }

    // 2. API lain (og.jsx) tidak tersedia di server mandiri
    if (pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `Endpoint ${pathname} tidak tersedia di server mandiri (khusus Vercel).` }));
      return;
    }

    // 3. File statis & fallback SPA
    const served = await serveStatic(pathname, res);
    if (!served) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404: halaman tidak ditemukan. Jalankan `npm run build` dulu bila folder dist/ kosong.');
    }
  } catch (err) {
    console.error('[server] Error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
});

await loadDotEnv();

server.listen(PORT, () => {
  console.log(`[server] GeoSiaga berjalan di http://localhost:${PORT}`);
  console.log(`[server] Frontend: ${DIST_DIR}`);
  console.log(`[server] FIRMS_MAP_KEY: ${process.env.FIRMS_MAP_KEY ? 'tersedia ✓' : 'BELUM DISET — fitur hotspot akan tampil "tidak tersedia"'}`);
  console.log(`[server] VAPID: ${process.env.VAPID_PUBLIC_KEY ? 'tersedia ✓ — notifikasi peringatan dini aktif' : 'BELUM DISET — jalankan `npx web-push generate-vapid-keys` lalu isi .env'}`);
  startPushWatcher();
});
