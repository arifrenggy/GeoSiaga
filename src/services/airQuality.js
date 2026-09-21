import { apiCache } from '../utils/apiCache.js';

export async function fetchAirQualityData(lat, lon, forceRefresh = false) {
  const safeLat = Number(lat) || -6.2088;
  const safeLon = Number(lon) || 106.8456;
  const cacheKey = `aqi_${safeLat.toFixed(3)}_${safeLon.toFixed(3)}`;

  if (!forceRefresh) {
    const cached = apiCache.get(cacheKey);
    if (cached) return cached;
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 6000) : null;

  try {
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${safeLat}&longitude=${safeLon}&current=us_aqi,pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,dust&hourly=us_aqi,pm2_5,pm10,carbon_monoxide,ozone&timezone=Asia%2FJakarta&forecast_days=3`;
    
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller ? controller.signal : undefined
    });
    if (!res.ok) throw new Error(`Open-Meteo Air Quality status: ${res.status}`);
    const data = await res.json();

    const formatted = {
      current: {
        aqi: Math.round(data.current?.us_aqi ?? 0),
        pm25: Math.round((data.current?.pm2_5 ?? 0) * 10) / 10,
        pm10: Math.round((data.current?.pm10 ?? 0) * 10) / 10,
        co: Math.round(data.current?.carbon_monoxide ?? 0),
        no2: Math.round((data.current?.nitrogen_dioxide ?? 0) * 10) / 10,
        so2: Math.round((data.current?.sulphur_dioxide ?? 0) * 10) / 10,
        o3: Math.round((data.current?.ozone ?? 0) * 10) / 10,
        dust: Math.round((data.current?.dust ?? 0) * 10) / 10,
        time: data.current?.time || new Date().toISOString()
      },
      hourly: data.hourly || null
    };

    apiCache.set(cacheKey, formatted, 5 * 60 * 1000);
    return formatted;
  } catch (error) {
    // JUJUR: saat API gagal, kembalikan data cache lama (nyata) jika ada, atau null.
    console.warn('Gagal mengambil data kualitas udara Open-Meteo:', error.message);
    return apiCache.get(cacheKey) || null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
