/**
 * Tests for PiP handling in macro-executed CUT, TRANSITION, and TAKE actions.
 *
 * `handleMessage` is driven directly with CouchDB and StromClient mocked, so
 * the assertions cover the Strom call sequence and the broadcast payloads
 * without needing a mixer or a database.
 *
 * PiP state is established through real inbound messages (SELECT_PVW_PIP,
 * TAKE) rather than by reaching into the module-level maps, so each case
 * exercises the same state machine the server runs in production.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// ---------------------------------------------------------------------------
// Mock StromClient — every mixer call the macro paths can reach
// ---------------------------------------------------------------------------

const selectPreview = vi.fn().mockResolvedValue({});
const transition = vi.fn().mockResolvedValue({});

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    mixer = {
      selectPreview,
      transition,
      toggleDsk: vi.fn().mockResolvedValue({ dsk: 1, enabled: true }),
      setPip: vi.fn().mockResolvedValue({}),
    };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
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

const { handleMessage, clearPipState } = await import('../ws/controller.js');
const { setTally } = await import('../services/tally.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROD = 'prod-pip-1';

function makeDoc(actions: Array<Record<string, unknown>>) {
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

beforeEach(() => {
  clearPipState(PROD);
  setTally(PROD, { pgm: 'video_in_0', pvw: 'video_in_1' });
  broadcasts.length = 0;
  selectPreview.mockClear();
  transition.mockClear();
  mockGet.mockReset();
  mockInsert.mockClear();
});

// ---------------------------------------------------------------------------
// Macro CUT / TRANSITION over a PiP that is on program
// ---------------------------------------------------------------------------

describe('macro CUT with a PiP on program', () => {
  it('moves the PiP to preview, tells clients, and restores it in Strom', async () => {
    mockGet.mockResolvedValue(makeDoc([{ type: 'CUT', sourceId: 'cam3' }]));

    // Put PiP 0 on program: select it into preview, then take.
    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE' });

    broadcasts.length = 0;
    selectPreview.mockClear();
    transition.mockClear();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    // The PiP leaves program for preview, and every subscriber is told.
    expect(pipStates()).toHaveLength(1);
    expect(pipStates()[0]).toMatchObject({ pgmPip: null, pvwPip: 0 });

    // The PiP is put back on Strom's preview bus.
    expect(selectPreview).toHaveBeenCalledWith('flow-1', 'mixer-1', { source: { pip: 0 } });

    // from_input is the tracked background (video_in_1), not a collapsed to_input.
    expect(transition).toHaveBeenCalledWith(
      'flow-1',
      'mixer-1',
      expect.objectContaining({ from_input: 1, to_input: 2 }),
    );
  });
});

describe('macro TRANSITION with a PiP on program', () => {
  it('moves the PiP to preview and restores it in Strom', async () => {
    mockGet.mockResolvedValue(
      makeDoc([{ type: 'TRANSITION', sourceId: 'cam3', transitionType: 'mix', durationMs: 500 }]),
    );

    await send({ type: 'SELECT_PVW_PIP', pip: 0 });
    await send({ type: 'TAKE' });

    broadcasts.length = 0;
    selectPreview.mockClear();
    transition.mockClear();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(pipStates()).toHaveLength(1);
    expect(pipStates()[0]).toMatchObject({ pgmPip: null, pvwPip: 0 });
    expect(selectPreview).toHaveBeenCalledWith('flow-1', 'mixer-1', { source: { pip: 0 } });
  });
});

// ---------------------------------------------------------------------------
// Macro TAKE promoting a PiP that is sitting in preview
// ---------------------------------------------------------------------------

describe('macro TAKE with a PiP in preview', () => {
  it('takes the PiP to program instead of reporting an empty bus', async () => {
    mockGet.mockResolvedValue(makeDoc([{ type: 'TAKE' }]));

    // PiP 1 into preview only — nothing on program yet.
    await send({ type: 'SELECT_PVW_PIP', pip: 1 });

    broadcasts.length = 0;
    selectPreview.mockClear();
    transition.mockClear();

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    // The regression: previously stromTransition early-returned on the null
    // target and Strom was never called at all.
    expect(transition).toHaveBeenCalledTimes(1);
    expect(selectPreview).toHaveBeenCalledWith('flow-1', 'mixer-1', { source: { pip: 1 } });

    // The server records the PiP as being on program.
    expect(pipStates()).toHaveLength(1);
    expect(pipStates()[0]).toMatchObject({ pgmPip: 1, pvwPip: null });
  });
});

// ---------------------------------------------------------------------------
// No PiP involved — the pre-existing path must be untouched
// ---------------------------------------------------------------------------

describe('macro CUT with no PiP anywhere', () => {
  it('behaves exactly as before: no PIP_STATE, no pip selectPreview', async () => {
    mockGet.mockResolvedValue(makeDoc([{ type: 'CUT', sourceId: 'cam3' }]));

    await send({ type: 'MACRO_EXEC', macroId: 'macro-1' });

    expect(pipStates()).toHaveLength(0);

    // Only stromTransition's own preview select, addressed by input not pip.
    for (const call of selectPreview.mock.calls) {
      expect(call[2]).toEqual({ source: { input: 2 } });
    }

    expect(transition).toHaveBeenCalledWith(
      'flow-1',
      'mixer-1',
      expect.objectContaining({ from_input: 0, to_input: 2 }),
    );
    expect(tallies()[0]).toMatchObject({ pgm: 'video_in_2', pvw: 'video_in_0' });
  });
});
