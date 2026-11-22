/**
 * A mixer input with no pad in the live mixer must never reach Strom as another
 * input's pad (issue #633, review of PR #634).
 *
 * Since #633 a slot whose source doc was deleted gets no input block and no
 * `mixerInputMap` entry at activation, but it stays in `production.sources`, so
 * Studio can still address it. With the layout from the issue — live inputs
 * video_in_0..4, the orphan video_in_5, the guest return feed video_in_15 — the
 * compact map is {video_in_0..4: 0..4, video_in_15: 5}. Falling back to the
 * stored index would send `CUT video_in_5` to compact pad 5, i.e. put the guest
 * WHIP feed on program while the tally says Input 6.
 *
 * Same harness as ws-cut-to-on-air-input.test.ts: the real StromClient talks to
 * a throwaway HTTP server that records requests, CouchDB is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const mockGet = vi.fn();
const mockInsert = vi.fn().mockResolvedValue({ ok: true });

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
}));

vi.mock('../routes/productions.js', () => ({
  updateProductionDoc: vi.fn().mockResolvedValue(undefined),
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

interface StromRequest {
  method: string;
  path: string;
  body?: unknown;
}

const stromRequests: StromRequest[] = [];

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    stromRequests.push({
      method: req.method ?? '',
      path: req.url ?? '',
      ...(raw ? { body: JSON.parse(raw) as unknown } : {}),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  });
});

await new Promise<void>((resolve) => {
  stromServer.listen(0, '127.0.0.1', () => resolve());
});
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;

afterAll(() => {
  stromServer.close();
});

const { handleMessage, clearPipState } = await import('../ws/controller.js');
const { setTally, getTally } = await import('../services/tally.service.js');

const PROD = 'prod-unmapped-input-1';
const BLOCK = '/api/flows/flow-1/blocks/mixer-1';
const TRANSITION = `${BLOCK}/transition`;
const PREVIEW = `${BLOCK}/preview`;

// The issue's layout after activation: video_in_5 (orphan) was dropped, the
// guest return feed video_in_15 is compacted to pad 5.
const MAP = { video_in_0: 0, video_in_1: 1, video_in_2: 2, video_in_3: 3, video_in_4: 4, video_in_15: 5 };

function makeProductionDoc(mixerInputMap: Record<string, number> | null = MAP) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Unmapped Input Test',
    status: 'active',
    stromFlowId: 'flow-1',
    mixerBlockId: 'mixer-1',
    ...(mixerInputMap ? { mixerInputMap } : {}),
    sources: [
      { sourceId: 'cam0', mixerInput: 'video_in_0' },
      { sourceId: 'cam1', mixerInput: 'video_in_1' },
      { sourceId: 'cam2', mixerInput: 'video_in_2' },
      { sourceId: 'cam3', mixerInput: 'video_in_3' },
      { sourceId: 'cam4', mixerInput: 'video_in_4' },
      { sourceId: 'deleted-source', mixerInput: 'video_in_5' },
      { sourceId: 'whip-guest', mixerInput: 'video_in_15' },
    ],
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: 'video_in_0', pvw: 'video_in_1' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const ws = { send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;

function send(msg: Record<string, unknown>) {
  return handleMessage(PROD, ws, JSON.stringify(msg), {});
}

function sentToClient(): Array<Record<string, unknown>> {
  return (ws.send as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>);
}

function requestsTo(path: string) {
  return stromRequests.filter((r) => r.path === path);
}

/** Every pad index this test's Strom server was asked to put on PVW/PGM. */
function addressedPads(): number[] {
  const pads: number[] = [];
  for (const r of requestsTo(PREVIEW)) {
    const input = (r.body as { source?: { input?: number } }).source?.input;
    if (typeof input === 'number') pads.push(input);
  }
  for (const r of requestsTo(TRANSITION)) {
    pads.push((r.body as { to_input: number }).to_input);
  }
  return pads;
}

beforeEach(() => {
  clearPipState(PROD);
  setTally(PROD, { pgm: 'video_in_0', pvw: 'video_in_1' });
  broadcasts.length = 0;
  stromRequests.length = 0;
  mockGet.mockReset();
  mockInsert.mockClear();
  (ws.send as ReturnType<typeof vi.fn>).mockClear();
  mockGet.mockResolvedValue(makeProductionDoc());
});

describe('switching to a mixer input that is not in mixerInputMap (#633)', () => {
  for (const msg of [
    { type: 'CUT', mixerInput: 'video_in_5', cmdId: 'c-1' },
    { type: 'TRANSITION', mixerInput: 'video_in_5', transitionType: 'fade', durationMs: 500, cmdId: 'c-1' },
  ]) {
    it(`${msg.type} never sends another input's pad to Strom, and is refused`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await send(msg);
      warn.mockRestore();

      // Pad 5 is the guest WHIP feed; nothing at all is sent for the orphan.
      expect(addressedPads()).toEqual([]);
      // Nothing changed on air, so the tally is rolled back and the command NACKed.
      expect(getTally(PROD)).toEqual({ pgm: 'video_in_0', pvw: 'video_in_1' });
      expect(sentToClient().filter((m) => m.type === 'NACK').at(-1)).toMatchObject({ cmdId: 'c-1' });
    });
  }

  it('TAKE with the unmapped input on PVW sends nothing and is refused', async () => {
    setTally(PROD, { pgm: 'video_in_0', pvw: 'video_in_5' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await send({ type: 'TAKE', cmdId: 'c-2' });
    warn.mockRestore();

    expect(addressedPads()).toEqual([]);
    expect(getTally(PROD)).toEqual({ pgm: 'video_in_0', pvw: 'video_in_5' });
    expect(sentToClient().filter((m) => m.type === 'NACK').at(-1)).toMatchObject({ cmdId: 'c-2' });
  });

  it('reverse-PiP TAKE to the unmapped input on PVW sends nothing and is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE', cmdId: 't-1' }); // PiP 0 to PGM
    await send({ type: 'SET_PVW', mixerInput: 'video_in_5' });
    const before = getTally(PROD);
    stromRequests.length = 0;
    (ws.send as ReturnType<typeof vi.fn>).mockClear();

    await send({ type: 'TAKE', cmdId: 't-2' }); // PiP on PGM → the orphan input
    warn.mockRestore();

    expect(requestsTo(TRANSITION)).toHaveLength(0);
    expect(before).toEqual({ pgm: null, pvw: 'video_in_5' });
    expect(getTally(PROD)).toEqual(before);
    expect(sentToClient().filter((m) => m.type === 'NACK').at(-1)).toMatchObject({ cmdId: 't-2' });
    expect(sentToClient().filter((m) => m.type === 'ACK' && m.cmdId === 't-2' && m.phase === 'executed')).toHaveLength(0);
  });

  it('SET_PVW does not preview another input\'s pad', async () => {
    await send({ type: 'SET_PVW', mixerInput: 'video_in_5' });

    expect(requestsTo(PREVIEW)).toHaveLength(0);
  });

  it('a mapped input still goes to its compact pad', async () => {
    await send({ type: 'CUT', mixerInput: 'video_in_15' });

    expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ from_input: 0, to_input: 5 });
    expect(getTally(PROD)).toEqual({ pgm: 'video_in_15', pvw: 'video_in_0' });
  });

  it('SET_PIP drops an unmapped background and zone source instead of remapping them', async () => {
    await send({
      type: 'SET_PIP',
      pip: 0,
      bg: 5,
      zones: [{ rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, capacity: null, sources: [5, 15, 2] }],
    });

    const put = requestsTo(`${BLOCK}/pip/0`)[0];
    expect(put?.body).toMatchObject({ bg: null, zones: [{ sources: [5, 2] }] });
  });

  it('SET_EFFECT on an unmapped input is not sent to Strom', async () => {
    await send({ type: 'SET_EFFECT', target: { input: 5 }, effect: { type: 'blur', radius: 4 } });

    expect(requestsTo(`${BLOCK}/effect`)).toHaveLength(0);
    expect(sentToClient().at(-1)).toMatchObject({ type: 'ERROR' });
  });
});

describe('legacy production without mixerInputMap', () => {
  it('CUT still addresses the stored pad index', async () => {
    mockGet.mockResolvedValue(makeProductionDoc(null));

    await send({ type: 'CUT', mixerInput: 'video_in_5' });

    expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ from_input: 0, to_input: 5 });
  });

  it('SET_EFFECT still addresses the stored pad index', async () => {
    mockGet.mockResolvedValue(makeProductionDoc(null));

    await send({ type: 'SET_EFFECT', target: { input: 5 }, effect: { type: 'blur', radius: 4 } });

    expect(requestsTo(`${BLOCK}/effect`)[0]?.body).toMatchObject({ target: { input: 5 } });
  });
});
