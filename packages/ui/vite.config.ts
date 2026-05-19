import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const DAEMON_URL = process.env.SISYPHUS_DAEMON_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: DAEMON_URL,
        changeOrigin: true,
      },
    },
  },
});
