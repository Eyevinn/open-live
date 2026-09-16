/**
 * Tests the WS connect-time snapshot for CLIP_STATE (epic #206, issue #278,
 * spec docs/specs/clip-story-playback.md §3): a client attaching to
 * /ws/productions/:id/controller receives one CLIP_STATE per clip source
 * (mixerInput present in clipPlayerBlockIds), before SNAPSHOT_END, so a
 * reconnecting operator/automation client learns the current clip state without
 * a REST round-trip.
 *
 * Uses the REAL controller plugin against a listening Fastify server with a live
 * `ws` client — the connect handler lives in the plugin, not handleMessage, so
 * it can only be exercised over an actual socket. CouchDB is mocked; a throwaway
 * HTTP server stands in for Strom so the cold-registry restore path
 * (player.getState) is driven deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

const productionDocs = new Map<string, Record<string, unknown>>();
const sourceDocs = new Map<string, Record<string, unknown>>();

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = productionDocs.get(id);
      if (!doc) throw new Error('not_found');
      return doc;
    }),
    insert: vi.fn().mockResolvedValue({ ok: true }),
    find: vi.fn().mockResolvedValue({ docs: [] }),
  }),
  getSourcesDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = sourceDocs.get(id);
      if (!doc) throw new Error('not_found');
      return doc;
    }),
    insert: vi.fn(),
    find: vi.fn().mockResolvedValue({ docs: [] }),
  }),
  getOutputsDb: () => ({ get: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Throwaway Strom (drives the cold-registry player.getState restore path)
// ---------------------------------------------------------------------------
let playerState: Record<string, unknown> = { state: 'stopped' };
const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if ((req.url ?? '').endsWith('/player/state')) res.end(JSON.stringify(playerState));
    else res.end(JSON.stringify({ success: true }));
  });
});
await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
afterAll(() => stromServer.close());

const { buildServer } = await import('../server.js');
const { handleMessage, clearClipStateForProduction } = await import('../ws/controller.js');

const PROD = 'prod-clip-connect';
const FLOW = 'flow-clip-connect';
const BLOCK = 'b-clip-0-connect';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Clip Connect Test',
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

let app: FastifyInstance;

async function connectAndCollect(productionId: string, timeoutMs = 400): Promise<Array<Record<string, unknown>>> {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${productionId}/controller`);
  const messages: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    ws.on('error', reject);
    // Resolve on SNAPSHOT_END (all sync frames sent) or a hard timeout.
    ws.on('message', (data) => {
      try { if ((JSON.parse(data.toString()) as { type?: string }).type === 'SNAPSHOT_END') resolve(); } catch { /* ignore */ }
    });
    ws.on('open', () => setTimeout(resolve, timeoutMs));
  });
  ws.close();
  return messages;
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearClipStateForProduction(PROD);
  playerState = { state: 'stopped' };
  productionDocs.clear();
  sourceDocs.clear();
  productionDocs.set(PROD, makeProductionDoc());
  sourceDocs.set('src-clip', {
    _id: 'src-clip',
    type: 'source',
    name: 'Story A',
    address: JSON.stringify({ type: 'url', url: 'https://media.example.com/story-a.mp4' }),
    streamType: 'clip',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await app.close();
});

describe('WS connect snapshot — CLIP_STATE (spec §3)', () => {
  it('restores CLIP_STATE from Strom player.getState on a cold registry', async () => {
    playerState = { state: 'paused', position_ms: 5000, duration_ms: 12000 };

    const messages = await connectAndCollect(PROD);
    const clip = messages.find((m) => m.type === 'CLIP_STATE');
    const snapshotEnd = messages.find((m) => m.type === 'SNAPSHOT_END');

    expect(clip).toBeDefined();
    expect(clip).toMatchObject({
      type: 'CLIP_STATE',
      mixerInput: 'video_in_0',
      state: 'paused',
      positionMs: 5000,
      durationMs: 12000,
    });
    // CLIP_STATE must be part of the connect snapshot, before SNAPSHOT_END.
    expect(snapshotEnd).toBeDefined();
    expect(messages.indexOf(clip!)).toBeLessThan(messages.indexOf(snapshotEnd!));
  });

  it('reflects a stopped player as CLIP_STATE stopped', async () => {
    playerState = { state: 'stopped', position_ms: 0 };

    const messages = await connectAndCollect(PROD);
    const clip = messages.find((m) => m.type === 'CLIP_STATE');

    expect(clip).toBeDefined();
    expect(clip).toMatchObject({ mixerInput: 'video_in_0', state: 'stopped' });
  });

  it('prefers the in-memory registry (authoritative cued state) over Strom', async () => {
    // Drive the registry to `cued` via a real CLIP_CUE, which Strom's player
    // state (paused/stopped) cannot itself represent. The connect snapshot must
    // echo the tracked `cued`.
    const cueWs = { send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;
    playerState = { state: 'paused', duration_ms: 8000, position_ms: 0 };
    await handleMessage(PROD, cueWs, JSON.stringify({ type: 'CLIP_CUE', mixerInput: 'video_in_0' }), {});

    const messages = await connectAndCollect(PROD);
    const clip = messages.find((m) => m.type === 'CLIP_STATE');

    expect(clip).toBeDefined();
    expect(clip).toMatchObject({ mixerInput: 'video_in_0', state: 'cued' });
  });

  it('emits no CLIP_STATE for a production with no clip sources', async () => {
    productionDocs.set(PROD, makeProductionDoc({ clipPlayerBlockIds: undefined }));

    const messages = await connectAndCollect(PROD);
    expect(messages.find((m) => m.type === 'CLIP_STATE')).toBeUndefined();
    expect(messages.find((m) => m.type === 'SNAPSHOT_END')).toBeDefined();
  });
});
