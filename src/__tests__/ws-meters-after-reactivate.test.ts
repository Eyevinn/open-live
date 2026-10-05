/**
 * A controller that connects while a deactivate is still tearing down must not
 * leave the meter or clip relay bound to the old flow after reactivation.
 *
 * Deactivate force-stops the meter relay before its slow teardown steps (VOD
 * upload, Strom flow delete), but the doc keeps the old `stromFlowId` until the
 * final write. A connect in that window starts relays filtered to the old flow;
 * later connects must rebind it to the new flow rather than only ref-count in.
 *
 * Real server (controller WS + productions routes), CouchDB mocked, and a
 * throwaway HTTP + WebSocket server as Strom. The Strom flow delete is held
 * open to keep the deactivate in flight.
 */

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

const productionDocs = new Map<string, Record<string, unknown>>();

vi.mock('../db/index.js', () => {
  const empty = () => ({ get: vi.fn().mockRejectedValue(new Error('not_found')), insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) });
  return {
    getDb: () => ({
      get: vi.fn(async (id: string) => {
        const doc = productionDocs.get(id);
        if (!doc) throw new Error('not_found');
        return doc;
      }),
      insert: vi.fn(async (doc: Record<string, unknown>) => {
        productionDocs.set(doc['_id'] as string, doc);
        return { ok: true, rev: '2-x' };
      }),
      find: vi.fn().mockResolvedValue({ docs: [] }),
    }),
    getSourcesDb: empty,
    getOutputsDb: empty,
    getRecordingsDb: empty,
    getGuestInvitesDb: empty,
    getGuestSessionsDb: empty,
    connectDb: vi.fn().mockResolvedValue(undefined),
    isDbReady: vi.fn().mockResolvedValue(true),
    isDbConnected: vi.fn().mockReturnValue(true),
  };
});

let releaseFlowDelete: (() => void) | null = null;
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(() => new Promise<void>((resolve) => { releaseFlowDelete = resolve; })),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Throwaway Strom: serves any flow (one 2-channel builtin.mixer) and accepts
// property writes; /api/ws is the event socket the meter relay subscribes to.
// ---------------------------------------------------------------------------

const AUDIO_BLOCK = 'b-audio-mixer-0';
const CLIP_BLOCK = 'b-clip-player-0';
const CLIP_INPUT = 'video_in_0';
const FLOW_OLD = 'flow-old';
const FLOW_NEW = 'flow-new';

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    const url = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    const flowMatch = /^\/api\/flows\/([^/]+)$/.exec(url);
    if (req.method === 'GET' && flowMatch) {
      res.end(JSON.stringify({
        flow: { id: flowMatch[1], blocks: [{ id: AUDIO_BLOCK, block_definition_id: 'builtin.mixer', properties: { num_channels: 2 } }] },
      }));
      return;
    }
    if (url.endsWith('/properties')) {
      const props = (body?.['properties'] as Record<string, unknown>) ?? {};
      res.end(JSON.stringify({ block_id: AUDIO_BLOCK, properties: props, rejected: {} }));
      return;
    }
    res.end(JSON.stringify({ success: true }));
  });
});
const stromEvents = new WebSocketServer({ server: stromServer, path: '/api/ws' });

await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
afterAll(() => { stromEvents.close(); stromServer.close(); });

function emitClip(flowId: string): void {
  const frame = JSON.stringify({ type: 'MediaPlayerStateChanged', data: { flow_id: flowId, block_id: CLIP_BLOCK, state: 'playing' } });
  for (const client of stromEvents.clients) client.send(frame);
}

function emitMeter(flowId: string): void {
  const frame = JSON.stringify({ type: 'MeterData', data: { flow_id: flowId, element_id: `${AUDIO_BLOCK}:meter:1`, rms: -20, peak: -10 } });
  for (const client of stromEvents.clients) client.send(frame);
}

const { buildServer } = await import('../server.js');

const PROD = 'prod-meters-reactivate';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Meters After Reactivate',
    status: 'active',
    stromFlowId: FLOW_OLD,
    audioMixerBlockId: AUDIO_BLOCK,
    clipPlayerBlockIds: { [CLIP_INPUT]: CLIP_BLOCK },
    sources: [],
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    pipeline: { stromConfig: null, status: 'running' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let app: FastifyInstance;

interface Live {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
  waitFor: (pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function openSocket(): Promise<Live> {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${PROD}/controller`);
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = [];
  ws.on('message', (data) => {
    let m: Record<string, unknown>;
    try { m = JSON.parse(data.toString()); } catch { return; }
    messages.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(m)) {
        waiters[i]!.resolve(m);
        waiters.splice(i, 1);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  return {
    ws,
    messages,
    waitFor: (pred, timeoutMs = 2000) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const existing = messages.find(pred);
      if (existing) { resolve(existing); return; }
      const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs);
      waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    }),
    close: () => new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close(); }),
  };
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const isSnapshotEnd = (m: Record<string, unknown>) => m['type'] === 'SNAPSHOT_END';
const isMeter = (m: Record<string, unknown>) => m['type'] === 'METER_DATA';
const isClip = (m: Record<string, unknown>) => m['type'] === 'CLIP_STATE';

afterEach(async () => {
  releaseFlowDelete?.();
  releaseFlowDelete = null;
  await app.close();
});

describe('meter and clip relays across a deactivate with a connect mid-teardown', () => {
  it('a connect after reactivation gets METER_DATA and CLIP_STATE from the new flow', async () => {
    productionDocs.clear();
    productionDocs.set(PROD, makeProductionDoc());
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });

    // Operator connected while the old flow is live.
    const s1 = await openSocket();
    await s1.waitFor(isSnapshotEnd);

    // Deactivate; the Strom flow delete is held, so the deactivate stays in
    // flight after the relays were force-stopped.
    const deactivated = app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/deactivate` });
    await waitUntil(() => releaseFlowDelete !== null);
    await s1.close();

    // A controller connects mid-teardown. The doc still names the old flow.
    const s2 = await openSocket();
    await s2.waitFor(isSnapshotEnd);

    releaseFlowDelete!();
    expect((await deactivated).statusCode).toBe(200);
    expect(productionDocs.get(PROD)?.['stromFlowId']).toBeUndefined();

    // Reactivation builds a new flow (no reinit: s2 is the only socket and
    // stays open, as on the rig).
    productionDocs.set(PROD, makeProductionDoc({ _rev: '3-x', stromFlowId: FLOW_NEW }));

    const s3 = await openSocket();
    await s3.waitFor(isSnapshotEnd);
    // One Strom event socket each for the meter and clip relays.
    await waitUntil(() => stromEvents.clients.size >= 2);

    emitMeter(FLOW_NEW);
    const meter = await s3.waitFor(isMeter, 1000);
    expect(meter).toMatchObject({ elementId: 'ch1', peak: -10, rms: -20 });

    // Old-flow frames are still dropped.
    s3.messages.length = 0;
    emitMeter(FLOW_OLD);
    emitClip(FLOW_OLD);
    await new Promise((r) => setTimeout(r, 100));
    expect(s3.messages.filter(isMeter)).toHaveLength(0);
    expect(s3.messages.filter(isClip)).toHaveLength(0);

    emitClip(FLOW_NEW);
    const clip = await s3.waitFor(isClip, 1000);
    expect(clip).toMatchObject({ mixerInput: CLIP_INPUT, state: 'playing' });

    await s2.close();
    await s3.close();
  });
});
