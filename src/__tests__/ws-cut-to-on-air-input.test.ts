/**
 * CUT / TRANSITION to the input that is already on program must be a no-op,
 * like the PGM button of the on-air source on a vision mixer.
 *
 * Before the guard, the handler set the tally to `{pgm: X, pvw: X}` and asked
 * Strom for a take with `from_input === to_input`; Strom treats that as a
 * PGM/PVW swap, so the picture flipped to the previous preview while Open
 * Live still reported X on program.
 *
 * Same harness as ws-macro-pip.test.ts: the real StromClient talks to a
 * throwaway HTTP server that records requests, CouchDB is mocked.
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

const PROD = 'prod-cut-same-1';
const TRANSITION = '/api/flows/flow-1/blocks/mixer-1/transition';

function makeProductionDoc(actions: Array<Record<string, unknown>> = []) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Cut To On-Air Test',
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
    tally: { pgm: 'video_in_0', pvw: 'video_in_1' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const ws = { send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;

function send(msg: Record<string, unknown>) {
  return handleMessage(PROD, ws, JSON.stringify(msg), {});
}

function tallies() {
  return broadcasts.filter((m) => m.type === 'TALLY');
}

function transitions() {
  return stromRequests.filter((r) => r.path === TRANSITION);
}

function pipStates() {
  return broadcasts.filter((m) => m.type === 'PIP_STATE');
}

function degenerateTakes() {
  return transitions().filter((r) => {
    const b = r.body as { from_input?: number; to_input?: number };
    return b.from_input === b.to_input;
  });
}

beforeEach(() => {
  clearPipState(PROD);
  setTally(PROD, { pgm: 'video_in_0', pvw: 'video_in_1' });
  broadcasts.length = 0;
  stromRequests.length = 0;
  mockGet.mockReset();
  mockInsert.mockClear();
  (ws.send as ReturnType<typeof vi.fn>).mockClear();
  mockGet.mockResolvedValue(makeProductionDoc([{ type: 'CUT', sourceId: 'cam1' }]));
});

describe('CUT to the input already on program', () => {
  it('does not change state or take, but re-broadcasts current tally (#353 item 3)', async () => {
    await send({ type: 'CUT', mixerInput: 'video_in_0' });

    // State is unchanged and no Strom take fires, but the current tally is
    // re-broadcast so an optimistically-swapped client is corrected.
    expect(transitions()).toHaveLength(0);
    expect(getTally(PROD)).toEqual({ pgm: 'video_in_0', pvw: 'video_in_1' });
    expect(tallies()).toHaveLength(1);
    expect(tallies()[0]).toMatchObject({ pgm: 'video_in_0', pvw: 'video_in_1' });
  });

  it('still acks the command so the sender is not left waiting', async () => {
    await send({ type: 'CUT', mixerInput: 'video_in_0', cmdId: 'c-1' });

    const acks = (ws.send as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
      .filter((m) => m.type === 'ACK');
    expect(acks.at(-1)).toMatchObject({ cmdId: 'c-1', phase: 'executed' });
  });

  it('a CUT to a different input is unaffected', async () => {
    await send({ type: 'CUT', mixerInput: 'video_in_2' });

    expect(tallies()[0]).toMatchObject({ pgm: 'video_in_2', pvw: 'video_in_0' });
    expect(transitions()[0]?.body).toMatchObject({ from_input: 0, to_input: 2, transition_type: 'cut' });
  });
});

describe('TRANSITION to the input already on program', () => {
  it('does not change state or take, but re-broadcasts current tally (#353 item 3)', async () => {
    await send({ type: 'TRANSITION', mixerInput: 'video_in_0', transitionType: 'fade', durationMs: 500 });

    expect(transitions()).toHaveLength(0);
    expect(getTally(PROD)).toEqual({ pgm: 'video_in_0', pvw: 'video_in_1' });
    expect(tallies()).toHaveLength(1);
    expect(tallies()[0]).toMatchObject({ pgm: 'video_in_0', pvw: 'video_in_1' });
  });

  it('a TRANSITION to a different input is unaffected', async () => {
    await send({ type: 'TRANSITION', mixerInput: 'video_in_1', transitionType: 'fade', durationMs: 500 });

    expect(tallies()[0]).toMatchObject({ pgm: 'video_in_1', pvw: 'video_in_0', transitionType: 'fade', durationMs: 500 });
    expect(transitions()[0]?.body).toMatchObject({ from_input: 0, to_input: 1, transition_type: 'fade', duration_ms: 500 });
  });
});

// ---------------------------------------------------------------------------
// CUT / TRANSITION to the source *behind an on-air PiP* (issues #342, #353)
//
// With a PiP on PGM the tally.pgm is null and the real on-air source is the
// tracked background behind the PiP. Cutting to that same background input must
// take the PiP off program (the background stays on PGM, PVW clears, the PiP
// moves to PVW) — #347 mis-classified it as "already on program" and dropped the
// command silently, leaving the Studio tally split (#353). The command must
// still never fire a degenerate from_input === to_input take (#342).
// PiP-on-PGM state is arranged through real inbound messages (SELECT_PVW_PIP +
// TAKE), exactly like ws-macro-pip.test.ts, so the same state machine runs.
// ---------------------------------------------------------------------------

describe('CUT/TRANSITION to the input behind an on-air PiP (#342, #353)', () => {
  /** Put PiP 0 on PGM over background video_in_1; return with recordings cleared. */
  async function pipOnProgramOverInput1() {
    // pgm=video_in_0, pvw=video_in_1 from beforeEach. Selecting the PiP in PVW
    // then taking it puts PiP 0 on PGM with video_in_1 (the pre-PiP PVW) as the
    // background, and tally.pgm null.
    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE' });
    // Sanity: the background the take recorded is video_in_1.
    expect(tallies().at(-1)).toMatchObject({ pgm: null, pgmBg: 'video_in_1' });
    broadcasts.length = 0;
    stromRequests.length = 0;
  }

  it('CUT to the background takes the PiP off program without a degenerate take (#353)', async () => {
    await pipOnProgramOverInput1();

    await send({ type: 'CUT', mixerInput: 'video_in_1' });

    // The background stays on PGM, PVW clears, and the PiP moves to PVW.
    expect(tallies().at(-1)).toMatchObject({ pgm: 'video_in_1', pvw: null });
    expect(pipStates().at(-1)).toMatchObject({ pgmPip: null, pvwPip: 0 });
    expect(getTally(PROD)).toEqual({ pgm: 'video_in_1', pvw: null });
    // Never a degenerate from_input === to_input take (#342).
    expect(degenerateTakes()).toHaveLength(0);
  });

  it('CUT to the background still acks the command', async () => {
    await pipOnProgramOverInput1();

    await send({ type: 'CUT', mixerInput: 'video_in_1', cmdId: 'c-pip' });

    const acks = (ws.send as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
      .filter((m) => m.type === 'ACK');
    expect(acks.at(-1)).toMatchObject({ cmdId: 'c-pip', phase: 'executed' });
  });

  it('TRANSITION to the background takes the PiP off program without a degenerate take (#353)', async () => {
    await pipOnProgramOverInput1();

    await send({ type: 'TRANSITION', mixerInput: 'video_in_1', transitionType: 'fade', durationMs: 500 });

    expect(tallies().at(-1)).toMatchObject({ pgm: 'video_in_1', pvw: null });
    expect(pipStates().at(-1)).toMatchObject({ pgmPip: null, pvwPip: 0 });
    expect(getTally(PROD)).toEqual({ pgm: 'video_in_1', pvw: null });
    expect(degenerateTakes()).toHaveLength(0);
  });

  it('CUT to a DIFFERENT real input while a PiP is on PGM is unaffected', async () => {
    await pipOnProgramOverInput1();

    await send({ type: 'CUT', mixerInput: 'video_in_2' });

    // Genuine change: real from (the background) → the new input, never degenerate.
    const take = transitions()[0]?.body as { from_input?: number; to_input?: number };
    expect(take).toMatchObject({ from_input: 1, to_input: 2 });
    expect(take?.from_input).not.toBe(take?.to_input);
  });
});

// ---------------------------------------------------------------------------
// A TAKE's TALLY must carry the transitionType / durationMs it sent to Strom so
// a controller-socket recorder can re-render the exact transition, matching the
// TRANSITION broadcast. FTB_STATE must likewise carry the durationMs sent to
// Strom. Additive, non-breaking fields (issue #451).
// ---------------------------------------------------------------------------

describe('TAKE surfaces the transition it sent to Strom on its TALLY (#451)', () => {
  function ftbs() {
    return broadcasts.filter((m) => m.type === 'FTB_STATE');
  }

  it('TALLY carries the given transitionType and durationMs', async () => {
    await send({ type: 'TAKE', transitionType: 'fade', durationMs: 500 });

    // pgm/pvw swap from the beforeEach state, plus the new transition fields.
    expect(tallies().at(-1)).toMatchObject({
      pgm: 'video_in_1',
      pvw: 'video_in_0',
      transitionType: 'fade',
      durationMs: 500,
    });
    // The same values reach Strom's /transition call.
    expect(transitions()[0]?.body).toMatchObject({ transition_type: 'fade', duration_ms: 500 });
  });

  it('TALLY defaults transitionType to cut when none is given', async () => {
    await send({ type: 'TAKE' });

    const tally = tallies().at(-1) as Record<string, unknown>;
    expect(tally).toMatchObject({ pgm: 'video_in_1', pvw: 'video_in_0', transitionType: 'cut' });
    expect(tally.durationMs).toBeUndefined();
  });

  it('FTB_STATE carries the durationMs sent to Strom', async () => {
    await send({ type: 'FTB', active: true, durationMs: 700 });

    expect(ftbs().at(-1)).toMatchObject({ durationMs: 700 });
    const ftbReq = stromRequests.find((r) => r.path === '/api/flows/flow-1/blocks/mixer-1/ftb');
    expect(ftbReq?.body).toMatchObject({ duration_ms: 700 });
  });

  it('FTB_STATE defaults durationMs to the Strom default (1000) when none is given', async () => {
    await send({ type: 'FTB', active: true });

    expect(ftbs().at(-1)).toMatchObject({ durationMs: 1000 });
    const ftbReq = stromRequests.find((r) => r.path === '/api/flows/flow-1/blocks/mixer-1/ftb');
    expect(ftbReq?.body).toMatchObject({ duration_ms: 1000 });
  });
});

describe('macro actions targeting the input already on program', () => {
  it('CUT action is skipped without breaking the rest of the macro', async () => {
    mockGet.mockResolvedValue(
      makeProductionDoc([
        { type: 'CUT', sourceId: 'cam1' },
        { type: 'CUT', sourceId: 'cam3' },
      ]),
    );

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(transitions()).toHaveLength(1);
    expect(transitions()[0]?.body).toMatchObject({ from_input: 0, to_input: 2 });
    expect(tallies()).toHaveLength(1);
    expect(tallies()[0]).toMatchObject({ pgm: 'video_in_2', pvw: 'video_in_0' });
  });

  it('TRANSITION action is skipped', async () => {
    mockGet.mockResolvedValue(makeProductionDoc([{ type: 'TRANSITION', sourceId: 'cam1', transitionType: 'fade', durationMs: 300 }]));

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(transitions()).toHaveLength(0);
    expect(tallies()).toHaveLength(0);
    expect(getTally(PROD)).toEqual({ pgm: 'video_in_0', pvw: 'video_in_1' });
  });
});
