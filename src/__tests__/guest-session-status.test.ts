/**
 * Guest-scoped on-air status (issue #592):
 * `GET /api/v1/guests/:inviteId/session/status` → `{ onAir: boolean }`.
 *
 *  - `onAir` is true when the guest's live-session mixerInput is the program
 *    `pgm` input, or a layer (background or zone source) of the PiP on program,
 *    and false otherwise — via the same contribution rules as the TALLY
 *    (`isMixerInputOnProgram` → `computeTallyContributions`);
 *  - the body is only the guest's own boolean — no other tally details;
 *  - a return-only slot (non-WHIP source) is never on air, even when its
 *    input is on program;
 *  - 401 for no token, a bad token, a token for another invite, a revoked
 *    invite, and a guest who has left.
 *
 * CouchDB, the WS controller and Strom (`fetch`) are mocked. The controller
 * mock answers `isInputOnProgram` from a test-controlled switch state through
 * the REAL `isMixerInputOnProgram`, so the pgm / PiP cases are exercised end to
 * end through the route.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GuestInviteDoc, GuestSessionDoc, ProductionDoc } from '../db/types.js';
import type { PipConfig } from '../lib/strom.js';
import { isMixerInputOnProgram } from '../services/automation-contract.js';

const TEST_API_KEY: string = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
process.env['GUEST_INVITE_SECRET'] = 'test-hmac-secret';
process.env['PUBLIC_BASE_URL'] = 'https://live.example.com';

// ---- Controller switch state the mock reads ----
const switchState = vi.hoisted(() => ({
  pgm: null as string | null,
  pgmPip: null as number | null,
  pgmBg: null as string | null,
  pipConfigs: undefined as PipConfig[] | undefined,
}));

// ---- Mock CouchDB stores ----
const invitesStore = new Map<string, GuestInviteDoc>();
const sessionsStore = new Map<string, GuestSessionDoc>();
const productionsStore = new Map<string, ProductionDoc>();
const sourcesStore = new Map<string, { _id: string; streamType: string }>();

function matchSelector<T>(docs: T[], selector: Record<string, unknown>): T[] {
  return docs.filter((d) =>
    Object.entries(selector).every(([k, v]) => (d as Record<string, unknown>)[k] === v),
  );
}

function store<T extends { _id: string }>(map: Map<string, T>) {
  return {
    get: vi.fn(async (id: string) => {
      const doc = map.get(id);
      if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
      return doc;
    }),
    insert: vi.fn(async (doc: T) => {
      map.set(doc._id, { ...doc, _rev: '1-x' });
      return { ok: true };
    }),
    destroy: vi.fn(async (id: string) => {
      map.delete(id);
      return { ok: true };
    }),
    find: vi.fn(async (q: { selector: Record<string, unknown> }) => ({
      docs: matchSelector(Array.from(map.values()), q.selector),
    })),
    findTrusted: vi.fn(async () => ({ docs: [] })),
  };
}

const prodDb = store(productionsStore);
const invitesDb = store(invitesStore);
const sessionsDb = store(sessionsStore);
const sourcesDb = store(sourcesStore);

vi.mock('../lib/ice-servers.js', () => ({
  getIceServers: vi.fn().mockRejectedValue(new Error('Strom unreachable')),
  resetIceServersCache: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => prodDb,
  getGuestInvitesDb: () => invitesDb,
  getGuestSessionsDb: () => sessionsDb,
  getSourcesDb: () => sourcesDb,
  getOutputsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGatewaysDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', async () => {
  const contract = await import('../services/automation-contract.js');
  return {
    default: async () => {},
    applyReturnMode: vi.fn(),
    clearAudioState: vi.fn(),
    clearPipState: vi.fn(),
    clearFxState: vi.fn(),
    isInputOnProgram: vi.fn((_productionId: string, mixerInput: string) =>
      contract.isMixerInputOnProgram(
        mixerInput,
        switchState.pgm,
        switchState.pgmPip,
        switchState.pgmBg,
        switchState.pipConfigs,
      ),
    ),
  };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

let app: FastifyInstance;
let buildServer: typeof import('../server.js')['buildServer'];

/** An active production: video_in_0 is a WHIP guest slot, video_in_1 an SRT (return-only) one. */
function seedProduction(id = 'prod-1'): void {
  productionsStore.set(id, {
    _id: id,
    _rev: '1-a',
    type: 'production',
    name: 'Test show',
    status: 'active',
    stromFlowId: 'flow-abc',
    sources: [
      { sourceId: 'src-whip', mixerInput: 'video_in_0', returnFeed: { synced: 'program-minus' } },
      { sourceId: 'src-srt', mixerInput: 'video_in_1', returnFeed: { synced: 'program-minus' } },
      { sourceId: 'src-cam', mixerInput: 'video_in_2' },
    ],
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '',
    updatedAt: '',
  } as unknown as ProductionDoc);
}

async function joinedGuest(mixerInput = 'video_in_0') {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/productions/prod-1/guests/invites',
    headers: AUTH,
    payload: { mixerInput },
  });
  const invite = created.json() as { id: string; token: string };
  const join = await app.inject({
    method: 'POST',
    url: `/api/v1/guests/${invite.id}/join`,
    headers: { authorization: `Bearer ${invite.token}` },
  });
  expect(join.statusCode).toBe(200);
  return invite;
}

function getStatus(inviteId: string, token?: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/guests/${inviteId}/session/status`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
});

beforeEach(async () => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  sourcesStore.clear();
  sourcesStore.set('src-whip', { _id: 'src-whip', streamType: 'whip' });
  sourcesStore.set('src-srt', { _id: 'src-srt', streamType: 'srt' });
  sourcesStore.set('src-cam', { _id: 'src-cam', streamType: 'srt' });
  Object.assign(switchState, { pgm: null, pgmPip: null, pgmBg: null, pipConfigs: undefined });
  seedProduction();
  // The join route's per-route rate limiter accumulates across tests sharing one app.
  app = await buildServer();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 201,
      text: async () => 'v=0',
      json: async () => ({}),
      headers: { get: (name: string) => (name === 'Location' ? '/whip/session-1' : null) },
    })),
  );
});

describe('GET /api/v1/guests/:inviteId/session/status (issue #592)', () => {
  it('onAir is true when the guest input is the program pgm', async () => {
    const invite = await joinedGuest();
    switchState.pgm = 'video_in_0';
    const res = await getStatus(invite.id, invite.token);
    expect(res.statusCode).toBe(200);
    // Only the guest's own boolean — no other tally details.
    expect(res.json()).toEqual({ onAir: true });
  });

  it('onAir is true when the guest input is a layer of the PiP on program', async () => {
    const invite = await joinedGuest();
    switchState.pgmPip = 0;
    switchState.pgmBg = 'video_in_2';
    switchState.pipConfigs = [
      { bg: 2, zones: [{ rect: null, capacity: 1, sources: [0] }], transforms: {} } as unknown as PipConfig,
    ];
    const res = await getStatus(invite.id, invite.token);
    expect(res.json()).toEqual({ onAir: true });

    // As the PiP's background, too.
    switchState.pgmBg = 'video_in_0';
    switchState.pipConfigs = [
      { bg: 0, zones: [{ rect: null, capacity: 1, sources: [2] }], transforms: {} } as unknown as PipConfig,
    ];
    expect((await getStatus(invite.id, invite.token)).json()).toEqual({ onAir: true });
  });

  it('onAir is false when another input is on program, or the guest is only on preview', async () => {
    const invite = await joinedGuest();
    expect((await getStatus(invite.id, invite.token)).json()).toEqual({ onAir: false });
    switchState.pgm = 'video_in_2';
    expect((await getStatus(invite.id, invite.token)).json()).toEqual({ onAir: false });
    // A PiP on program that the guest is not part of.
    switchState.pgm = null;
    switchState.pgmPip = 0;
    switchState.pgmBg = 'video_in_2';
    switchState.pipConfigs = [
      { bg: 2, zones: [{ rect: null, capacity: 1, sources: [1] }], transforms: {} } as unknown as PipConfig,
    ];
    expect((await getStatus(invite.id, invite.token)).json()).toEqual({ onAir: false });
  });

  it('a return-only slot never reads on air, even when its input is on program', async () => {
    const invite = await joinedGuest('video_in_1');
    switchState.pgm = 'video_in_1';
    const res = await getStatus(invite.id, invite.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ onAir: false });
  });

  it('401s with no token, a bad token, or another invite\'s token', async () => {
    const invite = await joinedGuest();
    switchState.pgm = 'video_in_0';
    expect((await getStatus(invite.id)).statusCode).toBe(401);
    expect((await getStatus(invite.id, 'olgi_v1_forged.token')).statusCode).toBe(401);
    expect((await getStatus(invite.id, TEST_API_KEY)).statusCode).toBe(401);
    const other = await joinedGuest('video_in_1');
    expect((await getStatus(invite.id, other.token)).statusCode).toBe(401);
  });

  it('401s a revoked invite', async () => {
    const invite = await joinedGuest();
    switchState.pgm = 'video_in_0';
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-1/guests/invites/${invite.id}`,
      headers: AUTH,
    });
    expect(revoke.statusCode).toBe(204);
    const res = await getStatus(invite.id, invite.token);
    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toHaveProperty('onAir');
  });

  it('401s once the guest has left', async () => {
    const invite = await joinedGuest();
    switchState.pgm = 'video_in_0';
    const leave = await app.inject({
      method: 'DELETE',
      url: `/api/v1/guests/${invite.id}/session`,
      headers: { authorization: `Bearer ${invite.token}` },
    });
    expect(leave.statusCode).toBe(204);
    expect((await getStatus(invite.id, invite.token)).statusCode).toBe(401);
  });
});

describe('isMixerInputOnProgram (issue #592)', () => {
  const pip = (bg: number | null, sources: number[]): PipConfig[] =>
    [{ bg, zones: [{ rect: null, capacity: null, sources }], transforms: {} } as unknown as PipConfig];

  it('is true for the main pgm input', () => {
    expect(isMixerInputOnProgram('video_in_3', 'video_in_3', null, null, undefined)).toBe(true);
  });

  it('is true for a PiP zone source or the PiP background while the PiP is on program', () => {
    expect(isMixerInputOnProgram('video_in_3', null, 0, 'video_in_1', pip(1, [3]))).toBe(true);
    expect(isMixerInputOnProgram('video_in_1', null, 0, 'video_in_1', pip(1, [3]))).toBe(true);
  });

  it('is false otherwise', () => {
    expect(isMixerInputOnProgram('video_in_3', null, null, null, undefined)).toBe(false);
    expect(isMixerInputOnProgram('video_in_3', 'video_in_1', null, null, undefined)).toBe(false);
    expect(isMixerInputOnProgram('video_in_3', null, 0, 'video_in_1', pip(1, [2]))).toBe(false);
    // A PiP that is configured but NOT on program does not count.
    expect(isMixerInputOnProgram('video_in_3', 'video_in_1', null, null, pip(1, [3]))).toBe(false);
  });
});
