/**
 * Route tests for `audioStreamIndex` on POST/PATCH /api/v1/sources and
 * GET /api/v1/sources/:id/audio-streams (issue #515, ADR-006 Decisions 1-3).
 * CouchDB, Strom, and the WS controller are mocked.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GatewayDoc, SourceDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;

// ---- Mock CouchDB ----
const gatewaysStore = new Map<string, GatewayDoc>();
const sourcesStore = new Map<string, SourceDoc>();

const gatewaysDb = {
  get: vi.fn(async (id: string) => {
    const doc = gatewaysStore.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(),
  destroy: vi.fn(),
  find: vi.fn(async () => ({ docs: Array.from(gatewaysStore.values()) })),
};

const sourcesDb = {
  get: vi.fn(async (id: string) => {
    const doc = sourcesStore.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(async (doc: SourceDoc) => {
    sourcesStore.set(doc._id, { ...doc, _rev: '2-x' });
    return { ok: true, id: doc._id, rev: '2-x' };
  }),
  destroy: vi.fn(async (id: string) => {
    sourcesStore.delete(id);
    return { ok: true };
  }),
  find: vi.fn(async () => ({ docs: Array.from(sourcesStore.values()) })),
  findTrusted: vi.fn(async () => ({ docs: [] })),
};

const prodDb = {
  get: vi.fn(),
  insert: vi.fn(),
  find: vi.fn(),
  findTrusted: vi.fn(async () => ({ docs: [] })),
};

vi.mock('../db/index.js', () => ({
  getDb: () => prodDb,
  getSourcesDb: () => sourcesDb,
  getGatewaysDb: () => gatewaysDb,
  getOutputsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
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
    flows = { get: vi.fn(), start: vi.fn(), stop: vi.fn(), delete: vi.fn() };
    mixer = { multiviewEndpoint: vi.fn() };
    ports = { pool: vi.fn(), reservations: { create: vi.fn(), renew: vi.fn(), release: vi.fn(), list: vi.fn(), get: vi.fn(), assign: vi.fn(), unassign: vi.fn() } };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

// Port-lease service: a listener source needs a lease + free-port check. Keep it
// permissive so the SRT create path (which our tests use) succeeds deterministically.
vi.mock('../services/port-reservation.js', () => ({
  getPortReservation: () => ({ start: 9000, end: 9100 }),
}));

vi.mock('../services/listener-ports.js', () => ({
  usedListenerPorts: vi.fn().mockResolvedValue([]),
  clashesAfterWrite: vi.fn().mockReturnValue(undefined),
  listenerPortRequest: vi.fn().mockReturnValue(9000),
  resolveListenerAddress: vi.fn((address: string) => ({ ok: true, address, port: 9000 })),
}));

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

let app: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

beforeEach(() => {
  sourcesStore.clear();
});

function seed(streamType: SourceDoc['streamType'] = 'srt', audioStreamIndex?: number): void {
  sourcesStore.set('src-1', {
    _id: 'src-1', _rev: '1-a', type: 'source', name: 'cam1',
    address: streamType === 'srt' ? 'srt://host:9000' : 'https://example.com/page',
    streamType, status: 'inactive',
    ...(audioStreamIndex !== undefined ? { audioStreamIndex } : {}),
    createdAt: 'x', updatedAt: 'x',
  });
}

describe('audioStreamIndex on POST /api/v1/sources', () => {
  it('persists and returns it for an SRT source', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/sources', headers: AUTH,
      payload: { name: 'cam1', address: 'srt://host:9000', streamType: 'srt', audioStreamIndex: 2 } });
    expect(res.statusCode).toBe(201);
    expect(res.json().audioStreamIndex).toBe(2);
    expect(sourcesStore.get(res.json().id)!.audioStreamIndex).toBe(2);
  });

  it('leaves it absent when not supplied', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/sources', headers: AUTH,
      payload: { name: 'cam1', address: 'srt://host:9000', streamType: 'srt' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().audioStreamIndex).toBeUndefined();
  });

  it('rejects it on a non-SRT/EFP source with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/sources', headers: AUTH,
      payload: { name: 'page', address: 'https://example.com/page', streamType: 'html', audioStreamIndex: 1 } });
    expect(res.statusCode).toBe(400);
    expect(sourcesStore.size).toBe(0);
  });

  it('rejects negative and non-integer values with 400', async () => {
    for (const v of [-1, 1.5]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/sources', headers: AUTH,
        payload: { name: 'cam1', address: 'srt://host:9000', streamType: 'srt', audioStreamIndex: v } });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('audioStreamIndex on PATCH /api/v1/sources/:id', () => {
  it('sets and round-trips it on an SRT source', async () => {
    seed();
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-1', headers: AUTH,
      payload: { audioStreamIndex: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().audioStreamIndex).toBe(1);
    expect(sourcesStore.get('src-1')!.audioStreamIndex).toBe(1);
  });

  it('rejects it on a non-SRT/EFP source with 400', async () => {
    seed('html');
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-1', headers: AUTH,
      payload: { audioStreamIndex: 1 } });
    expect(res.statusCode).toBe(400);
    expect(sourcesStore.get('src-1')!.audioStreamIndex).toBeUndefined();
  });
});

describe('GET /api/v1/sources/:id/audio-streams', () => {
  it('returns the unavailable shape with selectedIndex defaulting to 0', async () => {
    seed();
    const res = await app.inject({ method: 'GET', url: '/api/v1/sources/src-1/audio-streams', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ selectedIndex: 0, discovery: 'unavailable', reason: 'strom-probe-unsupported', streams: null });
  });

  it('reports the persisted selectedIndex', async () => {
    seed('srt', 3);
    const res = await app.inject({ method: 'GET', url: '/api/v1/sources/src-1/audio-streams', headers: AUTH });
    expect(res.json().selectedIndex).toBe(3);
  });

  it('returns 404 for an unknown source', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sources/nope/audio-streams', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});
