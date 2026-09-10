/**
 * Tests for API-key auth coverage of POST /api/v1/reconnect.
 *
 * Regression guard for #59 (OWASP A01 Broken Access Control): /api/v1/reconnect
 * was in the auth-exempt set, letting unauthenticated callers trigger DB/Strom
 * connection attempts and read {ok, db, strom} infrastructure status. It must
 * require the API key when API_KEY is set, like other mutating endpoints.
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
    system = { version: vi.fn().mockResolvedValue({ version: '1.0.0' }), iceServers: vi.fn() };
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

describe('POST /api/v1/reconnect auth (#59)', () => {
  it('rejects reconnect without an API key when API_KEY is set', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/reconnect' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects reconnect with a wrong API key', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/reconnect',
      headers: { authorization: 'Bearer wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not leak infrastructure status without a valid key', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/reconnect' });
    const body = res.json();
    expect(body).not.toHaveProperty('db');
    expect(body).not.toHaveProperty('strom');
    expect(body).not.toHaveProperty('ok');
  });

  it('succeeds with the correct API key', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/reconnect',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, db: true, strom: true });
  });
});
