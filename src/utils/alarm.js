/**
 * Alarm bencana GeoSiaga — sirine dua nada via Web Audio,
 * diputar di aplikasi saat peringatan baru masuk (selain notifikasi sistem).
 * Pola getar juga diaktifkan untuk perangkat mobile.
 */

let audioCtx = null;

function getContext() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

export function playDisasterAlarm(cycles = 4) {
  try {
    const ctx = getContext();
    if (!ctx) return false;

    const start = ctx.currentTime;
    const toneDuration = 0.35;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    for (let i = 0; i < cycles; i++) {
      const freq = i % 2 === 0 ? 880 : 660; // dua nada bergantian
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      const t = start + i * toneDuration;
      osc.start(t);
      osc.stop(t + toneDuration * 0.9);
    }

    // Rampa volume supaya tidak menggedor telinga
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.3, start + 0.05);
    gain.gain.setValueAtTime(0.3, start + cycles * toneDuration - 0.1);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + cycles * toneDuration);

    if (navigator.vibrate) {
      navigator.vibrate([500, 200, 500, 200, 500]);
    }
    return true;
  } catch (err) {
    console.warn('Alarm gagal diputar:', err.message);
    return false;
  }
}

// ===== Alarm Darurat Kontinu (bunyi terus sampai dihentikan) =====
let sirenTimer = null;
let vibrateTimer = null;

// satu dengungan sirena dua nada (2 detik)
function bunyiSirena() {
  const ctx = getContext();
  if (!ctx || ctx.state !== 'running') return false;
  try {
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.05);
    gain.gain.setValueAtTime(0.35, t + 1.85);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 2);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(700, t);
    osc.frequency.linearRampToValueAtTime(950, t + 1);
    osc.frequency.linearRampToValueAtTime(700, t + 2);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 2);
    return true;
  } catch {
    return false;
  }
}

const DURASI_MAX_MS = 30 * 60 * 1000; // pengaman: berhenti sendiri setelah 30 menit

export function mulaiAlarm() {
  const ok = bunyiSirena();
  clearInterval(sirenTimer);
  sirenTimer = setInterval(() => { if (!bunyiSirena()) clearInterval(sirenTimer); }, 2400);
  if (navigator.vibrate) {
    navigator.vibrate([500, 200, 500, 200, 500, 200, 500]);
    clearInterval(vibrateTimer);
    vibrateTimer = setInterval(() => navigator.vibrate([500, 200, 500, 200, 500, 200, 500]), 5000);
  }
  setTimeout(() => hentikanAlarm(), DURASI_MAX_MS);
  return ok;
}

export function hentikanAlarm() {
  clearInterval(sirenTimer);
  clearInterval(vibrateTimer);
  sirenTimer = null;
  vibrateTimer = null;
  if (navigator.vibrate) navigator.vibrate(0);
}

// jika kebijakan autoplay memblokir bunyi, nyalakan saat interaksi pertama
export function aktifkanAlarmSetelahInteraksi() {
  const coba = () => { bunyiSirena(); window.removeEventListener('pointerdown', coba); };
  window.addEventListener('pointerdown', coba, { once: true });
}
