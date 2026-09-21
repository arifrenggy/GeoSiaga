import { useState, useEffect } from 'react';

export function useDarkMode() {
  const [isDark, setIsDark] = useState(() => {
    try {
      const saved = localStorage.getItem('geosiaga-theme');
      if (saved !== null) {
        return saved === 'dark';
      }
    } catch (e) {}
    // Default explicitly to Light Mode
    return false;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.setAttribute('data-theme', 'dark');
      try {
        localStorage.setItem('geosiaga-theme', 'dark');
      } catch (e) {}
    } else {
      root.removeAttribute('data-theme');
      try {
        localStorage.setItem('geosiaga-theme', 'light');
      } catch (e) {}
    }
  }, [isDark]);

  const toggleDarkMode = () => setIsDark(prev => !prev);

  return { isDark, toggleDarkMode };
}
