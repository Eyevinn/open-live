/**
 * Route tests for the REST clip cue/play/stop/state surface (epic #206,
 * issue #277, spec docs/specs/clip-story-playback.md).
 *
 * CouchDB is mocked; a throwaway HTTP server stands in for Strom so the real
 * StromClient's media-player requests are exercised on the wire and the player
 * state response is controllable per test.
 *
 * Covers: happy paths (cue/play/stop/state), 404 (production + clip source),
 * 409 (not activated + play-with-nothing-cued), 400 (bad body/param), 401.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProductionDoc, SourceDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;

// ---------------------------------------------------------------------------
// Mock CouchDB
// ---------------------------------------------------------------------------
const productionStore = new Map<string, ProductionDoc>();
const sourceStore = new Map<string, SourceDoc>();

const prodDb = {
  get: vi.fn(async (id: string) => {
    const doc = productionStore.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(async (doc: ProductionDoc) => {
    productionStore.set(doc._id, { ...doc, _rev: '2-x' });
    return { ok: true, id: doc._id, rev: '2-x' };
  }),
  find: vi.fn(async () => ({ docs: [] })),
  findTrusted: vi.fn(async () => ({ docs: [] })),
};
const sourcesDb = {
  get: vi.fn(async (id: string) => {
    const doc = sourceStore.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(),
  find: vi.fn(),
  destroy: vi.fn(),
};

vi.mock('../db/index.js', () => ({
  getDb: () => prodDb,
  getSourcesDb: () => sourcesDb,
  getOutputsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGatewaysDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Throwaway Strom the real StromClient talks to
// ---------------------------------------------------------------------------
interface StromRequest {
  method: string;
  path: string;
  body?: unknown;
}
const stromRequests: StromRequest[] = [];
// Controllable player state returned by GET …/player/state
let playerState: Record<string, unknown> = { state: 'stopped' };

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    stromRequests.push({
      method: req.method ?? '',
      path: req.url ?? '',
      ...(raw ? { body: JSON.parse(raw) as unknown } : {}),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    if ((req.url ?? '').endsWith('/player/state')) {
      res.end(JSON.stringify(playerState));
    } else {
      res.end(JSON.stringify({ success: true }));
    }
  });
});

await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;

afterAll(() => stromServer.close());

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };
const PROD = 'prod-clip-abcdef01';
const FLOW = 'flow-clip';
const BLOCK = 'b-clip-0-abcdef01';

function makeProduction(overrides: Partial<ProductionDoc> = {}): ProductionDoc {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Clip Test',
    status: 'active',
    stromFlowId: FLOW,
    clipPlayerBlockIds: { video_in_0: BLOCK },
    sources: [{ sourceId: 'src-clip', mixerInput: 'video_in_0' }],
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ProductionDoc;
}

function makeSource(overrides: Partial<SourceDoc> = {}): SourceDoc {
  return {
    _id: 'src-clip',
    type: 'source',
    name: 'Story A',
    address: JSON.stringify({ type: 'url', url: 'https://media.example.com/story-a.mp4' }),
    streamType: 'clip',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as SourceDoc;
}

let app: FastifyInstance;
let clearClipState: (productionId: string) => void;

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
  ({ clearClipState } = await import('../services/clip-state.service.js'));
});

beforeEach(() => {
  productionStore.clear();
  sourceStore.clear();
  stromRequests.length = 0;
  playerState = { state: 'stopped' };
  clearClipState(PROD);
  productionStore.set(PROD, makeProduction());
  sourceStore.set('src-clip', makeSource());
});

function playerReqs(suffix: string) {
  return stromRequests.filter((r) => r.path === `/api/flows/${FLOW}/blocks/${BLOCK}/player/${suffix}`);
}

describe('POST /clips/:mixerInput/cue', () => {
  it('sets the playlist, gotos index 0, and returns a cued ClipState', async () => {
    playerState = { state: 'paused', duration_ms: 12000, position_ms: 0 };
    const res = await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/clips/video_in_0/cue`, headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ mixerInput: 'video_in_0', state: 'cued', clipId: 'src-clip', durationMs: 12000 });

    const playlist = playerReqs('playlist');
    expect(playlist).toHaveLength(1);
    expect(playlist[0].body).toEqual({ files: ['https://media.example.com/story-a.mp4'] });
    expect(playerReqs('goto')[0].body).toEqual({ index: 0 });
  });

  it('accepts an explicit clipId in the body', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/clips/video_in_0/cue`, headers: AUTH, payload: { clipId: 'story-42' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().clipId).toBe('story-42');
  });

  it('404s an unknown production', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/productions/prod-nope/clips/video_in_0/cue`, headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('404s when no clip source is assigned to the input', async () => {
    productionStore.set(PROD, makeProduction({ clipPlayerBlockIds: {}, sources: [] }));
    const res = await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/clips/video_in_1/cue`, headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('409s when the production is not activated', async () => {
    productionStore.set(PROD, makeProduction({ stromFlowId: undefined }));
    const res = await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/clips/video_in_0/cue`, headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(409);
  });

  it('400s an invalid mixerInput param', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/clips/not_a_pad/cue`, headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('400s an unknown body field (strict)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/clips/video_in_0/cue`, headers: AUTH, payload: { bogus: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it('401s without an API key', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/clips/video_in_0/cue`, payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /clips/:mixerInput/play', () => {
  it('409s when nothing has been cued', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/clips/video_in_0/play`, headers: AUTH });
    expect(res.statusCode).toBe(409);
  });

  it('plays after a cue and returns a playing ClipState', async () => {
    await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/clips/video_in_0/cue`, headers: AUTH, payload: {} });
    playerState = { state: 'playing', position_ms: 40, duration_ms: 12000 };
    const res = await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/clips/video_in_0/play`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mixerInput: 'video_in_0', state: 'playing', durationMs: 12000 });
    expect(playerReqs('control').at(-1)?.body).toEqual({ action: 'play' });
  });
});

describe('POST /clips/:mixerInput/stop', () => {
  it('stops and returns a stopped ClipState', async () => {
    playerState = { state: 'stopped', position_ms: 0 };
    const res = await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/clips/video_in_0/stop`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mixerInput: 'video_in_0', state: 'stopped' });
    expect(playerReqs('control').at(-1)?.body).toEqual({ action: 'stop' });
  });
});

describe('GET /clips/:mixerInput/state', () => {
  it('returns the current mapped clip state', async () => {
    playerState = { state: 'playing', position_ms: 3000, duration_ms: 9000 };
    const res = await app.inject({ method: 'GET', url: `/api/v1/productions/${PROD}/clips/video_in_0/state`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mixerInput: 'video_in_0', state: 'playing', positionMs: 3000, durationMs: 9000 });
  });

  it('404s when the source is not a clip source', async () => {
    sourceStore.set('src-clip', makeSource({ streamType: 'srt', address: 'srt://1.2.3.4:9000' }));
    const res = await app.inject({ method: 'GET', url: `/api/v1/productions/${PROD}/clips/video_in_0/state`, headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});
