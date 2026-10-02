/**
 * Guest-token auth for the return-picture WHEP routes (issue #380, epic #208).
 *
 * Extends the guest-invite-token model (issue #299, `guests.ts`) to
 * `POST/DELETE /api/v1/productions/:id/returns/:mixerInput/picture/whep[/:sessionId]`:
 * a live guest's per-invite token now authorizes their own return-picture feed,
 * scoped to their own production + mixerInput, without weakening the shared
 * API_KEY gate for crew callers.
 *
 * Covers the issue #380 acceptance matrix: no-auth 401, API_KEY success
 * (scope-free), wrong production/mixerInput 403, revoked/expired/kicked/left
 * guest 401, and a guest attempting to DELETE another guest's WHEP
 * :sessionId (rejected via the returnWhepSessionId binding).
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
  applyReturnMode: vi.fn(),
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };
const STROM_URL = 'http://localhost:7000'; // matches vitest.config.ts env STROM_URL

const { applyReturnMode } = await import('../ws/controller.js');

let app: FastifyInstance;
let buildServer: typeof import('../server.js')['buildServer'];

/** An active production with return-picture feeds wired up on two inputs. */
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
  return res.json() as { guestId: string; whipUrl: string };
}

/** POST the return-picture WHEP feed, returning the parsed Location sessionId. */
async function postPicture(mixerInput: string, headers: Record<string, string>) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/productions/prod-1/returns/${mixerInput}/picture/whep`,
    headers: { ...headers, 'content-type': 'application/sdp' },
    payload: 'v=0',
  });
  const location = res.headers['location'] as string | undefined;
  const sessionId = location ? location.split('/').pop()! : undefined;
  return { res, sessionId };
}

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
});

let fetchCounter = 0;

beforeEach(async () => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  fetchCounter = 0;
  // Rebuild the server per test — the join route's per-route rate limiter
  // (max 10/min) otherwise accumulates across tests sharing one app instance.
  app = await buildServer();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      fetchCounter += 1;
      return {
        ok: true,
        status: 201,
        text: async () => 'v=0 mock-answer-sdp',
        headers: { get: (name: string) => (name === 'Location' ? `/whep/session-${fetchCounter}` : null) },
      };
    }),
  );
});

describe('Return-picture WHEP guest-token auth (issue #380)', () => {
  it('401s with neither a token nor the API key', async () => {
    seedActiveProduction();
    const { res } = await postPicture('video_in_0', {});
    expect(res.statusCode).toBe(401);
  });

  it('the shared API_KEY authorizes any mixerInput (crew, scope-free)', async () => {
    seedActiveProduction();
    const { res } = await postPicture('video_in_1', AUTH);
    expect(res.statusCode).toBe(201);
  });

  it('a live guest token authorizes its own return-picture feed', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const { res } = await postPicture('video_in_0', { authorization: `Bearer ${invite.token}` });
    expect(res.statusCode).toBe(201);
  });

  it('403s a guest token used against a different production', async () => {
    seedActiveProduction('prod-1');
    seedActiveProduction('prod-2');
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-2/returns/video_in_0/picture/whep',
      headers: { authorization: `Bearer ${invite.token}`, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(403);
  });

  it('403s a guest token used against the wrong mixerInput', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const { res } = await postPicture('video_in_1', { authorization: `Bearer ${invite.token}` });
    expect(res.statusCode).toBe(403);
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
    const { res } = await postPicture('video_in_0', { authorization: `Bearer ${invite.token}` });
    expect(res.statusCode).toBe(401);
  });

  it('401s once the guest has been kicked by an operator', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    const { guestId } = await joinGuest(invite.id, invite.token);
    const kick = await app.inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/guests/${guestId}`,
      headers: AUTH,
    });
    expect(kick.statusCode).toBe(204);
    const { res } = await postPicture('video_in_0', { authorization: `Bearer ${invite.token}` });
    expect(res.statusCode).toBe(401);
  });

  it('401s a revoked invite', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/guests/invites/${invite.id}`,
      headers: AUTH,
    });
    expect(revoke.statusCode).toBe(204);
    const { res } = await postPicture('video_in_0', { authorization: `Bearer ${invite.token}` });
    expect(res.statusCode).toBe(401);
  });

  it('401s an expired invite (persisted expiry; signature still cryptographically valid)', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const stored = invitesStore.get(invite.id)!;
    invitesStore.set(invite.id, { ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const { res } = await postPicture('video_in_0', { authorization: `Bearer ${invite.token}` });
    expect(res.statusCode).toBe(401);
  });

  it('a guest may DELETE their OWN bound return-picture session', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const { sessionId } = await postPicture('video_in_0', { authorization: `Bearer ${invite.token}` });
    expect(sessionId).toBeDefined();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/returns/video_in_0/picture/whep/${sessionId}`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('rejects a guest DELETEing another guest\'s bound return-picture :sessionId', async () => {
    seedActiveProduction();
    const inviteA = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(inviteA.id, inviteA.token);
    const { sessionId: sessionIdA } = await postPicture('video_in_0', { authorization: `Bearer ${inviteA.token}` });
    expect(sessionIdA).toBeDefined();

    const inviteB = await createInvite('prod-1', { mixerInput: 'video_in_1' });
    await joinGuest(inviteB.id, inviteB.token);

    // Guest B is authorized for video_in_1 (passes the shared-key gate), but
    // supplies guest A's bound :sessionId. The DELETE handler must reject —
    // never trust an unbound client-supplied :sessionId for a guest caller
    // (issue #380, item 3).
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/returns/video_in_1/picture/whep/${sessionIdA}`,
      headers: { authorization: `Bearer ${inviteB.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('crew (API_KEY) may still DELETE an arbitrary :sessionId on their own mixerInput (unchanged)', async () => {
    seedActiveProduction();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/productions/prod-1/returns/video_in_0/picture/whep/any-session-id',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(204);
  });
});

describe('Guest return mode: GET / PUT /api/v1/guests/:inviteId/session/return', () => {
  const returnUrl = (inviteId: string) => `/api/v1/guests/${inviteId}/session/return`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeEach(() => {
    vi.mocked(applyReturnMode).mockReset();
    vi.mocked(applyReturnMode).mockImplementation(async (_productionId, mixerInput, mode) => ({
      ok: true,
      mixerInput,
      mode,
    }));
  });

  async function leaveGuest(inviteId: string, token: string) {
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/guests/${inviteId}/session`, headers: bearer(token) });
    expect(res.statusCode).toBe(204);
  }

  it('GET reports the slot mode and the modes on offer to a live guest', async () => {
    const doc = seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    doc.sources[0]!.returnFeed = { synced: 'program' };
    const res = await app.inject({ method: 'GET', url: returnUrl(invite.id), headers: bearer(invite.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mixerInput: string; mode: string; modes: Array<{ key: string }>; defaultMode: string };
    expect(body.mixerInput).toBe('video_in_0');
    expect(body.mode).toBe('program');
    expect(body.defaultMode).toBe('program-minus');
    expect(body.modes.map((m) => m.key)).toEqual(['program', 'program-minus']);
  });

  it('PUT applies the mode on the guest\'s own input', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const res = await app.inject({
      method: 'PUT',
      url: returnUrl(invite.id),
      headers: bearer(invite.token),
      payload: { mode: 'program' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mixerInput: 'video_in_0', mode: 'program' });
    expect(applyReturnMode).toHaveBeenCalledWith('prod-1', 'video_in_0', 'program');
  });

  it('401s without a token, and the shared API key is not a guest token', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    for (const headers of [{}, AUTH]) {
      const get = await app.inject({ method: 'GET', url: returnUrl(invite.id), headers });
      expect(get.statusCode).toBe(401);
      const put = await app.inject({ method: 'PUT', url: returnUrl(invite.id), headers, payload: { mode: 'program' } });
      expect(put.statusCode).toBe(401);
    }
    expect(applyReturnMode).not.toHaveBeenCalled();
  });

  it('401s a token used under another invite\'s id', async () => {
    seedActiveProduction();
    const inviteA = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    const inviteB = await createInvite('prod-1', { mixerInput: 'video_in_1' });
    await joinGuest(inviteA.id, inviteA.token);
    await joinGuest(inviteB.id, inviteB.token);
    const res = await app.inject({
      method: 'PUT',
      url: returnUrl(inviteB.id),
      headers: bearer(inviteA.token),
      payload: { mode: 'program' },
    });
    expect(res.statusCode).toBe(401);
    expect(applyReturnMode).not.toHaveBeenCalled();
  });

  it('a guest who left cannot change the mode of the guest who now holds the slot', async () => {
    seedActiveProduction();
    const first = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(first.id, first.token);
    await leaveGuest(first.id, first.token);
    const second = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(second.id, second.token);
    vi.mocked(applyReturnMode).mockClear();

    const put = await app.inject({
      method: 'PUT',
      url: returnUrl(first.id),
      headers: bearer(first.token),
      payload: { mode: 'program' },
    });
    expect(put.statusCode).toBe(401);
    const get = await app.inject({ method: 'GET', url: returnUrl(first.id), headers: bearer(first.token) });
    expect(get.statusCode).toBe(401);
    expect(applyReturnMode).not.toHaveBeenCalled();
  });

  it('401s once the guest has been kicked', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    const { guestId } = await joinGuest(invite.id, invite.token);
    const kick = await app.inject({ method: 'DELETE', url: `/api/v1/productions/prod-1/guests/${guestId}`, headers: AUTH });
    expect(kick.statusCode).toBe(204);
    const res = await app.inject({
      method: 'PUT',
      url: returnUrl(invite.id),
      headers: bearer(invite.token),
      payload: { mode: 'program' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s an expired invite (persisted expiry)', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const stored = invitesStore.get(invite.id)!;
    invitesStore.set(invite.id, { ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await app.inject({ method: 'GET', url: returnUrl(invite.id), headers: bearer(invite.token) });
    expect(res.statusCode).toBe(401);
  });

  it('400s low-latency-minus, which is a feed choice rather than a mix', async () => {
    seedActiveProduction();
    const invite = await createInvite('prod-1', { mixerInput: 'video_in_0' });
    await joinGuest(invite.id, invite.token);
    const res = await app.inject({
      method: 'PUT',
      url: returnUrl(invite.id),
      headers: bearer(invite.token),
      payload: { mode: 'low-latency-minus' },
    });
    expect(res.statusCode).toBe(400);
    expect(applyReturnMode).not.toHaveBeenCalled();
  });
});
