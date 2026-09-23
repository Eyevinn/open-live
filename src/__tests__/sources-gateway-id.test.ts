/**
 * Route tests for `gatewayId` on POST/PATCH /api/v1/sources (issue #308,
 * spec `docs/specs/studio-gateways.md`). CouchDB, Strom, and the WS controller
 * are mocked — no live services required.
 *
 * Covers: gatewayId set on create, an unknown gateway rejected with 400 on
 * create and patch, set + clear (`null`) on patch, and the field round-tripping
 * in responses. Backward-compat: a create without gatewayId leaves it absent.
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
  gatewaysStore.clear();
  sourcesStore.clear();
});

function seedGateway(id = 'gw-1'): void {
  gatewaysStore.set(id, {
    _id: id, type: 'gateway', name: 'venue', tokenHash: 'a'.repeat(64),
    lastSeenAt: null, createdAt: 'x', updatedAt: 'x',
  });
}

describe('POST /api/v1/sources with gatewayId', () => {
  it('persists gatewayId when it names an existing gateway and returns it', async () => {
    seedGateway('gw-1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers: AUTH,
      payload: { name: 'cam1', address: 'srt://host:9000', streamType: 'srt', gatewayId: 'gw-1' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.gatewayId).toBe('gw-1');
    // Round-trips from storage.
    expect(sourcesStore.get(body.id)!.gatewayId).toBe('gw-1');
  });

  it('rejects an unknown gatewayId with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers: AUTH,
      payload: { name: 'cam1', address: 'srt://host:9000', streamType: 'srt', gatewayId: 'gw-nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('gw-nope');
    expect(sourcesStore.size).toBe(0);
  });

  it('is backward-compatible: a create without gatewayId leaves it absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers: AUTH,
      payload: { name: 'cam1', address: 'srt://host:9000', streamType: 'srt' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().gatewayId).toBeUndefined();
    expect(sourcesStore.get(res.json().id)!.gatewayId).toBeUndefined();
  });
});

describe('PATCH /api/v1/sources/:id with gatewayId', () => {
  function seedSource(gatewayId?: string): void {
    sourcesStore.set('src-1', {
      _id: 'src-1', _rev: '1-a', type: 'source', name: 'cam1', address: 'srt://host:9000',
      streamType: 'srt', status: 'inactive',
      ...(gatewayId ? { gatewayId } : {}),
      createdAt: 'x', updatedAt: 'x',
    });
  }

  it('sets gatewayId on an untagged source', async () => {
    seedGateway('gw-1');
    seedSource();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/sources/src-1', headers: AUTH,
      payload: { gatewayId: 'gw-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().gatewayId).toBe('gw-1');
    expect(sourcesStore.get('src-1')!.gatewayId).toBe('gw-1');
  });

  it('clears gatewayId when patched with null', async () => {
    seedGateway('gw-1');
    seedSource('gw-1');
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/sources/src-1', headers: AUTH,
      payload: { gatewayId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().gatewayId).toBeUndefined();
    expect(sourcesStore.get('src-1')!.gatewayId).toBeUndefined();
  });

  it('rejects a patch to an unknown gatewayId with 400', async () => {
    seedSource();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/sources/src-1', headers: AUTH,
      payload: { gatewayId: 'gw-nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('gw-nope');
    expect(sourcesStore.get('src-1')!.gatewayId).toBeUndefined();
  });

  it('leaves an existing gatewayId untouched when the patch omits it', async () => {
    seedGateway('gw-1');
    seedSource('gw-1');
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/sources/src-1', headers: AUTH,
      payload: { name: 'renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().gatewayId).toBe('gw-1');
    expect(sourcesStore.get('src-1')!.gatewayId).toBe('gw-1');
  });
});
