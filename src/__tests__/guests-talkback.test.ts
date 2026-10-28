/**
 * Guest and crew talkback WHIP/WHEP proxy routes (issue #599,
 * `docs/specs/guest-talkback.md` §3.1–§3.5, §4, §7, R3–R5; ADR-012).
 *
 * The intercom-manager boundary is a fake speaking the manager's real WHIP/WHEP
 * contract (spec §3.1): `POST /<kind>/:p/:l/:username` → `201` SDP answer with
 * `Location: /api/v1/<kind>/:p/:l/:uuid`, `ETag: <uuid>` and a `Link` header
 * (ICE servers, TURN credentials); `DELETE …/:sessionId` → `200 'OK'` or `404`.
 *
 * The server's log lines are captured (`buildServer({ logStream })`) so the
 * key-never-leaks test can check every log line as well as every response.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { GuestInviteDoc, GuestSessionDoc, ProductionDoc, SourceDoc } from '../db/types.js';

const CREW_BEARER = 'test-secret-key';
const WHIP_KEY = 'whip-key-CANARY-5f1e9c';
process.env['API_KEY'] = CREW_BEARER;
process.env['GUEST_INVITE_SECRET'] = 'test-hmac-secret';
process.env['PUBLIC_BASE_URL'] = 'https://live.example.com';
process.env['INTERCOM_MANAGER_URL'] = 'https://intercom.example.com/api/v1';
process.env['INTERCOM_MANAGER_TOKEN'] = 'ic-token';
process.env['INTERCOM_WHIP_AUTH_KEY'] = WHIP_KEY;
process.env['LOG_LEVEL'] = 'trace';

// ---- Mock CouchDB stores ----
const invitesStore = new Map<string, GuestInviteDoc>();
const sessionsStore = new Map<string, GuestSessionDoc>();
const productionsStore = new Map<string, ProductionDoc>();
const sourcesStore = new Map<string, Partial<SourceDoc>>();

function matchSelector<T>(docs: T[], selector: Record<string, unknown>): T[] {
  return docs.filter((d) =>
    Object.entries(selector).every(([k, v]) => (d as Record<string, unknown>)[k] === v),
  );
}

function notFound(): Error {
  return Object.assign(new Error('not_found'), { statusCode: 404 });
}

const prodDb = {
  get: vi.fn(async (id: string) => {
    const doc = productionsStore.get(id);
    if (!doc) throw notFound();
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
    if (!doc) throw notFound();
    return doc;
  }),
  insert: vi.fn(async (doc: GuestInviteDoc) => {
    invitesStore.set(doc._id, { ...doc, _rev: '1-x' });
    return { ok: true };
  }),
  destroy: vi.fn(async (id: string) => {
    invitesStore.delete(id);
    return { ok: true };
  }),
  find: vi.fn(async (q: { selector: Record<string, unknown> }) => ({
    docs: matchSelector(Array.from(invitesStore.values()), q.selector),
  })),
};

const sessionsDb = {
  get: vi.fn(async (id: string) => {
    const doc = sessionsStore.get(id);
    if (!doc) throw notFound();
    return doc;
  }),
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

const sourcesDb = {
  get: vi.fn(async (id: string) => {
    const doc = sourcesStore.get(id);
    if (!doc) throw notFound();
    return doc;
  }),
  insert: vi.fn(),
  find: vi.fn(),
  destroy: vi.fn(),
};

vi.mock('../lib/ice-servers.js', () => ({
  getIceServers: vi.fn().mockRejectedValue(new Error('Strom unreachable')),
  resetIceServersCache: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => prodDb,
  getGuestInvitesDb: () => invitesDb,
  getGuestSessionsDb: () => sessionsDb,
  getSourcesDb: () => sourcesDb,
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
  isInputOnProgram: vi.fn().mockReturnValue(false),
}));

const AUTH = { authorization: `Bearer ${CREW_BEARER}` };
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const ANSWER = 'v=0\r\no=- 3 4 IN IP4 10.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const logLines: string[] = [];
const responses: LightMyRequestResponse[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer({ logStream: { write: (line: string) => void logLines.push(line) } });
});

// ---- Fake intercom-manager (spec §3.1) ----

const MANAGER = 'https://intercom.example.com/api/v1';
const PROD = '7';
const LINES: Record<string, string> = { 'guest-video_in_0': '42', 'guest-video_in_1': '43' };

interface ManagerCall {
  method: string;
  kind?: string;
  production?: string;
  line?: string;
  tail?: string;
  auth?: string;
  contentType?: string;
  body?: string;
}

type OfferHandler = (call: ManagerCall, sessionId: string) => Response | Promise<Response>;

interface FakeManager {
  calls: ManagerCall[];
  offer: OfferHandler;
  del: (call: ManagerCall) => Response | Promise<Response>;
}

function created(call: ManagerCall, sessionId: string, overrides: Record<string, string | null> = {}): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/sdp',
    location: `/api/v1/${call.kind}/${call.production}/${call.line}/${sessionId}`,
    etag: sessionId,
    link: '<turn:turn.example.com:3478>; rel="ice-server"; username="u"; credential="TURN-SECRET-xyz"',
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  return new Response(ANSWER, { status: 201, headers });
}

let mgr: FakeManager;

function fakeManager(): FakeManager {
  const m: FakeManager = {
    calls: [],
    offer: (call, sessionId) => created(call, sessionId),
    del: () => new Response('OK', { status: 200 }),
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (!u.startsWith(MANAGER)) throw new Error(`unexpected fetch ${u}`);
    const path = u.slice(MANAGER.length);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit);
    if (path === `/production/${PROD}/line` && method === 'GET') {
      return new Response(
        JSON.stringify(Object.entries(LINES).map(([name, id]) => ({ name, id, smbConferenceId: 'c', participants: [] }))),
        { status: 200 },
      );
    }
    const wm = /^\/(whip|whep)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (!wm) throw new Error(`unexpected fetch ${method} ${path}`);
    const call: ManagerCall = {
      method,
      kind: wm[1],
      production: wm[2],
      line: wm[3],
      tail: decodeURIComponent(wm[4]!),
      auth: headers.get('authorization') ?? undefined,
      contentType: headers.get('content-type') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    m.calls.push(call);
    if (method === 'POST') return m.offer(call, crypto.randomUUID());
    if (method === 'DELETE') return m.del(call);
    throw new Error(`unexpected fetch ${method} ${path}`);
  });
  return m;
}

// ---- Fixtures ----

function seedProduction(overrides: Partial<ProductionDoc> = {}): ProductionDoc {
  const doc = {
    _id: 'prod-1',
    _rev: '1-a',
    type: 'production',
    name: 'Test show',
    status: 'inactive',
    intercomProductionId: PROD,
    sources: [
      { sourceId: 'Whip', mixerInput: 'video_in_0', returnFeed: { synced: 'program-minus', lowLatency: false } },
      // Return-only slot: its source is an SRT encoder, not WHIP.
      { sourceId: 'src-srt', mixerInput: 'video_in_1', returnFeed: { synced: 'program-minus', lowLatency: false } },
    ],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as unknown as ProductionDoc;
  productionsStore.set(doc._id, doc);
  return doc;
}

let ip = 0;
/** Each request gets its own address so the per-route 10/min limits never trip by accident. */
function nextIp(): string {
  ip += 1;
  return `10.${Math.floor(ip / 62500) % 250}.${Math.floor(ip / 250) % 250}.${(ip % 250) + 1}`;
}

async function inject(opts: InjectOptions): Promise<LightMyRequestResponse> {
  const res = await app.inject({ remoteAddress: nextIp(), ...opts });
  responses.push(res);
  return res;
}

interface Guest {
  inviteId: string;
  token: string;
  guestId: string;
  join: Record<string, unknown>;
}

async function joinGuest(mixerInput = 'video_in_0', label: string | null = 'Ana/Smith (guest)'): Promise<Guest> {
  const inv = await inject({
    method: 'POST',
    url: '/api/v1/productions/prod-1/guests/invites',
    headers: AUTH,
    payload: { mixerInput, ...(label ? { label } : {}) },
  });
  expect(inv.statusCode).toBe(201);
  const { id, token } = inv.json() as { id: string; token: string };
  const res = await inject({
    method: 'POST',
    url: `/api/v1/guests/${id}/join`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const join = res.json() as Record<string, unknown>;
  return { inviteId: id, token, guestId: join['guestId'] as string, join };
}

function guestPost(g: Guest, kind: 'whip' | 'whep', headers: Record<string, string> = {}, payload = OFFER) {
  return inject({
    method: 'POST',
    url: `/api/v1/guests/${g.inviteId}/talkback/${kind}`,
    headers: { authorization: `Bearer ${g.token}`, 'content-type': 'application/sdp', ...headers },
    payload,
  });
}

function guestDelete(g: Guest, kind: 'whip' | 'whep', sessionId: string, token = g.token) {
  return inject({
    method: 'DELETE',
    url: `/api/v1/guests/${g.inviteId}/talkback/${kind}/${sessionId}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function crewPost(g: Guest, kind: 'whip' | 'whep', query = '', headers: Record<string, string> = AUTH) {
  return inject({
    method: 'POST',
    url: `/api/v1/productions/prod-1/guests/${g.guestId}/talkback/${kind}${query}`,
    headers: { ...headers, 'content-type': 'application/sdp' },
    payload: OFFER,
  });
}

function setSession(guestId: string, patch: Partial<GuestSessionDoc>) {
  const s = sessionsStore.get(guestId)!;
  sessionsStore.set(guestId, { ...s, ...patch });
}

beforeEach(() => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  sourcesStore.clear();
  vi.restoreAllMocks();
  sourcesStore.set('src-srt', { _id: 'src-srt', streamType: 'srt', name: 'Encoder' } as Partial<SourceDoc>);
  seedProduction();
  mgr = fakeManager();
});

// ---------------------------------------------------------------------------

describe('join response — talkback URLs (§3.4)', () => {
  it('a WHIP slot gets server-built whipUrl + whepUrl', async () => {
    const g = await joinGuest('video_in_0');
    expect(g.join['talkback']).toEqual({
      whipUrl: `https://live.example.com/api/v1/guests/${g.inviteId}/talkback/whip`,
      whepUrl: `https://live.example.com/api/v1/guests/${g.inviteId}/talkback/whep`,
    });
  });

  it('a return-only slot gets whepUrl only', async () => {
    const g = await joinGuest('video_in_1');
    expect(g.join['talkback']).toEqual({
      whepUrl: `https://live.example.com/api/v1/guests/${g.inviteId}/talkback/whep`,
    });
  });

  it('no line provisioned (manager down) → no talkback, join still 200', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const g = await joinGuest('video_in_0');
    expect(g.join).not.toHaveProperty('talkback');
    expect(g.join).not.toHaveProperty('intercomLine');
  });
});

describe('guest talkback POST (§3.2)', () => {
  it('WHEP: 201 with the SDP answer, an open-live Location and ETag, no Link; binds the session id', async () => {
    const g = await joinGuest();
    const res = await guestPost(g, 'whep');

    expect(res.statusCode).toBe(201);
    expect(res.body).toBe(ANSWER);
    expect(res.headers['content-type']).toMatch(/^application\/sdp/);
    const sid = String(res.headers['etag']);
    expect(sid).toMatch(UUID_RE);
    expect(res.headers['location']).toBe(`/api/v1/guests/${g.inviteId}/talkback/whep/${sid}`);
    expect(res.headers['link']).toBeUndefined();
    expect(JSON.stringify(res.headers)).not.toContain('TURN-SECRET');

    // Line and production come from the DB; username from the invite label.
    const call = mgr.calls.at(-1)!;
    expect(call).toMatchObject({
      method: 'POST',
      kind: 'whep',
      production: PROD,
      line: '42',
      tail: 'Ana_Smith _guest_',
      auth: `Bearer ${WHIP_KEY}`,
      contentType: 'application/sdp',
      body: OFFER,
    });
    expect(sessionsStore.get(g.guestId)?.talkbackWhepSessionId).toBe(sid);
  });

  it('WHIP on a WHIP slot: 201 and binds talkbackWhipSessionId', async () => {
    const g = await joinGuest();
    const res = await guestPost(g, 'whip');
    expect(res.statusCode).toBe(201);
    expect(sessionsStore.get(g.guestId)?.talkbackWhipSessionId).toBe(res.headers['etag']);
    expect(mgr.calls.at(-1)).toMatchObject({ kind: 'whip', line: '42' });
  });

  it('username falls back to "Guest <slot number>" when the invite has no label', async () => {
    const g = await joinGuest('video_in_0', null);
    expect((await guestPost(g, 'whep')).statusCode).toBe(201);
    // Slot numbering mirrors the flow generator (pad index descending): video_in_0 is Guest 2 here.
    expect(mgr.calls.at(-1)!.tail).toBe('Guest 2');
  });

  it('username is sanitized and cut to 200 characters', async () => {
    const g = await joinGuest('video_in_0', `${'é'.repeat(150)}${'x'.repeat(100)}`);
    expect((await guestPost(g, 'whep')).statusCode).toBe(201);
    const tail = mgr.calls.at(-1)!.tail!;
    expect(tail).toHaveLength(200);
    expect(tail).toMatch(/^[\w .-]{1,200}$/);
  });

  it('return-only slot: WHIP POST → 403, WHEP works', async () => {
    const g = await joinGuest('video_in_1');
    const whip = await guestPost(g, 'whip');
    expect(whip.statusCode).toBe(403);
    expect(whip.json().error).toBe('This guest slot does not take WHIP');
    const whep = await guestPost(g, 'whep');
    expect(whep.statusCode).toBe(201);
    expect(mgr.calls.at(-1)).toMatchObject({ kind: 'whep', line: '43' });
    expect(mgr.calls.filter((c) => c.kind === 'whip')).toHaveLength(0);
  });

  describe('401 — who-you-are failures', () => {
    it('missing or malformed token', async () => {
      const g = await joinGuest();
      expect((await guestPost(g, 'whep', { authorization: '' })).statusCode).toBe(401);
      expect((await guestPost(g, 'whep', { authorization: 'Bearer olgi_v1_forged.token' })).statusCode).toBe(401);
    });

    it('another invite’s token on this inviteId', async () => {
      const a = await joinGuest('video_in_0');
      const b = await joinGuest('video_in_1');
      const res = await guestPost({ ...a, token: b.token }, 'whep');
      expect(res.statusCode).toBe(401);
    });

    it('expired invite', async () => {
      const g = await joinGuest();
      invitesStore.set(g.inviteId, { ...invitesStore.get(g.inviteId)!, expiresAt: new Date(Date.now() - 1000).toISOString() });
      expect((await guestPost(g, 'whep')).statusCode).toBe(401);
    });

    it('revoked invite', async () => {
      const g = await joinGuest();
      invitesStore.delete(g.inviteId);
      expect((await guestPost(g, 'whep')).statusCode).toBe(401);
    });

    it('left guest', async () => {
      const g = await joinGuest();
      setSession(g.guestId, { state: 'left' });
      expect((await guestPost(g, 'whep')).statusCode).toBe(401);
      expect((await guestPost(g, 'whip')).statusCode).toBe(401);
    });

    it('kicked guest', async () => {
      const g = await joinGuest();
      const kick = await inject({ method: 'DELETE', url: `/api/v1/productions/prod-1/guests/${g.guestId}`, headers: AUTH });
      expect(kick.statusCode).toBe(204);
      expect((await guestPost(g, 'whep')).statusCode).toBe(401);
    });
  });

  describe('404 Talkback unavailable', () => {
    it('intercom unconfigured', async () => {
      const g = await joinGuest();
      const { config } = await import('../config.js');
      const mutable = config as Record<string, unknown>;
      const saved = config.intercomManagerUrl;
      mutable['intercomManagerUrl'] = undefined;
      try {
        const res = await guestPost(g, 'whep');
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toBe('Talkback unavailable');
      } finally {
        mutable['intercomManagerUrl'] = saved;
      }
    });

    it('session has no intercomLineId', async () => {
      const g = await joinGuest();
      setSession(g.guestId, { intercomLineId: undefined });
      const res = await guestPost(g, 'whep');
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Talkback unavailable');
      expect(mgr.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('a non-numeric stored line id is refused (R4) without calling the manager', async () => {
      const g = await joinGuest();
      setSession(g.guestId, { intercomLineId: '../../production' });
      expect((await guestPost(g, 'whep')).statusCode).toBe(404);
      expect(mgr.calls).toHaveLength(0);
    });

    it('manager 404 → 404', async () => {
      const g = await joinGuest();
      mgr.offer = () => new Response('Line not found', { status: 404 });
      const res = await guestPost(g, 'whep');
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Talkback unavailable');
    });
  });

  describe('manager error mapping', () => {
    it('manager 401 (key mismatch) → 502, logged as a key rejection', async () => {
      const g = await joinGuest();
      mgr.offer = () => new Response('Unauthorized', { status: 401 });
      const res = await guestPost(g, 'whep');
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('Intercom manager unreachable');
      expect(logLines.some((l) => l.includes('talkback: intercom-manager rejected INTERCOM_WHIP_AUTH_KEY'))).toBe(true);
    });

    it('manager 5xx → 502', async () => {
      const g = await joinGuest();
      mgr.offer = () => new Response('boom', { status: 500 });
      expect((await guestPost(g, 'whep')).statusCode).toBe(502);
    });

    it('manager network error → 502', async () => {
      const g = await joinGuest();
      mgr.offer = () => {
        throw new TypeError('fetch failed');
      };
      expect((await guestPost(g, 'whep')).statusCode).toBe(502);
    });

    it('manager 429 → 503 with the manager’s Retry-After', async () => {
      const g = await joinGuest();
      mgr.offer = () => new Response('Too many', { status: 429, headers: { 'retry-after': '30' } });
      const res = await guestPost(g, 'whep');
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('Intercom manager busy');
      expect(res.headers['retry-after']).toBe('30');
    });

    it('manager 429 without Retry-After → 503 with Retry-After 5', async () => {
      const g = await joinGuest();
      mgr.offer = () => new Response('Too many', { status: 429 });
      const res = await guestPost(g, 'whep');
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
    });

    it('manager 400 → 400 Malformed SDP', async () => {
      const g = await joinGuest();
      mgr.offer = () => new Response('Invalid SDP', { status: 400 });
      const res = await guestPost(g, 'whep');
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Malformed SDP');
    });

    it('manager 406 → 406 pass-through', async () => {
      const g = await joinGuest();
      mgr.offer = () => new Response(JSON.stringify({ message: 'm=video not negotiated' }), { status: 406 });
      const res = await guestPost(g, 'whep');
      expect(res.statusCode).toBe(406);
      expect(res.json().error).toBe('m=video not negotiated');
    });

    it('manager 415 → 415', async () => {
      const g = await joinGuest();
      mgr.offer = () => new Response('nope', { status: 415 });
      expect((await guestPost(g, 'whep')).statusCode).toBe(415);
    });
  });

  describe('R4: manager Location / ETag validation → 502', () => {
    const cases: Array<[string, (call: ManagerCall, sid: string) => Record<string, string | null>]> = [
      ['foreign origin', (c, sid) => ({ location: `https://evil.example.com/api/v1/${c.kind}/${PROD}/42/${sid}` })],
      ['other port', (c, sid) => ({ location: `https://intercom.example.com:8443/api/v1/${c.kind}/${PROD}/42/${sid}` })],
      ['other line', (c, sid) => ({ location: `/api/v1/${c.kind}/${PROD}/99/${sid}` })],
      ['other kind', (_c, sid) => ({ location: `/api/v1/whip/${PROD}/42/${sid}` })],
      ['non-UUID session id', () => ({ location: `/api/v1/whep/${PROD}/42/not-a-uuid`, etag: 'not-a-uuid' })],
      ['extra path segment', (c, sid) => ({ location: `/api/v1/${c.kind}/${PROD}/42/${sid}/x` })],
      ['query string', (c, sid) => ({ location: `/api/v1/${c.kind}/${PROD}/42/${sid}?a=b` })],
      ['missing Location', () => ({ location: null })],
      ['ETag ≠ Location', () => ({ etag: '00000000-0000-4000-8000-000000000000' })],
      ['missing ETag', () => ({ etag: null })],
    ];
    it.each(cases)('%s', async (_name, override) => {
      const g = await joinGuest();
      mgr.offer = (call, sid) => created(call, sid, override(call, sid));
      const res = await guestPost(g, 'whep');
      expect(res.statusCode).toBe(502);
      expect(res.headers['location']).toBeUndefined();
      expect(sessionsStore.get(g.guestId)?.talkbackWhepSessionId).toBeUndefined();
    });

    it('accepts an absolute Location on the manager origin and a quoted ETag', async () => {
      const g = await joinGuest();
      mgr.offer = (call, sid) =>
        created(call, sid, { location: `${MANAGER}/${call.kind}/${PROD}/42/${sid}`, etag: `"${sid}"` });
      expect((await guestPost(g, 'whep')).statusCode).toBe(201);
    });
  });

  it('a non-SDP body → 415; an empty SDP body → 400', async () => {
    const g = await joinGuest();
    expect((await guestPost(g, 'whep', { 'content-type': 'text/plain' })).statusCode).toBe(415);
    expect((await guestPost(g, 'whep', {}, '')).statusCode).toBe(400);
    expect(mgr.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('an SDP over 64 KiB is refused before reaching the manager', async () => {
    const g = await joinGuest();
    const res = await guestPost(g, 'whep', {}, 'a'.repeat(64 * 1024 + 1));
    expect(res.statusCode).toBe(413);
    expect(mgr.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('rebinding: a second POST replaces the stored id and DELETEs the previous manager session', async () => {
    const g = await joinGuest();
    const first = String((await guestPost(g, 'whep')).headers['etag']);
    const second = String((await guestPost(g, 'whep')).headers['etag']);
    expect(second).not.toBe(first);
    expect(sessionsStore.get(g.guestId)?.talkbackWhepSessionId).toBe(second);
    const deletes = mgr.calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toEqual([
      expect.objectContaining({ kind: 'whep', production: PROD, line: '42', tail: first, auth: `Bearer ${WHIP_KEY}` }),
    ]);
  });

  it('own 10/min per-route rate limit → 429', async () => {
    const g = await joinGuest();
    let last: LightMyRequestResponse | undefined;
    for (let i = 0; i < 11; i++) {
      last = await inject({
        method: 'POST',
        remoteAddress: '192.0.2.77',
        url: `/api/v1/guests/${g.inviteId}/talkback/whep`,
        headers: { authorization: `Bearer ${g.token}`, 'content-type': 'application/sdp' },
        payload: OFFER,
      });
    }
    expect(last!.statusCode).toBe(429);
  });

  it('the guests projection never exposes the talkback session ids', async () => {
    const g = await joinGuest();
    await guestPost(g, 'whep');
    await guestPost(g, 'whip');
    const list = await inject({ method: 'GET', url: '/api/v1/productions/prod-1/guests', headers: AUTH });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('talkbackWhepSessionId');
    expect(list.body).not.toContain('talkbackWhipSessionId');
  });
});

describe('guest talkback DELETE (§3.2)', () => {
  it('own session → 204, manager DELETE, binding cleared', async () => {
    const g = await joinGuest();
    const sid = String((await guestPost(g, 'whep')).headers['etag']);
    const res = await guestDelete(g, 'whep', sid);
    expect(res.statusCode).toBe(204);
    expect(mgr.calls.at(-1)).toMatchObject({ method: 'DELETE', kind: 'whep', line: '42', tail: sid });
    expect(sessionsStore.get(g.guestId)?.talkbackWhepSessionId).toBeUndefined();
  });

  it('manager 404 (already gone) → 204', async () => {
    const g = await joinGuest();
    const sid = String((await guestPost(g, 'whip')).headers['etag']);
    mgr.del = () => new Response('WHIP session not found', { status: 404 });
    expect((await guestDelete(g, 'whip', sid)).statusCode).toBe(204);
  });

  it('another guest’s session id → 403, manager not called', async () => {
    const a = await joinGuest('video_in_0');
    const b = await joinGuest('video_in_1');
    const bSid = String((await guestPost(b, 'whep')).headers['etag']);
    await guestPost(a, 'whep');
    const before = mgr.calls.length;
    const res = await guestDelete(a, 'whep', bSid);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Session does not belong to this guest');
    expect(mgr.calls).toHaveLength(before);
  });

  it('own WHIP id on the WHEP resource → 403', async () => {
    const g = await joinGuest();
    const whipSid = String((await guestPost(g, 'whip')).headers['etag']);
    expect((await guestDelete(g, 'whep', whipSid)).statusCode).toBe(403);
  });

  it('a 36-char non-UUID session id → 400', async () => {
    const g = await joinGuest();
    expect((await guestDelete(g, 'whep', '-'.repeat(36))).statusCode).toBe(400);
  });

  it('left guest → 401', async () => {
    const g = await joinGuest();
    const sid = String((await guestPost(g, 'whep')).headers['etag']);
    setSession(g.guestId, { state: 'left' });
    expect((await guestDelete(g, 'whep', sid)).statusCode).toBe(401);
  });

  it('manager 5xx on DELETE → 502', async () => {
    const g = await joinGuest();
    const sid = String((await guestPost(g, 'whep')).headers['etag']);
    mgr.del = () => new Response('boom', { status: 500 });
    expect((await guestDelete(g, 'whep', sid)).statusCode).toBe(502);
  });
});

describe('isGuestTokenAuthedPath — anchored and UUID-constrained', () => {
  const sid = '0b8a6c1e-7f3d-4c2a-9e51-2d4f6a8b0c1d';

  it('a non-UUID or suffixed/prefixed talkback path is NOT guest-token-authed (shared-key 401)', async () => {
    const g = await joinGuest();
    const paths = [
      `/api/v1/guests/${g.inviteId}/talkback/whip/not-a-uuid`,
      `/api/v1/guests/${g.inviteId}/talkback/whep/${sid}x`,
      `/api/v1/guests/${g.inviteId}/talkback/whep/${sid}/extra`,
      `/api/v1/guests/${g.inviteId}/talkback/whipx`,
      `/api/v1/guests/${g.inviteId}/xtalkback/whip`,
      `/api/v1/guests/${g.inviteId}/talkback/whip/`,
      `/api/v1/guests/${g.inviteId}/talkback`,
      `/x/api/v1/guests/${g.inviteId}/talkback/whip`,
    ];
    for (const url of paths) {
      for (const method of ['POST', 'DELETE'] as const) {
        const res = await inject({ method, url, headers: { authorization: `Bearer ${g.token}` } });
        if (url.startsWith('/x/')) {
          // Outside /api/v1 the gate does not apply; it must simply not route.
          expect(res.statusCode, `${method} ${url}`).toBe(404);
          continue;
        }
        expect(res.statusCode, `${method} ${url}`).toBe(401);
        expect(res.json(), `${method} ${url}`).toEqual({ error: 'Unauthorized', statusCode: 401 });
      }
      // The same paths still accept the shared API_KEY at the gate (the
      // handler or router answers instead of the gate's 401).
      const crew = await inject({ method: 'DELETE', url, headers: AUTH });
      expect(crew.json(), `API_KEY DELETE ${url}`).not.toEqual({ error: 'Unauthorized', statusCode: 401 });
    }
  });

  it('the exact talkback paths pass the gate with an invite token', async () => {
    const g = await joinGuest();
    const post = await guestPost(g, 'whep');
    expect(post.statusCode).toBe(201);
    const del = await guestDelete(g, 'whep', String(post.headers['etag']));
    expect(del.statusCode).toBe(204);
  });
});

describe('crew talkback routes (§3.3)', () => {
  it('POST WHEP/WHIP with API_KEY: 201, crew Location, default name Producer, not persisted', async () => {
    const g = await joinGuest();
    const before = JSON.stringify(sessionsStore.get(g.guestId));
    for (const kind of ['whep', 'whip'] as const) {
      const res = await crewPost(g, kind);
      expect(res.statusCode).toBe(201);
      const sid = String(res.headers['etag']);
      expect(res.headers['location']).toBe(`/api/v1/productions/prod-1/guests/${g.guestId}/talkback/${kind}/${sid}`);
      expect(res.headers['link']).toBeUndefined();
      expect(mgr.calls.at(-1)).toMatchObject({ kind, production: PROD, line: '42', tail: 'Producer', auth: `Bearer ${WHIP_KEY}` });
    }
    expect(JSON.stringify(sessionsStore.get(g.guestId))).toBe(before);
  });

  it('?name= is sanitized', async () => {
    const g = await joinGuest();
    const res = await crewPost(g, 'whep', `?name=${encodeURIComponent('Jane <Doe>/PD')}`);
    expect(res.statusCode).toBe(201);
    expect(mgr.calls.at(-1)!.tail).toBe('Jane _Doe__PD');
  });

  it('crew may talk to a return-only guest (WHIP is the operator mic, not the slot)', async () => {
    const g = await joinGuest('video_in_1');
    const res = await crewPost(g, 'whip');
    expect(res.statusCode).toBe(201);
    expect(mgr.calls.at(-1)).toMatchObject({ kind: 'whip', line: '43' });
  });

  it('no API_KEY → 401; an invite token is not accepted', async () => {
    const g = await joinGuest();
    expect((await crewPost(g, 'whep', '', {})).statusCode).toBe(401);
    expect((await crewPost(g, 'whep', '', { authorization: `Bearer ${g.token}` })).statusCode).toBe(401);
  });

  it('unknown guest, other production, or left guest → 404 Guest not found', async () => {
    const g = await joinGuest();
    const unknown = await inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/guests/guest-session-nope/talkback/whep',
      headers: { ...AUTH, 'content-type': 'application/sdp' },
      payload: OFFER,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('Guest not found');
    const other = await inject({
      method: 'POST',
      url: `/api/v1/productions/prod-2/guests/${g.guestId}/talkback/whep`,
      headers: { ...AUTH, 'content-type': 'application/sdp' },
      payload: OFFER,
    });
    expect(other.statusCode).toBe(404);
    setSession(g.guestId, { state: 'left' });
    const left = await crewPost(g, 'whep');
    expect(left.statusCode).toBe(404);
    expect(left.json().error).toBe('Guest not found');
  });

  it('no line → 404 Talkback unavailable; manager 429 → 503 + Retry-After', async () => {
    const g = await joinGuest();
    mgr.offer = () => new Response('', { status: 429, headers: { 'retry-after': '12' } });
    const busy = await crewPost(g, 'whep');
    expect(busy.statusCode).toBe(503);
    expect(busy.headers['retry-after']).toBe('12');
    setSession(g.guestId, { intercomLineId: undefined });
    const res = await crewPost(g, 'whep');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Talkback unavailable');
  });

  it('DELETE: 204 on manager 200 or 404, also after the guest left; 400 on a non-UUID', async () => {
    const g = await joinGuest();
    const sid = String((await crewPost(g, 'whep')).headers['etag']);
    const del = await inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/guests/${g.guestId}/talkback/whep/${sid}`,
      headers: AUTH,
    });
    expect(del.statusCode).toBe(204);
    expect(mgr.calls.at(-1)).toMatchObject({ method: 'DELETE', kind: 'whep', line: '42', tail: sid });

    setSession(g.guestId, { state: 'left' });
    mgr.del = () => new Response('WHEP session not found', { status: 404 });
    const gone = await inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/guests/${g.guestId}/talkback/whep/${sid}`,
      headers: AUTH,
    });
    expect(gone.statusCode).toBe(204);

    const bad = await inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/guests/${g.guestId}/talkback/whip/not-a-uuid`,
      headers: AUTH,
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('key never leaks (must-have, §7)', () => {
  it('INTERCOM_WHIP_AUTH_KEY appears in no response body/header and no log line, across success and error paths', async () => {
    const g = await joinGuest();
    const rs = await joinGuest('video_in_1');
    const scenarios: Array<() => void> = [
      () => {
        mgr.offer = (call, sid) => created(call, sid);
      },
      () => {
        mgr.offer = () => new Response(`bad key ${WHIP_KEY}`, { status: 401 });
      },
      () => {
        mgr.offer = () => new Response(`error with ${WHIP_KEY}`, { status: 500 });
      },
      () => {
        mgr.offer = () => {
          throw new TypeError(`connect ECONNREFUSED (${WHIP_KEY})`);
        };
      },
      () => {
        mgr.offer = () => new Response('slow down', { status: 429, headers: { 'retry-after': '9' } });
      },
      () => {
        mgr.offer = () => new Response(JSON.stringify({ message: `not acceptable ${WHIP_KEY}` }), { status: 406 });
      },
      () => {
        mgr.offer = () => new Response(`bad sdp ${WHIP_KEY}`, { status: 400 });
      },
      () => {
        mgr.offer = () => new Response('', { status: 404 });
      },
      () => {
        mgr.offer = () => new Response('', { status: 415 });
      },
      () => {
        mgr.offer = (call, sid) => created(call, sid, { location: `https://evil.example.com/${WHIP_KEY}/${sid}` });
      },
      () => {
        mgr.offer = (call, sid) => created(call, sid, { etag: WHIP_KEY });
      },
    ];
    const deleteBehaviours: Array<() => void> = [
      () => {
        mgr.del = () => new Response('OK', { status: 200 });
      },
      () => {
        mgr.del = () => new Response(`nope ${WHIP_KEY}`, { status: 401 });
      },
      () => {
        mgr.del = () => {
          throw new TypeError(`socket hang up ${WHIP_KEY}`);
        };
      },
      () => {
        mgr.del = () => new Response('', { status: 429 });
      },
    ];

    for (const set of scenarios) {
      set();
      await guestPost(g, 'whep');
      await guestPost(g, 'whip');
      await guestPost(rs, 'whip'); // 403 path
      await crewPost(g, 'whep');
      await crewPost(g, 'whip', '?name=Director');
    }
    // DELETE paths, with a bound session to delete.
    mgr.offer = (call, sid) => created(call, sid);
    for (const set of deleteBehaviours) {
      mgr.del = () => new Response('OK', { status: 200 });
      const sid = String((await guestPost(g, 'whep')).headers['etag']);
      set();
      await guestDelete(g, 'whep', sid);
      await guestDelete(g, 'whep', '0b8a6c1e-7f3d-4c2a-9e51-2d4f6a8b0c1d'); // 403
      await inject({
        method: 'DELETE',
        url: `/api/v1/productions/prod-1/guests/${g.guestId}/talkback/whip/${sid}`,
        headers: AUTH,
      });
    }

    // The key really was used on the outbound calls…
    expect(mgr.calls.length).toBeGreaterThan(20);
    expect(mgr.calls.every((c) => c.auth === `Bearer ${WHIP_KEY}`)).toBe(true);
    // …and never came back out.
    expect(responses.length).toBeGreaterThan(50);
    for (const res of responses) {
      expect(res.body).not.toContain(WHIP_KEY);
      expect(JSON.stringify(res.headers)).not.toContain(WHIP_KEY);
      expect(JSON.stringify(res.headers)).not.toContain('TURN-SECRET');
    }
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).not.toContain(WHIP_KEY);
    }
  });
});
