import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Search, X, MapPin, ChevronRight, Compass, Flame } from 'lucide-react';
import { INDONESIA_CITIES, REGIONS } from '../../utils/cities';
import { fetchWeatherData } from '../../services/weather';
import { fetchAirQualityData } from '../../services/airQuality';
import { triggerHaptic } from '../../utils/haptics';

const POPULAR_CITIES = [
  'Jakarta Pusat',
  'Surabaya',
  'Bandung',
  'Medan',
  'Denpasar',
  'Nusantara (IKN Sepaku)',
  'Makassar',
  'Yogyakarta',
  'Semarang',
  'Palembang'
];

export function CitySearchModal({ isOpen, onClose, onSelectCity, currentCity = {} }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRegion, setSelectedRegion] = useState('Semua');
  const [remoteResults, setRemoteResults] = useState([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 80);
    } else {
      setSearchTerm('');
      setSelectedRegion('Semua');
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const filteredCities = useMemo(() => {
    return INDONESIA_CITIES.filter((city) => {
      const matchRegion =
        selectedRegion === 'Semua' ||
        city.region === selectedRegion ||
        (selectedRegion === 'Nusantara' && city.name.includes('Nusantara'));

      if (!searchTerm) return matchRegion;

      const q = searchTerm.toLowerCase().trim();
      return (
        matchRegion &&
        (city.name.toLowerCase().includes(q) ||
         city.province.toLowerCase().includes(q) ||
         city.region.toLowerCase().includes(q))
      );
    });
  }, [searchTerm, selectedRegion]);

  // Pencarian nama tempat bebas (desa/kampung/permukiman) via Nominatim,
  // jalan paralel dengan daftar kota bawaan. Debounce 700ms supaya hemat kuota
  // dan sopan terhadap layanan publik OSM.
  useEffect(() => {
    const q = searchTerm.trim();
    if (q.length < 3) {
      setRemoteResults([]);
      setRemoteLoading(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setRemoteLoading(true);
      try {
        const url =
          'https://nominatim.openstreetmap.org/search?format=jsonv2' +
          '&countrycodes=id&accept-language=id&limit=8&addressdetails=1&q=' +
          encodeURIComponent(q);
        const res = await fetch(url, {
          signal: typeof AbortSignal !== 'undefined' ? AbortSignal.timeout(6000) : undefined
        });
        const data = res.ok ? await res.json() : [];
        if (!cancelled) setRemoteResults(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setRemoteResults([]);
      } finally {
        if (!cancelled) setRemoteLoading(false);
      }
    }, 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchTerm]);

  const handleSelectRemotePlace = (place) => {
    triggerHaptic(12);
    const province = place?.address?.state || place?.address?.region || '';
    onSelectCity({
      name: place?.name || (place?.display_name || 'Lokasi').split(',')[0],
      province,
      lat: Number(place?.lat),
      lon: Number(place?.lon)
    });
    onClose();
  };

  // Prefetch city data into cache on hover/touch for instant click response
  const prefetchCityData = (city) => {
    if (!city?.lat || !city?.lon) return;
    fetchWeatherData(city.lat, city.lon, false).catch(() => {});
    fetchAirQualityData(city.lat, city.lon, false).catch(() => {});
  };

  if (!isOpen) return null;

  const currentCityCleanName = currentCity?.name ? currentCity.name.replace(' (GPS)', '') : '';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.72)',
        backdropFilter: 'blur(6px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem'
      }}
      onClick={onClose}
    >
      <div
        className="flat-card animate-fade-in"
        style={{
          width: '100%',
          maxWidth: '600px',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--bg-card)',
          border: 'var(--border-thick)',
          overflow: 'hidden',
          padding: 0
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Header */}
        <div style={{ padding: '1.25rem', borderBottom: 'var(--border-thick)', backgroundColor: 'var(--bg-card)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.85rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{
                width: '32px',
                height: '32px',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--color-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff'
              }}>
                <Compass size={18} strokeWidth={2.5} />
              </div>
              <h3 style={{ fontSize: '1.15rem', fontWeight: '800', margin: 0, color: 'var(--text-main)', letterSpacing: '-0.02em' }}>
                Pilih Lokasi Anda
              </h3>
            </div>
            <button
              onClick={onClose}
              aria-label="Tutup"
              className="flat-btn-secondary"
              style={{ minHeight: '32px', padding: '4px 8px' }}
            >
              <X size={16} strokeWidth={2.5} />
            </button>
          </div>

          {/* Search Input Bar */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={18} style={{ position: 'absolute', left: '12px', color: 'var(--text-muted)' }} strokeWidth={2.5} />
            <input
              ref={inputRef}
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Cari kota, kabupaten, desa, atau nama tempat..."
              style={{
                width: '100%',
                padding: '0.75rem 2.2rem 0.75rem 2.5rem',
                borderRadius: 'var(--radius-md)',
                backgroundColor: 'var(--bg-muted)',
                border: 'var(--border-thick)',
                color: 'var(--text-main)',
                fontSize: '0.9rem',
                fontWeight: '600',
                outline: 'none'
              }}
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                style={{
                  position: 'absolute',
                  right: '12px',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                <X size={16} strokeWidth={2.5} />
              </button>
            )}
          </div>

          {/* Quick Popular Pills */}
          {!searchTerm && selectedRegion === 'Semua' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', overflowX: 'auto', paddingTop: '0.75rem', scrollbarWidth: 'none' }}>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                <Flame size={13} color="var(--color-accent)" strokeWidth={2.5} /> Populer:
              </span>
              {POPULAR_CITIES.map((name) => {
                const cityObj = INDONESIA_CITIES.find(c => c.name === name);
                if (!cityObj) return null;
                return (
                  <button
                    key={name}
                    onMouseEnter={() => prefetchCityData(cityObj)}
                    onTouchStart={() => prefetchCityData(cityObj)}
                    onClick={() => {
                      triggerHaptic(12);
                      onSelectCity(cityObj);
                      onClose();
                    }}
                    style={{
                      padding: '3px 9px',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.725rem',
                      fontWeight: '700',
                      whiteSpace: 'nowrap',
                      cursor: 'pointer',
                      border: 'var(--border-thick)',
                      backgroundColor: 'var(--bg-muted)',
                      color: 'var(--text-main)'
                    }}
                  >
                    {name.split(' ')[0]}
                  </button>
                );
              })}
            </div>
          )}

          {/* Region Filter Pills */}
          <div
            style={{
              display: 'flex',
              gap: '0.35rem',
              overflowX: 'auto',
              paddingTop: '0.75rem',
              scrollbarWidth: 'none'
            }}
          >
            {REGIONS.map((r) => (
              <button
                key={r}
                onClick={() => { triggerHaptic(8); setSelectedRegion(r); }}
                style={{
                  padding: '4px 10px',
                  borderRadius: 'var(--radius-full)',
                  fontSize: '0.75rem',
                  fontWeight: '700',
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  border: selectedRegion === r ? '2px solid var(--color-secondary)' : 'var(--border-thick)',
                  backgroundColor: selectedRegion === r ? 'var(--color-secondary-bg)' : 'var(--bg-muted)',
                  color: selectedRegion === r ? 'var(--color-secondary)' : 'var(--text-main)'
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Results List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0.85rem 1.25rem', backgroundColor: 'var(--bg-card)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.65rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: '700', color: 'var(--text-muted)' }}>
              Menampilkan {Math.min(filteredCities.length, 80)} dari {filteredCities.length} kota & kabupaten
            </span>
          </div>

          {/* Hasil nama tempat bebas (desa/kampung) dari OpenStreetMap */}
          {(remoteLoading || remoteResults.length > 0) && (
            <div style={{ marginBottom: '0.85rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: '700', color: 'var(--text-muted)', display: 'block', marginBottom: '0.45rem' }}>
                {remoteLoading ? 'Mencari nama tempat lain...' : 'Nama tempat lain (desa/kampung):'}
              </span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.4rem' }}>
                {remoteResults.map((place) => {
                  const detail = (place.display_name || '')
                    .split(',')
                    .map((x) => x.trim())
                    .filter((x) => x && x !== place.name && x !== 'Indonesia')
                    .slice(0, 2)
                    .join(', ');
                  return (
                    <button
                      key={place.place_id || place.osm_id}
                      onClick={() => handleSelectRemotePlace(place)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        gap: '0.5rem', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)',
                        border: 'var(--border-thick)', backgroundColor: 'var(--bg-muted)',
                        cursor: 'pointer', textAlign: 'left', color: 'var(--text-main)'
                      }}
                    >
                      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span style={{ fontSize: '0.85rem', fontWeight: '700', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {place.name || place.display_name.split(',')[0]}
                        </span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {detail}
                        </span>
                      </span>
                      <MapPin size={14} strokeWidth={2.5} style={{ flexShrink: 0, color: 'var(--color-accent)' }} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {filteredCities.length === 0 && remoteResults.length === 0 && !remoteLoading ? (
            <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-muted)' }}>
              <p style={{ fontSize: '0.95rem', fontWeight: '700', margin: 0, color: 'var(--text-main)' }}>Tidak ditemukan kota "{searchTerm}".</p>
              <p style={{ fontSize: '0.8rem', marginTop: '0.35rem' }}>
                Periksa ejaan, atau cari nama desa/kampung Anda, atau gunakan tombol GPS di halaman utama.
              </p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.45rem' }}>
              {filteredCities.slice(0, 80).map((city) => {
                const isSelected = currentCityCleanName ? currentCityCleanName === city.name : false;
                return (
                  <div
                    key={city.name}
                    onMouseEnter={() => prefetchCityData(city)}
                    onTouchStart={() => prefetchCityData(city)}
                    onClick={() => {
                      triggerHaptic(12);
                      onSelectCity(city);
                      onClose();
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.75rem 1rem',
                      borderRadius: 'var(--radius-md)',
                      backgroundColor: isSelected ? 'var(--color-secondary-bg)' : 'var(--bg-muted)',
                      border: isSelected ? '2px solid var(--color-secondary)' : 'var(--border-thick)',
                      cursor: 'pointer',
                      transition: 'transform var(--anim-fast)'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', minWidth: 0 }}>
                      <div style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: 'var(--radius-full)',
                        backgroundColor: isSelected ? 'var(--color-secondary)' : 'var(--bg-card)',
                        color: isSelected ? '#fff' : 'var(--color-secondary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0
                      }}>
                        <MapPin size={15} strokeWidth={2.5} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ fontSize: '0.9rem', color: isSelected ? 'var(--color-secondary)' : 'var(--text-main)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {city.name}
                        </strong>
                        <span style={{ fontSize: '0.725rem', color: 'var(--text-muted)', fontWeight: '600', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {city.province} • {city.region}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                      {isSelected ? (
                        <span style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--color-secondary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--color-secondary-bg)', border: '1px solid var(--color-secondary)' }}>
                          Aktif
                        </span>
                      ) : (
                        <ChevronRight size={16} color="var(--text-muted)" strokeWidth={2.5} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer info */}
        <div style={{ padding: '0.85rem 1.25rem', borderTop: 'var(--border-thick)', backgroundColor: 'var(--bg-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-muted)' }}>
          <span>Tekan ESC untuk menutup</span>
          <span>BMKG Official 38 Provinsi (515 Wilayah)</span>
        </div>
      </div>
    </div>
  );
}

export default CitySearchModal;
