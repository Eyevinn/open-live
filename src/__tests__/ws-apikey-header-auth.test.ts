/**
 * Tests for API-key auth on the WebSocket upgrade (#49).
 *
 * Previously the server accepted the API key via a `?key=<secret>` query
 * parameter on the WS upgrade. Reverse proxies, CDNs, and browser DevTools log
 * the full request URL, so a static (non-expiring) key placed there leaks into
 * access logs as permanent credentials.
 *
 * The key is now carried in a header instead, and `?key=` is no longer accepted:
 *   - `Authorization: Bearer <key>` for REST / non-browser WS clients, and
 *   - the `Sec-WebSocket-Protocol` subprotocol `openlive.bearer.<key>` for
 *     browser WebSocket clients (which can't set arbitrary headers). The client
 *     also offers the plain `openlive.bearer` marker, which the server echoes
 *     back so the secret is never reflected into the handshake response.
 *
 * The API-key check lives in the server's onRequest hook (src/server.ts), which
 * runs for the WS upgrade GET request before the socket is upgraded. We mock the
 * WS controller with a plain GET handler so `app.inject` can drive the upgrade
 * request through the real auth hook without needing a live socket: a 401 means
 * the hook rejected the request, any other status means auth passed and the
 * request reached the (mocked) handler.
 *
 * CouchDB, Strom, and the WS controller are mocked — no real services required.
 * API_KEY is set before importing the server so config.apiKey (read once at
 * module load) picks it up.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;

const WS_PATH = '/ws/productions/prod-1/controller';

// ---------------------------------------------------------------------------
// Mock CouchDB
// ---------------------------------------------------------------------------

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn().mockResolvedValue(null), insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// Mock the WS controller with a plain GET handler on the same path so the auth
// hook can be exercised via app.inject (no live socket required). Reaching this
// handler (non-401) proves the onRequest auth hook let the request through.
// ---------------------------------------------------------------------------

vi.mock('../ws/controller.js', () => ({
  default: async (fastify: import('fastify').FastifyInstance) => {
    fastify.get('/ws/productions/:id/controller', async () => ({ upgraded: true }));
  },
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
    flows = { get: vi.fn(), start: vi.fn().mockResolvedValue({}), stop: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue({}) };
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

describe('WebSocket upgrade API-key auth (#49)', () => {
  it('accepts the upgrade with the key in the Sec-WebSocket-Protocol subprotocol', async () => {
    const app = await buildServer();
    // Browser pattern: new WebSocket(url, ['openlive.bearer', `openlive.bearer.${key}`]).
    const res = await app.inject({
      method: 'GET',
      url: WS_PATH,
      headers: { 'sec-websocket-protocol': `openlive.bearer, openlive.bearer.${TEST_API_KEY}` },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('accepts the upgrade with the key in the Authorization header', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: WS_PATH,
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('rejects an upgrade that carries the key only in the ?key= query string', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: `${WS_PATH}?key=${TEST_API_KEY}` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an upgrade with a wrong subprotocol key', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: WS_PATH,
      headers: { 'sec-websocket-protocol': 'openlive.bearer, openlive.bearer.wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an upgrade offering only the plain marker (no key)', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: WS_PATH,
      headers: { 'sec-websocket-protocol': 'openlive.bearer' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an upgrade with no credentials at all', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: WS_PATH });
    expect(res.statusCode).toBe(401);
  });
});
