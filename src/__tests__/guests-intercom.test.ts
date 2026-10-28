/**
 * Intercom talkback provisioning on guest join (epic #208, issue #302; reworked
 * for the real intercom-manager API in issue #598, `docs/specs/guest-talkback.md`
 * §1.1, §3.1, §3.6).
 *
 * The intercom-manager HTTP boundary is mocked with the manager's REAL shapes:
 * `POST /production` → `{ name, productionId }`, `GET|POST /production/:p/line`
 * → `LineResponse[]` (every line of the production), a duplicate line name on
 * POST → `400 { message }`, plus a `500` and a network error.
 *
 *  1. Guest join: one line per guest slot (`guest-<mixerInput>`), found by GET
 *     or created by POST, reused on rejoin; any IntercomManagerError degrades
 *     to `200` without `intercomLine` and a warn log — join never 502s.
 *  2. The client itself: lookup-before-create, array selection, the
 *     duplicate-400 race fallback, auth header, and error mapping.
 *
 * The "unconfigured → intercomLine absent, join still succeeds" path is
 * covered in guests-routes.test.ts (that suite runs with intercom vars unset).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GuestInviteDoc, GuestSessionDoc, ProductionDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
process.env['GUEST_INVITE_SECRET'] = 'test-hmac-secret';
process.env['PUBLIC_BASE_URL'] = 'https://live.example.com';
// Intercom CONFIGURED for this suite — talkback is explicitly enabled.
process.env['INTERCOM_MANAGER_URL'] = 'https://intercom.example.com/api/v1';
process.env['INTERCOM_MANAGER_TOKEN'] = 'ic-token';

// ---- Mock CouchDB stores ----
const invitesStore = new Map<string, GuestInviteDoc>();
const sessionsStore = new Map<string, GuestSessionDoc>();
const productionsStore = new Map<string, ProductionDoc>();

function matchSelector<T>(docs: T[], selector: Record<string, unknown>): T[] {
  return docs.filter((d) =>
    Object.entries(selector).every(([k, v]) => (d as Record<string, unknown>)[k] === v),
  );
}

const prodDb = {
  get: vi.fn(async (id: string) => {
    const doc = productionsStore.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(async (doc: ProductionDoc) => {
    productionsStore.set(doc._id, { ...doc, _rev: '2-x' });
    return { ok: true, rev: '2-x' };
  }),
  find: vi.fn(),
  findTrusted: vi.fn(),
};

const invitesDb = {
  get: vi.fn(async (id: string) => {
    const doc = invitesStore.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(async (doc: GuestInviteDoc) => {
    invitesStore.set(doc._id, { ...doc, _rev: '1-x' });
    return { ok: true };
  }),
  destroy: vi.fn(),
  find: vi.fn(async (q: { selector: Record<string, unknown> }) => ({
    docs: matchSelector(Array.from(invitesStore.values()), q.selector),
  })),
};

const sessionsDb = {
  get: vi.fn(async (id: string) => {
    const doc = sessionsStore.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  // CouchDB revision semantics: writing an existing doc needs its current _rev
  // (a stale or missing one is a 409), so a second write in one join must carry
  // the revision returned by the first.
  insert: vi.fn(async (doc: GuestSessionDoc) => {
    const current = sessionsStore.get(doc._id);
    if (current && current._rev !== doc._rev) {
      throw Object.assign(new Error('conflict'), { statusCode: 409 });
    }
    const rev = `${Number(current?._rev?.split('-')[0] ?? 0) + 1}-x`;
    sessionsStore.set(doc._id, { ...doc, _rev: rev });
    return { ok: true, id: doc._id, rev };
  }),
  destroy: vi.fn(),
  find: vi.fn(async (q: { selector: Record<string, unknown> }) => ({
    docs: matchSelector(Array.from(sessionsStore.values()), q.selector),
  })),
};

// The join's ICE-server lookup goes to Strom, not through the mocked fetch.
vi.mock('../lib/ice-servers.js', () => ({
  getIceServers: vi.fn().mockRejectedValue(new Error('Strom unreachable')),
  resetIceServersCache: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => prodDb,
  getGuestInvitesDb: () => invitesDb,
  getGuestSessionsDb: () => sessionsDb,
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
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
  applyReturnMode: vi.fn().mockResolvedValue({ ok: true }),
}));

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

let app: FastifyInstance;

function seedProduction(id = 'prod-1'): ProductionDoc {
  const doc = {
    _id: id,
    _rev: '1-a',
    type: 'production',
    name: 'Test show',
    status: 'inactive',
    // One declared guest slot (#381): a source assignment carrying a returnFeed.
    sources: [
      { sourceId: 'Whip', mixerInput: 'video_in_0', returnFeed: { synced: 'program-minus' as const, lowLatency: false } },
      { sourceId: 'Whip', mixerInput: 'video_in_1', returnFeed: { synced: 'program-minus' as const, lowLatency: false } },
    ],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '',
    updatedAt: '',
  } as unknown as ProductionDoc;
  productionsStore.set(id, doc);
  return doc;
}

async function createInvite(payload: Record<string, unknown> = {}) {
  if (!productionsStore.has('prod-1')) seedProduction();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/productions/prod-1/guests/invites',
    headers: AUTH,
    // Invites must target a declared guest slot (#381); pin the seed's slot
    // unless a test overrides it.
    payload: { mixerInput: 'video_in_0', ...payload },
  });
  return res.json() as { id: string; token: string };
}

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

beforeEach(() => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  // Restore the per-test `fetch` spy so call counts don't accumulate across
  // tests. Only spyOn spies are restored — the db/ws `vi.fn()` module mocks are
  // untouched.
  vi.restoreAllMocks();
});

// ---- Fake intercom-manager speaking the real API shapes (spec §3.1) ----

const MANAGER = 'https://intercom.example.com/api/v1';

interface FakeLine {
  name: string;
  id: string;
  smbConferenceId: string;
  participants: unknown[];
}

interface FakeManager {
  productions: Map<string, FakeLine[]>;
  calls: Array<{ method: string; path: string; auth?: string; body?: unknown }>;
  /** Make the next POST …/line answer a duplicate 400 after another join "won" the race. */
  raceOnNextLinePost?: boolean;
}

function lineResponse(lines: FakeLine[]): Response {
  return new Response(JSON.stringify(lines), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fakeManager(seed: Record<string, FakeLine[]> = {}): FakeManager {
  const mgr: FakeManager = { productions: new Map(Object.entries(seed)), calls: [] };
  let nextProduction = 100;
  let nextLine = 1;
  const addLine = (lines: FakeLine[], name: string) =>
    lines.push({ name, id: String(nextLine++), smbConferenceId: `conf-${name}`, participants: [] });

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (!u.startsWith(MANAGER)) throw new Error(`unexpected fetch ${u}`);
    const path = u.slice(MANAGER.length);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    mgr.calls.push({ method, path, auth: headers.get('authorization') ?? undefined, body });

    if (path === '/production' && method === 'POST') {
      const productionId = String(nextProduction++);
      mgr.productions.set(productionId, []);
      return new Response(JSON.stringify({ name: body.name, productionId }), { status: 200 });
    }
    const m = /^\/production\/([^/]+)\/line$/.exec(path);
    if (m) {
      const lines = mgr.productions.get(decodeURIComponent(m[1]));
      if (!lines) return new Response(JSON.stringify({ message: 'Production not found' }), { status: 404 });
      if (method === 'GET') return lineResponse(lines);
      if (method === 'POST') {
        if (mgr.raceOnNextLinePost) {
          mgr.raceOnNextLinePost = false;
          addLine(lines, body.name); // a concurrent join created it first
        }
        if (lines.some((l) => l.name === body.name)) {
          return new Response(
            JSON.stringify({ message: `Line with name ${body.name} already exists` }),
            { status: 400 },
          );
        }
        addLine(lines, body.name);
        return lineResponse(lines);
      }
    }
    throw new Error(`unexpected fetch ${method} ${path}`);
  });
  return mgr;
}

// Join is rate-limited per IP (10/min); give each join its own address.
let joinIp = 0;
async function join(invite: { id: string; token: string }) {
  joinIp += 1;
  return app.inject({
    method: 'POST',
    remoteAddress: `10.0.${Math.floor(joinIp / 250)}.${(joinIp % 250) + 1}`,
    url: `/api/v1/guests/${invite.id}/join`,
    headers: { authorization: `Bearer ${invite.token}` },
  });
}

/** Mark a guest session `left` so the slot can take its next occupant. */
function leave(guestId: string) {
  const s = sessionsStore.get(guestId)!;
  sessionsStore.set(guestId, { ...s, state: 'left' });
}

describe('guest join — intercom configured', () => {
  it('creates the slot line by POST when missing and selects it from the LineResponse[]', async () => {
    // An unrelated line already exists on the production, so the POST response
    // array has more than one entry and the right one must be picked by name.
    const prod = seedProduction();
    productionsStore.set('prod-1', { ...prod, intercomProductionId: '7' });
    const mgr = fakeManager({
      '7': [{ name: 'producer', id: '1', smbConferenceId: 'c', participants: [] }],
    });
    mgr.productions.get('7')!.push({ name: 'other', id: '2', smbConferenceId: 'c', participants: [] });

    const invite = await createInvite({ label: 'Remote guest' });
    const res = await join(invite);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const created = mgr.productions.get('7')!.find((l) => l.name === 'guest-video_in_0')!;
    expect(body.intercomLine).toEqual({ id: created.id, productionId: '7', name: 'guest-video_in_0' });
    expect(body.intercomLine).not.toHaveProperty('joinUrl');
    expect(sessionsStore.get(body.guestId)?.intercomLineId).toBe(created.id);
    // Lookup first, then create.
    expect(mgr.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /production/7/line',
      'POST /production/7/line',
    ]);
    expect(mgr.calls[1].body).toEqual({ name: 'guest-video_in_0' });
    // WHIP video unaffected — talkback is additive.
    expect(body.whipUrl).toMatch(/\/api\/v1\/guests\/[^/]+\/whip$/);
  });

  it('creates the intercom grouping on first use and records it on the production', async () => {
    const mgr = fakeManager();
    const invite = await createInvite({ label: 'Remote guest' });
    const res = await join(invite);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.intercomLine).toMatchObject({ productionId: '100', name: 'guest-video_in_0' });
    expect(productionsStore.get('prod-1')?.intercomProductionId).toBe('100');
    expect(mgr.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /production',
      'GET /production/100/line',
      'POST /production/100/line',
    ]);
  });

  it('reuses a line found by GET without POSTing', async () => {
    const prod = seedProduction();
    productionsStore.set('prod-1', { ...prod, intercomProductionId: '7' });
    const mgr = fakeManager({
      '7': [{ name: 'guest-video_in_0', id: '42', smbConferenceId: 'c', participants: [] }],
    });

    const invite = await createInvite();
    const res = await join(invite);

    expect(res.statusCode).toBe(200);
    expect(res.json().intercomLine).toEqual({ id: '42', productionId: '7', name: 'guest-video_in_0' });
    expect(mgr.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /production/7/line']);
  });

  it('falls back to a re-GET when the POST hits a duplicate-name 400 (race)', async () => {
    const prod = seedProduction();
    productionsStore.set('prod-1', { ...prod, intercomProductionId: '7' });
    const mgr = fakeManager({ '7': [] });
    mgr.raceOnNextLinePost = true;

    const invite = await createInvite();
    const res = await join(invite);

    expect(res.statusCode).toBe(200);
    const raced = mgr.productions.get('7')!.find((l) => l.name === 'guest-video_in_0')!;
    expect(res.json().intercomLine.id).toBe(raced.id);
    expect(mgr.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /production/7/line',
      'POST /production/7/line',
      'GET /production/7/line',
    ]);
    expect(mgr.productions.get('7')!.filter((l) => l.name === 'guest-video_in_0')).toHaveLength(1);
  });

  it('a rejoin with the same invite gets the same intercomLine.id and no second line', async () => {
    const mgr = fakeManager();
    const invite = await createInvite({ label: 'Remote guest' });

    const first = await join(invite);
    const second = await join(invite);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().intercomLine.id).toBe(first.json().intercomLine.id);
    expect(second.json().guestId).toBe(first.json().guestId);
    const lines = mgr.productions.get('100')!.filter((l) => l.name === 'guest-video_in_0');
    expect(lines).toHaveLength(1);
    // The second join only looked the line up.
    expect(mgr.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/line'))).toHaveLength(1);
  });

  it('the slot\'s next occupant reuses the slot line', async () => {
    fakeManager();
    const a = await createInvite({ label: 'Guest A' });
    const first = await join(a);
    leave(first.json().guestId);

    const b = await createInvite({ label: 'Guest B' });
    const second = await join(b);

    expect(second.statusCode).toBe(200);
    expect(second.json().intercomLine.id).toBe(first.json().intercomLine.id);
  });

  it('two invites with the same label in different slots get different lines, neither fails', async () => {
    const mgr = fakeManager();
    const a = await createInvite({ label: 'Studio guest', mixerInput: 'video_in_0' });
    const b = await createInvite({ label: 'Studio guest', mixerInput: 'video_in_1' });

    const ra = await join(a);
    const rb = await join(b);

    expect(ra.statusCode).toBe(200);
    expect(rb.statusCode).toBe(200);
    expect(ra.json().intercomLine.name).toBe('guest-video_in_0');
    expect(rb.json().intercomLine.name).toBe('guest-video_in_1');
    expect(ra.json().intercomLine.id).not.toBe(rb.json().intercomLine.id);
    expect(mgr.productions.get('100')!.map((l) => l.name).sort()).toEqual([
      'guest-video_in_0',
      'guest-video_in_1',
    ]);
  });

  it('manager 500 → join 200 without intercomLine, no intercomLineId, warn log', async () => {
    const warn = vi.spyOn(app.log, 'warn');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'boom' }), { status: 500 }),
    );

    const invite = await createInvite();
    const res = await join(invite);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).not.toHaveProperty('intercomLine');
    expect(sessionsStore.get(body.guestId)?.intercomLineId).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ name: 'IntercomManagerError' }) }),
      expect.stringContaining('intercom'),
    );
  });

  it('manager network error → join 200 without intercomLine, warn log', async () => {
    const warn = vi.spyOn(app.log, 'warn');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'));

    const invite = await createInvite();
    const res = await join(invite);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).not.toHaveProperty('intercomLine');
    expect(sessionsStore.get(body.guestId)?.intercomLineId).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ name: 'IntercomManagerError' }) }),
      expect.stringContaining('intercom'),
    );
  });

  it('a rejoin whose provisioning fails drops the previous intercomLineId', async () => {
    fakeManager();
    const invite = await createInvite();
    const first = await join(invite);
    expect(first.json().intercomLine).toBeDefined();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const second = await join(invite);

    expect(second.statusCode).toBe(200);
    expect(second.json()).not.toHaveProperty('intercomLine');
    expect(sessionsStore.get(second.json().guestId)?.intercomLineId).toBeUndefined();
  });
});

describe('intercom-manager client', () => {
  it('sends the bearer token and names nothing it did not ask for', async () => {
    const { provisionGuestLine } = await import('../lib/intercom-manager.js');
    const mgr = fakeManager();
    const line = await provisionGuestLine({ productionId: 'prod-1', lineName: 'guest-video_in_0' });
    expect(line).toEqual({ id: '1', productionId: '100', name: 'guest-video_in_0' });
    expect(mgr.calls.every((c) => c.auth === 'Bearer ic-token')).toBe(true);
    expect(mgr.calls[0].body).toEqual({ name: 'open-live-prod-1', lines: [] });
  });

  it('guestLineName is guest-<mixerInput>', async () => {
    const { guestLineName } = await import('../lib/intercom-manager.js');
    expect(guestLineName('video_in_3')).toBe('guest-video_in_3');
  });

  it('throws IntercomManagerError when unreachable', async () => {
    const { provisionGuestLine, IntercomManagerError } = await import('../lib/intercom-manager.js');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      provisionGuestLine({ intercomProductionId: '7', productionId: 'prod-1', lineName: 'x' }),
    ).rejects.toBeInstanceOf(IntercomManagerError);
  });

  it('throws IntercomManagerError (with status) on a non-2xx response', async () => {
    const { provisionGuestLine, IntercomManagerError } = await import('../lib/intercom-manager.js');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const err = await provisionGuestLine({ intercomProductionId: '7', productionId: 'prod-1', lineName: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntercomManagerError);
    expect((err as InstanceType<typeof IntercomManagerError>).status).toBe(500);
  });

  it('a duplicate 400 whose re-GET still lacks the line is an IntercomManagerError', async () => {
    const { provisionGuestLine, IntercomManagerError } = await import('../lib/intercom-manager.js');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      (init?.method ?? 'GET') === 'GET'
        ? lineResponse([])
        : new Response(JSON.stringify({ message: 'Line with name x already exists' }), { status: 400 }),
    );
    await expect(
      provisionGuestLine({ intercomProductionId: '7', productionId: 'prod-1', lineName: 'x' }),
    ).rejects.toBeInstanceOf(IntercomManagerError);
  });

  it('rejects a non-array line response (the invented { id, name, joinUrl } object)', async () => {
    const { provisionGuestLine, IntercomManagerError } = await import('../lib/intercom-manager.js');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'ic-line-1', name: 'x', joinUrl: 'https://x' }), { status: 200 }),
    );
    await expect(
      provisionGuestLine({ intercomProductionId: '7', productionId: 'prod-1', lineName: 'x' }),
    ).rejects.toBeInstanceOf(IntercomManagerError);
  });
});
