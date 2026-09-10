/**
 * Tests for API-key auth coverage of the Swagger UI / OpenAPI spec routes.
 *
 * Regression guard for #81: /documentation and its specs sit outside the
 * /api/v1 prefix and must still require the API key when API_KEY is set.
 *
 * CouchDB, Strom client, and the WS controller are mocked — no real services
 * required. API_KEY is set before importing the server so config.apiKey (read
 * once at module load) picks it up.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;

// ---------------------------------------------------------------------------
// Mock CouchDB
// ---------------------------------------------------------------------------

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// Mock WebSocket controller (avoids startup side effects)
// ---------------------------------------------------------------------------

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock StromClient / flow-generator (imported transitively via routes)
// ---------------------------------------------------------------------------

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = { version: vi.fn(), iceServers: vi.fn() };
    flows = {
      get: vi.fn(),
      start: vi.fn().mockResolvedValue({}),
      stop: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    mixer = { multiviewEndpoint: vi.fn() };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let buildServer: typeof import('../server.js').buildServer;

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
});

describe('Swagger UI / OpenAPI spec auth (#81)', () => {
  const specPaths = ['/documentation/json', '/documentation/yaml'];

  it('rejects the Swagger UI page without an API key when API_KEY is set', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/documentation' });
    expect(res.statusCode).toBe(401);
  });

  it.each(specPaths)('rejects %s without an API key when API_KEY is set', async (url) => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an OpenAPI spec request with a wrong API key', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/documentation/json',
      headers: { authorization: 'Bearer wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('serves the OpenAPI spec with the correct API key', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/documentation/json',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('openapi');
  });

  it('still exempts health probes from auth', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).not.toBe(401);
  });
});
