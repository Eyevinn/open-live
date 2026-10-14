/**
 * Self-hosted / BYO-Strom zero-reporting (issue #500 AC: "Productions on a
 * self-hosted or BYO Strom report zero shared-GPU time"). With GPU_POOL unset,
 * metering is off: /api/v1/usage/gpu returns hours:[] and /metrics emits no
 * osc_gpu_* samples — EVEN IF productions carry historical gpuHours buckets — so
 * an instance that is not on the managed shared GPU never reports non-zero time.
 *
 * API_KEY is set (auth still enforced); GPU_POOL is explicitly unset.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
delete process.env['GPU_POOL'];

const mockFindTrusted = vi.fn(async () => ({
  // Even a production that somehow carries buckets must not be reported when
  // metering is disabled.
  docs: [{ _id: 'prod-9', type: 'production', status: 'active', activatedAt: '2026-10-13T12:00:00Z', gpuHours: { '2026-10-13T11:00:00Z': 3600 } }],
}));

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

let app: FastifyInstance;
const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

describe('shared-GPU metering disabled (GPU_POOL unset)', () => {
  it('reports zero on /api/v1/usage/gpu (hours:[])', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/usage/gpu', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.standard).toBe('osc-gpu-usage/v1');
    expect(body.basis).toBe('allocation');
    expect(body.hours).toEqual([]);
  });

  it('emits no osc_gpu_* samples on /metrics (headers only)', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: AUTH });
    expect(res.statusCode).toBe(200);
    // HELP/TYPE header lines are still present, but there are no sample lines.
    expect(res.body).toContain('# TYPE osc_gpu_seconds_total counter');
    expect(res.body).toContain('# TYPE osc_gpu_active gauge');
    expect(res.body).not.toMatch(/^osc_gpu_seconds_total\{/m);
    expect(res.body).not.toMatch(/^osc_gpu_active\{/m);
  });
});
