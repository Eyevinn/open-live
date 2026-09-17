/**
 * Tests for the WebSocket CLIP_* command surface (epic #206, issue #278,
 * spec docs/specs/clip-story-playback.md).
 *
 * Covers:
 *  - the CLIP_CUE/PLAY/STOP/PAUSE/SEEK arms of the inbound zod schema (validation),
 *  - the handlers driving the Strom media-player block and broadcasting CLIP_STATE
 *    on every transition (cued/playing/paused/stopped),
 *  - the play-with-nothing-cued rejection (ERROR + CLIP_STATE error),
 *  - completion detection via the poll fallback (fake timers): while playing,
 *    when Strom reports `stopped` a CLIP_STATE `completed` is broadcast.
 *
 * CouchDB is mocked; a throwaway HTTP server stands in for Strom so the real
 * StromClient's player requests are asserted on the wire and player state is
 * controllable per test.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const productionDocs = new Map<string, Record<string, unknown>>();
const sourceDocs = new Map<string, Record<string, unknown>>();

const getProduction = vi.fn(async (id: string) => {
  const doc = productionDocs.get(id);
  if (!doc) throw new Error('not_found');
  return doc;
});
const getSource = vi.fn(async (id: string) => {
  const doc = sourceDocs.get(id);
  if (!doc) throw new Error('not_found');
  return doc;
});

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: getProduction, insert: vi.fn().mockResolvedValue({ ok: true }), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: getSource, insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
}));

const updateProductionDoc = vi.fn(async (id: string, patch: Record<string, unknown>) => {
  // Emulate the real read-merge-write so clipCues accumulate on the doc mock,
  // letting the cue-persistence assertions observe the persisted map.
  const doc = productionDocs.get(id);
  if (doc) productionDocs.set(id, { ...doc, ...patch });
});
vi.mock('../routes/productions.js', () => ({
  updateProductionDoc: (id: string, patch: Record<string, unknown>) => updateProductionDoc(id, patch),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

const broadcasts: Array<Record<string, unknown>> = [];

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return {
    ...actual,
    broadcast: (_id: string, message: unknown) => {
      broadcasts.push(message as Record<string, unknown>);
    },
  };
});

// ---------------------------------------------------------------------------
// Throwaway Strom
// ---------------------------------------------------------------------------
interface StromRequest {
  method: string;
  path: string;
  body?: unknown;
}
const stromRequests: StromRequest[] = [];
let playerState: Record<string, unknown> = { state: 'stopped' };

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    stromRequests.push({ method: req.method ?? '', path: req.url ?? '', ...(raw ? { body: JSON.parse(raw) as unknown } : {}) });
    res.writeHead(200, { 'content-type': 'application/json' });
    if ((req.url ?? '').endsWith('/player/state')) res.end(JSON.stringify(playerState));
    else res.end(JSON.stringify({ success: true }));
  });
});

await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
afterAll(() => stromServer.close());

const { handleMessage, clearClipStateForProduction } = await import('../ws/controller.js');
const { config } = await import('../config.js');

const PROD = 'prod-clip-ws01';
const FLOW = 'flow-clip-ws';
const BLOCK = 'b-clip-0-ws';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Clip WS Test',
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
  };
}

function makeSourceDoc(overrides: Record<string, unknown> = {}) {
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
  };
}

const ws = { send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;

function send(msg: Record<string, unknown>) {
  return handleMessage(PROD, ws, JSON.stringify(msg), {});
}
function clipStates() {
  return broadcasts.filter((m) => m.type === 'CLIP_STATE');
}
function errorFrames() {
  return (ws.send as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => JSON.parse(c[0] as string) as Record<string, unknown>)
    .filter((m) => m.type === 'ERROR');
}
function playerReqs(suffix: string) {
  return stromRequests.filter((r) => r.path === `/api/flows/${FLOW}/blocks/${BLOCK}/player/${suffix}`);
}

beforeEach(() => {
  clearClipStateForProduction(PROD);
  broadcasts.length = 0;
  stromRequests.length = 0;
  playerState = { state: 'stopped' };
  (ws.send as unknown as ReturnType<typeof vi.fn>).mockClear();
  updateProductionDoc.mockClear();
  productionDocs.clear();
  sourceDocs.clear();
  productionDocs.set(PROD, makeProductionDoc());
  sourceDocs.set('src-clip', makeSourceDoc());
});

describe('CLIP_* schema validation', () => {
  it('rejects CLIP_CUE with a bad mixerInput', async () => {
    await send({ type: 'CLIP_CUE', mixerInput: 'nope' });
    expect(errorFrames().length).toBeGreaterThan(0);
    expect(playerReqs('playlist')).toHaveLength(0);
  });
  it('rejects CLIP_SEEK with a negative positionMs', async () => {
    await send({ type: 'CLIP_SEEK', mixerInput: 'video_in_0', positionMs: -1 });
    expect(errorFrames().length).toBeGreaterThan(0);
    expect(playerReqs('seek')).toHaveLength(0);
  });
  it('rejects CLIP_SEEK missing positionMs', async () => {
    await send({ type: 'CLIP_SEEK', mixerInput: 'video_in_0' });
    expect(errorFrames().length).toBeGreaterThan(0);
  });
});

describe('CLIP_CUE / PLAY / PAUSE / STOP transitions', () => {
  it('CLIP_CUE sets playlist + gotos and broadcasts CLIP_STATE cued', async () => {
    playerState = { state: 'paused', duration_ms: 12000, position_ms: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    expect(errorFrames()).toHaveLength(0);
    expect(playerReqs('playlist')[0].body).toEqual({ files: ['https://media.example.com/story-a.mp4'] });
    expect(playerReqs('goto')[0].body).toEqual({ index: 0 });
    const states = clipStates();
    expect(states.at(-1)).toMatchObject({ type: 'CLIP_STATE', mixerInput: 'video_in_0', state: 'cued', durationMs: 12000 });
  });

  it('CLIP_PLAY after cue broadcasts CLIP_STATE playing and controls play', async () => {
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'playing', position_ms: 20, duration_ms: 12000 };
    await send({ type: 'CLIP_PLAY', mixerInput: 'video_in_0' });
    expect(playerReqs('control').at(-1)?.body).toEqual({ action: 'play' });
    expect(clipStates().at(-1)).toMatchObject({ state: 'playing' });
  });

  it('CLIP_PLAY with nothing cued sends ERROR + CLIP_STATE error', async () => {
    await send({ type: 'CLIP_PLAY', mixerInput: 'video_in_0' });
    expect(errorFrames().length).toBeGreaterThan(0);
    expect(clipStates().at(-1)).toMatchObject({ state: 'error' });
    expect(playerReqs('control')).toHaveLength(0);
  });

  it('CLIP_PAUSE controls pause and broadcasts paused', async () => {
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'paused', position_ms: 500, duration_ms: 12000 };
    await send({ type: 'CLIP_PAUSE', mixerInput: 'video_in_0' });
    expect(playerReqs('control').at(-1)?.body).toEqual({ action: 'pause' });
    expect(clipStates().at(-1)).toMatchObject({ state: 'paused' });
  });

  it('CLIP_STOP controls stop and broadcasts stopped', async () => {
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'stopped', position_ms: 0 };
    await send({ type: 'CLIP_STOP', mixerInput: 'video_in_0' });
    expect(playerReqs('control').at(-1)?.body).toEqual({ action: 'stop' });
    expect(clipStates().at(-1)).toMatchObject({ state: 'stopped' });
  });

  it('CLIP_SEEK seeks and broadcasts state', async () => {
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'paused', position_ms: 5000, duration_ms: 12000 };
    await send({ type: 'CLIP_SEEK', mixerInput: 'video_in_0', positionMs: 5000 });
    expect(playerReqs('seek').at(-1)?.body).toEqual({ position_ms: 5000 });
    expect(clipStates().length).toBeGreaterThan(0);
  });

  it('CLIP_CUE 404s (ERROR) when the source is not a clip source', async () => {
    sourceDocs.set('src-clip', makeSourceDoc({ streamType: 'srt', address: 'srt://1.2.3.4:9000' }));
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    expect(errorFrames().length).toBeGreaterThan(0);
    expect(playerReqs('playlist')).toHaveLength(0);
  });
});

describe('cue persistence (issue #307 / OQ3)', () => {
  function clipCuesCalls() {
    return updateProductionDoc.mock.calls.filter((c) => 'clipCues' in (c[1] as Record<string, unknown>));
  }

  it('CLIP_CUE persists the cue point to the production doc', async () => {
    playerState = { state: 'paused', duration_ms: 12000, position_ms: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    const call = clipCuesCalls().at(-1);
    expect(call).toBeDefined();
    const clipCues = (call![1] as { clipCues: Record<string, unknown> }).clipCues;
    expect(clipCues['video_in_0']).toMatchObject({ clipId: 'src-clip' });
  });

  it('CLIP_STOP clears the persisted cue', async () => {
    playerState = { state: 'paused', duration_ms: 12000, position_ms: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'stopped', position_ms: 0 };
    await send({ type: 'CLIP_STOP', mixerInput: 'video_in_0' });
    const lastClipCues = (clipCuesCalls().at(-1)![1] as { clipCues: Record<string, unknown> }).clipCues;
    expect(lastClipCues['video_in_0']).toBeUndefined();
  });
});

describe('completion poll fallback', () => {
  it('broadcasts CLIP_STATE completed one poll interval after Strom reports stopped', async () => {
    // The completion poll fires on a real setInterval and reads player state over
    // the wire (throwaway Strom); fake timers can't drive that real HTTP round
    // trip, so we let the poll run for real and wait it out. Latency is bounded
    // by one poll interval (config.clipStatePollMs).
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'playing', position_ms: 10, duration_ms: 8000 };
    await send({ type: 'CLIP_PLAY', mixerInput: 'video_in_0' });
    broadcasts.length = 0;

    // Strom now reports end-of-media.
    playerState = { state: 'stopped', position_ms: 8000, duration_ms: 8000 };

    // Wait until the poll observes `stopped` and broadcasts `completed` (or a
    // generous multiple of the poll interval elapses).
    const deadline = Date.now() + config.clipStatePollMs * 8 + 500;
    let completed: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      completed = clipStates().find((m) => m.state === 'completed');
      if (completed) break;
      await new Promise((r) => setTimeout(r, config.clipStatePollMs / 4 + 5));
    }

    expect(completed).toBeDefined();
    expect(completed).toMatchObject({ mixerInput: 'video_in_0', state: 'completed', durationMs: 8000 });
  });
});
