/**
 * Tests for the heartbeat WS auth split (issue #263, ADR-001).
 *
 * The gateway heartbeat upgrade `/ws/gateways/:id/heartbeat` must BYPASS the
 * shared `API_KEY` onRequest gate — it authenticates with a per-gateway token
 * inside the handler instead. Every OTHER `/ws/` path (e.g. the controller)
 * must still require the shared key.
 *
 * We mock the heartbeat plugin with a plain GET handler on the same path so the
 * auth hook can be exercised via app.inject without a live socket: reaching the
 * handler (non-401) proves the shared-key gate let it through; a 401 proves the
 * gate rejected it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { vi } from 'vitest';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn().mockResolvedValue(null), insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getGatewaysDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }), destroy: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async (fastify: import('fastify').FastifyInstance) => {
    fastify.get('/ws/productions/:id/controller', async () => ({ upgraded: true }));
  },
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

// Plain-GET stand-in for the heartbeat plugin so the auth hook is what's tested.
vi.mock('../ws/gateway-heartbeat.js', () => ({
  default: async (fastify: import('fastify').FastifyInstance) => {
    fastify.get('/ws/gateways/:id/heartbeat', async () => ({ reached: true }));
  },
}));

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = { version: vi.fn().mockResolvedValue({ version: '1.0.0' }), iceServers: vi.fn() };
    flows = { get: vi.fn(), start: vi.fn(), stop: vi.fn(), delete: vi.fn() };
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

const HEARTBEAT = '/ws/gateways/gw-1/heartbeat';
const CONTROLLER = '/ws/productions/prod-1/controller';

describe('heartbeat WS shared-key gate exemption (ADR-001)', () => {
  it('lets the heartbeat upgrade through WITHOUT the shared API key', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: HEARTBEAT });
    // No shared-key 401: the per-gateway auth is enforced inside the handler.
    expect(res.statusCode).not.toBe(401);
  });

  it('still never accepts a credential via the ?key= query string', async () => {
    const app = await buildServer();
    // The heartbeat path is exempt from the shared gate regardless, but a
    // controller path must reject a query-string key.
    const res = await app.inject({ method: 'GET', url: `${CONTROLLER}?key=${TEST_API_KEY}` });
    expect(res.statusCode).toBe(401);
  });

  it('still requires the shared key on the controller WS path', async () => {
    const app = await buildServer();
    const noauth = await app.inject({ method: 'GET', url: CONTROLLER });
    expect(noauth.statusCode).toBe(401);
    const withauth = await app.inject({ method: 'GET', url: CONTROLLER, headers: { authorization: `Bearer ${TEST_API_KEY}` } });
    expect(withauth.statusCode).not.toBe(401);
  });
});
