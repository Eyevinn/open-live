/**
 * The intercom connection applies at runtime (issue #617, OL-47,
 * `docs/specs/intercom-connection.md` §3, §5). CouchDB, Strom and two intercom
 * managers (fetch) are mocked; the server is built ONCE, so every case also
 * shows that a change applies without a restart.
 *
 *  - AC2/AC4: a stored connection overrides env — the next join provisions on
 *    the stored manager and records its origin on the production.
 *  - AC3: cleared, with no env → join answers 200 without `intercomLine`.
 *  - AC6: after repointing, an `intercomProductionId` from the old manager is
 *    never addressed on the new one — join creates a fresh grouping, the
 *    talkback proxy answers 404, and deactivate skips the teardown and still
 *    completes. With a matching origin, deactivate tears down on that manager.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GuestInviteDoc, GuestSessionDoc, IntercomConnectionDoc, ProductionDoc } from '../db/types.js';

const CREW_BEARER = 'test-secret-key';
process.env['API_KEY'] = CREW_BEARER;
process.env['GUEST_INVITE_SECRET'] = 'test-hmac-secret';
process.env['PUBLIC_BASE_URL'] = 'https://live.example.com';
process.env['LOG_LEVEL'] = 'info';
process.env['SRT_PASSPHRASE_KEY'] = Buffer.alloc(32, 5).toString('base64');
// Env manager A — today's configuration.
const A = 'https://a.example.com/api/v1';
const B = 'https://b.example.com/api/v1';
process.env['INTERCOM_MANAGER_URL'] = A;
process.env['INTERCOM_MANAGER_TOKEN'] = 'env-token-a';

const invitesStore = new Map<string, GuestInviteDoc>();
const sessionsStore = new Map<string, GuestSessionDoc>();
const productionsStore = new Map<string, ProductionDoc>();
const intercomStore = new Map<string, IntercomConnectionDoc>();

function matchSelector<T>(docs: T[], selector: Record<string, unknown>): T[] {
  return docs.filter((d) => Object.entries(selector).every(([k, v]) => (d as Record<string, unknown>)[k] === v));
}

function mapDb<T extends { _id: string; _rev?: string }>(m: Map<string, T>) {
  return {
    get: vi.fn(async (id: string) => {
      const doc = m.get(id);
      if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
      return doc;
    }),
    insert: vi.fn(async (doc: T) => {
      const rev = `${Number(m.get(doc._id)?._rev?.split('-')[0] ?? 0) + 1}-x`;
      m.set(doc._id, { ...doc, _rev: rev });
      return { ok: true, id: doc._id, rev };
    }),
    destroy: vi.fn(async (id: string) => {
      m.delete(id);
      return { ok: true };
    }),
    find: vi.fn(async (q: { selector: Record<string, unknown> }) => ({
      docs: matchSelector(Array.from(m.values()), q.selector),
    })),
    findTrusted: vi.fn(async () => ({ docs: [] })),
  };
}

const prodDb = mapDb(productionsStore);
const invitesDb = mapDb(invitesStore);
const sessionsDb = mapDb(sessionsStore);
const intercomDb = mapDb(intercomStore);

vi.mock('../lib/ice-servers.js', () => ({
  getIceServers: vi.fn().mockRejectedValue(new Error('Strom unreachable')),
  resetIceServersCache: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => prodDb,
  getGuestInvitesDb: () => invitesDb,
  getGuestSessionsDb: () => sessionsDb,
  getIntercomConnectionDb: () => intercomDb,
  getSourcesDb: () => ({ get: vi.fn(async () => { throw Object.assign(new Error('nf'), { statusCode: 404 }); }), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(async () => ({ docs: [] })), destroy: vi.fn() }),
  getGatewaysDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
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
  applyReturnMode: vi.fn().mockResolvedValue({ ok: true }),
  isInputOnProgram: vi.fn().mockReturnValue(false),
}));

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn().mockResolvedValue(undefined),
}));

const AUTH = { authorization: `Bearer ${CREW_BEARER}` };
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

let app: FastifyInstance;
const logLines: string[] = [];
let mutable: Record<string, unknown>;

/** Two fake managers; every call is recorded with the manager it hit. */
let calls: Array<{ manager: 'A' | 'B'; method: string; path: string; auth?: string }> = [];
function installManagers() {
  calls = [];
  let nextProduction = 100;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    const manager = u.startsWith(A) ? 'A' : u.startsWith(B) ? 'B' : undefined;
    if (!manager) throw new Error(`unexpected fetch ${u}`);
    const path = u.slice((manager === 'A' ? A : B).length);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ manager, method, path, auth: new Headers(init?.headers as HeadersInit).get('authorization') ?? undefined });
    if (path === '/production' && method === 'POST') {
      return new Response(JSON.stringify({ productionId: String(nextProduction++) }), { status: 200 });
    }
    if (/^\/production\/\d+\/line$/.test(path)) {
      if (method === 'GET') return new Response('[]', { status: 200 });
      return new Response(
        JSON.stringify([
          { name: 'guest-video_in_0', id: '1', participants: [] },
          { name: 'guest-video_in_1', id: '2', participants: [] },
        ]),
        { status: 200 },
      );
    }
    if (/^\/production\/\d+$/.test(path) && method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${method} ${path}`);
  });
}

function seedProduction(overrides: Partial<ProductionDoc> = {}): void {
  productionsStore.set('prod-1', {
    _id: 'prod-1',
    _rev: '1-a',
    type: 'production',
    name: 'Show',
    status: 'inactive',
    sources: [
      { sourceId: 'Whip', mixerInput: 'video_in_0', returnFeed: { synced: 'program-minus', lowLatency: false } },
      { sourceId: 'Whip', mixerInput: 'video_in_1', returnFeed: { synced: 'program-minus', lowLatency: false } },
    ],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as unknown as ProductionDoc);
}

let joinIp = 0;
async function joinGuest(mixerInput = 'video_in_0') {
  const inv = await app.inject({
    method: 'POST',
    url: '/api/v1/productions/prod-1/guests/invites',
    headers: AUTH,
    payload: { mixerInput },
  });
  expect(inv.statusCode).toBe(201);
  const { id, token } = inv.json() as { id: string; token: string };
  joinIp += 1;
  const res = await app.inject({
    method: 'POST',
    remoteAddress: `10.1.0.${joinIp}`,
    url: `/api/v1/guests/${id}/join`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return { inviteId: id, token, body: res.json() as Record<string, unknown> };
}

async function storeDirectB() {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/v1/intercom-connection',
    headers: AUTH,
    payload: { url: 'https://b.example.com', apiKey: 'stored-key-b' },
  });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  const { config } = await import('../config.js');
  mutable = config as unknown as Record<string, unknown>;
  const { buildServer } = await import('../server.js');
  app = await buildServer({ logStream: { write: (line: string) => void logLines.push(line) } });
});

beforeEach(() => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  intercomStore.clear();
  vi.restoreAllMocks();
  mutable['intercomManagerUrl'] = A;
  mutable['intercomManagerToken'] = 'env-token-a';
  installManagers();
});

describe('join', () => {
  it('env only: provisions on the env manager (unchanged behaviour)', async () => {
    seedProduction();
    const { body } = await joinGuest();
    expect(body['intercomLine']).toMatchObject({ productionId: '100' });
    expect(calls.every((c) => c.manager === 'A' && c.auth === 'Bearer env-token-a')).toBe(true);
    expect(productionsStore.get('prod-1')?.intercomManagerOrigin).toBe('https://a.example.com');
  });

  it('a stored connection overrides env on the next join, without a restart', async () => {
    seedProduction();
    await storeDirectB();
    const { body } = await joinGuest();
    expect(body['intercomLine']).toMatchObject({ productionId: '100' });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.manager === 'B' && c.auth === 'Bearer stored-key-b')).toBe(true);
    expect(productionsStore.get('prod-1')).toMatchObject({
      intercomProductionId: '100',
      intercomManagerOrigin: 'https://b.example.com',
    });
  });

  it('cleared with no env: join answers 200 without intercomLine, and no manager is called', async () => {
    seedProduction();
    await storeDirectB();
    mutable['intercomManagerUrl'] = undefined;
    mutable['intercomManagerToken'] = undefined;
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/intercom-connection', headers: AUTH });
    expect(del.statusCode).toBe(204);
    const { body } = await joinGuest();
    expect(body).not.toHaveProperty('intercomLine');
    expect(calls).toHaveLength(0);
    const status = await app.inject({ method: 'GET', url: '/api/v1/intercom-connection', headers: AUTH });
    expect(status.json()).toMatchObject({ source: 'none', configured: false });
  });

  it('after repointing, an id from the old manager is not reused on the new one', async () => {
    // Pre-#617 doc: id '7' from the env manager A, no recorded origin.
    seedProduction({ intercomProductionId: '7' });
    await storeDirectB();
    const { body } = await joinGuest();
    expect(body['intercomLine']).toMatchObject({ productionId: '100' });
    expect(calls.some((c) => c.path.includes('/production/7'))).toBe(false);
    expect(calls.map((c) => `${c.manager} ${c.method} ${c.path}`)[0]).toBe('B POST /production');
    expect(productionsStore.get('prod-1')).toMatchObject({
      intercomProductionId: '100',
      intercomManagerOrigin: 'https://b.example.com',
    });
  });
});

describe('talkback proxy', () => {
  it('after repointing, the guest proxy answers 404 instead of calling the new manager with an old id', async () => {
    seedProduction();
    const g = await joinGuest(); // provisioned on env manager A
    await storeDirectB();
    calls = [];
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${g.inviteId}/talkback/whep`,
      headers: { authorization: `Bearer ${g.token}`, 'content-type': 'application/sdp' },
      payload: OFFER,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Talkback unavailable');
    expect(calls).toHaveLength(0);
  });

  it('after repointing and a new grouping, an older session on the old grouping is not proxied to the new manager', async () => {
    seedProduction();
    const first = await joinGuest('video_in_0'); // line on env manager A, grouping 100
    await storeDirectB();
    await joinGuest('video_in_1'); // production re-recorded on manager B
    expect(productionsStore.get('prod-1')?.intercomManagerOrigin).toBe('https://b.example.com');
    calls = [];
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${first.inviteId}/talkback/whep`,
      headers: { authorization: `Bearer ${first.token}`, 'content-type': 'application/sdp' },
      payload: OFFER,
    });
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('deactivate', () => {
  it('repointed: skips the teardown with a log, calls no manager, and completes', async () => {
    seedProduction({ status: 'active', intercomProductionId: '7', intercomManagerOrigin: 'https://a.example.com' });
    await storeDirectB();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(0);
    expect(logLines.some((l) => l.includes('intercom teardown skipped'))).toBe(true);
    expect(productionsStore.get('prod-1')).toMatchObject({ intercomProductionId: undefined, intercomManagerOrigin: undefined });
  });

  it('cleared with no env: deactivate still completes', async () => {
    seedProduction({ status: 'active', intercomProductionId: '7', intercomManagerOrigin: 'https://b.example.com' });
    mutable['intercomManagerUrl'] = undefined;
    mutable['intercomManagerToken'] = undefined;
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('same manager: sweeps and deletes the grouping on it', async () => {
    seedProduction({ status: 'active', intercomProductionId: '7', intercomManagerOrigin: 'https://b.example.com' });
    await storeDirectB();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(calls.map((c) => `${c.manager} ${c.method} ${c.path}`)).toEqual([
      'B GET /production/7/line',
      'B DELETE /production/7',
    ]);
  });
});
