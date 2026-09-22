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
