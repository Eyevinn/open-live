/**
 * Talkback teardown on leave, kick, revoke and deactivate (issue #600,
 * `docs/specs/guest-talkback.md` §6, §3.1, §5).
 *
 * The intercom-manager boundary is a fake speaking the manager's real contract
 * (spec §3.1): `GET /production/:p/line` → `LineResponse[]` with
 * `participants[] = { name, sessionId, isActive, isWhip, isWhepReceiver? }`;
 * `DELETE /whip|whep/:p/:l/:sid` → `200 'OK'` or `404`;
 * `DELETE /production/:p` → `200`, or `409` while a session is active (v4.1.0).
 * Every manager call is recorded in order so the deactivate sweep order can be
 * asserted. Log lines are captured to check that failures are logged at warn.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { GuestInviteDoc, GuestSessionDoc, ProductionDoc } from '../db/types.js';

const CREW_BEARER = 'test-secret-key';
process.env['API_KEY'] = CREW_BEARER;
process.env['GUEST_INVITE_SECRET'] = 'test-hmac-secret';
process.env['PUBLIC_BASE_URL'] = 'https://live.example.com';
process.env['INTERCOM_MANAGER_URL'] = 'https://intercom.example.com/api/v1';
process.env['INTERCOM_MANAGER_TOKEN'] = 'ic-token';
process.env['INTERCOM_WHIP_AUTH_KEY'] = 'whip-key';
process.env['LOG_LEVEL'] = 'trace';

// ---- Mock CouchDB stores ----
const invitesStore = new Map<string, GuestInviteDoc>();
const sessionsStore = new Map<string, GuestSessionDoc>();
const productionsStore = new Map<string, ProductionDoc>();

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
    return { ok: true, id: doc._id, rev: '2-x' };
  }),
  find: vi.fn(async () => ({ docs: [] })),
  findTrusted: vi.fn(async () => ({ docs: [] })),
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
    sessionsStore.set(doc._id, { ...doc, _rev: `${Date.now()}-x` });
    return { ok: true, id: doc._id, rev: '2-x' };
  }),
  destroy: vi.fn(),
  find: vi.fn(async (q: { selector: Record<string, unknown> }) => ({
    docs: matchSelector(Array.from(sessionsStore.values()), q.selector),
  })),
};

vi.mock('../lib/ice-servers.js', () => ({
  getIceServers: vi.fn().mockRejectedValue(new Error('Strom unreachable')),
  resetIceServersCache: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => prodDb,
  getGuestInvitesDb: () => invitesDb,
  getGuestSessionsDb: () => sessionsDb,
  getSourcesDb: () => ({ get: vi.fn(async () => { throw notFound(); }), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
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

const AUTH = { authorization: `Bearer ${CREW_BEARER}` };
const MANAGER = 'https://intercom.example.com/api/v1';
const PROD = '7';
const LINE = '42';
const WHIP_SID = '11111111-1111-4111-8111-111111111111';
const WHEP_SID = '22222222-2222-4222-8222-222222222222';
const CREW_WHIP_SID = '33333333-3333-4333-8333-333333333333';
const CREW_WHEP_SID = '44444444-4444-4444-8444-444444444444';

const logLines: string[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer({ logStream: { write: (line: string) => void logLines.push(line) } });
});

/** Parsed log entries at `level` (pino numbers: 30 info, 40 warn) whose msg matches. */
function logsMatching(re: RegExp, level?: number): Array<Record<string, unknown>> {
  return logLines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((e) => typeof e['msg'] === 'string' && re.test(e['msg'] as string))
    .filter((e) => level === undefined || e['level'] === level);
}

// ---- Fake intercom-manager (spec §3.1) ----

interface ManagerCall {
  method: string;
  path: string;
}

interface FakeManager {
  calls: ManagerCall[];
  /** `participants[]` per line id for `GET /production/:p/line`. */
  participants: Record<string, Array<Record<string, unknown>>>;
  listLines: () => Response | Promise<Response>;
  delSession: (path: string) => Response | Promise<Response>;
  delProduction: () => Response | Promise<Response>;
}

let mgr: FakeManager;

function fakeManager(): FakeManager {
  const m: FakeManager = {
    calls: [],
    participants: { [LINE]: [] },
    listLines: () =>
      new Response(
        JSON.stringify(
          Object.entries(m.participants).map(([id, participants]) => ({
            name: `guest-${id}`,
            id,
            smbConferenceId: 'c',
            participants,
          })),
        ),
        { status: 200 },
      ),
    delSession: () => new Response('OK', { status: 200 }),
    delProduction: () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (!u.startsWith(MANAGER)) throw new Error(`unexpected fetch ${u}`);
    const path = u.slice(MANAGER.length);
    const method = (init?.method ?? 'GET').toUpperCase();
    m.calls.push({ method, path });
    if (path === `/production/${PROD}/line` && method === 'GET') return m.listLines();
    if (path === `/production/${PROD}` && method === 'DELETE') return m.delProduction();
    if (/^\/(whip|whep)\/[^/]+\/[^/]+\/[^/]+$/.test(path) && method === 'DELETE') return m.delSession(path);
    throw new Error(`unexpected fetch ${method} ${path}`);
  });
  return m;
}

/** The manager DELETEs of talkback sessions, as `kind/p/l/sid` paths. */
function sessionDeletes(): string[] {
  return mgr.calls
    .filter((c) => c.method === 'DELETE' && /^\/(whip|whep)\//.test(c.path))
    .map((c) => c.path)
    .sort();
}

// ---- Fixtures ----

function seedProduction(overrides: Partial<ProductionDoc> = {}): ProductionDoc {
  const doc = {
    _id: 'prod-1',
    _rev: '1-a',
    type: 'production',
    name: 'Test show',
    status: 'active',
    intercomProductionId: PROD,
    sources: [
      { sourceId: 'Whip', mixerInput: 'video_in_0', returnFeed: { synced: 'program-minus', lowLatency: false } },
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
function nextIp(): string {
  ip += 1;
  return `10.1.${Math.floor(ip / 250) % 250}.${(ip % 250) + 1}`;
}

function inject(opts: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject({ remoteAddress: nextIp(), ...opts });
}

interface Guest {
  inviteId: string;
  token: string;
  guestId: string;
}

/**
 * A live guest whose talkback is open: the invite and session are seeded
 * directly (the join path is covered elsewhere) with the stored manager ids.
 */
async function seedGuest(talkback: Partial<GuestSessionDoc> = {
  talkbackWhipSessionId: WHIP_SID,
  talkbackWhepSessionId: WHEP_SID,
}): Promise<Guest> {
  const inv = await inject({
    method: 'POST',
    url: '/api/v1/productions/prod-1/guests/invites',
    headers: AUTH,
    payload: { mixerInput: 'video_in_0', label: 'Ana' },
  });
  expect(inv.statusCode).toBe(201);
  const { id, token } = inv.json() as { id: string; token: string };
  const guestId = `gs-${id}`;
  sessionsStore.set(guestId, {
    _id: guestId,
    _rev: '1-x',
    type: 'guest-session',
    inviteId: id,
    productionId: 'prod-1',
    mixerInput: 'video_in_0',
    state: 'connected',
    intercomLineId: LINE,
    createdAt: '',
    updatedAt: '',
    ...talkback,
  } as unknown as GuestSessionDoc);
  return { inviteId: id, token, guestId };
}

const leave = (g: Guest) =>
  inject({ method: 'DELETE', url: `/api/v1/guests/${g.inviteId}/session`, headers: { authorization: `Bearer ${g.token}` } });
const kick = (g: Guest) =>
  inject({ method: 'DELETE', url: `/api/v1/productions/prod-1/guests/${g.guestId}`, headers: AUTH });
const revoke = (g: Guest) =>
  inject({ method: 'DELETE', url: `/api/v1/productions/prod-1/guests/invites/${g.inviteId}`, headers: AUTH });
const deactivate = () => inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate', headers: AUTH });

beforeEach(() => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  logLines.length = 0;
  vi.restoreAllMocks();
  seedProduction();
  mgr = fakeManager();
});

// ---------------------------------------------------------------------------

const TRIGGERS: Array<[string, (g: Guest) => Promise<LightMyRequestResponse>]> = [
  ['leave', leave],
  ['kick', kick],
  ['revoke', revoke],
];

describe.each(TRIGGERS)('%s ends the guest’s talkback sessions (§6)', (_name, trigger) => {
  it('DELETEs the stored WHIP and WHEP manager sessions and never the line', async () => {
    const g = await seedGuest();
    const res = await trigger(g);
    expect(res.statusCode).toBe(204);
    expect(sessionDeletes()).toEqual([
      `/whep/${PROD}/${LINE}/${WHEP_SID}`,
      `/whip/${PROD}/${LINE}/${WHIP_SID}`,
    ]);
    // The line belongs to the slot and is reused: no line or production DELETE.
    expect(mgr.calls.filter((c) => c.method === 'DELETE' && c.path.startsWith('/production'))).toEqual([]);
    expect(logsMatching(/talkback teardown: session ended/, 30)).toHaveLength(2);
  });

  it('only the ids that are stored: a WHEP-only (return-only) guest gets one DELETE', async () => {
    const g = await seedGuest({ talkbackWhepSessionId: WHEP_SID });
    expect((await trigger(g)).statusCode).toBe(204);
    expect(sessionDeletes()).toEqual([`/whep/${PROD}/${LINE}/${WHEP_SID}`]);
  });

  it('no stored talkback ids (legacy or never opened) → no manager call', async () => {
    const g = await seedGuest({});
    expect((await trigger(g)).statusCode).toBe(204);
    expect(mgr.calls).toEqual([]);
  });

  it('manager 404 on DELETE counts as already gone (no warn)', async () => {
    mgr.delSession = () => new Response('WHIP session not found', { status: 404 });
    const g = await seedGuest();
    expect((await trigger(g)).statusCode).toBe(204);
    expect(sessionDeletes()).toHaveLength(2);
    expect(logsMatching(/talkback teardown: session ended/, 30).map((e) => e['outcome'])).toEqual(['gone', 'gone']);
    expect(logsMatching(/talkback teardown: DELETE failed/)).toEqual([]);
  });

  it('manager 500: the action still succeeds and a warn is logged', async () => {
    mgr.delSession = () => new Response('boom', { status: 500 });
    const g = await seedGuest();
    expect((await trigger(g)).statusCode).toBe(204);
    expect(sessionDeletes()).toHaveLength(2);
    expect(logsMatching(/talkback teardown: DELETE failed/, 40)).toHaveLength(2);
  });

  it('manager unreachable: the action still succeeds and a warn is logged', async () => {
    mgr.delSession = () => {
      throw new TypeError('fetch failed');
    };
    const g = await seedGuest();
    expect((await trigger(g)).statusCode).toBe(204);
    expect(logsMatching(/talkback teardown: DELETE failed/, 40)).toHaveLength(2);
  });
});

describe('guest teardown edge cases', () => {
  it('leave marks the session left even when the manager is down', async () => {
    mgr.delSession = () => {
      throw new TypeError('fetch failed');
    };
    const g = await seedGuest();
    expect((await leave(g)).statusCode).toBe(204);
    expect(sessionsStore.get(g.guestId)?.state).toBe('left');
  });

  it('revoke ends the talkback of every live session of the invite, not of left ones', async () => {
    const g = await seedGuest();
    const other = '55555555-5555-4555-8555-555555555555';
    sessionsStore.set('gs-old', {
      ...sessionsStore.get(g.guestId)!,
      _id: 'gs-old',
      state: 'left',
      talkbackWhipSessionId: other,
      talkbackWhepSessionId: undefined,
    } as GuestSessionDoc);
    expect((await revoke(g)).statusCode).toBe(204);
    expect(sessionDeletes()).toEqual([
      `/whep/${PROD}/${LINE}/${WHEP_SID}`,
      `/whip/${PROD}/${LINE}/${WHIP_SID}`,
    ]);
  });

  it('no intercom production on the production doc → no manager call', async () => {
    seedProduction({ intercomProductionId: undefined });
    const g = await seedGuest();
    expect((await kick(g)).statusCode).toBe(204);
    expect(mgr.calls).toEqual([]);
  });

  it('a non-UUID stored session id is refused (R4) without calling the manager', async () => {
    const g = await seedGuest({ talkbackWhipSessionId: '../../production/7' });
    expect((await kick(g)).statusCode).toBe(204);
    expect(mgr.calls).toEqual([]);
    expect(logsMatching(/talkback teardown: DELETE failed/, 40)).toHaveLength(1);
  });
});

describe('production deactivate sweep (§6)', () => {
  function openTalkback() {
    mgr.participants = {
      [LINE]: [
        // Guest: WHIP publish + WHEP listen.
        { name: 'Ana', sessionId: WHIP_SID, isActive: true, isWhip: true },
        { name: 'Ana', sessionId: WHEP_SID, isActive: true, isWhip: true, isWhepReceiver: true },
        // Studio crew sessions (never persisted by open-live).
        { name: 'Producer', sessionId: CREW_WHIP_SID, isActive: true, isWhip: true },
        { name: 'Producer', sessionId: CREW_WHEP_SID, isActive: true, isWhip: true, isWhepReceiver: true },
        // A non-WHIP browser participant of the line is not ours to end.
        { name: 'Intercom user', sessionId: 'browser-sid', isActive: true, isWhip: false },
      ],
      '43': [{ name: 'Bo', sessionId: '66666666-6666-4666-8666-666666666666', isActive: false, isWhip: true }],
    };
  }

  it('DELETEs every WHIP/WHEP participant (guest and crew) before DELETE /production/:p', async () => {
    openTalkback();
    const res = await deactivate();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ended' });

    expect(sessionDeletes()).toEqual([
      `/whep/${PROD}/${LINE}/${CREW_WHEP_SID}`,
      `/whep/${PROD}/${LINE}/${WHEP_SID}`,
      `/whip/${PROD}/${LINE}/${WHIP_SID}`,
      `/whip/${PROD}/${LINE}/${CREW_WHIP_SID}`,
      `/whip/${PROD}/43/66666666-6666-4666-8666-666666666666`,
    ].sort());

    const order = mgr.calls.map((c) => `${c.method} ${c.path}`);
    expect(order[0]).toBe(`GET /production/${PROD}/line`);
    expect(order[order.length - 1]).toBe(`DELETE /production/${PROD}`);
    expect(order.filter((c) => c === `DELETE /production/${PROD}`)).toHaveLength(1);
  });

  it('a 409 on DELETE /production/:p is logged and deactivation still succeeds', async () => {
    openTalkback();
    mgr.delProduction = () => new Response(JSON.stringify({ message: 'active sessions' }), { status: 409 });
    const res = await deactivate();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ended' });
    const order = mgr.calls.map((c) => `${c.method} ${c.path}`);
    expect(order[order.length - 1]).toBe(`DELETE /production/${PROD}`);
    expect(logsMatching(/intercom teardown refused \(409/, 40)).toHaveLength(1);
  });

  it('manager 500 on the participant DELETEs: still DELETEs the production, warns, succeeds', async () => {
    openTalkback();
    mgr.delSession = () => new Response('boom', { status: 500 });
    const res = await deactivate();
    expect(res.statusCode).toBe(200);
    expect(sessionDeletes()).toHaveLength(5);
    expect(logsMatching(/talkback teardown: DELETE failed/, 40)).toHaveLength(5);
    expect(mgr.calls.at(-1)).toEqual({ method: 'DELETE', path: `/production/${PROD}` });
  });

  it('manager 404 on a participant DELETE is treated as success', async () => {
    openTalkback();
    mgr.delSession = () => new Response('WHEP session not found', { status: 404 });
    expect((await deactivate()).statusCode).toBe(200);
    expect(logsMatching(/talkback teardown: DELETE failed/)).toEqual([]);
    expect(logsMatching(/talkback sweep: participant sessions ended/, 30)[0]).toMatchObject({ ended: 5, failed: 0 });
  });

  it('manager unreachable: deactivation still succeeds and warns', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const res = await deactivate();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ended' });
    expect(logsMatching(/talkback sweep: could not list intercom lines/, 40)).toHaveLength(1);
    expect(logsMatching(/intercom teardown failed/, 40)).toHaveLength(1);
  });

  it('a 500 on GET /production/:p/line skips the sweep but still DELETEs the production', async () => {
    mgr.listLines = () => new Response('boom', { status: 500 });
    expect((await deactivate()).statusCode).toBe(200);
    expect(sessionDeletes()).toEqual([]);
    expect(mgr.calls.at(-1)).toEqual({ method: 'DELETE', path: `/production/${PROD}` });
    expect(logsMatching(/talkback sweep: could not list intercom lines/, 40)).toHaveLength(1);
  });

  it('no sessions on the lines → only GET line + DELETE production', async () => {
    expect((await deactivate()).statusCode).toBe(200);
    expect(mgr.calls).toEqual([
      { method: 'GET', path: `/production/${PROD}/line` },
      { method: 'DELETE', path: `/production/${PROD}` },
    ]);
  });
});

describe('talkbackSessionsFromLines', () => {
  it('maps isWhepReceiver → whep, other isWhip → whip, skips the rest; throws on a non-array', async () => {
    const { talkbackSessionsFromLines } = await import('../lib/intercom-manager.js');
    expect(
      talkbackSessionsFromLines('7', [
        { id: 42, participants: [{ sessionId: 'a', isWhip: true, isWhepReceiver: true }, { sessionId: 'b', isWhip: true }] },
        { id: '43', participants: [{ sessionId: 'c', isWhip: false }, { isWhip: true }] },
        { id: '44' },
        null,
      ]),
    ).toEqual([
      { kind: 'whep', productionId: '7', lineId: '42', sessionId: 'a' },
      { kind: 'whip', productionId: '7', lineId: '42', sessionId: 'b' },
    ]);
    expect(() => talkbackSessionsFromLines('7', { lines: [] })).toThrow();
  });
});
