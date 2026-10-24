import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@forge/shared': resolve(__dirname, '../../packages/shared/src/index.ts') },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    testTimeout: 15_000,
  },
});
