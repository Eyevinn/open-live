/**
 * Route tests for guest calling v1 page + mic mute (issue #382). CouchDB, the WS
 * controller and the tally broadcast bus are mocked; no live services required.
 *
 * Covers:
 *  - the invite `joinUrl` is the backend-served guest page with the token in the
 *    URL fragment (not the raw API endpoint, no query string);
 *  - `GET /guest/:inviteId` serves the guest HTML page unauthenticated with a
 *    page-appropriate CSP;
 *  - `PUT /api/v1/guests/:inviteId/session/mute` requires the invite token,
 *    persists `muted`, is reflected in the GUEST_STATE broadcast and the
 *    `GET /api/v1/productions/:id/guests` projection, and resets on rejoin.
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

// Capture every broadcast so we can assert GUEST_STATE carries `muted`.
const broadcasts: Array<{ productionId: string; message: Record<string, unknown> }> = [];
vi.mock('../services/tally.service.js', () => ({
  broadcast: vi.fn((productionId: string, message: Record<string, unknown>) => {
    broadcasts.push({ productionId, message });
  }),
  nextSeq: vi.fn(() => 1),
  currentSeq: vi.fn(() => 1),
  getTally: vi.fn(() => ({ pgm: null, pvw: null })),
  setTally: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  getSubscriberCount: vi.fn(() => 0),
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
    // A guest slot is a source assignment carrying a `returnFeed` (#381). Invites
    // can only target a declared slot, so seed one for the mute flow to use.
    sources: [
      {
        sourceId: 'Whip',
        mixerInput: 'video_in_0',
        returnFeed: { synced: 'program-minus' as const, lowLatency: false },
      },
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
  seedProduction();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/productions/prod-1/guests/invites',
    headers: AUTH,
    // An invite must pin a declared guest slot (#381); default to the seeded slot.
    payload: { mixerInput: 'video_in_0', ...payload },
  });
  return res.json() as { id: string; token: string; joinUrl: string };
}

async function createInviteAndJoin() {
  const invite = await createInvite();
  const joinRes = await app.inject({
    method: 'POST',
    url: `/api/v1/guests/${invite.id}/join`,
    headers: { authorization: `Bearer ${invite.token}` },
  });
  return { invite, guestId: (joinRes.json() as { guestId: string }).guestId };
}

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

beforeEach(() => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  broadcasts.length = 0;
});

describe('invite joinUrl link scheme (#382)', () => {
  it('is the backend guest page with the token in the fragment, no query string', async () => {
    const invite = await createInvite();
    expect(invite.joinUrl).toBe(`https://live.example.com/guest/${invite.id}#${invite.token}`);
    expect(invite.joinUrl).not.toContain('?');
    // Token is after the '#', so the server/proxy never sees it in the path.
    expect(invite.joinUrl.split('#')[0]).toBe(`https://live.example.com/guest/${invite.id}`);
  });
});

describe('GET /guest/:inviteId (guest page)', () => {
  it('serves the HTML page unauthenticated with a page-scoped CSP', async () => {
    const res = await app.inject({ method: 'GET', url: '/guest/guest-invite-anything' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<!DOCTYPE html>');
    expect(res.body).toContain('Go live');
    // The page overrides the API's default-src 'none' CSP so its own inline
    // script/style and WebRTC media can run.
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("media-src 'self' blob: mediastream:");
    expect(csp).not.toContain("default-src 'none'");
  });
});

describe('PUT /api/v1/guests/:inviteId/session/mute (#382)', () => {
  it('requires the invite token (401 without it, and the shared API key is not a guest token)', async () => {
    const { invite } = await createInviteAndJoin();
    const noToken = await app.inject({
      method: 'PUT',
      url: `/api/v1/guests/${invite.id}/session/mute`,
      payload: { muted: true },
    });
    expect(noToken.statusCode).toBe(401);

    const apiKey = await app.inject({
      method: 'PUT',
      url: `/api/v1/guests/${invite.id}/session/mute`,
      headers: AUTH,
      payload: { muted: true },
    });
    expect(apiKey.statusCode).toBe(401);
  });

  it('persists muted, reflects it in the GUEST_STATE broadcast and the guests projection', async () => {
    const { invite, guestId } = await createInviteAndJoin();
    broadcasts.length = 0;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/guests/${invite.id}/session/mute`,
      headers: { authorization: `Bearer ${invite.token}` },
      payload: { muted: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ guestId, muted: true });

    // Persisted on the session.
    expect(sessionsStore.get(guestId)?.muted).toBe(true);

    // Broadcast a GUEST_STATE carrying muted=true.
    const guestState = broadcasts.map((b) => b.message).find((m) => m['type'] === 'GUEST_STATE');
    expect(guestState).toBeDefined();
    expect(guestState).toMatchObject({ guestId, muted: true });

    // Reflected in the operator projection.
    const list = (await app.inject({
      method: 'GET',
      url: '/api/v1/productions/prod-1/guests',
      headers: AUTH,
    })).json() as Array<{ id: string; muted: boolean }>;
    expect(list.find((g) => g.id === guestId)?.muted).toBe(true);

    // Unmute round-trips back to false.
    await app.inject({
      method: 'PUT',
      url: `/api/v1/guests/${invite.id}/session/mute`,
      headers: { authorization: `Bearer ${invite.token}` },
      payload: { muted: false },
    });
    expect(sessionsStore.get(guestId)?.muted).toBe(false);
  });

  it('400s on a missing/invalid body', async () => {
    const { invite } = await createInviteAndJoin();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/guests/${invite.id}/session/mute`,
      headers: { authorization: `Bearer ${invite.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s when the guest has no active session', async () => {
    const invite = await createInvite(); // invite exists, but never joined
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/guests/${invite.id}/session/mute`,
      headers: { authorization: `Bearer ${invite.token}` },
      payload: { muted: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('a guest projection defaults muted=false before any toggle', async () => {
    const { guestId } = await createInviteAndJoin();
    const list = (await app.inject({
      method: 'GET',
      url: '/api/v1/productions/prod-1/guests',
      headers: AUTH,
    })).json() as Array<{ id: string; muted: boolean }>;
    expect(list.find((g) => g.id === guestId)?.muted).toBe(false);
  });

  it('resets muted to false when the guest rejoins on the same invite', async () => {
    const { invite, guestId } = await createInviteAndJoin();
    await app.inject({
      method: 'PUT',
      url: `/api/v1/guests/${invite.id}/session/mute`,
      headers: { authorization: `Bearer ${invite.token}` },
      payload: { muted: true },
    });
    expect(sessionsStore.get(guestId)?.muted).toBe(true);

    // Rejoin on the same invite — reuses the live session and starts unmuted.
    const rejoin = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(rejoin.statusCode).toBe(200);
    expect(sessionsStore.get(guestId)?.muted).toBe(false);
  });
});
