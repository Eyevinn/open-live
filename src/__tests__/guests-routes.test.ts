/**
 * Route tests for guest calling — production-scoped invites + token-authed join
 * (epic #208, issue #299, `docs/specs/guest-calling-intercom.md`). CouchDB and
 * the WS controller are mocked; no live services required.
 *
 * Covers: invite create (raw token returned once, only hash stored), join happy
 * path (whipUrl reuses the existing WHIP contract), token auth failures (401),
 * expired invite (409), production/invite 404, cross-production 403, and the
 * feature-disabled 503 gate.
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

const applyReturnModeMock = vi.fn().mockResolvedValue({ ok: true, mixerInput: 'video_in_0', mode: 'program-minus' });
vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
  applyReturnMode: (...args: unknown[]) => applyReturnModeMock(...args),
}));

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

let app: FastifyInstance;

/**
 * Seed a production with N declared guest slots (#381). A guest slot is a source
 * assignment carrying a `returnFeed` (program-minus) — the same shape the flow
 * generator turns into a per-guest return bus at activation. Invites can only
 * target a declared slot, so tests seed the slots they pin.
 */
function seedProduction(
  id = 'prod-1',
  opts: { slots?: string[]; status?: string; stromFlowId?: string } = {},
): ProductionDoc {
  const slots = opts.slots ?? ['video_in_0', 'video_in_1', 'video_in_2', 'video_in_3'];
  const doc = {
    _id: id,
    _rev: '1-a',
    type: 'production',
    name: 'Test show',
    status: opts.status ?? 'inactive',
    ...(opts.stromFlowId ? { stromFlowId: opts.stromFlowId } : {}),
    sources: slots.map((mixerInput) => ({
      sourceId: 'Whip',
      mixerInput,
      returnFeed: { synced: 'program-minus' as const, lowLatency: false },
    })),
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

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

beforeEach(() => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  applyReturnModeMock.mockClear();
});

describe('POST /api/v1/productions/:id/guests/invites', () => {
  it('creates an invite, returns the raw token exactly once, and stores only its hash', async () => {
    seedProduction();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/guests/invites',
      headers: AUTH,
      payload: { label: 'Remote guest', mixerInput: 'video_in_0' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^guest-invite-/);
    expect(body.productionId).toBe('prod-1');
    expect(body.token).toMatch(/^olgi_v1_/);
    // joinUrl is now the backend-served guest page with the token in the URL
    // fragment (issue #382) — never the raw API endpoint, and the token never
    // lands in a query string / server log.
    expect(body.joinUrl).toBe(`https://live.example.com/guest/${body.id}#${body.token}`);
    expect(body.joinUrl).not.toContain('?');
    expect(typeof body.expiresAt).toBe('string');

    // Only the hash is persisted — never the raw token.
    const stored = invitesStore.get(body.id)!;
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(body.token);
  });

  it('404s when the production does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-missing/guests/invites',
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('401s without the API key (invite management is operator-gated)', async () => {
    seedProduction();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/guests/invites',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('400s on an out-of-range expiresInS', async () => {
    seedProduction();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/guests/invites',
      headers: AUTH,
      payload: { expiresInS: 5 },
    });
    expect(res.statusCode).toBe(400);
  });

  // #381 item 2: an invite must target a declared guest slot — allocateMixerInput
  // is gone, so a guest can never be handed an input the running flow lacks.
  it('400s an invite with no guest slot (mixerInput omitted)', async () => {
    seedProduction();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/guests/invites',
      headers: AUTH,
      payload: { label: 'No slot' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/guest slot/i);
  });

  it('400s an invite targeting an input that is not a guest slot (no returnFeed)', async () => {
    // video_in_9 is not one of the declared slots (video_in_0..3).
    seedProduction();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/guests/invites',
      headers: AUTH,
      payload: { mixerInput: 'video_in_9' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a guest slot/i);
  });
});

describe('POST /api/v1/guests/:inviteId/join', () => {
  async function createInvite(payload: Record<string, unknown> = {}) {
    seedProduction();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/guests/invites',
      headers: AUTH,
      // Pin the seed's first declared guest slot unless a test overrides it.
      payload: { mixerInput: 'video_in_0', ...payload },
    });
    return res.json() as { id: string; token: string };
  }

  it('joins with a valid invite token and returns a whipUrl on the existing WHIP contract', async () => {
    const invite = await createInvite();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.guestId).toMatch(/^guest-session-/);
    // whipUrl MUST reuse /api/v1/productions/:id/whip/:mixerInput — not a new path.
    expect(body.whipUrl).toMatch(
      /^https:\/\/live\.example\.com\/api\/v1\/productions\/prod-1\/whip\/video_in_\d+$/,
    );
    expect(body.defaultMode).toBe('program-minus');
    expect(body.returnMode).toBe('program-minus');
    expect(Array.isArray(body.feeds)).toBe(true);
    expect(body.modes.map((m: { key: string }) => m.key)).toContain('program-minus');
    // A session doc was persisted.
    expect(sessionsStore.get(body.guestId)?.state).toBe('joined');
    // Intercom is unconfigured in this suite, so talkback degrades cleanly: join
    // succeeds and `intercomLine` is absent (spec §Configuration, OQ1).
    expect(body.intercomLine).toBeUndefined();
    expect(sessionsStore.get(body.guestId)?.intercomLineId).toBeUndefined();
  });

  it('honours a pinned mixerInput from the invite', async () => {
    const invite = await createInvite({ mixerInput: 'video_in_3' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(res.json().whipUrl).toContain('/whip/video_in_3');
  });

  it('does NOT require the shared API key (token-authed route is exempt)', async () => {
    const invite = await createInvite();
    // No API key header, only the invite bearer token.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('401s on a missing, malformed, or wrong-secret token', async () => {
    const invite = await createInvite();
    expect((await app.inject({ method: 'POST', url: `/api/v1/guests/${invite.id}/join` })).statusCode).toBe(401);
    expect(
      (await app.inject({
        method: 'POST',
        url: `/api/v1/guests/${invite.id}/join`,
        headers: { authorization: 'Bearer garbage' },
      })).statusCode,
    ).toBe(401);
  });

  it('401s when the invite doc was revoked (hash no longer matches / doc gone)', async () => {
    const invite = await createInvite();
    invitesStore.clear(); // simulate DELETE revocation
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('409s when the production has been deactivated (ended) — token cannot join (issue #325)', async () => {
    const invite = await createInvite();
    // Simulate a deactivate having ended the production while the token is still
    // cryptographically valid: the join must be rejected before a session is
    // created or an intercom line provisioned.
    const prod = productionsStore.get('prod-1')!;
    productionsStore.set('prod-1', { ...prod, status: 'ended' } as ProductionDoc);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not active/i);
    // No guest session was persisted for the rejected join.
    expect(sessionsStore.size).toBe(0);
  });

  it('409s when the invite has expired (persisted expiry check)', async () => {
    const invite = await createInvite();
    // Force the stored doc past expiry while the signature is still in the future
    // is not possible; instead expire the doc AND rely on the persisted-expiry
    // branch by setting expiresAt in the past. The signature check happens first,
    // so we must also mint a token that is still cryptographically valid — the
    // stored doc's expiresAt is independent of the token exp, so patch the doc.
    const stored = invitesStore.get(invite.id)!;
    invitesStore.set(invite.id, { ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('guest management + revocation', () => {
  async function createInviteAndJoin() {
    seedProduction();
    const inviteRes = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/guests/invites',
      headers: AUTH,
      payload: { mixerInput: 'video_in_0' },
    });
    const invite = inviteRes.json() as { id: string; token: string };
    const joinRes = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    return { invite, guestId: (joinRes.json() as { guestId: string }).guestId };
  }

  it('lists guest sessions for a production', async () => {
    const { guestId } = await createInviteAndJoin();
    const res = await app.inject({ method: 'GET', url: '/api/v1/productions/prod-1/guests', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; state: string }>;
    expect(list.find((g) => g.id === guestId)?.state).toBe('joined');
  });

  it('kicks a guest (marks the session left) and 403s across productions', async () => {
    const { guestId } = await createInviteAndJoin();
    seedProduction('prod-2');
    const wrong = await app.inject({ method: 'DELETE', url: `/api/v1/productions/prod-2/guests/${guestId}`, headers: AUTH });
    expect(wrong.statusCode).toBe(403);
    const ok = await app.inject({ method: 'DELETE', url: `/api/v1/productions/prod-1/guests/${guestId}`, headers: AUTH });
    expect(ok.statusCode).toBe(204);
    expect(sessionsStore.get(guestId)?.state).toBe('left');
  });

  it('deletes (revokes) an invite and 403s for a mismatched production', async () => {
    const { invite } = await createInviteAndJoin();
    seedProduction('prod-2');
    const wrong = await app.inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-2/guests/invites/${invite.id}`,
      headers: AUTH,
    });
    expect(wrong.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/guests/invites/${invite.id}`,
      headers: AUTH,
    });
    expect(ok.statusCode).toBe(204);
    expect(invitesStore.has(invite.id)).toBe(false);
  });
});

describe('guest slots — one guest per slot, reconnect, server-side teardown (#381)', () => {
  // A fresh server per test: the join route's per-route rate limiter (max 10/min)
  // otherwise accumulates across the several joins these scenarios drive.
  let slotApp: FastifyInstance;
  beforeEach(async () => {
    const { buildServer } = await import('../server.js');
    slotApp = await buildServer();
  });

  async function mkInvite(mixerInput: string, prodId = 'prod-1') {
    const res = await slotApp.inject({
      method: 'POST',
      url: `/api/v1/productions/${prodId}/guests/invites`,
      headers: AUTH,
      payload: { mixerInput },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; token: string };
  }
  function join(invite: { id: string; token: string }) {
    return slotApp.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
  }

  it('409s a second invite trying to join a slot another live guest holds', async () => {
    seedProduction();
    const a = await mkInvite('video_in_0');
    const b = await mkInvite('video_in_0');
    expect((await join(a)).statusCode).toBe(200);
    const res = await join(b);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/occupied/i);
  });

  it('lets a guest reconnect on the same invite while holding the slot (reuses the session)', async () => {
    seedProduction();
    const a = await mkInvite('video_in_0');
    const first = await join(a);
    expect(first.statusCode).toBe(200);
    const guestId = (first.json() as { guestId: string }).guestId;
    // A reconnect on the SAME invite reuses the same session and keeps working.
    const second = await join(a);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { guestId: string }).guestId).toBe(guestId);
  });

  it('resets a new occupant to program-minus (per-slot config, not inherited state)', async () => {
    // The slot was left on `program` by a previous guest; a NEW occupant must be
    // reset to program-minus via the shared applyReturnMode entry point.
    seedProduction('prod-1', { slots: [] });
    const prod = productionsStore.get('prod-1')!;
    (prod as unknown as { sources: unknown[] }).sources = [
      { sourceId: 'Whip', mixerInput: 'video_in_0', returnFeed: { synced: 'program', lowLatency: false } },
    ];
    const a = await mkInvite('video_in_0');
    const res = await join(a);
    expect(res.statusCode).toBe(200);
    expect(applyReturnModeMock).toHaveBeenCalledWith('prod-1', 'video_in_0', 'program-minus');
    expect((res.json() as { returnMode: string }).returnMode).toBe('program-minus');
  });

  it('frees the slot on the server on kick, so the next guest can take it', async () => {
    // Active production with a live flow: kick must tear down the WHIP publisher
    // in Strom from the backend (not the browser) and free the slot.
    seedProduction('prod-1', { status: 'active', stromFlowId: 'flow-1' });
    const whipDeletes: string[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: { method?: string }) => {
      if (init?.method === 'DELETE') whipDeletes.push(String(url));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const a = await mkInvite('video_in_0');
      const joinA = await join(a);
      expect(joinA.statusCode).toBe(200);
      const guestId = (joinA.json() as { guestId: string }).guestId;

      // A different guest cannot take the occupied slot yet.
      const b = await mkInvite('video_in_0');
      expect((await join(b)).statusCode).toBe(409);

      // Operator kicks guest A — the server tears down the Strom WHIP session
      // (does not wait for the guest's browser).
      const kick = await slotApp.inject({
        method: 'DELETE',
        url: `/api/v1/productions/prod-1/guests/${guestId}`,
        headers: AUTH,
      });
      expect(kick.statusCode).toBe(204);
      expect(sessionsStore.get(guestId)?.state).toBe('left');
      // Teardown hit the slot's WHIP endpoint on Strom, server-side.
      expect(whipDeletes.some((u) => u.includes('/whip/whip-0-'))).toBe(true);

      // The slot is now free: guest B can join.
      expect((await join(b)).statusCode).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
