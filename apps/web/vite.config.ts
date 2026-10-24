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
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * Die Syntaxhervorhebung und der Markdown-Renderer machen den größten
         * Teil des Bündels aus und werden nur auf Datei- und Issue-Seiten
         * gebraucht. In eigene Dateien ausgelagert, lädt die Startseite sie
         * nicht mit.
         */
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-highlight': ['highlight.js/lib/common'],
          'vendor-markdown': ['marked'],
        },
      },
    },
  },
});
