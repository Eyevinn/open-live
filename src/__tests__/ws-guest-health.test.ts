/**
 * Strom block health for guest seats reaches the controller WS as
 * `GUEST_HEALTH`: live `BlockHealthChanged` events through the meter relay, and
 * the flow's current `block_health` in the connect snapshot.
 *
 * Real server (controller WS), CouchDB mocked, and a throwaway HTTP + WebSocket
 * server as Strom, like ws-meters-after-reactivate.test.ts.
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

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

const PROD = 'prod-guesthealth';
const SUFFIX = 'guesthea';
const FLOW = 'flow-guest-health';
const AUDIO_BLOCK = 'b-audio-mixer-0';
// Guest 1 sits on the top input, Guest 2 below it; video_in_0 is a camera.
const GUEST1_BLOCK = `b-input-15-${SUFFIX}`;
const GUEST2_BLOCK = `b-input-14-${SUFFIX}`;
const CAMERA_BLOCK = `b-input-0-${SUFFIX}`;

// Normally an array of entries; a test sets a malformed value to check it is skipped.
let blockHealth: unknown = [];

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
        flow: {
          id: flowMatch[1],
          blocks: [{ id: AUDIO_BLOCK, block_definition_id: 'builtin.mixer', properties: { num_channels: 3 } }],
          ...(!Array.isArray(blockHealth) || blockHealth.length > 0 ? { block_health: blockHealth } : {}),
        },
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

function emitHealth(data: Record<string, unknown>): void {
  const frame = JSON.stringify({ type: 'BlockHealthChanged', data });
  for (const client of stromEvents.clients) client.send(frame);
}

const { buildServer } = await import('../server.js');
const { reinitConnectedControllers } = await import('../ws/controller.js');

function makeProductionDoc() {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Guest Health',
    status: 'active',
    stromFlowId: FLOW,
    audioMixerBlockId: AUDIO_BLOCK,
    sources: [
      { sourceId: 'cam-1', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_14', returnFeed: { synced: 'program-minus' } },
      { sourceId: 'Whip', mixerInput: 'video_in_15', returnFeed: { synced: 'program-minus' } },
    ],
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    pipeline: { stromConfig: null, status: 'running' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

let app: FastifyInstance;

interface Live {
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
const isHealth = (m: Record<string, unknown>) => m['type'] === 'GUEST_HEALTH';

/** Wait for the meter relay's Strom socket and the re-read it does on open
 *  (one GUEST_HEALTH per guest seat after SNAPSHOT_END). */
async function waitForRelay(s: Live): Promise<void> {
  await waitUntil(() => stromEvents.clients.size >= 1);
  await waitUntil(() => s.messages.slice(s.messages.findIndex(isSnapshotEnd) + 1).filter(isHealth).length >= 2);
}

async function startServer(): Promise<void> {
  productionDocs.clear();
  productionDocs.set(PROD, makeProductionDoc());
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
}

afterEach(async () => {
  blockHealth = [];
  await app.close();
});

describe('GUEST_HEALTH connect snapshot', () => {
  it('reports every guest seat from the flow block_health, before SNAPSHOT_END', async () => {
    const causes = [{ kind: 'whip_medium', slot: 0, medium: 'audio', fault: 'publisher_stopped' }];
    blockHealth = [
      { block_id: GUEST1_BLOCK, status: 'failed', detail: 'slot 0 has produced no audio for 6.0 s', causes },
      { block_id: CAMERA_BLOCK, status: 'failed', detail: 'camera stalled' },
    ];
    await startServer();

    const s = await openSocket();
    await s.waitFor(isSnapshotEnd);
    const endIndex = s.messages.findIndex(isSnapshotEnd);
    const health = s.messages.slice(0, endIndex).filter(isHealth);

    // Both guest seats, never the camera; Guest 2 is not listed by Strom, so ok.
    expect(health).toHaveLength(2);
    expect(health.find((m) => m['mixerInput'] === 'video_in_15')).toMatchObject({
      blockId: GUEST1_BLOCK,
      status: 'failed',
      detail: 'slot 0 has produced no audio for 6.0 s',
      causes,
    });
    const guest2 = health.find((m) => m['mixerInput'] === 'video_in_14');
    expect(guest2).toMatchObject({ blockId: GUEST2_BLOCK, status: 'ok' });
    expect(guest2).not.toHaveProperty('detail');
    expect(health.every((m) => typeof m['seq'] === 'number' && typeof m['ts'] === 'string')).toBe(true);

    await s.close();
  });

  it('reports guest seats ok when Strom sends no block_health', async () => {
    await startServer();
    const s = await openSocket();
    await s.waitFor(isSnapshotEnd);
    const health = s.messages.filter(isHealth);
    expect(health.map((m) => [m['mixerInput'], m['status']]).sort()).toEqual([['video_in_14', 'ok'], ['video_in_15', 'ok']]);
    await s.close();
  });

  for (const [label, value] of [['a null entry', [null]], ['an object, not an array', { foo: 1 }]] as const) {
    it(`still starts the meter relay when block_health is ${label}`, async () => {
      blockHealth = value;
      await startServer();
      const s = await openSocket();
      await s.waitFor(isSnapshotEnd);
      expect(s.messages.filter(isHealth).map((m) => [m['mixerInput'], m['status']]).sort())
        .toEqual([['video_in_14', 'ok'], ['video_in_15', 'ok']]);
      await waitUntil(() => stromEvents.clients.size >= 1);
      await s.close();
    });
  }
});

describe('GUEST_HEALTH live relay', () => {
  it('relays failed and ok edges for guest input blocks on the production flow only', async () => {
    await startServer();
    const s = await openSocket();
    await s.waitFor(isSnapshotEnd);
    await waitForRelay(s);
    s.messages.length = 0;

    // Not this production's guest seat, or not this flow: dropped.
    emitHealth({ flow_id: FLOW, block_id: CAMERA_BLOCK, status: 'failed', detail: 'camera stalled' });
    emitHealth({ flow_id: 'other-flow', block_id: GUEST1_BLOCK, status: 'failed', detail: 'x' });
    // Current #786 shape: no causes.
    emitHealth({ flow_id: FLOW, block_id: GUEST1_BLOCK, status: 'failed', detail: 'audio branch stopped' });

    const failed = await s.waitFor((m) => isHealth(m) && m['status'] === 'failed');
    expect(failed).toMatchObject({ type: 'GUEST_HEALTH', mixerInput: 'video_in_15', blockId: GUEST1_BLOCK, detail: 'audio branch stopped' });
    expect(failed).not.toHaveProperty('causes');

    emitHealth({ flow_id: FLOW, block_id: GUEST1_BLOCK, status: 'ok', detail: null });
    const ok = await s.waitFor((m) => isHealth(m) && m['status'] === 'ok');
    expect(ok).toMatchObject({ mixerInput: 'video_in_15', status: 'ok' });
    expect(ok).not.toHaveProperty('detail');

    expect(s.messages.filter(isHealth)).toHaveLength(2);
    await s.close();
  });

  it('drops a status other than ok or failed instead of clearing a failure', async () => {
    await startServer();
    const s = await openSocket();
    await s.waitFor(isSnapshotEnd);
    await waitForRelay(s);
    s.messages.length = 0;

    emitHealth({ flow_id: FLOW, block_id: GUEST1_BLOCK, status: 'failed', detail: 'x' });
    await s.waitFor((m) => isHealth(m) && m['status'] === 'failed');
    emitHealth({ flow_id: FLOW, block_id: GUEST1_BLOCK, status: 'degraded', detail: 'y' });
    // A later event on another seat marks that the degraded one has been handled.
    emitHealth({ flow_id: FLOW, block_id: GUEST2_BLOCK, status: 'failed', detail: 'z' });
    await s.waitFor((m) => isHealth(m) && m['mixerInput'] === 'video_in_14');

    expect(s.messages.filter(isHealth).map((m) => [m['mixerInput'], m['status']])).toEqual([['video_in_15', 'failed'], ['video_in_14', 'failed']]);
    await s.close();
  });

  it('passes structured causes through unchanged', async () => {
    await startServer();
    const s = await openSocket();
    await s.waitFor(isSnapshotEnd);
    await waitForRelay(s);
    s.messages.length = 0;

    const causes = [{ kind: 'whip_medium', slot: 0, medium: 'audio', fault: 'publisher_stopped' }];
    emitHealth({ flow_id: FLOW, block_id: GUEST2_BLOCK, status: 'failed', detail: 'no audio', causes });
    const failed = await s.waitFor(isHealth);
    expect(failed).toMatchObject({ mixerInput: 'video_in_14', status: 'failed', causes });
    await s.close();
  });
});

describe('GUEST_HEALTH across reactivation', () => {
  it('reinit replaces an old-flow failure and relays health from the new flow', async () => {
    blockHealth = [{ block_id: GUEST1_BLOCK, status: 'failed', detail: 'audio branch stopped' }];
    await startServer();
    const s = await openSocket();
    await s.waitFor(isSnapshotEnd);
    expect(s.messages.find((m) => isHealth(m) && m['mixerInput'] === 'video_in_15')).toMatchObject({ status: 'failed' });
    await waitForRelay(s);

    // Reactivation builds a new flow with no failures.
    blockHealth = [];
    productionDocs.set(PROD, { ...makeProductionDoc(), _rev: '3-x', stromFlowId: 'flow-guest-health-2' });
    s.messages.length = 0;
    await reinitConnectedControllers(PROD);
    await waitUntil(() => s.messages.filter(isHealth).length >= 2);
    expect(s.messages.filter(isHealth).map((m) => [m['mixerInput'], m['status']]).sort())
      .toEqual([['video_in_14', 'ok'], ['video_in_15', 'ok']]);

    s.messages.length = 0;
    emitHealth({ flow_id: FLOW, block_id: GUEST2_BLOCK, status: 'failed', detail: 'old flow' });
    emitHealth({ flow_id: 'flow-guest-health-2', block_id: GUEST2_BLOCK, status: 'failed', detail: 'new flow' });
    const failed = await s.waitFor(isHealth);
    expect(failed).toMatchObject({ mixerInput: 'video_in_14', status: 'failed', detail: 'new flow' });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.messages.filter(isHealth)).toHaveLength(1);
    await s.close();
  });
});
