/**
 * Guest-scoped WHIP publish + return-picture WHEP aliases under
 * `/api/v1/guests/:inviteId/...` (issue #423, part of #383).
 *
 * On OSC the ingress gate only passes `^/guest` and `^/api/v1/guests`
 * (osaas-app#6143), so the guest's WHIP publish / session PATCH+DELETE and the
 * return-feed WHEP under `/api/v1/productions/...` are blocked. This suite
 * covers the guest-scoped aliases that mirror the crew routes with the same
 * per-invite token check:
 *   - the join response hands back the guest-scoped whipUrl + return feed URL,
 *   - a live guest token publishes WHIP and plays its return WHEP through them,
 *   - PATCH/DELETE of the guest's own WHIP session succeed,
 *   - no-token / shared-API-key / left / wrong-invite callers are rejected,
 *   - the crew `/api/v1/productions/...` routes are unchanged (still API-keyed).
 *
 * CouchDB, the WS controller, Strom auth, and Strom itself (`fetch`) are mocked.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GuestInviteDoc, GuestSessionDoc, ProductionDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
process.env['GUEST_INVITE_SECRET'] = 'test-hmac-secret';
process.env['PUBLIC_BASE_URL'] = 'https://live.example.com';

const STROM_URL = 'http://localhost:7000'; // matches vitest.config.ts env STROM_URL

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
  insert: vi.fn(),
  find: vi.fn(async () => ({ docs: [] })),
  findTrusted: vi.fn(async () => ({ docs: [] })),
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
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(async (doc: GuestSessionDoc) => {
    sessionsStore.set(doc._id, { ...doc, _rev: '1-x' });
    return { ok: true };
  }),
  destroy: vi.fn(),
  find: vi.fn(async (q: { selector: Record<string, unknown> }) => ({
    docs: matchSelector(Array.from(sessionsStore.values()), q.selector),
  })),
};

vi.mock('../db/index.js', () => ({
  getDb: () => prodDb,
  getGuestInvitesDb: () => invitesDb,
  getGuestSessionsDb: () => sessionsDb,
  // Every slot's source is a WHIP guest.
  getSourcesDb: () => ({ get: vi.fn(async () => ({ streamType: 'whip' })), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
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

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

let app: FastifyInstance;
let buildServer: typeof import('../server.js')['buildServer'];

/** An active production with two declared guest slots + return-picture feeds. */
function seedActiveProduction(id = 'prod-1', mixerInputs = ['video_in_0', 'video_in_1']): ProductionDoc {
  const doc = {
    _id: id,
    _rev: '1-a',
    type: 'production',
    name: 'Test show',
    status: 'active',
    stromFlowId: 'flow-abc',
    sources: mixerInputs.map((mixerInput, i) => ({
      sourceId: `src-${i}`,
      mixerInput,
      returnFeed: { synced: 'program-minus' as const },
    })),
    returnWhepUrls: mixerInputs.map((mixerInput) => ({
      mixerInput,
      url: `${STROM_URL}/whep/return-${mixerInput}`,
    })),
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '',
    updatedAt: '',
  } as unknown as ProductionDoc;
  productionsStore.set(id, doc);
  return doc;
}

async function createInvite(prodId: string, payload: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/productions/${prodId}/guests/invites`,
    headers: AUTH,
    payload,
  });
  return res.json() as { id: string; token: string };
}

async function joinGuest(inviteId: string, token: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/guests/${inviteId}/join`,
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json() as { guestId: string; whipUrl: string; feeds: Array<{ id: string; url: string }> };
}

let fetchCounter = 0;

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
});

beforeEach(async () => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  fetchCounter = 0;
  // Rebuild per test — the join / WHIP / WHEP per-route rate limiters (max 10/min)
  // otherwise accumulate across tests sharing one app instance.
  app = await buildServer();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      fetchCounter += 1;
      return {
        ok: true,
        status: 201,
        text: async () => 'v=0 mock-answer-sdp',
        headers: { get: (name: string) => (name === 'Location' ? `/session/sess-${fetchCounter}` : null) },
      };
    }),
  );
});

describe('Guest-scoped join response (issue #423)', () => {
  it('hands back guest-scoped whipUrl and return-feed WHEP URL (not the crew /productions path)', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    const { whipUrl, feeds } = await joinGuest(invite.id, invite.token);
    expect(whipUrl).toBe(`https://live.example.com/api/v1/guests/${invite.id}/whip`);
    expect(feeds).toHaveLength(1);
    expect(feeds[0]!.url).toBe(
      `https://live.example.com/api/v1/guests/${invite.id}/returns/picture/whep`,
    );
    // Never the crew /api/v1/productions/... path (blocked by the OSC gate).
    expect(whipUrl).not.toContain('/productions/');
    expect(feeds[0]!.url).not.toContain('/productions/');
  });
});

describe('Guest-scoped WHIP /api/v1/guests/:inviteId/whip (issue #423)', () => {
  it('a live guest token publishes WHIP and gets a guest-scoped session Location back', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    const { whipUrl } = await joinGuest(invite.id, invite.token);
    const res = await app.inject({
      method: 'POST',
      url: new URL(whipUrl).pathname,
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(201);
    const location = res.headers['location'] as string;
    // Teardown comes back through the guest-scoped alias, carrying the Strom
    // session as a ?session= param (same shape as the crew route).
    expect(location).toContain(`/api/v1/guests/${invite.id}/whip?session=`);
  });

  it('a guest may PATCH and DELETE their OWN WHIP session', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    // Strom session under the guest's own WHIP endpoint (whip-0-<suffix>).
    const ownSession = `${STROM_URL}/whip/whip-0-1/session-abc`;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/guests/${invite.id}/whip?session=${encodeURIComponent(ownSession)}`,
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/trickle-ice-sdpfrag' },
      payload: 'a=candidate',
    });
    expect(patch.statusCode).toBe(201);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/guests/${invite.id}/whip?session=${encodeURIComponent(ownSession)}`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(del.statusCode).toBe(204);
  });

  it('rejects a guest PATCHing another endpoint via a stolen ?session= URL (403)', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    // A session under a DIFFERENT WHIP endpoint (whip-1-...) is not under this
    // guest's own endpoint (whip-0-...), so it must be rejected.
    const foreignSession = `${STROM_URL}/whip/whip-1-1/session-xyz`;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/guests/${invite.id}/whip?session=${encodeURIComponent(foreignSession)}`,
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/trickle-ice-sdpfrag' },
      payload: 'a=candidate',
    });
    expect(res.statusCode).toBe(403);
  });

  it('401s with no token, and the shared API key is not accepted as a guest token here', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    for (const headers of [{}, AUTH]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/guests/${invite.id}/whip`,
        headers: { ...headers, 'content-type': 'application/sdp' },
        payload: 'v=0',
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('401s a token presented under another invite\'s id', async () => {
    seedActiveProduction();
    const inviteA = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    const inviteB = await createInvite('prod-1', { mixerInput: 'video_in_1' });
    await joinGuest(inviteA.id, inviteA.token);
    await joinGuest(inviteB.id, inviteB.token);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${inviteB.id}/whip`,
      headers: { authorization: `Bearer ${inviteA.token}`, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s once the guest has left', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const leave = await app.inject({
      method: 'DELETE',
      url: `/api/v1/guests/${invite.id}/session`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(leave.statusCode).toBe(204);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/whip`,
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Guest-scoped return WHEP /api/v1/guests/:inviteId/returns/picture/whep (issue #423)', () => {
  it('a live guest plays its return feed and may DELETE its OWN bound session', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    const { feeds } = await joinGuest(invite.id, invite.token);
    const post = await app.inject({
      method: 'POST',
      url: new URL(feeds[0]!.url).pathname,
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(post.statusCode).toBe(201);
    const location = post.headers['location'] as string;
    expect(location).toContain(`/api/v1/guests/${invite.id}/returns/picture/whep/`);
    const sessionId = location.split('/').pop()!;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/guests/${invite.id}/returns/picture/whep/${sessionId}`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(del.statusCode).toBe(204);
  });

  it('rejects a guest DELETEing an unbound / another guest\'s return :sessionId (403)', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/guests/${invite.id}/returns/picture/whep/not-my-session`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('401s without a token and does not accept the shared API key here', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    for (const headers of [{}, AUTH]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/guests/${invite.id}/returns/picture/whep`,
        headers: { ...headers, 'content-type': 'application/sdp' },
        payload: 'v=0',
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('Crew /api/v1/productions routes unchanged (issue #423)', () => {
  it('the shared API_KEY still authorizes WHIP POST on any mixerInput', async () => {
    seedActiveProduction();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/whip/video_in_9',
      headers: { ...AUTH, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(201);
    // Crew Location still points back through the /productions path.
    expect(res.headers['location'] as string).toContain('/api/v1/productions/prod-1/whip/');
  });

  it('the crew WHIP/return routes still 401 without the API key', async () => {
    seedActiveProduction();
    const whip = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/whip/video_in_0',
      headers: { 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(whip.statusCode).toBe(401);
    const whep = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/returns/video_in_0/picture/whep',
      headers: { 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(whep.statusCode).toBe(401);
  });
});
