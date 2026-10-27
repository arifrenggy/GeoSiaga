import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Sandbox/preview only (BASE44_PREVIEW_MODE=1): the dev server runs without the
// standalone Node server, so forward the serverless endpoints (/api/*) to the API
// service that docker-compose.base44.yml runs next to Vite. When the flag is unset
// the dev server behaves exactly as before.
const isPreviewMode = process.env.BASE44_PREVIEW_MODE === '1';
const previewProxy = {
  '/api': {
    target: process.env.BASE44_API_ORIGIN || 'http://api:8080',
    changeOrigin: true
  }
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 3000,
    ...(isPreviewMode ? { proxy: previewProxy } : {})
  },
  build: {
    target: 'esnext',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('leaflet') || id.includes('react-leaflet')) {
              return 'vendor-leaflet';
            }
            if (id.includes('recharts')) {
              return 'vendor-recharts';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            if (id.includes('react') || id.includes('react-dom')) {
              return 'vendor-react';
            }
          }
        }
      }
    }
  }
});
