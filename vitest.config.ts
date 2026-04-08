import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
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
