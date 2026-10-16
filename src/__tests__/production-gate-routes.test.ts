/**
 * Route-level tests for the zero-balance start gate (issue #523) on
 * POST /api/v1/productions/:id/activate and GET /metrics.
 *
 * GPU_POOL + OSC_ACCESS_TOKEN are set before import so the instance is metered
 * and the gate can look up the balance. Global fetch is the balance source.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
process.env['GPU_POOL'] = 'fra-1';
process.env['GPU_CLASS'] = 'shared';
process.env['OSC_ACCESS_TOKEN'] = 'pat-test';

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockFind = vi.fn();
const mockFindTrusted = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: mockFind, findTrusted: mockFindTrusted }),
  getGpuUsageLedgerDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), findTrusted: vi.fn(async () => ({ docs: [] })), destroy: vi.fn() }),
  getSourcesDb: () => ({ get: mockGet }),
  getOutputsDb: () => ({ get: mockGet }),
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

const mockActivateStromFlow = vi.fn();
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: (...args: unknown[]) => mockActivateStromFlow(...args),
  deactivateStromFlow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

let buildServer: typeof import('../server.js').buildServer;
let resetGate: () => void;
let app: FastifyInstance;

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };
const fetchMock = vi.fn();

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'prod-test-1',
    _rev: '1-abc',
    type: 'production',
    name: 'Test Production',
    status: 'inactive',
    sources: [],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function balance(remainingTokens: number, status = 200): Response {
  return new Response(JSON.stringify({ remainingTokens }), { status });
}

async function activate() {
  return app.inject({ method: 'POST', url: '/api/v1/productions/prod-test-1/activate', headers: AUTH });
}

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
  ({ resetProductionGateCounters: resetGate } = await import('../services/production-gate.js'));
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Fresh app per test: /activate is rate limited (5/min) per app instance.
  app = await buildServer();
  vi.stubGlobal('fetch', fetchMock);
  resetGate();
  mockFind.mockResolvedValue({ docs: [] });
  mockFindTrusted.mockResolvedValue({ docs: [] });
  mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: 'prod-test-1' });
  mockActivateStromFlow.mockReturnValue(new Promise(() => {}));
});

describe('POST /activate balance gate (#523)', () => {
  it.each([0, -10])('refuses a new start at balance %s with 402 and the hours message', async (bal) => {
    mockGet.mockResolvedValue(makeDoc());
    fetchMock.mockResolvedValue(balance(bal));

    const res = await activate();

    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('hours');
    expect(body.error.toLowerCase()).not.toContain('token');
    // Nothing was written: the production is not left half-activated.
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockActivateStromFlow).not.toHaveBeenCalled();
  });

  it('allows a new start at balance 1 (passing path)', async () => {
    mockGet.mockResolvedValue(makeDoc());
    fetchMock.mockResolvedValue(balance(1));

    const res = await activate();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('activating');
  });

  it('allows the start when the balance lookup fails (fail open) and counts the error', async () => {
    mockGet.mockResolvedValue(makeDoc());
    fetchMock.mockRejectedValue(new Error('money-manager down'));

    const res = await activate();

    expect(res.statusCode).toBe(200);
    const metrics = await app.inject({ method: 'GET', url: '/metrics', headers: AUTH });
    expect(metrics.body).toContain('osc_production_gate_lookup_errors_total 1');
  });

  it('keeps a running production running when the balance is negative', async () => {
    const running = makeDoc({ status: 'active', activatedAt: '2026-10-15T10:00:00.000Z', stromFlowId: 'flow-1' });
    mockGet.mockResolvedValue(running);
    fetchMock.mockResolvedValue(balance(-500));

    const got = await app.inject({ method: 'GET', url: '/api/v1/productions/prod-test-1', headers: AUTH });
    expect(got.statusCode).toBe(200);
    expect(JSON.parse(got.body).status).toBe('active');

    // Re-activating an already running production is the unchanged 409; the
    // gate is not even consulted and nothing is stopped or rewritten.
    const again = await activate();
    expect(again.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('GET /metrics gate counters (#523)', () => {
  it('exposes both counters at zero before anything happens', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('osc_production_gate_lookup_errors_total 0');
    expect(res.body).toContain('osc_production_gate_refusals_total 0');
  });

  it('increments the refusal counter on a refused start', async () => {
    mockGet.mockResolvedValue(makeDoc());
    fetchMock.mockResolvedValue(balance(0));
    await activate();

    const res = await app.inject({ method: 'GET', url: '/metrics', headers: AUTH });
    expect(res.body).toContain('osc_production_gate_refusals_total 1');
  });

  it('requires the bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });
});
