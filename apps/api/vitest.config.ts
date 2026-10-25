import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@forge/shared': resolve(__dirname, '../../packages/shared/src/index.ts') },
  },
  test: {
    // Legt vor dem Lauf eine frische Testdatenbank als Datei an.
    globalSetup: ['./vitest.globalSetup.ts'],
    // Die Tests teilen sich eine Datenbank und echte Repositories auf der
    // Platte; parallele Dateien würden sich gegenseitig stören.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    environment: 'node',
  },
});
