/**
 * A watch-only controller holds a meter relay ref. When the relay is
 * force-stopped (deactivate, or an activation that fails) while the watcher
 * stays open, the watcher's ref goes with it. If nothing rebinds the watcher
 * onto a new relay, closing it must not release a ref on the relay an operator
 * started later, or the operator's meters stop.
 *
 * The relays are real here (CouchDB mocked, a throwaway HTTP + WebSocket server
 * as Strom).
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

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Throwaway Strom: serves any flow (one 2-channel builtin.mixer) and accepts
// property writes; /api/ws is the event socket the relays subscribe to.
// ---------------------------------------------------------------------------

const AUDIO_BLOCK = 'b-audio-mixer-0';
const CLIP_BLOCK = 'b-clip-player-0';
const CLIP_INPUT = 'video_in_0';
const FLOW_OLD = 'flow-old';
const FLOW_NEW = 'flow-new';
// GET /api/flows/:id fails this many more times (a transient Strom error).
let failFlowGets = 0;

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    const url = req.url ?? '';
    const flowMatch = /^\/api\/flows\/([^/]+)$/.exec(url);
    if (req.method === 'GET' && flowMatch && failFlowGets > 0) {
      failFlowGets--;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'transient' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
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

const { buildServer } = await import('../server.js');
const { reinitConnectedControllers } = await import('../ws/controller.js');
const { forceStopMeterRelay, getMeterRelayRefCount } = await import('../services/meter-relay.js');
const { forceStopClipRelay } = await import('../services/clip-relay.js');

const PROD = 'prod-stale-watcher-meter-hold';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Stale Watcher Meter Hold',
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

async function openSocket(mode?: 'watch'): Promise<{ ws: WebSocket; waitForSnapshotEnd: () => Promise<void>; close: () => Promise<void> }> {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${PROD}/controller${mode ? `?mode=${mode}` : ''}`);
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  return {
    ws,
    waitForSnapshotEnd: () => waitUntil(() => messages.some((m) => m['type'] === 'SNAPSHOT_END')),
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

afterEach(async () => {
  failFlowGets = 0;
  await app.close();
  forceStopMeterRelay(PROD);
  forceStopClipRelay(PROD);
});

describe('watch-only meter hold on a force-stopped relay', () => {
  async function start(): Promise<void> {
    productionDocs.clear();
    productionDocs.set(PROD, makeProductionDoc());
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
  }

  it('a watcher left on a force-stopped relay by a failed reinit does not stop a later operator\'s meters', async () => {
    await start();
    const watcher = await openSocket('watch');
    await watcher.waitForSnapshotEnd();
    await waitUntil(() => getMeterRelayRefCount(PROD) === 1);

    // Deactivate force-stops the relay; reactivation onto FLOW_NEW then runs
    // reinit, which fails to read the new flow, so the watcher is not rebound.
    forceStopMeterRelay(PROD, FLOW_OLD);
    productionDocs.set(PROD, makeProductionDoc({ _rev: '3-x', stromFlowId: FLOW_NEW }));
    failFlowGets = 1;
    await reinitConnectedControllers(PROD);
    expect(getMeterRelayRefCount(PROD)).toBe(0);

    const operator = await openSocket();
    await operator.waitForSnapshotEnd();
    await waitUntil(() => getMeterRelayRefCount(PROD) === 1);

    await watcher.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(getMeterRelayRefCount(PROD)).toBe(1);

    await operator.close();
    await waitUntil(() => getMeterRelayRefCount(PROD) === 0);
    await waitUntil(() => stromEvents.clients.size === 0);
  });

  it('a watcher open across a failed activation does not stop the meters of an operator who joins afterwards', async () => {
    await start();
    const watcher = await openSocket('watch');
    await watcher.waitForSnapshotEnd();
    await waitUntil(() => getMeterRelayRefCount(PROD) === 1);

    // A failed activation force-stops the relay on the flow it was building.
    forceStopMeterRelay(PROD, FLOW_OLD);
    productionDocs.set(PROD, makeProductionDoc({ _rev: '3-x', stromFlowId: FLOW_NEW }));

    const operator = await openSocket();
    await operator.waitForSnapshotEnd();
    await waitUntil(() => getMeterRelayRefCount(PROD) === 1);

    await watcher.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(getMeterRelayRefCount(PROD)).toBe(1);

    // Reinit after the watcher left counts only the operator.
    await reinitConnectedControllers(PROD);
    expect(getMeterRelayRefCount(PROD)).toBe(1);

    await operator.close();
    await waitUntil(() => getMeterRelayRefCount(PROD) === 0);
    await waitUntil(() => stromEvents.clients.size === 0);
  });
});
