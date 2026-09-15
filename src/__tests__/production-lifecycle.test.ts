/**
 * Integration tests for the production lifecycle + output health feature
 * (issue #255, spec docs/specs/production-lifecycle-health.md).
 *
 * Covers the three `active → ended` stop paths (explicit deactivate,
 * idle-watchdog auto-deactivate, startup reconcile), that a never-activated
 * production stays `inactive`, the REST `Output.status` derivation
 * (healthy / down / unknown), and the WS `PRODUCTION_STATUS` lifecycle event
 * (broadcast on transition + connect snapshot). CouchDB and Strom are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebSocket } from '@fastify/websocket';

// ---------------------------------------------------------------------------
// Mock CouchDB — the same handle backs productions and outputs collections.
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockFind = vi.fn();
const mockFindTrusted = vi.fn();
const mockOutputGet = vi.fn();
const mockOutputFind = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: mockFind, findTrusted: mockFindTrusted }),
  getOutputsDb: () => ({ get: mockOutputGet, find: mockOutputFind, insert: mockInsert, destroy: vi.fn() }),
  getSourcesDb: () => ({ get: mockGet }),
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

const mockDeactivateStromFlow = vi.fn();
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));

const mockStromFlowsList = vi.fn();
vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = { list: mockStromFlowsList, get: vi.fn(), start: vi.fn(), stop: vi.fn(), delete: vi.fn() };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

import { buildServer } from '../server.js';
import { subscribe, unsubscribe } from '../services/tally.service.js';
import { deactivateProduction } from '../services/idle-watchdog.js';
import { reconcileProductionStatuses } from '../services/reconcile.js';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
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

/** Minimal fake WebSocket that records everything sent to it. */
class FakeWs {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  send(payload: string): void { this.sent.push(payload); }
  messages(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s)); }
}

const silentLog = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} as unknown as import('fastify').FastifyBaseLogger;

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockResolvedValue({ docs: [] });
  mockFindTrusted.mockResolvedValue({ docs: [] });
});

// ---------------------------------------------------------------------------
// Stop path 1: explicit deactivate
// ---------------------------------------------------------------------------

describe('explicit deactivate — active → ended, activating → inactive (spec §1)', () => {
  it('an active production that is deactivated becomes ended (endedReason: deactivated)', async () => {
    const doc = makeProductionDoc({ status: 'active', stromFlowId: 'flow-abc', mixerBlockId: 'mixer-1' });
    mockGet.mockResolvedValue(doc);
    mockDeactivateStromFlow.mockResolvedValue(undefined);
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-test-1/deactivate' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ended');
    const inserted = mockInsert.mock.calls[0][0];
    expect(inserted.status).toBe('ended');
    expect(inserted.endedReason).toBe('deactivated');
    expect(inserted.stromFlowId).toBeUndefined();
  });

  it('an activating production that is deactivated stays inactive (never broadcast)', async () => {
    const doc = makeProductionDoc({ status: 'activating', stromFlowId: 'flow-abc' });
    mockGet.mockResolvedValue(doc);
    mockDeactivateStromFlow.mockResolvedValue(undefined);
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-test-1/deactivate' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('inactive');
    const inserted = mockInsert.mock.calls[0][0];
    expect(inserted.status).toBe('inactive');
    expect(inserted.endedReason).toBeUndefined();
  });

  it('a never-activated (inactive) production stays inactive on deactivate', async () => {
    const doc = makeProductionDoc({ status: 'inactive' });
    mockGet.mockResolvedValue(doc);
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-test-1/deactivate' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('inactive');
    expect(mockInsert.mock.calls[0][0].status).toBe('inactive');
  });

  it('broadcasts PRODUCTION_STATUS { status: ended } to subscribers on deactivate', async () => {
    const doc = makeProductionDoc({
      status: 'active',
      stromFlowId: 'flow-abc',
      mixerBlockId: 'mixer-1',
      outputAssignments: [{ outputId: 'out-1' }, { outputId: 'out-2' }],
    });
    mockGet.mockResolvedValue(doc);
    mockDeactivateStromFlow.mockResolvedValue(undefined);
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });

    const ws = new FakeWs();
    subscribe('prod-test-1', ws as unknown as WebSocket);

    const app = await buildServer();
    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-test-1/deactivate' });

    const statusEvt = ws.messages().find((m) => m.type === 'PRODUCTION_STATUS');
    expect(statusEvt).toBeDefined();
    expect(statusEvt!.productionId).toBe('prod-test-1');
    expect(statusEvt!.status).toBe('ended');
    expect(typeof statusEvt!.ts).toBe('string'); // stamped by broadcast()
    // Flow torn down → all assigned outputs derive as down.
    expect(statusEvt!.outputs).toEqual([
      { id: 'out-1', status: 'down' },
      { id: 'out-2', status: 'down' },
    ]);

    unsubscribe('prod-test-1', ws as unknown as WebSocket);
  });
});

// ---------------------------------------------------------------------------
// Stop path 2: idle-watchdog auto-deactivate
// ---------------------------------------------------------------------------

describe('idle-watchdog auto-deactivate — active → ended (spec §1)', () => {
  it('an idle active production becomes ended (endedReason: idle, autoDeactivated)', async () => {
    const doc = makeProductionDoc({ status: 'active', stromFlowId: 'flow-abc', outputAssignments: [{ outputId: 'out-1' }] });
    mockGet.mockResolvedValue(doc);
    mockDeactivateStromFlow.mockResolvedValue(undefined);
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });

    await deactivateProduction('prod-test-1', silentLog);

    const inserted = mockInsert.mock.calls[0][0];
    expect(inserted.status).toBe('ended');
    expect(inserted.endedReason).toBe('idle');
    expect(inserted.autoDeactivated).toBe(true);
  });

  it('an idle activating production resets to inactive (never broadcast)', async () => {
    const doc = makeProductionDoc({ status: 'activating', stromFlowId: 'flow-abc' });
    mockGet.mockResolvedValue(doc);
    mockDeactivateStromFlow.mockResolvedValue(undefined);
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });

    await deactivateProduction('prod-test-1', silentLog);

    const inserted = mockInsert.mock.calls[0][0];
    expect(inserted.status).toBe('inactive');
    expect(inserted.endedReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stop path 3: startup reconcile finds the Strom flow gone
// ---------------------------------------------------------------------------

describe('startup reconcile — flow gone: active → ended, activating → inactive (spec §1)', () => {
  it('an active production whose flow disappeared becomes ended (endedReason: flow-lost)', async () => {
    mockStromFlowsList.mockResolvedValue({ flows: [] }); // no live flows
    mockFind.mockResolvedValue({
      docs: [makeProductionDoc({ status: 'active', stromFlowId: 'flow-gone' })],
    });
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true });

    await reconcileProductionStatuses(silentLog);

    const inserted = mockInsert.mock.calls[0][0];
    expect(inserted.status).toBe('ended');
    expect(inserted.endedReason).toBe('flow-lost');
    expect(inserted.stromFlowId).toBeUndefined();
  });

  it('an activating production whose flow never appeared resets to inactive', async () => {
    mockStromFlowsList.mockResolvedValue({ flows: [] });
    mockFind.mockResolvedValue({
      docs: [makeProductionDoc({ status: 'activating', stromFlowId: 'flow-gone' })],
    });
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true });

    await reconcileProductionStatuses(silentLog);

    const inserted = mockInsert.mock.calls[0][0];
    expect(inserted.status).toBe('inactive');
    expect(inserted.endedReason).toBeUndefined();
  });

  it('does not touch a production whose flow is still live', async () => {
    mockStromFlowsList.mockResolvedValue({ flows: [{ id: 'flow-live' }] });
    mockFind.mockResolvedValue({
      docs: [makeProductionDoc({ status: 'active', stromFlowId: 'flow-live' })],
    });

    await reconcileProductionStatuses(silentLog);

    expect(mockInsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Output.status derivation via REST (GET /api/v1/outputs)
// ---------------------------------------------------------------------------

describe('GET /api/v1/outputs — derived Output.status (spec §2)', () => {
  it('healthy when the output is assigned to a running active production', async () => {
    mockOutputFind.mockResolvedValue({
      docs: [{ _id: 'out-1', type: 'output', name: 'SRT Out', outputType: 'mpegtssrt', createdAt: '', updatedAt: '' }],
    });
    mockFindTrusted.mockResolvedValue({
      docs: [{ stromFlowId: 'flow-abc', outputAssignments: [{ outputId: 'out-1' }] }],
    });

    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/outputs' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body[0].status).toBe('healthy');
  });

  it('down when the output is not assigned to any running active production', async () => {
    mockOutputFind.mockResolvedValue({
      docs: [{ _id: 'out-1', type: 'output', name: 'SRT Out', outputType: 'mpegtssrt', createdAt: '', updatedAt: '' }],
    });
    mockFindTrusted.mockResolvedValue({ docs: [] }); // no active productions

    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/outputs' });

    expect(JSON.parse(res.body)[0].status).toBe('down');
  });

  it('unknown when the production DB cannot be queried for health', async () => {
    mockOutputFind.mockResolvedValue({
      docs: [{ _id: 'out-1', type: 'output', name: 'SRT Out', outputType: 'mpegtssrt', createdAt: '', updatedAt: '' }],
    });
    mockFindTrusted.mockRejectedValue(new Error('CouchDB unreachable'));

    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/outputs' });

    expect(JSON.parse(res.body)[0].status).toBe('unknown');
  });

  it('down when an active production has no live stromFlowId', async () => {
    mockOutputFind.mockResolvedValue({
      docs: [{ _id: 'out-1', type: 'output', name: 'SRT Out', outputType: 'mpegtssrt', createdAt: '', updatedAt: '' }],
    });
    mockFindTrusted.mockResolvedValue({
      docs: [{ stromFlowId: undefined, outputAssignments: [{ outputId: 'out-1' }] }],
    });

    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/outputs' });

    expect(JSON.parse(res.body)[0].status).toBe('down');
  });
});
