import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const DAEMON_URL = process.env.SISYPHUS_DAEMON_URL ?? 'http://localhost:8787';
const DAEMON_WS_URL = DAEMON_URL.replace(/^http/, 'ws');

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
      '/ws': {
        target: DAEMON_WS_URL,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    // In production, externalize React so the importmap in index.html
    // resolves it to the same URL plugin bundles do. Host and plugins
    // share one React instance — vital because hooks identity has to
    // cross module boundaries.
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    },
  },
});
