/**
 * Clip-source routes for OL-19 (issue #504): `GET /api/v1/sources?streamType=clip`
 * and the PATCH-while-playing 409 guard. CouchDB/Strom/WS controller mocked.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GatewayDoc, SourceDoc } from '../db/types.js';
import { setClipStateEntry, clearClipState } from '../services/clip-state.service.js';

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
  findTrusted: vi.fn(async (): Promise<{ docs: Array<{ _id: string; name: string }> }> => ({ docs: [] })),
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
  clearClipState('prod-1');
  prodDb.findTrusted.mockResolvedValue({ docs: [] });
  sourcesDb.find.mockImplementation(async (q?: { selector?: Record<string, unknown> }) => {
    const st = q?.selector?.['streamType'];
    return { docs: Array.from(sourcesStore.values()).filter((s) => !st || s.streamType === st) };
  });
});


function seedClip(id: string, url = 'https://media.example.com/a.mp4'): void {
  sourcesStore.set(id, {
    _id: id, _rev: '1-a', type: 'source', name: id, streamType: 'clip', status: 'active',
    address: JSON.stringify({ type: 'url', url }), createdAt: 'x', updatedAt: 'x',
  } as SourceDoc);
}
const NEW_ADDR = JSON.stringify({ type: 'url', url: 'https://media.example.com/b.mp4' });

describe('GET /api/v1/sources?streamType=clip', () => {
  it('lists only clip sources when filtered, all sources otherwise', async () => {
    seedClip('clip-1');
    sourcesStore.set('srt-1', { _id: 'srt-1', type: 'source', name: 's', streamType: 'srt', status: 'active', address: 'srt://0.0.0.0:9000?mode=listener', createdAt: 'x', updatedAt: 'x' } as SourceDoc);
    const filtered = await app.inject({ method: 'GET', url: '/api/v1/sources?streamType=clip', headers: AUTH });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().map((s: { id: string }) => s.id)).toEqual(['clip-1']);
    const all = await app.inject({ method: 'GET', url: '/api/v1/sources', headers: AUTH });
    expect(all.json()).toHaveLength(2);
  });
  it('400s an unknown streamType', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sources?streamType=bogus', headers: AUTH });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH clip source address while in use (OL-19)', () => {
  it('409s when the clip is currently playing in an active production', async () => {
    seedClip('clip-1');
    prodDb.findTrusted.mockResolvedValue({ docs: [{ _id: 'prod-1', name: 'Show' }] });
    setClipStateEntry('prod-1', { mixerInput: 'video_in_0', state: 'playing', clipId: 'clip-1' });
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/clip-1', headers: AUTH, payload: { address: NEW_ADDR } });
    expect(res.statusCode).toBe(409);
    expect(sourcesDb.insert).not.toHaveBeenCalled();
  });
  it('allows the change while cued (takes effect at next Cue)', async () => {
    seedClip('clip-1');
    prodDb.findTrusted.mockResolvedValue({ docs: [{ _id: 'prod-1', name: 'Show' }] });
    setClipStateEntry('prod-1', { mixerInput: 'video_in_0', state: 'cued', clipId: 'clip-1' });
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/clip-1', headers: AUTH, payload: { address: NEW_ADDR } });
    expect(res.statusCode).toBe(200);
    expect(sourcesStore.get('clip-1')?.address).toBe(NEW_ADDR);
  });
  it('allows a rename while playing (guard covers address only)', async () => {
    seedClip('clip-1');
    prodDb.findTrusted.mockResolvedValue({ docs: [{ _id: 'prod-1', name: 'Show' }] });
    setClipStateEntry('prod-1', { mixerInput: 'video_in_0', state: 'playing', clipId: 'clip-1' });
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/clip-1', headers: AUTH, payload: { name: 'renamed' } });
    expect(res.statusCode).toBe(200);
  });
});
