/**
 * Live multiview tile labelling for guest slots (issue #466).
 *
 * `input_{N}_label` became a LIVE vision-mixer property in Strom PR#1014
 * (strom#999). When a guest joins a slot on a running flow the backend PATCHes
 * their invite name onto the slot's tile (falling back to `Guest N` when the
 * invite has none); when the guest leaves / is kicked / the invite is revoked it
 * resets the tile to `Guest N`. On an older Strom the property is rejected — the
 * join/leave must still succeed and the tile keeps `Guest N`.
 *
 * CouchDB and the WS controller are mocked; the Strom HTTP client is driven via
 * a stubbed global fetch that captures the block-properties PATCHes.
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

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
  applyReturnMode: vi.fn().mockResolvedValue({ ok: true }),
}));

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

/**
 * Seed an ACTIVE production with a live flow and two WHIP guest slots. Studio
 * allocates guest slots from the top of the mixer-input range down, so
 * video_in_15 is Guest 1 and video_in_14 is Guest 2; the flow generator compacts
 * those sparse stored pads to a contiguous range and records the mapping in
 * `mixerInputMap` (video_in_14 → 0, video_in_15 → 1). The live `input_{N}_label`
 * PATCH must target the COMPACT pad, so Guest 1 (video_in_15) is pad 1.
 */
function seedActiveProduction(id = 'prod-1'): ProductionDoc {
  const doc = {
    _id: id,
    _rev: '1-a',
    type: 'production',
    name: 'Test show',
    status: 'active',
    stromFlowId: 'flow-1',
    mixerBlockId: 'b-mixer',
    mixerInputMap: { video_in_14: 0, video_in_15: 1 },
    sources: [
      { sourceId: 'Whip', mixerInput: 'video_in_14', returnFeed: { synced: 'program-minus', lowLatency: false } },
      { sourceId: 'Whip', mixerInput: 'video_in_15', returnFeed: { synced: 'program-minus', lowLatency: false } },
    ],
    tally: { pgm: null, pvw: null },
    createdAt: '',
    updatedAt: '',
  } as unknown as ProductionDoc;
  productionsStore.set(id, doc);
  return doc;
}

interface PatchCall {
  flowId: string;
  blockId: string;
  properties: Record<string, unknown>;
}

/**
 * Stub global fetch to capture vision-mixer block-properties PATCHes.
 * `rejected` keys are echoed back in the response so the "older Strom rejects
 * the property" path can be driven (StromClient turns a rejected written key
 * into StromPropertiesRejectedError).
 */
function stubStromFetch(captured: PatchCall[], rejected: Record<string, string> = {}) {
  const fetchMock = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const m = /\/api\/flows\/([^/]+)\/blocks\/([^/]+)\/properties$/.exec(u);
    if (init?.method === 'PATCH' && m) {
      const body = JSON.parse(init.body ?? '{}') as { properties: Record<string, unknown> };
      captured.push({ flowId: m[1], blockId: m[2], properties: body.properties });
      return new Response(
        JSON.stringify({ block_id: m[2], properties: body.properties, rejected }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let app: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

beforeEach(() => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
});

async function mkInvite(mixerInput: string, label?: string, prodId = 'prod-1') {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/productions/${prodId}/guests/invites`,
    headers: AUTH,
    payload: { mixerInput, ...(label ? { label } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string };
}

function join(invite: { id: string; token: string }) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/guests/${invite.id}/join`,
    headers: { authorization: `Bearer ${invite.token}` },
  });
}

describe('guest slot live multiview label (#466)', () => {
  it('sets the invite name on the guest tile (compact pad) when the guest joins a live flow', async () => {
    seedActiveProduction();
    const captured: PatchCall[] = [];
    stubStromFetch(captured);
    try {
      const invite = await mkInvite('video_in_15', 'Anna, Helsinki');
      const res = await join(invite);
      expect(res.statusCode).toBe(200);
      // video_in_15 is Guest 1 and wired to compact pad 1 (mixerInputMap), so the
      // live label PATCH targets input_1_label with the invite name.
      const labelPatch = captured.find((c) => 'input_1_label' in c.properties);
      expect(labelPatch).toBeDefined();
      expect(labelPatch!.flowId).toBe('flow-1');
      expect(labelPatch!.blockId).toBe('b-mixer');
      expect(labelPatch!.properties['input_1_label']).toBe('Anna, Helsinki');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to "Guest N" when the invite has no label', async () => {
    seedActiveProduction();
    const captured: PatchCall[] = [];
    stubStromFetch(captured);
    try {
      // video_in_14 is Guest 2, wired to compact pad 0.
      const invite = await mkInvite('video_in_14');
      expect((await join(invite)).statusCode).toBe(200);
      const labelPatch = captured.find((c) => 'input_0_label' in c.properties);
      expect(labelPatch).toBeDefined();
      expect(labelPatch!.properties['input_0_label']).toBe('Guest 2');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resets the tile to "Guest N" when the guest leaves', async () => {
    seedActiveProduction();
    const captured: PatchCall[] = [];
    stubStromFetch(captured);
    try {
      const invite = await mkInvite('video_in_15', 'Anna, Helsinki');
      expect((await join(invite)).statusCode).toBe(200);
      captured.length = 0; // ignore the join-time label

      const leave = await app.inject({
        method: 'DELETE',
        url: `/api/v1/guests/${invite.id}/session`,
        headers: { authorization: `Bearer ${invite.token}` },
      });
      expect(leave.statusCode).toBe(204);
      const labelPatch = captured.find((c) => 'input_1_label' in c.properties);
      expect(labelPatch).toBeDefined();
      expect(labelPatch!.properties['input_1_label']).toBe('Guest 1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resets the tile to "Guest N" when the operator kicks the guest', async () => {
    seedActiveProduction();
    const captured: PatchCall[] = [];
    stubStromFetch(captured);
    try {
      const invite = await mkInvite('video_in_15', 'Anna, Helsinki');
      const guestId = (await join(invite).then((r) => r.json())).guestId as string;
      captured.length = 0;

      const kick = await app.inject({
        method: 'DELETE',
        url: `/api/v1/productions/prod-1/guests/${guestId}`,
        headers: AUTH,
      });
      expect(kick.statusCode).toBe(204);
      const labelPatch = captured.find((c) => 'input_1_label' in c.properties);
      expect(labelPatch!.properties['input_1_label']).toBe('Guest 1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resets the tile to "Guest N" when the invite is revoked', async () => {
    seedActiveProduction();
    const captured: PatchCall[] = [];
    stubStromFetch(captured);
    try {
      const invite = await mkInvite('video_in_15', 'Anna, Helsinki');
      expect((await join(invite)).statusCode).toBe(200);
      captured.length = 0;

      const revoke = await app.inject({
        method: 'DELETE',
        url: `/api/v1/productions/prod-1/guests/invites/${invite.id}`,
        headers: AUTH,
      });
      expect(revoke.statusCode).toBe(204);
      const labelPatch = captured.find((c) => 'input_1_label' in c.properties);
      expect(labelPatch!.properties['input_1_label']).toBe('Guest 1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not fail the join when an older Strom rejects the live label property', async () => {
    seedActiveProduction();
    const captured: PatchCall[] = [];
    // Strom answers 200 but lists input_1_label under `rejected` (unknown
    // property on a pre-PR#1014 Strom) → the client throws, which the label
    // helper must swallow so the join still succeeds.
    stubStromFetch(captured, { input_1_label: 'unknown property: input_1_label' });
    const warnSpy = vi.spyOn(app.log, 'warn');
    try {
      const invite = await mkInvite('video_in_15', 'Anna, Helsinki');
      const res = await join(invite);
      // The join is unaffected by the rejected cosmetic label.
      expect(res.statusCode).toBe(200);
      expect(captured.some((c) => 'input_1_label' in c.properties)).toBe(true);
      // The rejection is logged at warn, not thrown.
      expect(
        warnSpy.mock.calls.some(
          (c) => typeof c[1] === 'string' && (c[1] as string).includes('guest slot label'),
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      warnSpy.mockRestore();
    }
  });

  it('does not PATCH a label when the production has no live flow (set at flow build instead)', async () => {
    // Inactive production: no stromFlowId / mixerBlockId, so there is nothing
    // live to label — the Guest N label is written at the next flow build.
    const doc = seedActiveProduction();
    productionsStore.set('prod-1', {
      ...doc,
      status: 'inactive',
      stromFlowId: undefined,
      mixerBlockId: undefined,
    } as unknown as ProductionDoc);
    const captured: PatchCall[] = [];
    stubStromFetch(captured);
    try {
      const invite = await mkInvite('video_in_15', 'Anna, Helsinki');
      expect((await join(invite)).statusCode).toBe(200);
      expect(captured.length).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
