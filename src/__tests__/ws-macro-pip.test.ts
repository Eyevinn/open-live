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

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
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

// When > 0, the fake Strom delays its reply to /transition by this many ms,
// widening the round-trip window so a concurrent inbound message (e.g. SET_PVW)
// can be interleaved deterministically. Mirrors the 150 ms delay used to
// reproduce issue #341.
let transitionDelayMs = 0;

// When >= 400, the fake Strom fails /transition with this status, reproducing
// Strom rejecting the actual cut/transition (issue #355). Other endpoints
// (e.g. /preview) keep answering 200.
let transitionStatus = 200;

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
    const isTransition = (req.url ?? '').endsWith('/transition');
    const respond = () => {
      if (isTransition && transitionStatus >= 400) {
        res.writeHead(transitionStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'transition rejected' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      // The /dsk endpoint returns the resolved key state; the controller reads
      // `dsk`/`enabled` off it. Echo the request so callers see what they asked.
      if ((req.url ?? '').endsWith('/dsk') && raw) {
        const body = JSON.parse(raw) as { dsk: number; enabled: boolean };
        res.end(JSON.stringify({ dsk: body.dsk, enabled: body.enabled, message: 'ok' }));
      } else {
        res.end(JSON.stringify({ success: true }));
      }
    };
    if (transitionDelayMs > 0 && isTransition) {
      setTimeout(respond, transitionDelayMs);
    } else {
      respond();
    }
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

/** Every DSK_STATE broadcast seen so far, in order. */
function dskStates() {
  return broadcasts.filter((m) => m.type === 'DSK_STATE');
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
  transitionDelayMs = 0;
  transitionStatus = 200;
  mockGet.mockReset();
  mockInsert.mockReset();
  mockInsert.mockResolvedValue({ ok: true });
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The PGM background must be recorded even when Strom is unconfigured
// ---------------------------------------------------------------------------

describe('pgmBg with no Strom flow configured', () => {
  it('records the background behind the PiP so later tallies still carry it', async () => {
    mockGet.mockResolvedValue({
      ...makeProductionDoc([{ type: 'CUT', sourceId: 'cam3' }]),
      stromFlowId: undefined,
      mixerBlockId: undefined,
    });

    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE' });
    resetRecordings();

    // `pgmBgByProduction` is what a connecting client is served from. The
    // connect sync lives in the plugin rather than handleMessage, so observe
    // the map through a later TALLY, which reads it instead of recomputing it.
    // SET_PVW leaves the PiP on program, so the background is still current.
    await send({ type: 'SET_PVW', mixerInput: 'video_in_2' });

    expect(tallies()[0]).toMatchObject({ pgmBg: 'video_in_1' });
  });
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
    expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ from_input: 1, to_input: 2 });
  });
});

// ---------------------------------------------------------------------------
// issue #355 — a displaced PiP must not be announced or restored when the Strom
// transition or the DB write fails, or clients and Strom end up disagreeing.
// ---------------------------------------------------------------------------

function serverError(): Error & { statusCode: number } {
  const err = new Error('Internal Server Error') as Error & { statusCode: number };
  err.statusCode = 500;
  return err;
}

/** Put PiP 0 on program from the beforeEach state, then forget the recordings. */
async function arrangePgmPip() {
  await send({ type: 'SELECT_PVW_PIP', pip: 0 });
  await send({ type: 'TAKE' });
  resetRecordings();
}

/** True if any PREVIEW request restored PiP 0 into Strom's preview bus. */
function restoredPip0() {
  return requestsTo(PREVIEW).some((r) => JSON.stringify(r.body) === JSON.stringify({ source: { pip: 0 } }));
}

describe('PiP on program when the Strom transition is rejected (issue #355)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('interactive CUT: does not announce the move or restore the PiP on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    await arrangePgmPip();
    transitionStatus = 500;

    await send({ type: 'CUT', mixerInput: 'video_in_2' });

    // The transition was attempted, but Strom rejected it...
    expect(requestsTo(TRANSITION)).toHaveLength(1);
    // ...so clients are NOT told the PiP left program...
    expect(pipStates()).toHaveLength(0);
    // ...and the PiP is NOT put back on Strom's preview (it is still on air).
    expect(restoredPip0()).toBe(false);
  });

  it('interactive TRANSITION: does not announce the move or restore the PiP on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    await arrangePgmPip();
    transitionStatus = 500;

    await send({ type: 'TRANSITION', mixerInput: 'video_in_2', transitionType: 'fade', durationMs: 500 });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(pipStates()).toHaveLength(0);
    expect(restoredPip0()).toBe(false);
  });

  it('macro CUT: does not announce the move or restore the PiP on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam3' }]));
    await arrangePgmPip();
    transitionStatus = 500;

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(pipStates()).toHaveLength(0);
    expect(restoredPip0()).toBe(false);
  });

  it('macro TRANSITION: does not announce the move or restore the PiP on a /transition 500', async () => {
    mockGet.mockResolvedValue(
      makeProductionDoc([{ type: 'TRANSITION', sourceId: 'cam3', transitionType: 'mix', durationMs: 500 }]),
    );
    await arrangePgmPip();
    transitionStatus = 500;

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(pipStates()).toHaveLength(0);
    expect(restoredPip0()).toBe(false);
  });

  it('interactive TAKE: does not announce the move or restore the PiP on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    await arrangePgmPip();
    transitionStatus = 500;

    await send({ type: 'TAKE' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(pipStates()).toHaveLength(0);
    expect(restoredPip0()).toBe(false);
  });

  it('macro TAKE: does not announce the move or restore the PiP on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));
    await arrangePgmPip();
    transitionStatus = 500;

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(pipStates()).toHaveLength(0);
    expect(restoredPip0()).toBe(false);
  });
});

describe('PiP on program when the DB write fails (issue #355)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('interactive CUT: leaves no PIP_STATE broadcast without a matching TALLY on a non-conflict DB throw', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    await arrangePgmPip();
    // The persist for the CUT below fails with a non-conflict error, which
    // propagates out of handleMessage (matches ws-persist-error-propagation).
    mockInsert.mockRejectedValue(serverError());

    await expect(send({ type: 'CUT', mixerInput: 'video_in_2' })).rejects.toThrow('Internal Server Error');

    // The displacement broadcast now follows the persist, so a failed write
    // leaves neither a TALLY nor a dangling PIP_STATE behind.
    expect(tallies()).toHaveLength(0);
    expect(pipStates()).toHaveLength(0);
    // Every PIP_STATE that IS broadcast must be backed by a TALLY.
    if (pipStates().length > 0) expect(tallies().length).toBeGreaterThan(0);
  });

  it('macro CUT: leaves no PIP_STATE broadcast without a matching TALLY on a non-conflict DB throw', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam3' }]));
    await arrangePgmPip();
    mockInsert.mockRejectedValue(serverError());

    // The macro loop catches the failed action and reports MACRO_ERROR rather
    // than rejecting, but the persist still throws before any TALLY/PIP_STATE.
    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(tallies()).toHaveLength(0);
    expect(pipStates()).toHaveLength(0);
  });

  it('interactive TAKE: leaves no PIP_STATE broadcast without a matching TALLY on a non-conflict DB throw', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    await arrangePgmPip();
    // The persist for the TAKE below fails with a non-conflict error, which
    // propagates out of handleMessage (matches ws-persist-error-propagation).
    mockInsert.mockRejectedValue(serverError());

    await expect(send({ type: 'TAKE' })).rejects.toThrow('Internal Server Error');

    // The persist runs before the TALLY and the deferred PIP_STATE, so a failed
    // write leaves neither a TALLY nor a dangling PIP_STATE behind.
    expect(tallies()).toHaveLength(0);
    expect(pipStates()).toHaveLength(0);
    if (pipStates().length > 0) expect(tallies().length).toBeGreaterThan(0);
  });

  it('macro TAKE: leaves no PIP_STATE broadcast without a matching TALLY on a non-conflict DB throw', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));
    await arrangePgmPip();
    mockInsert.mockRejectedValue(serverError());

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(tallies()).toHaveLength(0);
    expect(pipStates()).toHaveLength(0);
  });
});

describe('macro TAKE with a PiP on program', () => {
  it('moves the PiP to preview and restores it in Strom after the take', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));

    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE' });
    resetRecordings();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(pipStates()).toHaveLength(1);
    expect(pipStates()[0]).toMatchObject({ pgmPip: null, pvwPip: 0 });
    expect(tallies()[0]).toMatchObject({ pgm: 'video_in_0', pvw: null });
    expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ from_input: 1, to_input: 0 });
    // The restore follows the transition, so it is the last preview select.
    expect(requestsTo(PREVIEW).at(-1)?.body).toEqual({ source: { pip: 0 } });
  });
});

describe('macro TAKE with a PiP on program and another in preview', () => {
  it('swaps the two PiPs, as the interactive TAKE does', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));

    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE' });
    await send({ type: 'SELECT_PVW_PIP', pip: 1 });
    resetRecordings();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(pipStates()).toHaveLength(1);
    expect(pipStates()[0]).toMatchObject({ pgmPip: 1, pvwPip: 0 });
    // PiP 0 is on air until the transition lands, so it is never selected
    // into Strom's preview ahead of it.
    for (const req of requestsTo(PREVIEW)) {
      expect(req.body).not.toEqual({ source: { pip: 0 } });
    }
  });
});

// ---------------------------------------------------------------------------
// Macro TAKE promoting a PiP that is waiting in preview
// ---------------------------------------------------------------------------

describe('macro TAKE with a PiP in preview', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('takes the PiP to program instead of reporting an empty bus', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));

    // PiP 1 into preview over video_in_1; video_in_0 stays on program.
    await send({ type: 'SELECT_PVW_PIP', pip: 1 });
    resetRecordings();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    // The PiP is selected into Strom's preview, then taken over the source
    // that was in preview before it.
    expect(requestsTo(PREVIEW)).toEqual([
      { method: 'PUT', path: PREVIEW, body: { source: { pip: 1 } } },
    ]);
    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ from_input: 0, to_input: 1, transition_type: 'cut' });

    // Clients see the PiP on program over its background, not an empty bus.
    expect(tallies()).toHaveLength(1);
    expect(tallies()[0]).toMatchObject({ pgm: null, pvw: 'video_in_0', pgmBg: 'video_in_1' });
    expect(pipStates()).toHaveLength(1);
    expect(pipStates()[0]).toMatchObject({ pgmPip: 1, pvwPip: null });
  });

  it('sends the same TALLY and PIP_STATE as an interactive TAKE from the same state', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));

    const broadcastsAfter = async (msg: Record<string, unknown>) => {
      clearPipState(PROD);
      setTally(PROD, { pgm: 'video_in_0', pvw: 'video_in_1' });
      await send({ type: 'SELECT_PVW_PIP', pip: 1 });
      resetRecordings();
      await send(msg);
      return [...broadcasts];
    };

    const fromMacro = await broadcastsAfter({ type: 'MACRO_EXEC', macroId: 'macro-1' });
    const fromTake = await broadcastsAfter({ type: 'TAKE' });

    const mixerEvents = (events: Array<Record<string, unknown>>) =>
      events.filter((m) => m.type === 'TALLY' || m.type === 'PIP_STATE');
    expect(mixerEvents(fromMacro)).toEqual(mixerEvents(fromTake));
  });

  it('promotes a PiP that an earlier CUT in the same macro displaced', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam3' }, { type: 'TAKE' }]));
    await arrangePgmPip();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    // CUT moves PiP 0 to preview; TAKE puts it back on program.
    expect(requestsTo(TRANSITION)).toHaveLength(2);
    expect(pipStates().at(-1)).toMatchObject({ pgmPip: 0, pvwPip: null });
    expect(tallies().at(-1)).toMatchObject({ pgm: null, pvw: 'video_in_2' });
  });

  it('does not announce the PiP on program when Strom rejects the transition', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));
    await send({ type: 'SELECT_PVW_PIP', pip: 1 });
    resetRecordings();
    transitionStatus = 500;

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(pipStates()).toHaveLength(0);
  });

  it('leaves no TALLY or PIP_STATE behind on a non-conflict DB throw', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));
    await send({ type: 'SELECT_PVW_PIP', pip: 1 });
    resetRecordings();
    mockInsert.mockRejectedValue(serverError());

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(tallies()).toHaveLength(0);
    expect(pipStates()).toHaveLength(0);
    expect(requestsTo(TRANSITION)).toHaveLength(0);
  });

  it('does not clobber a PiP the operator put in PVW during the transition', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));
    await send({ type: 'SELECT_PVW_PIP', pip: 1 });
    resetRecordings();

    transitionDelayMs = 150;
    const macro = send({ type: 'MACRO_EXEC', macroId: 'macro-1' });
    await delay(30);
    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await macro;

    // The operator's PIP_STATE is the last word; the macro's stale
    // { pvwPip: null } is not broadcast after it.
    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(pipStates().at(-1)).toMatchObject({ pvwPip: 0 });
    expect(pipStates()).not.toContainEqual(expect.objectContaining({ pvwPip: null }));
  });
});

// A PiP selected into PVW while a take is still writing to CouchDB must not
// change what that take sends to Strom, nor lose its own pre-PiP source.
describe('TAKE of a PVW PiP vs. SELECT_PVW_PIP during the DB write', () => {
  const takes: Array<[string, Record<string, unknown>, Array<Record<string, unknown>>]> = [
    ['macro', { type: 'MACRO_EXEC', macroId: 'macro-1' }, [{ type: 'TAKE' }]],
    ['interactive', { type: 'TAKE' }, []],
  ];

  for (const [name, msg, actions] of takes) {
    it(`${name} TAKE cuts to the source that was under the PiP`, async () => {
      mockGet.mockResolvedValue(makeProductionDoc(actions));
      // PiP 1 over video_in_1; video_in_0 on program.
      await send({ type: 'SELECT_PVW_PIP', pip: 1 });
      resetRecordings();
      mockInsert.mockImplementation(() => delay(60).then(() => ({ ok: true })));

      const take = send(msg);
      await delay(20);
      // Next PiP into PVW, over video_in_0, while the take is persisting.
      await send({ type: 'SELECT_PVW_PIP', pip: 0 });
      await take;

      expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ from_input: 0, to_input: 1 });
      const takeTally = tallies().find((t) => t.pvw === 'video_in_0');
      expect(takeTally).toMatchObject({ pgm: null, pgmBg: 'video_in_1' });

      // The next take of PiP 0 composites it over video_in_0, the source it
      // was selected over.
      mockInsert.mockResolvedValue({ ok: true });
      resetRecordings();
      await send({ type: 'TAKE' });
      expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ to_input: 0 });
      expect(tallies()[0]).toMatchObject({ pgmBg: 'video_in_0' });
    });
  }
});

describe('macro TAKE with a PiP on program and nothing in preview', () => {
  it('leaves the program PiP in place', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));

    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE' });
    // Empty PVW behind the PGM PiP.
    setTally(PROD, { pgm: null, pvw: null });
    resetRecordings();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(pipStates()).toHaveLength(0);
    expect(requestsTo(TRANSITION)).toHaveLength(0);
    for (const req of requestsTo(PREVIEW)) {
      expect(req.body).not.toEqual({ source: { pip: 0 } });
    }
  });
});

describe('macro TALLY over a PiP on program', () => {
  /** Put PiP 0 on program from a fresh state, send `msg`, return its first TALLY. */
  const tallyFromPgmPip = async (msg: Record<string, unknown>) => {
    clearPipState(PROD);
    setTally(PROD, { pgm: 'video_in_0', pvw: 'video_in_1' });
    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE' });
    resetRecordings();
    await send(msg);
    return tallies()[0];
  };

  it('CUT matches the TALLY an interactive CUT sends from the same state', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam3' }]));

    const fromMacro = await tallyFromPgmPip({ type: 'MACRO_EXEC', macroId: 'macro-1' });
    const fromCut = await tallyFromPgmPip({ type: 'CUT', mixerInput: 'video_in_2' });

    expect(fromMacro).toHaveProperty('program');
    expect(fromMacro).toEqual(fromCut);
  });

  it('TRANSITION matches the TALLY an interactive TRANSITION sends from the same state', async () => {
    mockGet.mockResolvedValue(
      makeProductionDoc([{ type: 'TRANSITION', sourceId: 'cam3', transitionType: 'fade', durationMs: 500 }]),
    );

    const fromMacro = await tallyFromPgmPip({ type: 'MACRO_EXEC', macroId: 'macro-1' });
    const fromTransition = await tallyFromPgmPip({
      type: 'TRANSITION', mixerInput: 'video_in_2', transitionType: 'fade', durationMs: 500,
    });

    expect(fromMacro).toHaveProperty('program');
    expect(fromMacro).toEqual(fromTransition);
  });

  it('TAKE carries the new program', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));

    const fromMacro = await tallyFromPgmPip({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(fromMacro).toMatchObject({ pgm: 'video_in_0', program: ['video_in_0'], pgmBg: null });
  });

  // Regression for #356: the interactive TAKE that moves a PiP from PGM to PVW
  // used to build the TALLY before updating the PiP maps, so it broadcast a
  // stale pgmBg (the old background) and an empty preview. It must now report
  // pgmBg: null and the background that is now under the PiP in preview.
  it('interactive TAKE moving a PiP off program reports pgmBg: null and the background in preview', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));

    const fromTake = await tallyFromPgmPip({ type: 'TAKE' });

    expect(fromTake).toMatchObject({
      pgm: 'video_in_0',
      pvw: null,
      pgmBg: null,
      program: ['video_in_0'],
      preview: ['video_in_1'],
    });
  });

  // The interactive TAKE's TALLY must match the macro TAKE's from the same
  // state (the parity the issue calls for).
  it('interactive TAKE matches the TALLY a macro TAKE sends from the same state', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));

    const fromMacro = await tallyFromPgmPip({ type: 'MACRO_EXEC', macroId: 'macro-1' });
    const fromTake = await tallyFromPgmPip({ type: 'TAKE' });

    expect(fromTake).toHaveProperty('program');
    expect(fromTake).toEqual(fromMacro);
  });
});

describe('macro TRANSITION with a PiP in preview only', () => {
  it('clears the preview PiP', async () => {
    mockGet.mockResolvedValue(
      makeProductionDoc([{ type: 'TRANSITION', sourceId: 'cam3', transitionType: 'fade', durationMs: 500 }]),
    );

    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    resetRecordings();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(pipStates()).toHaveLength(1);
    expect(pipStates()[0]).toMatchObject({ pgmPip: null, pvwPip: null });
  });
});

describe('macro PiP restore vs. concurrent SET_PVW', () => {
  const actions: Array<[string, Record<string, unknown>]> = [
    ['CUT', { type: 'CUT', sourceId: 'cam3' }],
    ['TRANSITION', { type: 'TRANSITION', sourceId: 'cam3', transitionType: 'fade', durationMs: 500 }],
    ['TAKE', { type: 'TAKE' }],
  ];

  for (const [name, action] of actions) {
    it(`${name} does not restore the PiP if the operator changed PVW mid-transition`, async () => {
      mockGet.mockResolvedValue(makeProductionDoc([action]));

      await send({ type: 'SELECT_PVW_PIP', pip: 0 });
      await send({ type: 'TAKE' });
      resetRecordings();

      transitionDelayMs = 150;
      const macro = send({ type: 'MACRO_EXEC', macroId: 'macro-1' });
      await delay(30);
      await send({ type: 'SET_PVW', mixerInput: 'video_in_1' });
      await macro;

      expect(requestsTo(PREVIEW).at(-1)?.body).toEqual({ source: { input: 1 } });
      expect(requestsTo(PREVIEW)).not.toContainEqual(
        expect.objectContaining({ body: { source: { pip: 0 } } }),
      );
    });
  }
});

describe('macro CUT with a PiP in preview only', () => {
  it('clears the preview PiP', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam3' }]));

    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    resetRecordings();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(pipStates()).toHaveLength(1);
    expect(pipStates()[0]).toMatchObject({ pgmPip: null, pvwPip: null });
    for (const req of requestsTo(PREVIEW)) {
      expect(req.body).not.toEqual({ source: { pip: 0 } });
    }
  });
});

// ---------------------------------------------------------------------------
// Macro DSK_TOGGLE must update DSK state and broadcast DSK_STATE (issue #357)
//
// A macro DSK_TOGGLE used to call Strom's toggleDsk without recording the keyed
// layer or telling clients, so every later TALLY omitted the keyed DSK. It must
// now behave like the interactive DSK_TOGGLE: record dskLayersByProduction and
// broadcast DSK_STATE, so the CUT that follows in the same macro carries dsk:0.
// ---------------------------------------------------------------------------

const DSK = '/api/flows/flow-1/blocks/mixer-1/dsk';

describe('macro DSK_TOGGLE (issue #357)', () => {
  it('keys the DSK, broadcasts DSK_STATE, and the following CUT TALLY carries dsk:0', async () => {
    mockGet.mockResolvedValue(
      makeProductionDoc([
        { type: 'DSK_TOGGLE', layer: 0, visible: true },
        { type: 'CUT', sourceId: 'cam3' },
      ]),
    );

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    // Strom was asked to enable DSK 1 (1-based), matching the interactive path.
    expect(requestsTo(DSK)).toContainEqual({
      method: 'POST',
      path: DSK,
      body: { dsk: 1, enabled: true },
    });

    // Clients are told the key changed, addressed by 0-based layer.
    expect(dskStates()).toHaveLength(1);
    expect(dskStates()[0]).toMatchObject({ layer: 0, visible: true });

    // The CUT that follows builds its TALLY off the now-keyed DSK layer, so the
    // keyed DSK appears in both program and contributions.
    const tally = tallies()[0];
    expect(tally).toMatchObject({ pgm: 'video_in_2' });
    expect(tally?.program).toContain('dsk:0');
    expect(tally?.contributions).toContainEqual({ source: 'dsk:0', role: 'dsk' });
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

// ---------------------------------------------------------------------------
// Race: a PVW change during the Strom round trip must not be clobbered by the
// PiP restore that a displacing CUT queues after the transition (issue #341).
// ---------------------------------------------------------------------------

describe('interactive CUT PiP restore vs. concurrent SET_PVW (issue #341)', () => {
  it('does not restore the displaced PiP into Strom preview if the operator changed PVW mid-transition', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));

    // Arrange: put PiP 0 on PGM via the real state machine.
    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE' });
    resetRecordings();

    // A CUT to a real source displaces the PGM PiP into PVW, then restores it
    // to Strom's preview *after* awaiting /transition. Delay that reply so the
    // operator's SET_PVW lands inside the round-trip window.
    transitionDelayMs = 150;
    const cutPromise = send({ type: 'CUT', mixerInput: 'video_in_2' });
    await delay(30);

    // Operator changes PVW to a real source while /transition is in flight.
    await send({ type: 'SET_PVW', mixerInput: 'video_in_1' });

    await cutPromise;
    transitionDelayMs = 0;

    // Server state agrees the PiP is gone from PVW.
    expect(pipStates().at(-1)).toMatchObject({ pvwPip: null });

    // Strom's preview must end on the operator's source (input 1), NOT a stale
    // pip restore. Before the fix the final preview request was { pip: 0 }.
    expect(requestsTo(PREVIEW).at(-1)?.body).toEqual({ source: { input: 1 } });
    expect(requestsTo(PREVIEW)).not.toContainEqual(
      expect.objectContaining({ body: { source: { pip: 0 } } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Interactive CUT / TRANSITION must both clear a preview-only PiP (#343)
//
// After SELECT_PVW_PIP the PiP is the only thing in preview. Sending a real
// source to program (whether by CUT or TRANSITION) replaces preview, so the
// stale PiP must be cleared and a PIP_STATE {pvwPip:null} broadcast. TRANSITION
// used to skip this while CUT did it, leaving clients showing both.
// ---------------------------------------------------------------------------

describe('interactive send of a real source over a preview-only PiP', () => {
  it('CUT clears the preview-only PiP and broadcasts PIP_STATE {pvwPip:null}', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));

    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    resetRecordings();

    await send({ type: 'CUT', mixerInput: 'video_in_2' });

    const states = pipStates();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ pgmPip: null, pvwPip: null });
    expect(tallies()[0]).toMatchObject({ pgm: 'video_in_2', pvw: 'video_in_0' });
  });

  it('TRANSITION clears the preview-only PiP and broadcasts PIP_STATE {pvwPip:null}', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));

    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    resetRecordings();

    await send({ type: 'TRANSITION', mixerInput: 'video_in_2', transitionType: 'fade' });

    const states = pipStates();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ pgmPip: null, pvwPip: null });
    expect(tallies()[0]).toMatchObject({ pgm: 'video_in_2', pvw: 'video_in_0' });
  });
});
