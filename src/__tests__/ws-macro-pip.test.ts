/**
 * Harness and tests for PiP handling in macro-executed CUT, TRANSITION, and
 * TAKE actions.
 *
 * The real `StromClient` runs against a throwaway HTTP server that records
 * every request, so the assertions cover the URL, the verb, and the body the
 * server actually puts on the wire — not a hand-written stand-in that could
 * drift from the client without anything failing. CouchDB is mocked via
 * vi.mock('../db/index.js'), as elsewhere in this suite.
 *
 * PiP state is established through real inbound messages (SELECT_PVW_PIP,
 * TAKE) rather than by reaching into the module-level maps, so each case
 * exercises the same state machine the server runs in production.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Mock the CouchDB layer
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Capture broadcasts, keep the real tally state machine
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// A throwaway Strom the real StromClient can talk to
// ---------------------------------------------------------------------------

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

// Imported after STROM_URL is set so config picks up the throwaway server.
const { handleMessage, clearPipState } = await import('../ws/controller.js');
const { setTally } = await import('../services/tally.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROD = 'prod-pip-1';
const PREVIEW = '/api/flows/flow-1/blocks/mixer-1/preview';
const TRANSITION = '/api/flows/flow-1/blocks/mixer-1/transition';

/** A minimal active ProductionDoc carrying one macro. */
function makeProductionDoc(actions: Array<Record<string, unknown>>) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'PiP Test',
    status: 'active',
    stromFlowId: 'flow-1',
    mixerBlockId: 'mixer-1',
    sources: [
      { sourceId: 'cam1', mixerInput: 'video_in_0' },
      { sourceId: 'cam2', mixerInput: 'video_in_1' },
      { sourceId: 'cam3', mixerInput: 'video_in_2' },
    ],
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [{ id: 'macro-1', slot: 0, label: 'M', color: '#ffffff', actions }],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const ws = { send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;

/** Send one inbound message through the controller. */
function send(msg: Record<string, unknown>) {
  return handleMessage(PROD, ws, JSON.stringify(msg), {});
}

/** Every PIP_STATE broadcast seen so far, in order. */
function pipStates() {
  return broadcasts.filter((m) => m.type === 'PIP_STATE');
}

/** Every TALLY broadcast seen so far, in order. */
function tallies() {
  return broadcasts.filter((m) => m.type === 'TALLY');
}

/** Requests the controller made to Strom, in order. */
function requestsTo(path: string) {
  return stromRequests.filter((r) => r.path === path);
}

/** Forget everything recorded so far — used after arranging PiP state. */
function resetRecordings() {
  broadcasts.length = 0;
  stromRequests.length = 0;
}

beforeEach(() => {
  clearPipState(PROD);
  setTally(PROD, { pgm: 'video_in_0', pvw: 'video_in_1' });
  resetRecordings();
  mockGet.mockReset();
  mockInsert.mockClear();
});

// ---------------------------------------------------------------------------
// Macro CUT / TRANSITION over a PiP that is on program
// ---------------------------------------------------------------------------

describe('macro CUT with a PiP on program', () => {
  it('moves the PiP to preview, tells clients, and restores it in Strom', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam3' }]));

    // Put PiP 0 on program: select it into preview, then take.
    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE' });
    resetRecordings();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    // The PiP leaves program for preview, and every subscriber is told.
    expect(pipStates()).toHaveLength(1);
    expect(pipStates()[0]).toMatchObject({ pgmPip: null, pvwPip: 0 });

    // The PiP is put back on Strom's preview bus.
    expect(requestsTo(PREVIEW)).toContainEqual({
      method: 'PUT',
      path: PREVIEW,
      body: { source: { pip: 0 } },
    });

    // from_input is the tracked background (video_in_1), not a collapsed to_input.
    expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ from_input: 1, to_input: 2 });
  });
});

describe('macro TRANSITION with a PiP on program', () => {
  it('moves the PiP to preview and restores it in Strom', async () => {
    mockGet.mockResolvedValue(
      makeProductionDoc([
        { type: 'TRANSITION', sourceId: 'cam3', transitionType: 'mix', durationMs: 500 },
      ]),
    );

    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE' });
    resetRecordings();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(pipStates()).toHaveLength(1);
    expect(pipStates()[0]).toMatchObject({ pgmPip: null, pvwPip: 0 });
    expect(requestsTo(PREVIEW)).toContainEqual({
      method: 'PUT',
      path: PREVIEW,
      body: { source: { pip: 0 } },
    });
  });
});

// ---------------------------------------------------------------------------
// Macro TAKE promoting a PiP that is sitting in preview
// ---------------------------------------------------------------------------

describe('macro TAKE with a PiP in preview', () => {
  it('takes the PiP to program instead of reporting an empty bus', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));

    // PiP 1 into preview only — nothing on program yet.
    await send({ type: 'SELECT_PVW_PIP', pip: 1 });
    resetRecordings();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    // The regression: previously stromTransition early-returned on the null
    // target and Strom was never called at all.
    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(requestsTo(PREVIEW)).toContainEqual({
      method: 'PUT',
      path: PREVIEW,
      body: { source: { pip: 1 } },
    });

    // The server records the PiP as being on program.
    expect(pipStates()).toHaveLength(1);
    expect(pipStates()[0]).toMatchObject({ pgmPip: 1, pvwPip: null });
  });
});

// ---------------------------------------------------------------------------
// No PiP involved — the pre-existing path must be untouched
// ---------------------------------------------------------------------------

describe('macro CUT with no PiP anywhere', () => {
  it('behaves exactly as before: no PIP_STATE, no pip-addressed preview select', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam3' }]));

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(pipStates()).toHaveLength(0);

    // Only stromTransition's own preview select, addressed by input not pip.
    for (const req of requestsTo(PREVIEW)) {
      expect(req.body).toEqual({ source: { input: 2 } });
    }

    expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ from_input: 0, to_input: 2 });
    expect(tallies()[0]).toMatchObject({ pgm: 'video_in_2', pvw: 'video_in_0' });
  });
});
