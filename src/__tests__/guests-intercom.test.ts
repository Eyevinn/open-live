/**
 * Intercom talkback provisioning on guest join (epic #208, issue #302,
 * `docs/specs/guest-calling-intercom.md` §"Service Interactions", §Configuration).
 *
 * Two concerns are tested with the HTTP boundary mocked (no real network):
 *
 *  1. The guest-join route: with intercom CONFIGURED a joined guest gets an
 *     `intercomLine` and the refs are recorded on the session + production; with
 *     intercom UNREACHABLE during an explicitly-enabled provision the join fails
 *     502 (talkback was asked for and could not be delivered).
 *  2. The intercom-manager client itself: production-grouping create on first
 *     use, line attach on an existing grouping, and unreachable/non-2xx →
 *     IntercomManagerError.
 *
 * The "unconfigured → intercomLine absent, join still succeeds" degrade path is
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
process.env['INTERCOM_MANAGER_URL'] = 'https://intercom.example.com';
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

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

let app: FastifyInstance;

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

async function createInvite(payload: Record<string, unknown> = {}) {
  seedProduction();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/productions/prod-1/guests/invites',
    headers: AUTH,
    payload,
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

describe('guest join — intercom configured', () => {
  it('provisions a talkback line and records refs on the session + production', async () => {
    // Mock the intercom-manager HTTP boundary: grouping create then line attach.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (u.endsWith('/production') && method === 'POST') {
        return new Response(JSON.stringify({ productionId: 'ic-prod-9' }), { status: 201 });
      }
      if (/\/production\/ic-prod-9\/line$/.test(u) && method === 'POST') {
        return new Response(
          JSON.stringify({ id: 'ic-line-1', name: 'guest', joinUrl: 'https://intercom.example.com/line/ic-line-1' }),
          { status: 201 },
        );
      }
      throw new Error(`unexpected fetch ${method} ${u}`);
    });

    const invite = await createInvite({ label: 'Remote guest' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.intercomLine).toMatchObject({
      id: 'ic-line-1',
      productionId: 'ic-prod-9',
      joinUrl: 'https://intercom.example.com/line/ic-line-1',
    });
    // The line ref is recorded on the guest session…
    expect(sessionsStore.get(body.guestId)?.intercomLineId).toBe('ic-line-1');
    // …and the grouping id on the production so teardown can find it.
    expect(productionsStore.get('prod-1')?.intercomProductionId).toBe('ic-prod-9');
    // WHIP video + WHEP return unaffected — talkback is additive.
    expect(body.whipUrl).toContain('/whip/video_in_');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reuses an existing intercom grouping and only attaches a line', async () => {
    const prod = seedProduction();
    productionsStore.set('prod-1', { ...prod, intercomProductionId: 'ic-prod-existing' });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (/\/production\/ic-prod-existing\/line$/.test(u) && method === 'POST') {
        return new Response(JSON.stringify({ id: 'ic-line-2', name: 'guest' }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${method} ${u}`);
    });

    const inviteRes = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-1/guests/invites',
      headers: AUTH,
      payload: {},
    });
    const invite = inviteRes.json() as { id: string; token: string };
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().intercomLine.id).toBe('ic-line-2');
    // No grouping create — only the line attach was called.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('502s when intercom is enabled but the manager is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const invite = await createInvite();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });

    expect(res.statusCode).toBe(502);
  });

  it('502s when the manager returns a non-2xx status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

    const invite = await createInvite();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guests/${invite.id}/join`,
      headers: { authorization: `Bearer ${invite.token}` },
    });

    expect(res.statusCode).toBe(502);
  });
});

describe('intercom-manager client', () => {
  it('creates a grouping on first use then attaches a line, sending the bearer token', async () => {
    const { provisionGuestLine } = await import('../lib/intercom-manager.js');
    const calls: Array<{ url: string; method: string; auth?: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      calls.push({ url: String(url), method: (init?.method ?? 'GET').toUpperCase(), auth: headers.get('authorization') ?? undefined });
      if (String(url).endsWith('/production')) {
        return new Response(JSON.stringify({ productionId: 'ic-prod-1' }), { status: 201 });
      }
      return new Response(JSON.stringify({ id: 'ic-line-1', name: 'l' }), { status: 201 });
    });

    const line = await provisionGuestLine({ productionId: 'prod-1', lineName: 'video_in_0' });
    expect(line).toMatchObject({ id: 'ic-line-1', productionId: 'ic-prod-1' });
    expect(calls[0]).toMatchObject({ method: 'POST', auth: 'Bearer ic-token' });
    expect(calls[0].url).toContain('/production');
    expect(calls[1].url).toContain('/production/ic-prod-1/line');
  });

  it('skips grouping create when intercomProductionId is supplied', async () => {
    const { provisionGuestLine } = await import('../lib/intercom-manager.js');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'ic-line-3', name: 'l' }), { status: 201 }),
    );
    const line = await provisionGuestLine({
      intercomProductionId: 'ic-prod-keep',
      productionId: 'prod-1',
      lineName: 'video_in_1',
    });
    expect(line.productionId).toBe('ic-prod-keep');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/production/ic-prod-keep/line');
  });

  it('throws IntercomManagerError when unreachable', async () => {
    const { provisionGuestLine, IntercomManagerError } = await import('../lib/intercom-manager.js');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      provisionGuestLine({ intercomProductionId: 'ic-p', productionId: 'prod-1', lineName: 'x' }),
    ).rejects.toBeInstanceOf(IntercomManagerError);
  });

  it('throws IntercomManagerError on a non-2xx response', async () => {
    const { provisionGuestLine, IntercomManagerError } = await import('../lib/intercom-manager.js');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 503 }));
    await expect(
      provisionGuestLine({ intercomProductionId: 'ic-p', productionId: 'prod-1', lineName: 'x' }),
    ).rejects.toBeInstanceOf(IntercomManagerError);
  });
});
