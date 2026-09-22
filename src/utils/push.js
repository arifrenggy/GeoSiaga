/**
 * Pendaftaran Web Push GeoSiaga — notifikasi peringatan dini berbasis daerah.
 * Dipanggil setelah warga mengizinkan notifikasi; kirim juga kota warga
 * supaya server hanya menyiram peringatan yang relevan dengan daerahnya.
 */

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function getServerPublicKey() {
  try {
    const res = await fetch('/api/push/public-key');
    const data = await res.json();
    return data.publicKey || null;
  } catch {
    return null;
  }
}

/**
 * Mendaftarkan perangkat ini ke server peringatan dini.
 * @param {Object} city { name, province, lat, lon }
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function registerDisasterPush(city) {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (!city || typeof city.lat !== 'number' || typeof city.lon !== 'number') {
    return { ok: false, reason: 'no-city' };
  }

  const publicKey = await getServerPublicKey();
  if (!publicKey) {
    return { ok: false, reason: 'server-off' };
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    let sub = await registration.pushManager.getSubscription();

    // Jika kunci server berganti, daftar ulang dengan kunci baru
    if (sub) {
      const currentKey = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey)));
      if (currentKey !== btoa(publicKey)) {
        await sub.unsubscribe();
        sub = null;
      }
    }

    if (!sub) {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }

    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        city: { name: city.name, province: city.province || '', lat: city.lat, lon: city.lon }
      })
    });
    if (!res.ok) return { ok: false, reason: 'server-error' };
    return { ok: true };
  } catch (err) {
    console.warn('Push register gagal:', err.message);
    return { ok: false, reason: 'error' };
  }
}

export async function unregisterDisasterPush() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint })
      });
      await sub.unsubscribe();
    }
    return true;
  } catch {
    return false;
  }
}
