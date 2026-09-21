/**
 * Regression guard: the studio calls POST /api/v1/auth/token with
 * `credentials: 'include'` (open-live-studio's sat.ts) to ride the OSC
 * proxy/same-origin session. When CORS is registered with `credentials: false`,
 * @fastify/cors omits Access-Control-Allow-Credentials entirely, which browsers
 * report as an empty header value and reject as a failed preflight for any
 * credentialed request — regardless of the origin allow-list. See the CORS
 * registration in ../server.ts.
 *
 * CouchDB, Strom client, and the WS controller are mocked — no real services
 * required. CORS_ORIGIN is set to a specific origin before importing the
 * server so config.corsOrigin (read once at module load) reflects it.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

process.env['CORS_ORIGIN'] = 'https://studio.example.com';

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

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

let buildServer: typeof import('../server.js').buildServer;

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
});

describe('CORS credentials for allowed origins', () => {
  it('sets Access-Control-Allow-Credentials: true on a credentialed preflight', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/token',
      headers: {
        origin: 'https://studio.example.com',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});
