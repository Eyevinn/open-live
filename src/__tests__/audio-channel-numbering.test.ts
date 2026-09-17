/**
 * The flow generator wires each source to an audio mixer channel (`input_N`).
 * The audio route and the WS controller address those channels by number, so
 * they must agree with it — test pattern sources included, since they carry a
 * silent audio branch and take a channel.
 *
 * Each case generates a real flow, serves it from a throwaway Strom, and reads
 * the expected channel for each source off the generated links. CouchDB is
 * mocked via vi.mock('../db/index.js'), as elsewhere in this suite.
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
  'cam-efp': { _id: 'cam-efp', name: 'Camera EFP', streamType: 'efp', address: 'srt://10.0.0.2:9000?mode=caller' },
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

vi.mock('../routes/productions.js', () => ({
  updateProductionDoc: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return { ...actual, broadcast: vi.fn() };
});

// ---------------------------------------------------------------------------
// A throwaway Strom: stores the created flow, serves it back, records PATCHes
// ---------------------------------------------------------------------------

const FLOW_ID = 'flow-audio-1';
let createdFlow: Record<string, unknown> | null = null;
const patches: Array<{ path: string; body: Record<string, unknown> }> = [];

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
      if (req.method === 'PATCH') patches.push({ path: req.url ?? '', body: body ?? {} });
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
const { handleMessage } = await import('../ws/controller.js');
const { setTally } = await import('../services/tally.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROD = 'prod-audio-numbering';

function makeProduction(sources: Array<{ sourceId: string; mixerInput: string }>) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Audio Numbering',
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

/**
 * Generates the flow for `sources` and returns the audio mixer block ID plus
 * the 1-based channel the generator wired each mixerInput to, read off the
 * `b-audio-offset-{pad}-*:out → {audioMixer}:input_{N}` links.
 */
async function generate(sources: Array<{ sourceId: string; mixerInput: string }>) {
  const production = makeProduction(sources);
  mockProductionGet.mockResolvedValue(production);
  const result = await activateStromFlow(production as never, new StromClient({ baseUrl: STROM_URL }));
  const audioMixerId = result.audioMixerBlockId!;
  const links = (createdFlow!['links'] as Array<{ from: string; to: string }>);
  const channelByMixerInput: Record<string, number> = {};
  for (const link of links) {
    const to = new RegExp(`^${audioMixerId}:input_(\\d+)$`).exec(link.to);
    const from = /^b-audio-offset-(\d+)-/.exec(link.from);
    if (to && from) channelByMixerInput[`video_in_${from[1]}`] = parseInt(to[1], 10);
  }
  return { audioMixerId, channelByMixerInput };
}

// Test patterns below real sources, so every real source's channel depends on them being counted.
const MIXED = [
  { sourceId: '__test1__', mixerInput: 'video_in_1' },
  { sourceId: 'cam-srt', mixerInput: 'video_in_2' },
  { sourceId: '__test2__', mixerInput: 'video_in_3' },
  { sourceId: 'cam-efp', mixerInput: 'video_in_4' },
];

beforeEach(() => {
  createdFlow = null;
  patches.length = 0;
  mockProductionGet.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audio channel numbering with test pattern sources', () => {
  it('generator gives every source, test patterns included, its own channel in mixerInput order', async () => {
    const { channelByMixerInput } = await generate(MIXED);
    expect(channelByMixerInput).toEqual({ video_in_1: 1, video_in_2: 2, video_in_3: 3, video_in_4: 4 });
  });

  it('GET /audio maps each channel to the source the generator wired to it', async () => {
    const { channelByMixerInput } = await generate(MIXED);

    const app = Fastify();
    await app.register(audioRoutes);
    const res = await app.inject({ method: 'GET', url: `/api/v1/productions/${PROD}/audio` });
    await app.close();

    expect(res.statusCode).toBe(200);
    const channels = res.json() as Array<{ id: string; label: string; mixerInput: string | null }>;
    const names: Record<string, string> = {
      video_in_1: 'Test - Pinwheel',
      video_in_2: 'Camera SRT',
      video_in_3: 'Test - Colors',
      video_in_4: 'Camera EFP',
    };
    for (const [mixerInput, ch] of Object.entries(channelByMixerInput)) {
      expect(channels.find((c) => c.id === `ch${ch}`)).toMatchObject({ mixerInput, label: names[mixerInput] });
    }
  });

  it('AFV_SET routes the channel the generator wired to that source', async () => {
    const { audioMixerId, channelByMixerInput } = await generate(MIXED);
    setTally(PROD, { pgm: 'video_in_4', pvw: 'video_in_2' });

    const ws = { send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;
    await handleMessage(PROD, ws, JSON.stringify({ type: 'AFV_SET', mixerInput: 'video_in_4', enabled: true }), { audioBlockId: audioMixerId });

    const ch = channelByMixerInput['video_in_4'];
    const routing = patches.filter((p) => p.path === `/api/flows/${FLOW_ID}/blocks/${audioMixerId}/properties`);
    expect(routing.map((p) => p.body['properties'])).toEqual([{ [`ch${ch}_to_main`]: true }]);
  });

  it('CUT with AFV enabled routes the channels the generator wired', async () => {
    const { audioMixerId, channelByMixerInput } = await generate(MIXED);
    setTally(PROD, { pgm: 'video_in_4', pvw: 'video_in_2' });

    const ws = { send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;
    const ctx = { audioBlockId: audioMixerId };
    await handleMessage(PROD, ws, JSON.stringify({ type: 'AFV_SET', mixerInput: 'video_in_2', enabled: true }), ctx);
    await handleMessage(PROD, ws, JSON.stringify({ type: 'AFV_SET', mixerInput: 'video_in_4', enabled: true }), ctx);
    patches.length = 0;

    await handleMessage(PROD, ws, JSON.stringify({ type: 'CUT', mixerInput: 'video_in_2' }), ctx);
    // applyAudioFollow is fired without awaiting; let its request land.
    await vi.waitFor(() => expect(patches.some((p) => p.path.endsWith(`/blocks/${audioMixerId}/properties`))).toBe(true));

    const routing = patches.filter((p) => p.path === `/api/flows/${FLOW_ID}/blocks/${audioMixerId}/properties`);
    expect(routing[0]!.body['properties']).toEqual({
      [`ch${channelByMixerInput['video_in_2']}_to_main`]: true,
      [`ch${channelByMixerInput['video_in_4']}_to_main`]: false,
    });
  });
});
