/**
 * Deactivate is idempotent: overlapping requests for the same production share
 * one teardown, and a CouchDB revision conflict on the final write does not
 * turn a completed teardown into a 500. CouchDB and Strom are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockInsert = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn(), findTrusted: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn(), find: vi.fn(), insert: vi.fn(), destroy: vi.fn() }),
  getSourcesDb: () => ({ get: mockGet }),
  getGuestInvitesDb: () => ({ find: vi.fn(async () => ({ docs: [] })), destroy: vi.fn() }),
  getGuestSessionsDb: () => ({ find: vi.fn(async () => ({ docs: [] })), insert: vi.fn() }),
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

const mockDeactivateStromFlow = vi.fn();
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

import { buildServer } from '../server.js';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'prod-test-1',
    _rev: '115-abc',
    type: 'production',
    name: 'Test Production',
    status: 'active',
    stromFlowId: 'flow-abc',
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

function conflict(): Error {
  return Object.assign(new Error('Document update conflict.'), { statusCode: 409 });
}

const url = '/api/v1/productions/prod-test-1/deactivate';

/** Let injected requests get through Fastify's hooks to the route handler. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Drop any unconsumed *Once values so one failing test cannot feed the next.
  mockGet.mockReset();
  mockInsert.mockReset();
  mockDeactivateStromFlow.mockReset();
});

describe('overlapping deactivates of one production', () => {
  it('share a single teardown and all return 200 with the same result', async () => {
    mockGet.mockResolvedValue(makeProductionDoc());
    mockInsert.mockResolvedValue({ ok: true, id: 'prod-test-1', rev: '116-def' });
    let releaseTeardown!: () => void;
    mockDeactivateStromFlow.mockReturnValue(new Promise<void>((resolve) => { releaseTeardown = resolve; }));

    const app = await buildServer();
    const first = app.inject({ method: 'POST', url });
    await vi.waitFor(() => expect(mockDeactivateStromFlow).toHaveBeenCalled());
    const second = app.inject({ method: 'POST', url });
    const third = app.inject({ method: 'POST', url });
    await settle();
    releaseTeardown();

    const responses = await Promise.all([first, second, third]);
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: 'prod-test-1', name: 'Test Production', status: 'ended', _rev: '116-def' });
    }
    expect(mockDeactivateStromFlow).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('a deactivate after the previous one finished runs again', async () => {
    mockGet.mockResolvedValueOnce(makeProductionDoc());
    mockGet.mockResolvedValueOnce(makeProductionDoc({ _rev: '116-def', status: 'inactive', stromFlowId: undefined }));
    mockInsert.mockResolvedValueOnce({ ok: true, id: 'prod-test-1', rev: '116-def' });
    mockInsert.mockResolvedValueOnce({ ok: true, id: 'prod-test-1', rev: '117-efg' });
    mockDeactivateStromFlow.mockResolvedValue(undefined);

    const app = await buildServer();
    const first = await app.inject({ method: 'POST', url });
    const second = await app.inject({ method: 'POST', url });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toMatchObject({ status: 'inactive', _rev: '117-efg' });
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });

  it('a failed run fails every request that joined it, and the next request starts fresh', async () => {
    mockGet.mockResolvedValue(makeProductionDoc());
    let failTeardown!: (err: Error) => void;
    mockDeactivateStromFlow.mockReturnValueOnce(new Promise<void>((_, reject) => { failTeardown = reject; }));
    mockDeactivateStromFlow.mockResolvedValue(undefined);
    mockInsert.mockResolvedValue({ ok: true, id: 'prod-test-1', rev: '116-def' });

    const app = await buildServer();
    const first = app.inject({ method: 'POST', url });
    await vi.waitFor(() => expect(mockDeactivateStromFlow).toHaveBeenCalled());
    const joined = app.inject({ method: 'POST', url });
    await settle();
    failTeardown(new Error('strom unreachable'));

    expect((await first).statusCode).toBe(500);
    expect((await joined).statusCode).toBe(500);

    const retry = await app.inject({ method: 'POST', url });
    expect(retry.statusCode).toBe(200);
    expect(mockDeactivateStromFlow).toHaveBeenCalledTimes(2);
  });
});

describe('revision conflict on the final write', () => {
  it('re-applies the deactivation when only an unrelated field changed', async () => {
    mockGet.mockResolvedValueOnce(makeProductionDoc());
    // A tally write and a rename landed while the teardown ran.
    mockGet.mockResolvedValueOnce(makeProductionDoc({ _rev: '116-tally', name: 'Renamed', tally: { pgm: 'src-1', pvw: null } }));
    mockInsert.mockRejectedValueOnce(conflict());
    mockInsert.mockResolvedValueOnce({ ok: true, id: 'prod-test-1', rev: '117-def' });
    mockDeactivateStromFlow.mockResolvedValue(undefined);

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: 'prod-test-1', name: 'Renamed', status: 'ended', _rev: '117-def' });
    const retried = mockInsert.mock.calls[1][0];
    expect(retried._rev).toBe('116-tally');
    expect(retried.status).toBe('ended');
    expect(retried.endedReason).toBe('deactivated');
    expect(retried.stromFlowId).toBeUndefined();
    expect(retried.tally).toEqual({ pgm: null, pvw: null });
  });

  it('keeps the status another stop path wrote and clears the refs it left behind', async () => {
    mockGet.mockResolvedValueOnce(makeProductionDoc({ intercomProductionId: 'ic-1' }));
    // The idle watchdog auto-deactivated the production meanwhile. It does not
    // clear the intercom grouping, which this run has already torn down.
    mockGet.mockResolvedValueOnce(makeProductionDoc({
      _rev: '116-idle', status: 'ended', endedReason: 'idle', stromFlowId: undefined, intercomProductionId: 'ic-1',
    }));
    mockInsert.mockRejectedValueOnce(conflict());
    mockInsert.mockResolvedValueOnce({ ok: true, id: 'prod-test-1', rev: '117-def' });
    mockDeactivateStromFlow.mockResolvedValue(undefined);

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: 'prod-test-1', name: 'Test Production', status: 'ended', _rev: '117-def' });
    const retried = mockInsert.mock.calls[1][0];
    expect(retried._rev).toBe('116-idle');
    expect(retried.status).toBe('ended');
    expect(retried.endedReason).toBe('idle');
    expect(retried.intercomProductionId).toBeUndefined();
  });

  it('does not drop an intercom grouping a guest created during the teardown', async () => {
    mockGet.mockResolvedValueOnce(makeProductionDoc());
    // A guest's join provisioned a talkback grouping after this run read the doc.
    mockGet.mockResolvedValueOnce(makeProductionDoc({ _rev: '116-guest', intercomProductionId: 'ic-new' }));
    mockInsert.mockRejectedValueOnce(conflict());
    mockDeactivateStromFlow.mockResolvedValue(undefined);

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url });

    // The request fails and the stored doc keeps the grouping, so the next
    // deactivate tears it down.
    expect(res.statusCode).toBe(500);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a production that now runs a different flow', async () => {
    mockGet.mockResolvedValueOnce(makeProductionDoc({ status: 'inactive', stromFlowId: undefined }));
    mockGet.mockResolvedValueOnce(makeProductionDoc({ _rev: '116-act', status: 'activating', stromFlowId: 'flow-new' }));
    mockInsert.mockRejectedValueOnce(conflict());

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url });

    expect(res.statusCode).toBe(500);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('gives up after repeated conflicts', async () => {
    mockGet.mockResolvedValue(makeProductionDoc());
    mockInsert.mockRejectedValue(conflict());
    mockDeactivateStromFlow.mockResolvedValue(undefined);

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url });

    expect(res.statusCode).toBe(500);
    expect(mockInsert).toHaveBeenCalledTimes(3);
  });
});
