/**
 * Route tests for the OL-5 Studio Gateways Phase-1 REST surface (issue #263,
 * `docs/specs/studio-gateways.md`). CouchDB, Strom, and the WS controller are
 * mocked — no live services required.
 *
 * Covers: create (token returned exactly once), list/get (health on read),
 * rotate-token, and the offline-gated "forget" cascade.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GatewayDoc, SourceDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
// Long forget-min-offline default (300s) applies; we drive lastSeenAt to be old.

// ---- Mock CouchDB ----
const gatewaysStore = new Map<string, GatewayDoc>();
const sourcesStore = new Map<string, SourceDoc>();
const productionDocs: Array<Record<string, unknown>> = [];

const gatewaysDb = {
  get: vi.fn(async (id: string) => {
    const doc = gatewaysStore.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(async (doc: GatewayDoc) => {
    gatewaysStore.set(doc._id, { ...doc, _rev: '1-x' });
    return { ok: true, id: doc._id, rev: '1-x' };
  }),
  destroy: vi.fn(async (id: string) => {
    gatewaysStore.delete(id);
    return { ok: true };
  }),
  find: vi.fn(async () => ({ docs: Array.from(gatewaysStore.values()) })),
};

const sourcesDb = {
  get: vi.fn(),
  insert: vi.fn(async (doc: SourceDoc) => {
    sourcesStore.set(doc._id, { ...doc, _rev: '2-x' });
    return { ok: true };
  }),
  destroy: vi.fn(async (id: string) => {
    sourcesStore.delete(id);
    return { ok: true };
  }),
  find: vi.fn(),
  findTrusted: vi.fn(async () => ({
    docs: Array.from(sourcesStore.values()).filter((s) => s.gatewayId),
  })),
};

const prodDb = {
  get: vi.fn(),
  insert: vi.fn(),
  find: vi.fn(),
  findTrusted: vi.fn(async () => ({ docs: productionDocs })),
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
    portLeases = { acquire: vi.fn(), renew: vi.fn(), release: vi.fn(), list: vi.fn(), get: vi.fn() };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
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
  productionDocs.length = 0;
});

describe('POST /api/v1/gateways', () => {
  it('creates a gateway, returns the token exactly once, and stores only its hash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/gateways',
      headers: AUTH,
      payload: { name: 'Venue A — main truck' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^gw-/);
    expect(body.name).toBe('Venue A — main truck');
    expect(body.health).toBe('unknown');
    expect(body.lastSeenAt).toBeNull();
    expect(body.token).toMatch(/^olgw_v1_/);

    // The stored doc holds only a hash, never the raw token.
    const stored = gatewaysStore.get(body.id)!;
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(body.token);

    // A subsequent GET never returns the token.
    const get = await app.inject({ method: 'GET', url: `/api/v1/gateways/${body.id}`, headers: AUTH });
    expect(get.json().token).toBeUndefined();
  });

  it('rejects an empty name (400) and a missing API key (401)', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/gateways', headers: AUTH, payload: { name: '' } });
    expect(bad.statusCode).toBe(400);
    const noauth = await app.inject({ method: 'POST', url: '/api/v1/gateways', payload: { name: 'X' } });
    expect(noauth.statusCode).toBe(401);
  });
});

describe('GET /api/v1/gateways', () => {
  it('lists gateways with health computed on read', async () => {
    const fresh: GatewayDoc = {
      _id: 'gw-fresh', type: 'gateway', name: 'fresh', tokenHash: 'a'.repeat(64),
      lastSeenAt: new Date().toISOString(), createdAt: 'x', updatedAt: 'x',
    };
    const old: GatewayDoc = {
      _id: 'gw-old', type: 'gateway', name: 'old', tokenHash: 'b'.repeat(64),
      lastSeenAt: new Date(Date.now() - 60_000).toISOString(), createdAt: 'x', updatedAt: 'x',
    };
    gatewaysStore.set(fresh._id, fresh);
    gatewaysStore.set(old._id, old);
    const res = await app.inject({ method: 'GET', url: '/api/v1/gateways', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(res.json().map((g: { id: string }) => [g.id, g]));
    expect(byId['gw-fresh'].health).toBe('healthy');
    expect(byId['gw-old'].health).toBe('down');
  });

  it('404s an unknown gateway', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/gateways/nope', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/v1/gateways/:id/rotate-token', () => {
  it('mints a new token and replaces the stored hash', async () => {
    const created = (await app.inject({
      method: 'POST', url: '/api/v1/gateways', headers: AUTH, payload: { name: 'rot' },
    })).json();
    const oldHash = gatewaysStore.get(created.id)!.tokenHash;

    const res = await app.inject({
      method: 'POST', url: `/api/v1/gateways/${created.id}/rotate-token`, headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(created.id);
    expect(body.token).toMatch(/^olgw_v1_/);
    expect(body.token).not.toBe(created.token);
    expect(gatewaysStore.get(created.id)!.tokenHash).not.toBe(oldHash);
  });

  it('404s an unknown gateway', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/gateways/nope/rotate-token', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/gateways/:id (forget)', () => {
  function seedGateway(lastSeenAt: string | null): GatewayDoc {
    const doc: GatewayDoc = {
      _id: 'gw-forget', _rev: '1-x', type: 'gateway', name: 'forget', tokenHash: 'c'.repeat(64),
      lastSeenAt, createdAt: 'x', updatedAt: 'x',
    };
    gatewaysStore.set(doc._id, doc);
    return doc;
  }

  it('refuses to forget a live (healthy) gateway with 409', async () => {
    seedGateway(new Date().toISOString());
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/gateways/gw-forget', headers: AUTH });
    expect(res.statusCode).toBe(409);
    expect(gatewaysStore.has('gw-forget')).toBe(true);
  });

  it('refuses a down gateway that has not been offline long enough with 409', async () => {
    // 60s ago: down (>15s) but under the 300s forget threshold.
    seedGateway(new Date(Date.now() - 60_000).toISOString());
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/gateways/gw-forget', headers: AUTH });
    expect(res.statusCode).toBe(409);
  });

  it('forgets a long-offline gateway and cascades its non-active sources', async () => {
    seedGateway(new Date(Date.now() - 3_600_000).toISOString()); // 1h ago
    sourcesStore.set('src-1', {
      _id: 'src-1', _rev: '1-a', type: 'source', name: 'cam1', address: 'srt://h:9000',
      streamType: 'srt', status: 'inactive', gatewayId: 'gw-forget', createdAt: 'x', updatedAt: 'x',
    });
    const res = await app.inject({
      method: 'DELETE', url: '/api/v1/gateways/gw-forget?cascadeSources=true', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('gw-forget');
    expect(body.deletedSources).toContain('src-1');
    expect(gatewaysStore.has('gw-forget')).toBe(false);
    expect(sourcesStore.has('src-1')).toBe(false);
  });

  it('keeps a source in an active production and unlinks it instead of deleting', async () => {
    seedGateway(new Date(Date.now() - 3_600_000).toISOString());
    sourcesStore.set('src-live', {
      _id: 'src-live', _rev: '1-a', type: 'source', name: 'camlive', address: 'srt://h:9001',
      streamType: 'srt', status: 'active', gatewayId: 'gw-forget', createdAt: 'x', updatedAt: 'x',
    });
    productionDocs.push({ _id: 'prod-1', name: 'Show 1' });
    const res = await app.inject({
      method: 'DELETE', url: '/api/v1/gateways/gw-forget?cascadeSources=true', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deletedSources).not.toContain('src-live');
    expect(body.keptSources[0].id).toBe('src-live');
    expect(body.keptSources[0].reason).toContain('Show 1');
    // Source survives but is unlinked from the forgotten gateway.
    expect(sourcesStore.has('src-live')).toBe(true);
    expect(sourcesStore.get('src-live')!.gatewayId).toBeUndefined();
  });

  it('404s an unknown gateway', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/gateways/nope', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});
