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
    },
  },
});
