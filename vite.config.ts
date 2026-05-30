import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8888,
    proxy: {
      '/api/auth': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      '/api/market': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      // MTM Analyzer — REST APIs proxied to Go backend
      '/api/historical': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      '/api/optionchain': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      '/api/instruments': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      // MTM Analyzer — Rust WS bridge (direct, no Vite WS intercept needed;
      // browser connects to :3003 directly so no proxy entry required here)
    },
  },
});
