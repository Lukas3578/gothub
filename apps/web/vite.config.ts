import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@forge/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@': resolve(__dirname, 'src'),
    },
  },

  server: {
    port: 5173,
    host: true,
    allowedHosts: [
      'gothub-q0p7.onrender.com',
    ],
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-highlight': ['highlight.js/lib/common'],
          'vendor-markdown': ['marked'],
        },
      },
    },
  },
});
