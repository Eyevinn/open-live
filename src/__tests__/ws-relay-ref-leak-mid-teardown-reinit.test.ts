/**
 * Regression for issue #434: a controller that connects mid-teardown must not
 * have its meter/clip relay ref counted twice by reactivation reinit.
 *
 * Deactivate force-stops (and forgets) the relays while leaving each socket's
 * per-socket hold in place and recording the torn-down flow as retired. A
 * controller that connects in that window reads the doc while it still names
 * the OLD flow, so it re-creates the relay on F_old and its hold lands on
 * F_old. When the production reactivates onto F_new, `reinitConnectedControllers`
 * used to call `startMeterRelay`/`startClipRelay` again for that same socket
 * (its hold F_old !== F_new), taking a SECOND per-production ref and leaving the
 * relay's Strom event socket + reconnect loop open after the last controller
 * closed (refCount stuck at +1).
 *
 * The relays are real here (CouchDB mocked, a throwaway HTTP + WebSocket server
 * as Strom) so the lingering Strom event socket is observable directly.
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

const { buildServer } = await import('../server.js');
const { reinitConnectedControllers } = await import('../ws/controller.js');
const { forceStopMeterRelay, getMeterRelayRefCount } = await import('../services/meter-relay.js');
const { forceStopClipRelay, getClipRelayRefCount } = await import('../services/clip-relay.js');

const PROD = 'prod-relay-ref-leak-434';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Relay Ref Leak Mid-Teardown',
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

async function openSocket(): Promise<{ ws: WebSocket; waitForSnapshotEnd: () => Promise<void>; close: () => Promise<void> }> {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${PROD}/controller`);
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
  await app.close();
  forceStopMeterRelay(PROD);
  forceStopClipRelay(PROD);
});

describe('relay ref leak: controller connected mid-teardown and reactivation reinit', () => {
  it('reinit onto the new flow takes no extra ref; closing every controller frees both relays', async () => {
    productionDocs.clear();
    productionDocs.set(PROD, makeProductionDoc());
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });

    // Simulate the deactivate that force-stopped and forgot the relays and
    // recorded FLOW_OLD as retired — without the controller still connected.
    forceStopMeterRelay(PROD, FLOW_OLD);
    forceStopClipRelay(PROD, FLOW_OLD);

    // A controller connects mid-teardown: the doc still names FLOW_OLD, so the
    // connect re-creates both relays on FLOW_OLD and its holds land on FLOW_OLD.
    const s1 = await openSocket();
    await s1.waitForSnapshotEnd();
    await waitUntil(() => stromEvents.clients.size >= 2); // one each for meter + clip
    expect(getMeterRelayRefCount(PROD)).toBe(1);
    expect(getClipRelayRefCount(PROD)).toBe(1);

    // Reactivation builds FLOW_NEW. The stayed-open controller is never re-run
    // through the connect handler, so reinit restarts the relays onto FLOW_NEW.
    productionDocs.set(PROD, makeProductionDoc({ _rev: '3-x', stromFlowId: FLOW_NEW }));
    await reinitConnectedControllers(PROD);

    // One operator socket => exactly one ref each, rebound to the new flow — NOT
    // a second ref (the bug: the mid-teardown hold on FLOW_OLD !== FLOW_NEW).
    expect(getMeterRelayRefCount(PROD)).toBe(1);
    expect(getClipRelayRefCount(PROD)).toBe(1);

    // A second reinit pass on the same flow must not take another ref either.
    await reinitConnectedControllers(PROD);
    expect(getMeterRelayRefCount(PROD)).toBe(1);
    expect(getClipRelayRefCount(PROD)).toBe(1);

    // Closing every controller frees both relays and closes their Strom sockets.
    await s1.close();
    await waitUntil(() => getMeterRelayRefCount(PROD) === 0 && getClipRelayRefCount(PROD) === 0);
    expect(getMeterRelayRefCount(PROD)).toBe(0);
    expect(getClipRelayRefCount(PROD)).toBe(0);
    await waitUntil(() => stromEvents.clients.size === 0);
    expect(stromEvents.clients.size).toBe(0);
  });
});
