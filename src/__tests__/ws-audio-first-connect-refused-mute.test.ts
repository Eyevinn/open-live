/**
 * Issue #396: on the first controller connection for a production, the reset
 * block in src/ws/controller.ts writes `chN_to_main: true` for every channel
 * and seeds an empty mute registry, assuming the write always takes. If Strom
 * refuses a channel's `chN_to_main` (e.g. a guard left over from an earlier
 * session where the channel was deliberately taken off program), the write
 * does not actually unmute it — but before the fix, the empty mute registry
 * meant the client was still told the channel was live.
 *
 * Uses the REAL controller plugin against a listening Fastify server with a
 * live `ws` client — the first-connect reset lives in the connect handler, not
 * handleMessage, so it can only be exercised over an actual socket. CouchDB is
 * mocked; a throwaway HTTP server stands in for Strom and refuses `ch1_to_main`
 * on the init PATCH, mirroring the scratch repro from the issue.
 */

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
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
// Throwaway Strom: serves the flow (one builtin.mixer block, 2 channels) and
// refuses ch1_to_main on the first-connect init PATCH, as if a guard from an
// earlier session is keeping channel 1 off program.
// ---------------------------------------------------------------------------

const FLOW = 'flow-audio-first-connect';
const AUDIO_BLOCK = 'b-audio-mixer-0';

const patches: Array<{ path: string; body: Record<string, unknown> }> = [];

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    const url = req.url ?? '';
    if (req.method === 'GET' && url === `/api/flows/${FLOW}`) {
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
      patches.push({ path: url, body: (body?.['properties'] as Record<string, unknown>) ?? {} });
      // Strom refuses ch1_to_main: it stays false despite the reset asking for true.
      // ch2_to_main is accepted normally.
      const requested = (body?.['properties'] as Record<string, unknown>) ?? {};
      const resultProps: Record<string, unknown> = { ...requested, ch1_to_main: false };
      res.end(JSON.stringify({
        block_id: AUDIO_BLOCK,
        properties: resultProps,
        rejected: { ch1_to_main: 'channel is held off program by an earlier session' },
      }));
      return;
    }
    if (req.method === 'GET' && url === `/api/flows/${FLOW}/blocks/${AUDIO_BLOCK}/properties`) {
      res.end(JSON.stringify({
        block_id: AUDIO_BLOCK,
        properties: { ch1_fader: 1.0, ch2_fader: 1.0, main_fader: 1.0 },
        rejected: {},
      }));
      return;
    }
    res.end(JSON.stringify({ success: true }));
  });
});

await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
afterAll(() => stromServer.close());

const { buildServer } = await import('../server.js');

const PROD = 'prod-audio-first-connect';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Audio First Connect Test',
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

async function connectAndCollect(productionId: string, timeoutMs = 400): Promise<Array<Record<string, unknown>>> {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${productionId}/controller`);
  const messages: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    ws.on('error', reject);
    ws.on('message', (data) => {
      try { if ((JSON.parse(data.toString()) as { type?: string }).type === 'SNAPSHOT_END') resolve(); } catch { /* ignore */ }
    });
    ws.on('open', () => setTimeout(resolve, timeoutMs));
  });
  ws.close();
  return messages;
}

afterEach(async () => {
  await app.close();
});

describe('WS first connect — mute registry reconciled against a refused chN_to_main (#396)', () => {
  it('reports a Strom-refused ch1_to_main as muted, not live', async () => {
    patches.length = 0;
    productionDocs.clear();
    sourceDocs.clear();
    productionDocs.set(PROD, makeProductionDoc());
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });

    const messages = await connectAndCollect(PROD);

    // The init PATCH did ask Strom to route ch1 to main...
    expect(patches.length).toBeGreaterThan(0);
    expect(patches[0]!.body['ch1_to_main']).toBe(true);

    // ...but Strom refused it, so the client-visible AUDIO_STATE for ch1 must
    // report it muted, not live.
    const ch1Mute = messages.find((m) => m.type === 'AUDIO_STATE' && m.elementId === 'ch1' && m.property === 'mute');
    const ch2Mute = messages.find((m) => m.type === 'AUDIO_STATE' && m.elementId === 'ch2' && m.property === 'mute');
    expect(ch1Mute).toMatchObject({ value: true });
    expect(ch2Mute).toMatchObject({ value: false });
  });
});
