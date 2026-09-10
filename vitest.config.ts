import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Exclude the tsc build output — without this, running `build` before
    // `test` (as CI does) makes vitest pick up compiled dist/__tests__/*.js
    // alongside src/__tests__/*.ts and double-report every test.
    exclude: ['**/node_modules/**', 'dist/**'],
    // Use forks pool so vi.mock works properly with ESM
    pool: 'forks',
    // Provide env vars required by config.ts
    env: {
      COUCHDB_URL: 'http://localhost:5984',
      COUCHDB_NAME: 'open-live-test',
      CORS_ORIGIN: 'http://localhost:5173',
      STROM_URL: 'http://localhost:7000',
      LOG_LEVEL: 'silent',
    },
  },
});
