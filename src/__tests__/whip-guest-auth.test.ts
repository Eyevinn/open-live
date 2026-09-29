/**
 * Guest-token auth for the WHIP upload routes (issue #380, epic #208).
 *
 * Extends the guest-invite-token model (issue #299, `guests.ts`) to
 * `POST/PATCH/DELETE /api/v1/productions/:id/whip/:mixerInput`: a live guest's
 * per-invite token now authorizes WHIP signaling on their own scoped
 * production + mixerInput, without weakening the shared API_KEY gate for crew
 * / OSC upstream callers.
 *
 * Covers the issue #380 acceptance matrix: no-auth 401, API_KEY success
 * (scope-free), wrong production/mixerInput 403, revoked/expired/kicked/left
 * guest 401, and a guest attempting to PATCH another guest's WHIP session via
 * a stolen `?session=` URL (rejected).
 *
 * CouchDB, the WS controller, Strom auth, and Strom itself (`fetch`) are all
 * mocked — no live services required.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GuestInviteDoc, GuestSessionDoc, ProductionDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
process.env['GUEST_INVITE_SECRET'] = 'test-hmac-secret';
process.env['PUBLIC_BASE_URL'] = 'https://live.example.com';

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
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

let app: FastifyInstance;
let resolveStromWhipUrl: (productionId: string, mixerInput: string) => string;

function seedProduction(id = 'prod-1'): ProductionDoc {
  const doc = {
    _id: id,
    _rev: '1-a',
    type: 'production',
    name: 'Test show',
    status: 'inactive',
    sources: [],
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
  return res.json() as { guestId: string; whipUrl: string };
}

let buildServer: typeof import('../server.js')['buildServer'];

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
  ({ resolveStromWhipUrl } = await import('../routes/whip.js'));
});

beforeEach(async () => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  // Rebuild the server per test — the join route's per-route rate limiter
  // (max 10/min) otherwise accumulates across tests sharing one app instance
  // and trips well within this suite's own request volume.
  app = await buildServer();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => 'v=0 mock-answer-sdp',
      headers: { get: (name: string) => (name === 'Location' ? '/session/mock-session-1' : null) },
    }),
  );
});

describe('WHIP guest-token auth (issue #380)', () => {
  it('401s with neither a token nor the API key', async () => {
    seedProduction();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/whip/video_in_0',
      headers: { 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(401);
  });

  it('the shared API_KEY authorizes any mixerInput (crew / OSC upstream, scope-free)', async () => {
    seedProduction();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/whip/video_in_9',
      headers: { ...AUTH, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(201);
  });

  it('a live guest token authorizes WHIP POST on its own (auto-allocated) slot', async () => {
    seedProduction();
    const invite = await createInvite('prod-1');
    const { whipUrl } = await joinGuest(invite.id, invite.token);
    const path = new URL(whipUrl).pathname;
    const res = await app.inject({
      method: 'POST',
      url: path,
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(201);
  });

  it('403s a guest token used against a different production', async () => {
    seedProduction('prod-1');
    seedProduction('prod-2');
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-2/whip/video_in_0',
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(403);
  });

  it('403s a guest token used against the wrong mixerInput', async () => {
    seedProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/whip/video_in_1',
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(403);
  });

  it('401s once the guest has left (self DELETE session)', async () => {
    seedProduction();
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
      url: '/api/v1/productions/prod-1/whip/video_in_0',
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s once the guest has been kicked by an operator', async () => {
    seedProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    const { guestId } = await joinGuest(invite.id, invite.token);
    const kick = await app.inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/guests/${guestId}`,
      headers: AUTH,
    });
    expect(kick.statusCode).toBe(204);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/whip/video_in_0',
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s a revoked invite', async () => {
    seedProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/guests/invites/${invite.id}`,
      headers: AUTH,
    });
    expect(revoke.statusCode).toBe(204);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/whip/video_in_0',
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s an expired invite (persisted expiry; signature still cryptographically valid)', async () => {
    seedProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const stored = invitesStore.get(invite.id)!;
    invitesStore.set(invite.id, { ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/whip/video_in_0',
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s garbage / malformed bearer tokens', async () => {
    seedProduction();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/whip/video_in_0',
      headers: { authorization: 'Bearer garbage', 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(401);
  });

  it('a guest may PATCH their OWN WHIP session', async () => {
    seedProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const ownEndpoint = resolveStromWhipUrl('prod-1', 'video_in_0');
    const ownSession = `${ownEndpoint}/session-of-guest-a`;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/productions/prod-1/whip/video_in_0?session=${encodeURIComponent(ownSession)}`,
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/trickle-ice-sdpfrag' },
      payload: 'a=candidate',
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a guest PATCHing another guest\'s WHIP session via a stolen ?session= URL', async () => {
    seedProduction();
    const inviteA = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(inviteA.id, inviteA.token);
    const inviteB = await createInvite('prod-1', { mixerInput: 'video_in_1' });
    await joinGuest(inviteB.id, inviteB.token);

    // Guest B is authorized for video_in_1 (passes the shared-key gate), but
    // supplies guest A's WHIP session URL. The handler must recompute the
    // expected endpoint from B's OWN scoped slot and reject A's URL — not
    // trust the client-supplied ?session= at face value (issue #380, item 3).
    const guestAEndpoint = resolveStromWhipUrl('prod-1', 'video_in_0');
    const stolenSession = `${guestAEndpoint}/session-of-guest-a`;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/productions/prod-1/whip/video_in_1?session=${encodeURIComponent(stolenSession)}`,
      headers: { authorization: `Bearer ${inviteB.token}`, 'content-type': 'application/trickle-ice-sdpfrag' },
      payload: 'a=candidate',
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a guest DELETEing another guest\'s WHIP session via a stolen ?session= URL', async () => {
    seedProduction();
    const inviteA = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(inviteA.id, inviteA.token);
    const inviteB = await createInvite('prod-1', { mixerInput: 'video_in_1' });
    await joinGuest(inviteB.id, inviteB.token);

    const guestAEndpoint = resolveStromWhipUrl('prod-1', 'video_in_0');
    const stolenSession = `${guestAEndpoint}/session-of-guest-a`;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/whip/video_in_1?session=${encodeURIComponent(stolenSession)}`,
      headers: { authorization: `Bearer ${inviteB.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('crew (API_KEY) may still PATCH/DELETE using an arbitrary same-host ?session= URL (unchanged)', async () => {
    seedProduction();
    const target = `${resolveStromWhipUrl('prod-1', 'video_in_0')}/whatever-session-id`;
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/productions/prod-1/whip/video_in_0?session=${encodeURIComponent(target)}`,
      headers: { ...AUTH, 'content-type': 'application/trickle-ice-sdpfrag' },
      payload: 'a=candidate',
    });
    expect(patchRes.statusCode).toBe(201);
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/whip/video_in_0?session=${encodeURIComponent(target)}`,
      headers: AUTH,
    });
    expect(deleteRes.statusCode).toBe(204);
  });
});
