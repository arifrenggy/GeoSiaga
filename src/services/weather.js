import { apiCache } from '../utils/apiCache.js';

export async function fetchWeatherData(lat, lon, forceRefresh = false) {
  const safeLat = Number(lat) || -6.2088;
  const safeLon = Number(lon) || 106.8456;
  const cacheKey = `weather_${safeLat.toFixed(3)}_${safeLon.toFixed(3)}`;

  if (!forceRefresh) {
    const cached = apiCache.get(cacheKey);
    if (cached) return cached;
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 6000) : null;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${safeLat}&longitude=${safeLon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,surface_pressure,wind_speed_10m,wind_direction_10m,uv_index&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,weather_code,uv_index&daily=weather_code,temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max&timezone=Asia%2FJakarta&forecast_days=7`;
    
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller ? controller.signal : undefined
    });
    if (!res.ok) throw new Error(`Open-Meteo Weather status: ${res.status}`);
    const data = await res.json();

    const formatted = {
      current: {
        temp: Math.round(data.current?.temperature_2m ?? 0),
        feelsLike: Math.round(data.current?.apparent_temperature ?? 0),
        humidity: data.current?.relative_humidity_2m ?? 0,
        precipitation: data.current?.precipitation ?? 0,
        weatherCode: data.current?.weather_code ?? null,
        windSpeed: data.current?.wind_speed_10m ?? 0,
        windDirection: data.current?.wind_direction_10m ?? 0,
        uvIndex: data.current?.uv_index ?? 0,
        pressure: data.current?.surface_pressure ?? 0,
        time: data.current?.time || new Date().toISOString()
      },
      hourly: data.hourly || null,
      daily: data.daily || null
    };

    apiCache.set(cacheKey, formatted, 5 * 60 * 1000);
    return formatted;
  } catch (error) {
    // JUJUR: saat API gagal, kembalikan data cache lama (nyata) jika ada, atau null.
    // Tidak ada lagi data cuaca PALSU.
    console.warn('Gagal mengambil data cuaca Open-Meteo:', error.message);
    return apiCache.get(cacheKey) || null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
