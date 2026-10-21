/**
 * Commentator preview routes (`docs/specs/guest-calling-intercom.md`
 * §"Commentator preview"):
 *   - `POST /api/v1/productions/:id/sources` accepts `commentatorPreview` on
 *     SRT/EFP/clip sources only;
 *   - crew `POST/DELETE /api/v1/productions/:id/previews/:mixerInput/whep[/:sessionId]`;
 *   - guest `POST/DELETE /api/v1/guests/:inviteId/previews/:mixerInput/whep[/:sessionId]`,
 *     scoped to the invite's own production, bound per guest session for DELETE;
 *   - `previews` on the guest join / slot responses.
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

const invitesStore = new Map<string, GuestInviteDoc>();
const sessionsStore = new Map<string, GuestSessionDoc>();
const productionsStore = new Map<string, ProductionDoc>();

const SOURCES: Record<string, { _id: string; name: string; streamType: string }> = {
  'src-cam': { _id: 'src-cam', name: 'Stadium cam', streamType: 'srt' },
  'src-tunnel': { _id: 'src-tunnel', name: 'Tunnel cam', streamType: 'efp' },
  'src-bug': { _id: 'src-bug', name: 'Score bug', streamType: 'html' },
};

function matchSelector<T>(docs: T[], selector: Record<string, unknown>): T[] {
  return docs.filter((d) =>
    Object.entries(selector).every(([k, v]) => (d as Record<string, unknown>)[k] === v),
  );
}

const notFound = () => Object.assign(new Error('not_found'), { statusCode: 404 });

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
  destroy: vi.fn(),
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
  getSourcesDb: () => ({
    get: vi.fn(async (id: string) => {
      if (!SOURCES[id]) throw notFound();
      return SOURCES[id];
    }),
    insert: vi.fn(),
    find: vi.fn(),
    destroy: vi.fn(),
  }),
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
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let app: FastifyInstance;
let buildServer: typeof import('../server.js')['buildServer'];
let fetchMock: ReturnType<typeof vi.fn>;

/**
 * A production with a WHIP guest slot (video_in_15), a flagged SRT camera
 * (video_in_0, previewed) and an EFP camera on video_in_1 that has a preview
 * URL from an earlier activation but is no longer flagged.
 */
function seedProduction(id = 'prod-1', status: ProductionDoc['status'] = 'active'): ProductionDoc {
  const doc = {
    _id: id,
    _rev: '1-a',
    type: 'production',
    name: 'Match',
    status,
    ...(status === 'active' ? { stromFlowId: `flow-${id}` } : {}),
    sources: [
      { sourceId: 'src-cam', mixerInput: 'video_in_0', commentatorPreview: true },
      { sourceId: 'src-tunnel', mixerInput: 'video_in_1' },
      { sourceId: 'Whip', mixerInput: 'video_in_15', returnFeed: { synced: 'program-minus' as const } },
    ],
    returnWhepUrls: [{ mixerInput: 'video_in_15', url: `${STROM_URL}/whep/return-${id}`, endpointId: `return-${id}` }],
    ...(status === 'active'
      ? {
          previewWhepUrls: [
            { mixerInput: 'video_in_0', url: `${STROM_URL}/whep/preview-0-${id}`, endpointId: `preview-0-${id}` },
            { mixerInput: 'video_in_1', url: `${STROM_URL}/whep/preview-1-${id}`, endpointId: `preview-1-${id}` },
          ],
        }
      : {}),
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

async function createInvite(prodId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/productions/${prodId}/guests/invites`,
    headers: AUTH,
    payload: { mixerInput: 'video_in_15', label: 'Commentator' },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string };
}

async function joinGuest(inviteId: string, token: string) {
  const res = await app.inject({ method: 'POST', url: `/api/v1/guests/${inviteId}/join`, headers: bearer(token) });
  expect(res.statusCode).toBe(200);
  return res.json() as { guestId: string; feeds: unknown[]; previews: Array<{ mixerInput: string; label: string; url: string }> };
}

async function postPreview(url: string, headers: Record<string, string>) {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { ...headers, 'content-type': 'application/sdp' },
    payload: 'v=0',
  });
  const location = res.headers['location'] as string | undefined;
  return { res, location, sessionId: location?.split('/').pop() };
}

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
});

let fetchCounter = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  fetchCounter = 0;
  // Rebuild per test — the per-route rate limiters (max 10/min) otherwise accumulate.
  app = await buildServer();
  fetchMock = vi.fn().mockImplementation(async () => {
    fetchCounter += 1;
    return {
      ok: true,
      status: 201,
      text: async () => 'v=0 mock-answer-sdp',
      headers: { get: (name: string) => (name === 'Location' ? `/whep/session-${fetchCounter}` : null) },
    };
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('POST /api/v1/productions/:id/sources — commentatorPreview', () => {
  it('persists commentatorPreview on an SRT source', async () => {
    seedProduction('prod-1', 'inactive');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/sources',
      headers: AUTH,
      payload: { sourceId: 'src-tunnel', mixerInput: 'video_in_1', commentatorPreview: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sourceId: 'src-tunnel', mixerInput: 'video_in_1', commentatorPreview: true });
    const stored = productionsStore.get('prod-1')!.sources.find((s) => s.mixerInput === 'video_in_1');
    expect(stored?.commentatorPreview).toBe(true);
  });

  it('omits the flag when false, so re-assigning without it clears the preview', async () => {
    seedProduction('prod-1', 'inactive');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/sources',
      headers: AUTH,
      payload: { sourceId: 'src-cam', mixerInput: 'video_in_0', commentatorPreview: false },
    });
    expect(res.statusCode).toBe(201);
    const stored = productionsStore.get('prod-1')!.sources.find((s) => s.mixerInput === 'video_in_0');
    expect(stored).toEqual({ sourceId: 'src-cam', mixerInput: 'video_in_0' });
  });

  it.each([
    ['the virtual Whip guest source', 'Whip'],
    ['an HTML source', 'src-bug'],
    ['a test pattern', '__test1__'],
    ['an unknown source', 'src-missing'],
  ])('400s commentatorPreview on %s', async (_label, sourceId) => {
    seedProduction('prod-1', 'inactive');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/sources',
      headers: AUTH,
      payload: { sourceId, mixerInput: 'video_in_2', commentatorPreview: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ statusCode: 400 });
    expect(prodDb.insert).not.toHaveBeenCalled();
  });
});

describe('Crew commentator preview WHEP: /api/v1/productions/:id/previews/:mixerInput/whep', () => {
  it('proxies to the server-derived Strom preview target and scopes Location to this route', async () => {
    seedProduction();
    const { res, location } = await postPreview('/api/v1/productions/prod-1/previews/video_in_0/whep', AUTH);
    expect(res.statusCode).toBe(201);
    expect(res.headers['content-type']).toContain('application/sdp');
    expect(fetchMock).toHaveBeenCalledWith(`${STROM_URL}/whep/preview-0-prod-1`, expect.objectContaining({ method: 'POST' }));
    expect(location).toBe('/api/v1/productions/prod-1/previews/video_in_0/whep/session-1');
  });

  it('404s an input that is not (or no longer) flagged for a preview', async () => {
    seedProduction();
    for (const mixerInput of ['video_in_1', 'video_in_15', 'video_in_7']) {
      const { res } = await postPreview(`/api/v1/productions/prod-1/previews/${mixerInput}/whep`, AUTH);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'feed_unavailable', statusCode: 404 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409s an inactive production', async () => {
    seedProduction('prod-1', 'inactive');
    const { res } = await postPreview('/api/v1/productions/prod-1/previews/video_in_0/whep', AUTH);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'production_inactive', statusCode: 409 });
  });

  it('DELETE tears the session down on the preview endpoint origin', async () => {
    seedProduction();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/productions/prod-1/previews/video_in_0/whep/sess-9',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(204);
    expect(fetchMock).toHaveBeenCalledWith(`${STROM_URL}/whep/sess-9`, expect.objectContaining({ method: 'DELETE' }));
  });

  it('is shared-key only: a guest invite token is refused on the crew path', async () => {
    seedProduction();
    const invite = await createInvite('prod-1');
    await joinGuest(invite.id, invite.token);
    const { res } = await postPreview('/api/v1/productions/prod-1/previews/video_in_0/whep', bearer(invite.token));
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Guest commentator preview WHEP: /api/v1/guests/:inviteId/previews/:mixerInput/whep', () => {
  it('a live guest watches a flagged source of their own production', async () => {
    seedProduction();
    const invite = await createInvite('prod-1');
    await joinGuest(invite.id, invite.token);
    const { res, location, sessionId } = await postPreview(
      `/api/v1/guests/${invite.id}/previews/video_in_0/whep`,
      bearer(invite.token),
    );
    expect(res.statusCode).toBe(201);
    expect(fetchMock).toHaveBeenCalledWith(`${STROM_URL}/whep/preview-0-prod-1`, expect.objectContaining({ method: 'POST' }));
    expect(location).toBe(`/api/v1/guests/${invite.id}/previews/video_in_0/whep/session-1`);
    // Bound to the guest's live session, without touching the return binding.
    const session = [...sessionsStore.values()].find((s) => s.inviteId === invite.id)!;
    expect(session.previewWhepSessionIds).toEqual({ video_in_0: sessionId });
    expect(session.returnWhepSessionId).toBeUndefined();
  });

  it('never reaches another production: the target comes from the invite, not the request', async () => {
    seedProduction('prod-1');
    seedProduction('prod-2');
    productionsStore.get('prod-1')!.previewWhepUrls = [];
    const invite = await createInvite('prod-1');
    await joinGuest(invite.id, invite.token);
    // prod-2 has a preview on video_in_0, but the guest's production does not.
    const { res } = await postPreview(`/api/v1/guests/${invite.id}/previews/video_in_0/whep`, bearer(invite.token));
    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s an unflagged input, even one with a stale preview URL', async () => {
    seedProduction();
    const invite = await createInvite('prod-1');
    await joinGuest(invite.id, invite.token);
    const { res } = await postPreview(`/api/v1/guests/${invite.id}/previews/video_in_1/whep`, bearer(invite.token));
    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409s while the production is inactive', async () => {
    seedProduction('prod-1', 'inactive');
    const invite = await createInvite('prod-1');
    await joinGuest(invite.id, invite.token);
    const { res } = await postPreview(`/api/v1/guests/${invite.id}/previews/video_in_0/whep`, bearer(invite.token));
    expect(res.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('401s without a token, with the shared API key, and once the guest has left', async () => {
    seedProduction();
    const invite = await createInvite('prod-1');
    await joinGuest(invite.id, invite.token);
    const url = `/api/v1/guests/${invite.id}/previews/video_in_0/whep`;
    expect((await postPreview(url, {})).res.statusCode).toBe(401);
    expect((await postPreview(url, AUTH)).res.statusCode).toBe(401);
    const leave = await app.inject({ method: 'DELETE', url: `/api/v1/guests/${invite.id}/session`, headers: bearer(invite.token) });
    expect(leave.statusCode).toBe(204);
    expect((await postPreview(url, bearer(invite.token))).res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a guest may DELETE their own bound preview session but not another guest\'s', async () => {
    const doc = seedProduction();
    // A second guest slot for a second commentator.
    doc.sources.push({ sourceId: 'Whip', mixerInput: 'video_in_14', returnFeed: { synced: 'program-minus' } });
    const inviteA = await createInvite('prod-1');
    await joinGuest(inviteA.id, inviteA.token);
    const resB = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/guests/invites',
      headers: AUTH,
      payload: { mixerInput: 'video_in_14' },
    });
    const inviteB = resB.json() as { id: string; token: string };
    await joinGuest(inviteB.id, inviteB.token);

    const { sessionId: sessionA } = await postPreview(
      `/api/v1/guests/${inviteA.id}/previews/video_in_0/whep`,
      bearer(inviteA.token),
    );
    expect(sessionA).toBeDefined();

    const stolen = await app.inject({
      method: 'DELETE',
      url: `/api/v1/guests/${inviteB.id}/previews/video_in_0/whep/${sessionA}`,
      headers: bearer(inviteB.token),
    });
    expect(stolen.statusCode).toBe(403);

    const own = await app.inject({
      method: 'DELETE',
      url: `/api/v1/guests/${inviteA.id}/previews/video_in_0/whep/${sessionA}`,
      headers: bearer(inviteA.token),
    });
    expect(own.statusCode).toBe(204);
    expect(fetchMock).toHaveBeenLastCalledWith(`${STROM_URL}/whep/${sessionA}`, expect.objectContaining({ method: 'DELETE' }));
  });
});

describe('Guest join / slot advertise commentator previews', () => {
  it('join lists the flagged previews with the source name, on the guest-scoped path', async () => {
    seedProduction();
    const invite = await createInvite('prod-1');
    const body = await joinGuest(invite.id, invite.token);
    expect(body.previews).toEqual([
      {
        mixerInput: 'video_in_0',
        label: 'Stadium cam',
        url: `https://live.example.com/api/v1/guests/${invite.id}/previews/video_in_0/whep`,
      },
    ]);
    // `feeds` is unchanged: still only the guest's own return picture.
    expect(body.feeds).toEqual([
      { id: 'picture', url: `https://live.example.com/api/v1/guests/${invite.id}/returns/picture/whep`, video: true },
    ]);
  });

  it('slot lists the same previews', async () => {
    seedProduction();
    const invite = await createInvite('prod-1');
    const res = await app.inject({ method: 'GET', url: `/api/v1/guests/${invite.id}/slot`, headers: bearer(invite.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      mixerInput: 'video_in_15',
      previews: [{ mixerInput: 'video_in_0', label: 'Stadium cam' }],
    });
  });

  it('previews is empty while the production is inactive', async () => {
    seedProduction('prod-1', 'inactive');
    const invite = await createInvite('prod-1');
    const body = await joinGuest(invite.id, invite.token);
    expect(body.previews).toEqual([]);
  });
});
