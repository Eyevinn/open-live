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

// When >= 400, the fake Strom fails PUT /pip/{idx} (a PiP layout it rejects).
let pipConfigStatus = 200;

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
      if ((req.url ?? '').includes('/pip/') && pipConfigStatus >= 400) {
        res.writeHead(pipConfigStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'pip config rejected' }));
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
const { handleMessage, clearPipState, setPipConfigSlot } = await import('../ws/controller.js');
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

/** Frames the controller sent directly to the originating operator socket. */
function sentFrames() {
  return vi.mocked(ws.send).mock.calls.map(([raw]) => JSON.parse(raw as string) as Record<string, unknown>);
}
function framesOfType(type: string) {
  return sentFrames().filter((m) => m.type === type);
}

/**
 * No PiP selected, video_in_0 on program, video_in_1 in preview. Strom
 * composites each PiP over its configured background: PiP 0 over input 1,
 * PiP 1 over input 2.
 */
function resetMixer() {
  clearPipState(PROD);
  setPipConfigSlot(PROD, 0, { bg: 1, zones: [], transforms: {} });
  setPipConfigSlot(PROD, 1, { bg: 2, zones: [], transforms: {} });
  setTally(PROD, { pgm: 'video_in_0', pvw: 'video_in_1' });
}

beforeEach(() => {
  resetMixer();
  resetRecordings();
  transitionDelayMs = 0;
  transitionStatus = 200;
  pipConfigStatus = 200;
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

    // `pgmBgOf` is what a connecting client is served from. The connect sync
    // lives in the plugin rather than handleMessage, so observe it through a
    // later TALLY. SET_PVW leaves the PiP on program, so the background is
    // still current.
    await send({ type: 'SET_PVW', mixerInput: 'video_in_2' });

    expect(tallies()[0]).toMatchObject({ pgmBg: 'video_in_1' });
  });
});

// ---------------------------------------------------------------------------
// issue #481 — TALLY must carry the PiP program/preview slot numbers so a
// client that applies the new TALLY before the trailing PIP_STATE arrives does
// not read stale PiP slot info. The slots mirror PIP_STATE's `pgmPip`/`pvwPip`.
// ---------------------------------------------------------------------------

describe('TALLY carries pgmPip/pvwPip (issue #481)', () => {
  it('reflects the PiP slots in the same TALLY that reflects the PiP going to program', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam3' }]));

    // Select PiP 0 into preview, then take it to program.
    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    resetRecordings();
    await send({ type: 'TAKE' });

    // The TALLY broadcast at TAKE time must already carry the new slots
    // (pgmPip: 0, pvwPip: null), not wait for the trailing PIP_STATE.
    expect(tallies()[0]).toMatchObject({ pgmPip: 0, pvwPip: null });
    // The authoritative PIP_STATE agrees, proving TALLY mirrors it.
    expect(pipStates()[0]).toMatchObject({ pgmPip: 0, pvwPip: null });
  });

  it('carries null slots when no PiP is on program or preview', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam3' }]));

    await send({ type: 'SET_PVW', mixerInput: 'video_in_2' });

    expect(tallies()[0]).toMatchObject({ pgmPip: null, pvwPip: null });
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
// issue #355 / #430 — when the Strom transition is rejected, the switch never
// reached air. The displaced PiP must not be announced as moved to preview and
// must not be restored into Strom's preview bus (#355); and the whole switch must
// be rolled back to the pre-switch state, with the authoritative TALLY + PIP_STATE
// re-broadcast so clients drop the switch they optimistically showed (#430).
//
// Pre-switch state here (from arrangePgmPip): PiP 0 is on program, so the rollback
// PIP_STATE restores { pgmPip: 0, pvwPip: null }, never the displacement
// { pgmPip: null, pvwPip: 0 }.
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

/** True if any PIP_STATE announced the displacement (PiP moved off program to preview). */
function announcedDisplacement() {
  return pipStates().some((s) => s.pgmPip === null && s.pvwPip === 0);
}

describe('PiP on program when the Strom transition is rejected (issue #355 / #430)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('interactive CUT: rolls back to the pre-switch PiP and never restores it into preview on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    await arrangePgmPip();
    transitionStatus = 500;

    await send({ type: 'CUT', mixerInput: 'video_in_2' });

    // The transition was attempted, but Strom rejected it...
    expect(requestsTo(TRANSITION)).toHaveLength(1);
    // ...so clients are NOT told the PiP left program (no displacement)...
    expect(announcedDisplacement()).toBe(false);
    // ...and the PiP is NOT put back on Strom's preview (it is still on air)...
    expect(restoredPip0()).toBe(false);
    // ...and the pre-switch PiP state is restored for every client (#430).
    expect(pipStates().at(-1)).toMatchObject({ pgmPip: 0, pvwPip: null });
  });

  it('interactive TRANSITION: rolls back to the pre-switch PiP and never restores it into preview on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    await arrangePgmPip();
    transitionStatus = 500;

    await send({ type: 'TRANSITION', mixerInput: 'video_in_2', transitionType: 'fade', durationMs: 500 });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(announcedDisplacement()).toBe(false);
    expect(restoredPip0()).toBe(false);
    expect(pipStates().at(-1)).toMatchObject({ pgmPip: 0, pvwPip: null });
  });

  it('macro CUT: rolls back to the pre-switch PiP and never restores it into preview on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam3' }]));
    await arrangePgmPip();
    transitionStatus = 500;

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(announcedDisplacement()).toBe(false);
    expect(restoredPip0()).toBe(false);
    expect(pipStates().at(-1)).toMatchObject({ pgmPip: 0, pvwPip: null });
  });

  it('macro TRANSITION: rolls back to the pre-switch PiP and never restores it into preview on a /transition 500', async () => {
    mockGet.mockResolvedValue(
      makeProductionDoc([{ type: 'TRANSITION', sourceId: 'cam3', transitionType: 'mix', durationMs: 500 }]),
    );
    await arrangePgmPip();
    transitionStatus = 500;

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(announcedDisplacement()).toBe(false);
    expect(restoredPip0()).toBe(false);
    expect(pipStates().at(-1)).toMatchObject({ pgmPip: 0, pvwPip: null });
  });

  it('interactive TAKE: rolls back to the pre-switch PiP and never restores it into preview on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    await arrangePgmPip();
    transitionStatus = 500;

    await send({ type: 'TAKE' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(announcedDisplacement()).toBe(false);
    expect(restoredPip0()).toBe(false);
    expect(pipStates().at(-1)).toMatchObject({ pgmPip: 0, pvwPip: null });
  });

  it('macro TAKE: rolls back to the pre-switch PiP and never restores it into preview on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));
    await arrangePgmPip();
    transitionStatus = 500;

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(announcedDisplacement()).toBe(false);
    expect(restoredPip0()).toBe(false);
    expect(pipStates().at(-1)).toMatchObject({ pgmPip: 0, pvwPip: null });
  });
});

// ---------------------------------------------------------------------------
// issue #430 — the GENERAL case: a switch Strom rejects (any CUT/TAKE/TRANSITION,
// PiP or not) must not stay in open-live's tally and state. On a /transition 500
// the controller rolls the tally, the persisted doc and the PiP maps back to the
// pre-switch value, re-broadcasts the authoritative TALLY, and tells the operator.
// Before the fix the TALLY kept naming the new source while Strom aired the old.
// ---------------------------------------------------------------------------

describe('a switch Strom rejects must not stay in tally/state (issue #430)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(ws.send).mockClear();
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('interactive CUT with no PiP: rolls tally + persisted doc back and sends ERROR on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    // beforeEach leaves tally { pgm: video_in_0, pvw: video_in_1 } and no PiP.
    transitionStatus = 500;

    await send({ type: 'CUT', mixerInput: 'video_in_2' });

    // The transition reached Strom and was rejected.
    expect(requestsTo(TRANSITION)).toHaveLength(1);
    // The last TALLY broadcast restores the pre-switch program, not video_in_2.
    expect(tallies().at(-1)).toMatchObject({ pgm: 'video_in_0', pvw: 'video_in_1' });
    // The persisted doc was rolled back too (reconnecting clients read it).
    expect(vi.mocked(mockInsert).mock.calls.at(-1)?.[0]).toMatchObject({
      tally: { pgm: 'video_in_0', pvw: 'video_in_1' },
    });
    // The operator is told the switch was rejected, and never gets an executed ACK.
    expect(framesOfType('ERROR')).toContainEqual(
      expect.objectContaining({ type: 'ERROR', error: 'Switch rejected by Strom' }),
    );
  });

  it('interactive TAKE with no PiP: rolls the swapped tally back on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    transitionStatus = 500;

    // A plain TAKE swaps PGM/PVW to { pgm: video_in_1, pvw: video_in_0 }.
    await send({ type: 'TAKE' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(tallies().at(-1)).toMatchObject({ pgm: 'video_in_0', pvw: 'video_in_1' });
    expect(framesOfType('ERROR')).toContainEqual(
      expect.objectContaining({ type: 'ERROR', error: 'Switch rejected by Strom' }),
    );
  });

  it('a rejected CUT carrying a cmdId gets a NACK, not an executed ACK', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    transitionStatus = 500;

    await send({ type: 'CUT', mixerInput: 'video_in_2', cmdId: 'cmd-1' });

    const nacks = framesOfType('NACK');
    expect(nacks).toContainEqual(
      expect.objectContaining({ type: 'NACK', cmdId: 'cmd-1', error: 'Switch rejected by Strom' }),
    );
    // The switch never reached air, so it must not be acked as executed.
    expect(framesOfType('ACK').some((f) => f.cmdId === 'cmd-1' && f.phase === 'executed')).toBe(false);
  });

  it('macro CUT with no PiP: rolls tally back and reports MACRO_ERROR on a /transition 500', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam3' }]));
    transitionStatus = 500;

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(tallies().at(-1)).toMatchObject({ pgm: 'video_in_0', pvw: 'video_in_1' });
    // The macro loop surfaces the rejected action as a MACRO_ERROR, not MACRO_EXECUTED.
    expect(framesOfType('MACRO_ERROR')).toContainEqual(
      expect.objectContaining({ type: 'MACRO_ERROR', macroId: 'macro-1', failedActionIndex: 0 }),
    );
    expect(broadcasts.some((m) => m.type === 'MACRO_EXECUTED')).toBe(false);
  });

  it('a successful CUT is unaffected: no rollback, no ERROR', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    transitionStatus = 200;

    await send({ type: 'CUT', mixerInput: 'video_in_2' });

    // The forward TALLY stands; nothing is rolled back and the operator sees no error.
    expect(tallies().at(-1)).toMatchObject({ pgm: 'video_in_2', pvw: 'video_in_0' });
    expect(framesOfType('ERROR')).toHaveLength(0);
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

    // PiP 1 into preview; video_in_0 stays on program.
    await send({ type: 'SELECT_PVW_PIP', pip: 1 });
    resetRecordings();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    // The PiP is selected into Strom's preview, then taken.
    expect(requestsTo(PREVIEW)).toEqual([
      { method: 'PUT', path: PREVIEW, body: { source: { pip: 1 } } },
    ]);
    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ from_input: 0, to_input: 2, transition_type: 'cut' });

    // Clients see the PiP on program over its background, not an empty bus.
    expect(tallies()).toHaveLength(1);
    expect(tallies()[0]).toMatchObject({ pgm: null, pvw: 'video_in_0', pgmBg: 'video_in_2' });
    expect(pipStates()).toHaveLength(1);
    expect(pipStates()[0]).toMatchObject({ pgmPip: 1, pvwPip: null });
  });

  it('sends the same TALLY and PIP_STATE as an interactive TAKE from the same state', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));

    const broadcastsAfter = async (msg: Record<string, unknown>) => {
      resetMixer();
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

  it('does not announce the PiP on program when Strom rejects the transition, and rolls back (#430)', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));
    await send({ type: 'SELECT_PVW_PIP', pip: 1 });
    resetRecordings();
    vi.mocked(ws.send).mockClear();
    transitionStatus = 500;

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    // Only the rollback's PIP_STATE: the PiP stays in preview.
    expect(pipStates()).toEqual([expect.objectContaining({ pgmPip: null, pvwPip: 1 })]);
    expect(tallies().at(-1)).toMatchObject({ pgm: 'video_in_0', pvw: null, pgmBg: null });
    expect(framesOfType('MACRO_ERROR')).toContainEqual(
      expect.objectContaining({ type: 'MACRO_ERROR', macroId: 'macro-1', failedActionIndex: 0 }),
    );
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

  // Switcher commands are serialised per production (#431), so a
  // SELECT_PVW_PIP sent mid-transition runs after the macro and supersedes it.
  it('lets a SELECT_PVW_PIP queued behind the take supersede it', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));
    await send({ type: 'SELECT_PVW_PIP', pip: 1 });
    resetRecordings();

    transitionDelayMs = 150;
    const macro = send({ type: 'MACRO_EXEC', macroId: 'macro-1' });
    await delay(30);
    const select = send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await Promise.all([macro, select]);

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(pipStates().map(({ pgmPip, pvwPip }) => ({ pgmPip, pvwPip }))).toEqual([
      { pgmPip: 1, pvwPip: null },
      { pgmPip: 1, pvwPip: 0 },
    ]);
  });
});

// A PiP selected into PVW while a take is still writing to CouchDB must not
// change what that take sends to Strom or reports as its background.
describe('TAKE of a PVW PiP vs. SELECT_PVW_PIP during the DB write', () => {
  const takes: Array<[string, Record<string, unknown>, Array<Record<string, unknown>>]> = [
    ['macro', { type: 'MACRO_EXEC', macroId: 'macro-1' }, [{ type: 'TAKE' }]],
    ['interactive', { type: 'TAKE' }, []],
  ];

  for (const [name, msg, actions] of takes) {
    it(`${name} TAKE reports the background of the PiP it took`, async () => {
      mockGet.mockResolvedValue(makeProductionDoc(actions));
      // PiP 1 (over video_in_2) in PVW; video_in_0 on program.
      await send({ type: 'SELECT_PVW_PIP', pip: 1 });
      resetRecordings();
      mockInsert.mockImplementation(() => delay(60).then(() => ({ ok: true })));

      const take = send(msg);
      await delay(20);
      // PiP 0 (over video_in_1) into PVW while the take is persisting.
      await send({ type: 'SELECT_PVW_PIP', pip: 0 });
      await take;

      expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ from_input: 0, to_input: 2 });
      const takeTally = tallies().find((t) => t.pvw === 'video_in_0');
      expect(takeTally).toMatchObject({ pgm: null, pgmBg: 'video_in_2' });

      // The next take puts PiP 0 on program over its own background.
      mockInsert.mockResolvedValue({ ok: true });
      resetRecordings();
      await send({ type: 'TAKE' });
      expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ to_input: 1 });
      expect(tallies()[0]).toMatchObject({ pgmBg: 'video_in_1' });
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
    resetMixer();
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

// Since #431 switcher commands are serialised per production, so a SET_PVW sent
// while a macro's transition is still in flight no longer interleaves with it:
// it runs only once the macro has fully finished (restoring the PiP into Strom
// preview). The operator's SET_PVW therefore lands last and cleanly supersedes
// the restore, so Strom's preview still ends on the operator's source — now by
// ordering rather than by the mid-transition guard the pre-serialisation code
// relied on (that guard remains in place as defence in depth).
describe('macro PiP restore then a SET_PVW queued behind it (#341, serialised by #431)', () => {
  const actions: Array<[string, Record<string, unknown>]> = [
    ['CUT', { type: 'CUT', sourceId: 'cam3' }],
    ['TRANSITION', { type: 'TRANSITION', sourceId: 'cam3', transitionType: 'fade', durationMs: 500 }],
    ['TAKE', { type: 'TAKE' }],
  ];

  for (const [name, action] of actions) {
    it(`${name} lets the operator's later SET_PVW supersede the restore`, async () => {
      mockGet.mockResolvedValue(makeProductionDoc([action]));

      await send({ type: 'SELECT_PVW_PIP', pip: 0 });
      await send({ type: 'TAKE' });
      resetRecordings();

      transitionDelayMs = 150;
      const macro = send({ type: 'MACRO_EXEC', macroId: 'macro-1' });
      await delay(30);
      const setPvw = send({ type: 'SET_PVW', mixerInput: 'video_in_1' });
      await Promise.all([macro, setPvw]);

      const previews = requestsTo(PREVIEW).map((r) => r.body);
      // The macro's PiP restore (pip:0) is applied first, then the operator's
      // SET_PVW (input:1) runs after it and wins — in operator order, never
      // interleaved mid-transition.
      expect(previews).toContainEqual({ source: { pip: 0 } });
      expect(previews.at(-1)).toEqual({ source: { input: 1 } });
      expect(pipStates().at(-1)).toMatchObject({ pvwPip: null });
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
// A SET_PVW sent while a displacing CUT's /transition is in flight (issue
// #341). Since #431 switcher commands are serialised per production, the
// SET_PVW no longer lands mid-transition: it runs after the CUT has finished
// (and restored the PiP into Strom preview), then supersedes it. Strom's
// preview therefore still ends on the operator's source — by ordering rather
// than by the mid-transition guard (which remains as defence in depth).
// ---------------------------------------------------------------------------

describe('interactive CUT PiP restore then a SET_PVW queued behind it (#341, serialised by #431)', () => {
  it('lets the operator\'s later SET_PVW supersede the restore', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));

    // Arrange: put PiP 0 on PGM via the real state machine.
    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE' });
    resetRecordings();

    // A CUT to a real source displaces the PGM PiP into PVW, then restores it
    // to Strom's preview *after* awaiting /transition. Delay that reply, then
    // send a SET_PVW while the CUT is still in flight — it queues behind the CUT.
    transitionDelayMs = 150;
    const cutPromise = send({ type: 'CUT', mixerInput: 'video_in_2' });
    await delay(30);
    const setPvwPromise = send({ type: 'SET_PVW', mixerInput: 'video_in_1' });

    await Promise.all([cutPromise, setPvwPromise]);
    transitionDelayMs = 0;

    // Server state agrees the PiP is gone from PVW.
    expect(pipStates().at(-1)).toMatchObject({ pvwPip: null });

    // The CUT's PiP restore (pip:0) runs first, then the operator's SET_PVW
    // (input:1) runs after it and wins — operator order, never interleaved.
    const previews = requestsTo(PREVIEW).map((r) => r.body);
    expect(previews).toContainEqual({ source: { pip: 0 } });
    expect(previews.at(-1)).toEqual({ source: { input: 1 } });
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

// ---------------------------------------------------------------------------
// issue #431 — switcher commands are serialised per production
//
// The controller used to process each inbound command concurrently, so a CUT
// whose DB write was slow could still be mid-persist when a TAKE arrived. The
// TAKE then reached Strom first and the two were applied in the reverse of the
// order the operator pressed them. A per-production queue now runs each
// switcher-mutating command's doc read → Strom call → DB write to completion
// before the next one starts, so Strom always sees operator order.
// ---------------------------------------------------------------------------

describe('serialisation of switcher commands sent close together (#431)', () => {
  it('a CUT whose DB write is slow still reaches Strom before a TAKE sent 20 ms later', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    // Program video_in_0, preview video_in_1 (set in beforeEach). Delay only the
    // first DB write by 80 ms to widen the CUT's persist window — the exact
    // condition from the issue — so a TAKE arriving mid-write would, without
    // serialisation, race ahead of the CUT on the wire to Strom.
    let inserts = 0;
    mockInsert.mockImplementation(async () => {
      inserts += 1;
      if (inserts === 1) await delay(80);
      return { ok: true };
    });

    const cut = send({ type: 'CUT', mixerInput: 'video_in_2' });
    await delay(20);
    const take = send({ type: 'TAKE' });
    await Promise.all([cut, take]);

    // Strom must see the CUT's transition (to_input 2) before the TAKE's
    // (to_input 0), matching the order the operator pressed them. Before #431
    // the TAKE's transition arrived first and Strom ended on the wrong program.
    const order = requestsTo(TRANSITION).map((r) => (r.body as { to_input: number }).to_input);
    expect(order).toEqual([2, 0]);

    // And the controller's final tally reflects CUT-then-TAKE: video_in_2 was
    // cut to program, then the TAKE swapped the old program (video_in_0) on air.
    expect(tallies().at(-1)).toMatchObject({ pgm: 'video_in_0', pvw: 'video_in_2' });
  });

  it('holds a following CUT until a slow-writing SET_PVW ahead of it has persisted and called Strom', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    let inserts = 0;
    mockInsert.mockImplementation(async () => {
      inserts += 1;
      if (inserts === 1) await delay(80);
      return { ok: true };
    });

    // SET_PVW persists but issues no Strom transition, so the only /transition on
    // the wire is the CUT's — and it must not fire until SET_PVW's slow write has
    // finished, i.e. the CUT waits its turn in the per-production queue.
    const setPvw = send({ type: 'SET_PVW', mixerInput: 'video_in_1' });
    await delay(20);
    const cut = send({ type: 'CUT', mixerInput: 'video_in_2' });

    // The CUT has been enqueued but must still be waiting behind SET_PVW's 80 ms
    // write, so no transition has reached Strom yet.
    expect(requestsTo(TRANSITION)).toHaveLength(0);

    await Promise.all([setPvw, cut]);

    // Once the queue drains the CUT runs to completion exactly once.
    expect(requestsTo(TRANSITION).map((r) => (r.body as { to_input: number }).to_input)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// Strom composites a PiP over its own configured background and ignores the
// take's from_input / to_input, swapping its PGM and PVW buses instead. The
// TALLY must report that background, whatever was on program or in preview
// before the PiP was selected.
// ---------------------------------------------------------------------------

describe('TAKE of a PiP reports the background Strom composites it over', () => {
  /** Mixer calls in order: `preview <source>` or `transition`. */
  const mixerCalls = () =>
    stromRequests
      .filter((r) => r.path === PREVIEW || r.path === TRANSITION)
      .map((r) => (r.path === TRANSITION ? 'transition' : `preview ${JSON.stringify((r.body as { source: unknown }).source)}`));

  const takes: Array<[string, () => Promise<void>]> = [
    ['interactive', () => send({ type: 'TAKE' })],
    ['macro', () => send({ type: 'MACRO_EXEC', macroId: 'macro-1' })],
  ];

  for (const [name, take] of takes) {
    it(`${name}: a PiP selected over an empty preview is on program over its own background`, async () => {
      mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));
      setTally(PROD, { pgm: 'video_in_0', pvw: null });
      await send({ type: 'SELECT_PVW_PIP', pip: 1 });
      resetRecordings();

      await take();

      expect(tallies()).toHaveLength(1);
      expect(tallies()[0]).toMatchObject({ pgm: null, pvw: 'video_in_0', pgmBg: 'video_in_2', program: ['video_in_2'] });
      expect(pipStates().at(-1)).toMatchObject({ pgmPip: 1, pvwPip: null });
    });

    it(`${name}: swapping two PiPs lists each PiP's own background`, async () => {
      mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));
      await send({ type: 'SELECT_PVW_PIP', pip: 0 });
      await send({ type: 'TAKE' });
      await send({ type: 'SELECT_PVW_PIP', pip: 1 });
      resetRecordings();

      await take();

      expect(tallies()).toHaveLength(1);
      expect(tallies()[0]).toMatchObject({ pgmBg: 'video_in_2', program: ['video_in_2'], preview: ['video_in_1'] });
      expect(pipStates().at(-1)).toMatchObject({ pgmPip: 1, pvwPip: 0 });
    });

    it(`${name}: a PiP with no background reports none`, async () => {
      mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TAKE' }]));
      setPipConfigSlot(PROD, 1, { bg: null, zones: [], transforms: {} });
      await send({ type: 'SELECT_PVW_PIP', pip: 1 });
      resetRecordings();

      await take();

      expect(tallies()[0]).toMatchObject({ pgm: null, pgmBg: null, program: [] });
    });
  }

  const cutThenTakes: Array<[string, () => Promise<void>]> = [
    ['interactive', async () => {
      await send({ type: 'CUT', mixerInput: 'video_in_1' });
      await send({ type: 'TAKE' });
    }],
    ['macro', () => send({ type: 'MACRO_EXEC', macroId: 'macro-1' })],
  ];

  for (const [name, cutThenTake] of cutThenTakes) {
    it(`${name}: CUT to the program PiP's background then TAKE takes the PiP off and back on`, async () => {
      mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam2' }, { type: 'TAKE' }]));
      await arrangePgmPip();

      await cutThenTake();

      // The CUT previews the background and takes, so Strom puts it on
      // program and the PiP in preview; the TAKE then puts the PiP back.
      expect(mixerCalls()).toEqual([
        'preview {"input":1}',
        'transition',
        'preview {"pip":0}',
        'transition',
      ]);
      expect(pipStates().map((p) => [p.pgmPip, p.pvwPip])).toEqual([[null, 0], [0, null]]);
      expect(tallies().map((t) => [t.pgm, t.pgmBg])).toEqual([['video_in_1', null], [null, 'video_in_1']]);
    });
  }

  it('SET_PIP changing the background of the PiP on program sends a TALLY naming it', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    await arrangePgmPip();

    await send({ type: 'SET_PIP', pip: 0, bg: 3, zones: [] });

    expect(tallies()).toHaveLength(1);
    expect(tallies()[0]).toMatchObject({ pgm: null, pgmBg: 'video_in_3', program: ['video_in_3'] });
  });

  for (const [name, take] of takes) {
    it(`${name}: the take sends compact Strom pads (#463)`, async () => {
      mockGet.mockResolvedValue({
        ...makeProductionDoc([{ type: 'TAKE' }]),
        mixerInputMap: { video_in_0: 0, video_in_2: 1 },
      });
      setTally(PROD, { pgm: 'video_in_0', pvw: null });
      await send({ type: 'SELECT_PVW_PIP', pip: 1 });
      resetRecordings();

      await take();

      expect(requestsTo(TRANSITION)[0]?.body).toMatchObject({ from_input: 0, to_input: 1 });
      expect(tallies()[0]).toMatchObject({ pgmBg: 'video_in_2' });
    });
  }

  it('SET_PIP that Strom rejects leaves the reported background unchanged', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await arrangePgmPip();
    pipConfigStatus = 400;

    await send({ type: 'SET_PIP', pip: 0, bg: 3, zones: [] });
    await send({ type: 'SET_PVW', mixerInput: 'video_in_2' });
    warn.mockRestore();

    // Strom still composites PiP 0 over input 1, and clients get the old layout back.
    expect(tallies().at(-1)).toMatchObject({ pgmBg: 'video_in_1', program: ['video_in_1'] });
    expect((pipStates().at(-1)?.pips as Array<{ bg: number | null }>)[0]?.bg).toBe(1);
  });

  it('CUT to the PiP\'s background that Strom rejects rolls back and NACKs (#430)', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await arrangePgmPip();
    vi.mocked(ws.send).mockClear();
    transitionStatus = 500;

    await send({ type: 'CUT', mixerInput: 'video_in_1', cmdId: 'cmd-1' });
    warn.mockRestore();

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    // The PiP is never announced in preview; the rollback re-sends it on program.
    expect(pipStates()).toEqual([expect.objectContaining({ pgmPip: 0, pvwPip: null })]);
    expect(tallies().at(-1)).toMatchObject({ pgm: null, pgmBg: 'video_in_1', program: ['video_in_1'] });
    expect(framesOfType('NACK')).toContainEqual(
      expect.objectContaining({ type: 'NACK', cmdId: 'cmd-1', error: 'Switch rejected by Strom' }),
    );
    expect(framesOfType('ACK').some((f) => f.cmdId === 'cmd-1' && f.phase === 'executed')).toBe(false);
  });

  it('macro CUT to the PiP\'s background that Strom rejects rolls back and reports MACRO_ERROR (#430)', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam2' }]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await arrangePgmPip();
    vi.mocked(ws.send).mockClear();
    transitionStatus = 500;

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });
    warn.mockRestore();

    expect(requestsTo(TRANSITION)).toHaveLength(1);
    expect(pipStates()).toEqual([expect.objectContaining({ pgmPip: 0, pvwPip: null })]);
    expect(tallies().at(-1)).toMatchObject({ pgm: null, pgmBg: 'video_in_1' });
    expect(framesOfType('MACRO_ERROR')).toContainEqual(
      expect.objectContaining({ type: 'MACRO_ERROR', macroId: 'macro-1', failedActionIndex: 0 }),
    );
  });
});
