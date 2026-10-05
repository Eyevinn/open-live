/**
 * Return-only guest slots: a guest slot whose source is not WHIP (an SRT
 * encoder) carries the guest's picture and voice itself, so the invite grants
 * the return only. CouchDB, the WS controller and Strom (`fetch`) are mocked.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GuestInviteDoc, GuestSessionDoc, ProductionDoc, SourceDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
process.env['GUEST_INVITE_SECRET'] = 'test-hmac-secret';
process.env['PUBLIC_BASE_URL'] = 'https://live.example.com';
process.env['STROM_URL'] = 'http://strom.test';

const invitesStore = new Map<string, GuestInviteDoc>();
const sessionsStore = new Map<string, GuestSessionDoc>();
const productionsStore = new Map<string, ProductionDoc>();
const sourcesStore = new Map<string, Partial<SourceDoc>>();
let sourcesDbDown = false;

const notFound = () => Object.assign(new Error('not_found'), { statusCode: 404 });

function matchSelector<T>(docs: T[], selector: Record<string, unknown>): T[] {
  return docs.filter((d) =>
    Object.entries(selector).every(([k, v]) => (d as Record<string, unknown>)[k] === v),
  );
}

function store<T extends { _id: string }>(m: Map<string, T>) {
  return {
    get: vi.fn(async (id: string) => {
      const doc = m.get(id);
      if (!doc) throw notFound();
      return doc;
    }),
    insert: vi.fn(async (doc: T) => {
      m.set(doc._id, { ...doc, _rev: '1-x' });
      return { ok: true };
    }),
    destroy: vi.fn(),
    find: vi.fn(async (q: { selector: Record<string, unknown> }) => ({
      docs: matchSelector(Array.from(m.values()), q.selector),
    })),
  };
}

const sourcesDb = {
  get: vi.fn(async (id: string) => {
    if (sourcesDbDown) throw Object.assign(new Error('ECONNREFUSED'), { statusCode: 500 });
    const doc = sourcesStore.get(id);
    if (!doc) throw notFound();
    return doc;
  }),
};

vi.mock('../db/index.js', () => ({
  getDb: () => store(productionsStore),
  getGuestInvitesDb: () => store(invitesStore),
  getGuestSessionsDb: () => store(sessionsStore),
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
  applyReturnMode: vi.fn().mockResolvedValue({ ok: true, mixerInput: 'video_in_1', mode: 'program-minus' }),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };
let app: FastifyInstance;
let buildServer: () => Promise<FastifyInstance>;

/** video_in_0 is a WHIP guest slot; video_in_1 is an SRT guest slot. */
function seedProduction(srtSourceId = 'src-srt') {
  sourcesStore.set('src-srt', { _id: 'src-srt', streamType: 'srt', name: 'Phone on cellular' });
  productionsStore.set('prod-1', {
    _id: 'prod-1',
    _rev: '1-a',
    type: 'production',
    name: 'Race',
    status: 'active',
    stromFlowId: 'flow-1',
    sources: [
      { sourceId: 'Whip', mixerInput: 'video_in_0', returnFeed: { synced: 'program-minus' } },
      { sourceId: srtSourceId, mixerInput: 'video_in_1', returnFeed: { synced: 'program-minus' } },
    ],
    returnWhepUrls: [
      { mixerInput: 'video_in_0', url: 'http://strom.test/whep/return-0' },
      { mixerInput: 'video_in_1', url: 'http://strom.test/whep/return-1' },
    ],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '',
    updatedAt: '',
  } as unknown as ProductionDoc);
}

async function invite(mixerInput: string): Promise<{ id: string; token: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/productions/prod-1/guests/invites',
    headers: AUTH,
    payload: { mixerInput },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const guest = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
});

beforeEach(async () => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  sourcesStore.clear();
  sourcesDbDown = false;
  // Fresh server per test: the guest routes rate-limit at 10/min.
  app = await buildServer();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => 'v=0 mock-answer-sdp',
      headers: { get: () => null },
    }),
  );
});

describe('GET /api/v1/guests/:inviteId/slot', () => {
  it('reports an SRT slot as return-only and a WHIP slot as not, without creating a session', async () => {
    seedProduction();
    const srt = await invite('video_in_1');
    const whip = await invite('video_in_0');

    const a = await app.inject({ method: 'GET', url: `/api/v1/guests/${srt.id}/slot`, headers: guest(srt.token) });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ mixerInput: 'video_in_1', returnOnly: true });

    const b = await app.inject({ method: 'GET', url: `/api/v1/guests/${whip.id}/slot`, headers: guest(whip.token) });
    expect(b.json()).toEqual({ mixerInput: 'video_in_0', returnOnly: false });

    expect(sessionsStore.size).toBe(0);
  });

  it('401s without a valid invite token, and with another invite\'s token', async () => {
    seedProduction();
    const srt = await invite('video_in_1');
    const whip = await invite('video_in_0');
    const none = await app.inject({ method: 'GET', url: `/api/v1/guests/${srt.id}/slot` });
    expect(none.statusCode).toBe(401);
    const crossed = await app.inject({ method: 'GET', url: `/api/v1/guests/${srt.id}/slot`, headers: guest(whip.token) });
    expect(crossed.statusCode).toBe(401);
    const apiKey = await app.inject({ method: 'GET', url: `/api/v1/guests/${srt.id}/slot`, headers: AUTH });
    expect(apiKey.statusCode).toBe(401);
  });

  it('503s rather than guessing when the source cannot be read', async () => {
    seedProduction();
    const srt = await invite('video_in_1');
    sourcesDbDown = true;
    const res = await app.inject({ method: 'GET', url: `/api/v1/guests/${srt.id}/slot`, headers: guest(srt.token) });
    expect(res.statusCode).toBe(503);
  });
});

describe('POST /api/v1/guests/:inviteId/join on a return-only slot', () => {
  it('omits whipUrl and still issues the return feed and modes for the slot', async () => {
    seedProduction();
    const srt = await invite('video_in_1');
    const res = await app.inject({ method: 'POST', url: `/api/v1/guests/${srt.id}/join`, headers: guest(srt.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).not.toHaveProperty('whipUrl');
    expect(body.returnOnly).toBe(true);
    expect(body.feeds).toEqual([
      {
        id: 'picture',
        url: `https://live.example.com/api/v1/guests/${srt.id}/returns/picture/whep`,
        video: true,
      },
    ]);
    // The minus mode excludes the SRT input — the channel carrying this guest's voice.
    expect(body.modes.find((m: { key: string }) => m.key === 'program-minus').excludesMixerInput).toBe('video_in_1');
  });

  it('keeps whipUrl on a WHIP slot', async () => {
    seedProduction();
    const whip = await invite('video_in_0');
    const res = await app.inject({ method: 'POST', url: `/api/v1/guests/${whip.id}/join`, headers: guest(whip.token) });
    expect(res.json()).toMatchObject({
      whipUrl: `https://live.example.com/api/v1/guests/${whip.id}/whip`,
      returnOnly: false,
    });
  });

  it('treats a slot whose source is gone as return-only', async () => {
    seedProduction('src-deleted');
    const srt = await invite('video_in_1');
    const res = await app.inject({ method: 'POST', url: `/api/v1/guests/${srt.id}/join`, headers: guest(srt.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().returnOnly).toBe(true);
  });

  it('503s before creating a session when the source cannot be read', async () => {
    seedProduction();
    const srt = await invite('video_in_1');
    sourcesDbDown = true;
    const res = await app.inject({ method: 'POST', url: `/api/v1/guests/${srt.id}/join`, headers: guest(srt.token) });
    expect(res.statusCode).toBe(503);
    expect(sessionsStore.size).toBe(0);
  });
});

// The guest page publishes to the guest-scoped alias; a guest token is also
// accepted on the crew path, so both are covered.
const paths = {
  'guest-scoped': {
    whip: (inviteId: string) => `/api/v1/guests/${inviteId}/whip`,
    returnFeed: (inviteId: string) => `/api/v1/guests/${inviteId}/returns/picture/whep`,
  },
  crew: {
    whip: (_inviteId: string, mixerInput: string) => `/api/v1/productions/prod-1/whip/${mixerInput}`,
    returnFeed: (_inviteId: string, mixerInput: string) =>
      `/api/v1/productions/prod-1/returns/${mixerInput}/picture/whep`,
  },
};

describe.each(Object.entries(paths))('WHIP publish with a return-only invite (%s path)', (_name, path) => {
  it('403s a guest publish on an SRT slot without reaching Strom', async () => {
    seedProduction();
    const srt = await invite('video_in_1');
    await app.inject({ method: 'POST', url: `/api/v1/guests/${srt.id}/join`, headers: guest(srt.token) });
    const res = await app.inject({
      method: 'POST',
      url: path.whip(srt.id, 'video_in_1'),
      headers: { ...guest(srt.token), 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still lets the guest open the return picture feed', async () => {
    seedProduction();
    const srt = await invite('video_in_1');
    await app.inject({ method: 'POST', url: `/api/v1/guests/${srt.id}/join`, headers: guest(srt.token) });
    const res = await app.inject({
      method: 'POST',
      url: path.returnFeed(srt.id, 'video_in_1'),
      headers: { ...guest(srt.token), 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(201);
    expect(fetch).toHaveBeenCalledWith('http://strom.test/whep/return-1', expect.anything());
  });

  it('lets a guest on a WHIP slot publish as before', async () => {
    seedProduction();
    const whip = await invite('video_in_0');
    await app.inject({ method: 'POST', url: `/api/v1/guests/${whip.id}/join`, headers: guest(whip.token) });
    const res = await app.inject({
      method: 'POST',
      url: path.whip(whip.id, 'video_in_0'),
      headers: { ...guest(whip.token), 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(201);
  });
});
