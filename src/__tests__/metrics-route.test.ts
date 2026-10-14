/**
 * Route tests for GET /metrics (issue #500, Prometheus exposition).
 *
 * The critical property: /metrics is a TOP-LEVEL path, so keeping it out of
 * AUTH_EXEMPT_PATHS is necessary but NOT sufficient — the shared-key gate only
 * guards known prefixes. This asserts the guarded-prefix extension actually
 * authenticates it: no token → 401 (the rejection branch), and a valid token →
 * 200 with both metric families (the success case the team rule requires
 * alongside the rejection test).
 *
 * API_KEY + GPU_POOL are set before import so auth is enforced and metering is on.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
process.env['GPU_POOL'] = 'fra-1';
process.env['GPU_CLASS'] = 'shared';

const mockFindTrusted = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), findTrusted: mockFindTrusted }),
  getGpuUsageLedgerDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), findTrusted: vi.fn(async () => ({ docs: [] })), destroy: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGraphicsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getConfigsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGatewaysDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getRecordingsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGuestInvitesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGuestSessionsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
  clearClipStateForProduction: vi.fn(),
}));

let buildServer: typeof import('../server.js').buildServer;
let app: FastifyInstance;

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
  app = await buildServer();
});

describe('GET /metrics (#500)', () => {
  it('rejects a request without a bearer token (401) — the exempt-list trap', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('returns Prometheus text with both families for a valid token', async () => {
    mockFindTrusted.mockResolvedValue({
      docs: [
        { _id: 'prod-17', type: 'production', status: 'active', activatedAt: '2026-10-13T12:00:00Z', gpuHours: {} },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('# TYPE osc_gpu_seconds_total counter');
    expect(res.body).toContain('# TYPE osc_gpu_active gauge');
    expect(res.body).toContain('osc_gpu_active{tenant="unattributed",gpu_pool="fra-1"} 1');
  });
});
