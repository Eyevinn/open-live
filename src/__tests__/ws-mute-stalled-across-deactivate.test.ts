/**
 * Issue #402: a channel-mute write that is still waiting on Strom when the
 * production is deactivated can land *after* the next session's first-connect
 * reset. Strom then holds the channel off program, but — before the fix — later
 * connects were told it is live.
 *
 * How it happens:
 *   1. An operator mutes ch1; Strom is slow to answer the PATCH of
 *      `ch1_to_main: false`.
 *   2. The production is deactivated (clearAudioState) and reactivated. The
 *      first connect resets every channel to `chN_to_main: true` and starts a
 *      fresh mute registry.
 *   3. Strom applies the stalled mute after that reset.
 *
 * The regression was that the AUDIO_SET handler updated the mute-registry Set it
 * captured *before* awaiting Strom. By the time the write settled that Set had
 * been replaced by clearAudioState + the next first-connect reset, so the live
 * registry never recorded the mute and the next connect was told ch1 was live.
 *
 * The fix re-fetches `mutedElementsByProduction.get(productionId)` *after* the
 * write settles, so the mute lands in the current registry.
 *
 * Uses the REAL controller plugin against a listening Fastify server with live
 * `ws` clients. CouchDB is mocked; a throwaway HTTP server stands in for Strom
 * and *holds* the ch1 mute PATCH open until the test has run a deactivate +
 * reactivate, mirroring the stall described in the issue.
 */

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, type Server, type ServerResponse } from 'node:http';
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
// Throwaway Strom: serves the flow (one builtin.mixer block, 2 channels),
// accepts the first-connect init PATCH normally, but *holds* the ch1 mute PATCH
// (`ch1_to_main` present, no fader in the body) open until the test releases it.
// ---------------------------------------------------------------------------

const FLOW = 'flow-mute-stall';
const AUDIO_BLOCK = 'b-audio-mixer-0';

let heldMuteRes: ServerResponse | null = null;
let heldMuteProps: Record<string, unknown> | null = null;
let onMutePatchReceived: (() => void) | null = null;

function isMutePatch(props: Record<string, unknown>): boolean {
  // The mute PATCH routes a single channel (`ch1_to_main`) and carries no fader
  // values; the first-connect init PATCH always includes `ch1_fader`.
  return Object.prototype.hasOwnProperty.call(props, 'ch1_to_main')
    && !Object.prototype.hasOwnProperty.call(props, 'ch1_fader');
}

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    const url = req.url ?? '';
    if (req.method === 'GET' && url === `/api/flows/${FLOW}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        flow: {
          id: FLOW,
          blocks: [
            { id: AUDIO_BLOCK, block_definition_id: 'builtin.mixer', properties: { num_channels: 2 } },
          ],
        },
      }));
      return;
    }
    if (req.method === 'PATCH' && url === `/api/flows/${FLOW}/blocks/${AUDIO_BLOCK}/properties`) {
      const props = (body?.['properties'] as Record<string, unknown>) ?? {};
      if (isMutePatch(props)) {
        // Stall: hold the response open. The test releases it only after a
        // deactivate + reactivate has replaced the mute registry.
        heldMuteRes = res;
        heldMuteProps = props;
        onMutePatchReceived?.();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ block_id: AUDIO_BLOCK, properties: { ...props }, rejected: {} }));
      return;
    }
    if (req.method === 'GET' && url === `/api/flows/${FLOW}/blocks/${AUDIO_BLOCK}/properties`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        block_id: AUDIO_BLOCK,
        properties: { ch1_fader: 1.0, ch2_fader: 1.0, main_fader: 1.0 },
        rejected: {},
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  });
});

await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
afterAll(() => stromServer.close());

const { buildServer } = await import('../server.js');
const { clearAudioState } = await import('../ws/controller.js');

const PROD = 'prod-mute-stall';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Mute Stall Test',
    status: 'active',
    stromFlowId: FLOW,
    audioMixerBlockId: AUDIO_BLOCK,
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
  close: () => void;
}

async function openSocket(productionId: string): Promise<Live> {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${productionId}/controller`);
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
    close: () => ws.close(),
  };
}

const isSnapshotEnd = (m: Record<string, unknown>) => m['type'] === 'SNAPSHOT_END';
const ch1Mute = (m: Record<string, unknown>) =>
  m['type'] === 'AUDIO_STATE' && m['elementId'] === 'ch1' && m['property'] === 'mute';

afterEach(async () => {
  heldMuteRes = null;
  heldMuteProps = null;
  onMutePatchReceived = null;
  await app.close();
});

describe('WS mute stalled across deactivate + reactivate (#402)', () => {
  it('records a late-settling mute in the current registry, so the next connect is not told the channel is live', async () => {
    productionDocs.clear();
    sourceDocs.clear();
    productionDocs.set(PROD, makeProductionDoc());
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });

    // (1) First connect for the production — seeds an empty mute registry.
    const s1 = await openSocket(PROD);
    await s1.waitFor(isSnapshotEnd);

    // (2) Operator mutes ch1. The handler awaits the Strom PATCH, which the
    //     stand-in Strom holds open (the stall from the issue).
    const mutePatchReceived = new Promise<void>((resolve) => { onMutePatchReceived = resolve; });
    s1.ws.send(JSON.stringify({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true }));
    await mutePatchReceived;

    // (3) The production is deactivated while the mute write is still in flight...
    clearAudioState(PROD);

    // ...and reactivated: the next first connect resets every channel to
    //    `chN_to_main: true` and starts a fresh (empty) mute registry.
    const s2 = await openSocket(PROD);
    await s2.waitFor(isSnapshotEnd);

    // (4) Strom finally applies the stalled mute. Releasing the held PATCH lets
    //     the ch1 mute handler resume; it broadcasts AUDIO_STATE ch1 mute when
    //     done, which we use as the sync point.
    expect(heldMuteRes).not.toBeNull();
    heldMuteRes!.writeHead(200, { 'content-type': 'application/json' });
    heldMuteRes!.end(JSON.stringify({ block_id: AUDIO_BLOCK, properties: { ...heldMuteProps }, rejected: {} }));

    const settledBroadcast = await s1.waitFor((m) => ch1Mute(m) && m['value'] === true);
    expect(settledBroadcast).toMatchObject({ value: true });

    // (5) A subsequent connect must be told ch1 is muted — matching what Strom
    //     is actually holding off program. Before the fix the mute landed in a
    //     replaced Set, so the current registry stayed empty and this connect
    //     was told ch1 was live (value: false).
    const s3 = await openSocket(PROD);
    await s3.waitFor(isSnapshotEnd);
    const s3Ch1 = s3.messages.find(ch1Mute);
    expect(s3Ch1).toMatchObject({ value: true });

    s1.close();
    s2.close();
    s3.close();
  });
});
