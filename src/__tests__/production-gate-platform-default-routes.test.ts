/**
 * Route-level zero-balance gate (issue #523) on an OSC-managed instance on the
 * platform-hosted shared Strom with NO env override (issue #547 AC7): no
 * `GPU_POOL`, no `GPU_CLASS`. The platform default alone makes the instance
 * metered, so the gate and the meter share one predicate: a new production is
 * refused at zero balance, and a running one is never stopped.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_BEARER = 'test-secret-key';
process.env['API_KEY'] = TEST_BEARER;
delete process.env['GPU_POOL'];
delete process.env['GPU_CLASS'];
process.env['OSC_HOSTNAME'] = 'acme-myprod.eyevinn-open-live.auto.prod.osaas.io';
process.env['STROM_URL'] = 'https://strom-se-sto01.osaas.io:8080';
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

const AUTH = { authorization: `Bearer ${TEST_BEARER}` };
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

describe('POST /activate balance gate, platform default with no env override (#547 AC7)', () => {
  it('resolves metering from the platform default (no GPU_POOL)', async () => {
    const { config, isGpuMeteringEnabled } = await import('../config.js');
    expect(process.env['GPU_POOL']).toBeUndefined();
    expect(config.gpuPool).toBe('se-sto01');
    expect(config.gpuClass).toBe('shared');
    expect(config.gpuMeteringSource).toBe('platform-default');
    expect(isGpuMeteringEnabled()).toBe(true);
  });

  it.each([0, -10])('refuses a new start at balance %s with 402', async (bal) => {
    mockGet.mockResolvedValue(makeDoc());
    fetchMock.mockResolvedValue(balance(bal));

    const res = await activate();

    expect(res.statusCode).toBe(402);
    expect(fetchMock).toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockActivateStromFlow).not.toHaveBeenCalled();
  });

  it('allows a new start at balance 1', async () => {
    mockGet.mockResolvedValue(makeDoc());
    fetchMock.mockResolvedValue(balance(1));

    const res = await activate();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('activating');
  });

  it('does not stop a running production at zero balance', async () => {
    const running = makeDoc({ status: 'active', activatedAt: '2026-10-15T10:00:00.000Z', stromFlowId: 'flow-1' });
    mockGet.mockResolvedValue(running);
    fetchMock.mockResolvedValue(balance(0));

    const got = await app.inject({ method: 'GET', url: '/api/v1/productions/prod-test-1', headers: AUTH });
    expect(got.statusCode).toBe(200);
    expect(JSON.parse(got.body).status).toBe('active');

    // Re-activating a running production is the unchanged 409: the gate is not
    // consulted and nothing is stopped or rewritten.
    const again = await activate();
    expect(again.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
