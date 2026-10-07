/**
 * Endpoint-level regression test for issue #464 — guest-slot audio strip labels.
 *
 * The flow generator writes `ch{N}_label = "Guest N"` on the audio mixer block
 * for every WHIP guest slot (a source assignment carrying a `returnFeed` whose
 * source is a WHIP input). But the `GET /audio` route resolved each strip label
 * from `loadAudioChannels` FIRST, and a WHIP guest slot resolves only to the
 * generic virtual-source name "WHIP Input" (audio-channels.ts), so the `??`
 * short-circuited and the "Guest N" flow label was never consulted — every guest
 * strip read "WHIP Input".
 *
 * This test generates a real flow (so the mixer carries the real ch{N}_label
 * props), serves it from a throwaway Strom, and injects `GET /audio`, asserting
 * the guest slot's label is "Guest N" and non-guest sources keep their own names.
 * It FAILS on the pre-fix route (label === "WHIP Input") and passes after it.
 *
 * Mirrors audio-channel-numbering.test.ts's harness.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

// ---------------------------------------------------------------------------
// Mock the CouchDB layer
// ---------------------------------------------------------------------------

const SOURCES: Record<string, Record<string, unknown>> = {
  'cam-srt': { _id: 'cam-srt', name: 'Camera SRT', streamType: 'srt', address: 'srt://10.0.0.1:9000?mode=caller' },
};

const mockProductionGet = vi.fn();

vi.mock('../db/index.js', () => {
  const sourcesGet = (id: string) =>
    SOURCES[id] ? Promise.resolve({ ...SOURCES[id] }) : Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
  return {
    getDb: () => ({ get: mockProductionGet, insert: vi.fn().mockResolvedValue({ ok: true }) }),
    getSourcesDb: () => ({ get: sourcesGet }),
    getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
  };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return { ...actual, broadcast: vi.fn() };
});

// ---------------------------------------------------------------------------
// A throwaway Strom: stores the created flow, serves it back
// ---------------------------------------------------------------------------

const FLOW_ID = 'flow-guest-labels-1';
let createdFlow: Record<string, unknown> | null = null;

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'POST' && req.url === '/api/flows') {
      createdFlow = { ...body, id: FLOW_ID };
      res.end(JSON.stringify({ flow: createdFlow }));
    } else if (req.method === 'GET' && req.url === `/api/flows/${FLOW_ID}`) {
      res.end(JSON.stringify({ flow: createdFlow }));
    } else {
      res.end(JSON.stringify({ success: true }));
    }
  });
});

await new Promise<void>((resolve) => {
  stromServer.listen(0, '127.0.0.1', () => resolve());
});
const STROM_URL = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
process.env['STROM_URL'] = STROM_URL;

afterAll(() => {
  stromServer.close();
});

// Imported after STROM_URL is set so config picks up the throwaway server.
const { activateStromFlow } = await import('../lib/flow-generator.js');
const { StromClient } = await import('../lib/strom.js');
const { default: audioRoutes } = await import('../routes/audio.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROD = 'prod-guest-labels';

type Src = { sourceId: string; mixerInput: string; returnFeed?: { synced: 'program' | 'program-minus'; lowLatency?: boolean } };

function makeProduction(sources: Src[]) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Guest Labels',
    status: 'active',
    stromFlowId: FLOW_ID,
    sources,
    graphicAssignments: [],
    values: {},
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Generates a real flow for `sources` and serves it from the throwaway Strom. */
async function generate(sources: Src[]) {
  const production = makeProduction(sources);
  mockProductionGet.mockResolvedValue(production);
  await activateStromFlow(production as never, new StromClient({ baseUrl: STROM_URL }));
}

/** Calls GET /audio and returns the channel descriptors. */
async function getAudioChannels() {
  const app = Fastify();
  await app.register(audioRoutes);
  const res = await app.inject({ method: 'GET', url: `/api/v1/productions/${PROD}/audio` });
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.json() as Array<{ id: string; label: string; mixerInput: string | null }>;
}

beforeEach(() => {
  createdFlow = null;
  mockProductionGet.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /audio — guest-slot strip labels (#464)', () => {
  it('returns "Guest N" for a WHIP guest slot, never the generic "WHIP Input"', async () => {
    await generate([
      { sourceId: 'cam-srt', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_5', returnFeed: { synced: 'program-minus' } },
    ]);

    const channels = await getAudioChannels();
    const guest = channels.find((c) => c.mixerInput === 'video_in_5');
    expect(guest).toBeDefined();
    // The single guest slot is Guest 1 — the flow's ch{N}_label must win over the
    // virtual "WHIP Input" name the source resolves to.
    expect(guest!.label).toBe('Guest 1');
    expect(channels.map((c) => c.label)).not.toContain('WHIP Input');
  });

  it('numbers multiple guest slots by trailing pad index descending (controller convention)', async () => {
    await generate([
      { sourceId: 'cam-srt', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_4', returnFeed: { synced: 'program-minus' } },
      { sourceId: 'Whip', mixerInput: 'video_in_5', returnFeed: { synced: 'program-minus' } },
    ]);

    const channels = await getAudioChannels();
    // Highest stored trailing index is Guest 1, next is Guest 2.
    expect(channels.find((c) => c.mixerInput === 'video_in_5')!.label).toBe('Guest 1');
    expect(channels.find((c) => c.mixerInput === 'video_in_4')!.label).toBe('Guest 2');
    expect(channels.map((c) => c.label)).not.toContain('WHIP Input');
  });

  it('keeps a named non-guest source label unchanged', async () => {
    await generate([
      { sourceId: 'cam-srt', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_5', returnFeed: { synced: 'program-minus' } },
    ]);

    const channels = await getAudioChannels();
    expect(channels.find((c) => c.mixerInput === 'video_in_0')!.label).toBe('Camera SRT');
  });

  it('keeps "WHIP Input" for a plain WHIP input without a returnFeed (not a guest slot)', async () => {
    await generate([
      { sourceId: 'cam-srt', mixerInput: 'video_in_0' },
      // No returnFeed → an ordinary WHIP source, not a guest slot.
      { sourceId: 'Whip', mixerInput: 'video_in_1' },
    ]);

    const channels = await getAudioChannels();
    const whip = channels.find((c) => c.mixerInput === 'video_in_1');
    expect(whip!.label).toBe('WHIP Input');
    expect(channels.map((c) => c.label)).not.toContain('Guest 1');
  });
});
