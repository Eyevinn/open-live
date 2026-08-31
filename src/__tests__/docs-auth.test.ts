/**
 * Tests that the Swagger UI and OpenAPI spec routes are protected by the same
 * API-key auth guard as the rest of the API when API_KEY is configured.
 *
 * Regression test for the "Swagger UI / OpenAPI spec served without
 * authentication" security issue (#81): the auth hook previously only fired for
 * /api/v1 and /ws/ paths, leaving /documentation (+ /documentation/json,
 * /documentation/yaml) exposed.
 *
 * CouchDB, the WS controller, and Strom are mocked — no real services required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TEST_API_KEY = 'test-secret-key';

// Inject an apiKey into config so the auth hook is registered. The factory is
// hoisted above imports, so the key is written inline here (it must match
// TEST_API_KEY above).
vi.mock('../config.js', () => ({
  config: {
    port: 3000,
    couchdbUrl: 'http://localhost:5984',
    stromUrl: 'http://localhost:7000',
    stromToken: undefined,
    stromAuthMode: 'osc',
    logLevel: 'silent',
    apiKey: 'test-secret-key',
    corsOrigin: 'http://localhost:5173',
    publicBaseUrl: undefined,
  },
}));

// Mock CouchDB — the docs/spec routes don't touch the DB.
vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbConnected: () => true,
  isDbReady: vi.fn().mockResolvedValue(true),
}));

// Mock the WebSocket controller (avoids startup side effects).
vi.mock('../ws/controller.js', () => ({
  default: async () => {},
}));

import { buildServer } from '../server.js';

describe('Swagger UI / OpenAPI spec auth gating (API_KEY set)', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const specRoutes = ['/documentation/json', '/documentation/yaml'];

  it.each(specRoutes)('rejects unauthenticated GET %s with 401', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthenticated GET /documentation (UI) with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/documentation' });
    expect(res.statusCode).toBe(401);
  });

  it.each(specRoutes)('allows authenticated GET %s with valid bearer token', async (url) => {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong bearer token on /documentation/json with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/documentation/json',
      headers: { authorization: 'Bearer wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });
});
