/**
 * Issue #527 (OL-25): the controller WS `AUDIO_PROC_SET` handler — per-channel
 * gain/HPF/gate/comp/EQ and main-bus comp/EQ/limiter control.
 *
 * Asserts: range validation (reject out-of-range, nothing reaches Strom),
 * stage/element compatibility, the debounced single Strom block-properties
 * PATCH, the applied:true AUDIO_PROC_STATE broadcast, debounce coalescing per
 * element:stage, persistence on the production doc, and cmdId ACK/NACK.
 *
 * Drives `handleMessage` directly, like `ws-audio-applied-broadcast.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockUpdateProductionDoc = vi.fn().mockResolvedValue(undefined);
const updateBlockPropertiesMock = vi.fn().mockResolvedValue({});
const broadcastMock = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: vi.fn().mockResolvedValue({ ok: true }), find: vi.fn().mockResolvedValue({ docs: [] }) }),
}));

vi.mock('../routes/productions.js', () => ({
  updateProductionDoc: mockUpdateProductionDoc,
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class StromClient {
    flows = { updateBlockProperties: updateBlockPropertiesMock, get: vi.fn() };
  }
  return { ...actual, StromClient };
});

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return { ...actual, broadcast: broadcastMock };
});

const { handleMessage } = await import('../ws/controller.js');

const PROD = 'prod-proc-1';
const FLOW = 'flow-proc-1';
const AUDIO_BLOCK = 'audio-block-proc-1';

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Proc Test',
    status: 'active',
    stromFlowId: FLOW,
    sources: [],
    values: {},
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeWs() {
  const sent: Array<Record<string, unknown>> = [];
  const ws = { send: (data: string) => { sent.push(JSON.parse(data)); } } as unknown as import('@fastify/websocket').WebSocket;
  return { ws, sent };
}

function broadcastsOf(type: string): Array<Record<string, unknown>> {
  return broadcastMock.mock.calls.map((c) => c[1] as Record<string, unknown>).filter((m) => m && m.type === type);
}

async function send(ws: import('@fastify/websocket').WebSocket, ctx: { audioBlockId?: string }, msg: Record<string, unknown>) {
  await handleMessage(PROD, ws, JSON.stringify(msg), ctx);
  await new Promise((r) => setTimeout(r, 220)); // let the 150ms debounce fire
}

describe('AUDIO_PROC_SET (#527)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue(makeDoc());
    mockUpdateProductionDoc.mockClear();
    updateBlockPropertiesMock.mockClear();
    broadcastMock.mockClear();
  });

  it('accepts ch1 comp, writes one PATCH and broadcasts applied AUDIO_PROC_STATE (acceptance #2)', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'comp', params: { enabled: true, threshold: -24, ratio: 4 },
    });

    expect(updateBlockPropertiesMock).toHaveBeenCalledTimes(1);
    expect(updateBlockPropertiesMock).toHaveBeenCalledWith(FLOW, AUDIO_BLOCK, {
      properties: { ch1_comp_enabled: true, ch1_comp_threshold: -24, ch1_comp_ratio: 4 },
    });

    const applied = broadcastsOf('AUDIO_PROC_STATE').filter((m) => m.applied === true);
    expect(applied).toContainEqual({
      type: 'AUDIO_PROC_STATE', elementId: 'ch1', stage: 'comp', params: { enabled: true, threshold: -24, ratio: 4 }, applied: true,
    });
  });

  it('persists the change on the production doc', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'main', stage: 'limiter', params: { enabled: true, threshold: -6 },
    });
    expect(mockUpdateProductionDoc).toHaveBeenCalledWith(PROD, {
      audioProcessing: { main: { limiter: { enabled: true, threshold: -6 } } },
    });
  });

  it('rejects an out-of-range value and nothing reaches Strom (acceptance #4)', async () => {
    const { ws, sent } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'comp', params: { ratio: 50 },
    });
    expect(updateBlockPropertiesMock).not.toHaveBeenCalled();
    expect(mockUpdateProductionDoc).not.toHaveBeenCalled();
    expect(broadcastsOf('AUDIO_PROC_STATE')).toHaveLength(0);
    expect(sent.some((m) => m.type === 'ERROR' && /ratio/.test(String(m.error)))).toBe(true);
  });

  it('rejects a stage not valid on the element (limiter on ch1) — nothing reaches Strom', async () => {
    const { ws, sent } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'limiter', params: { enabled: true, threshold: -6 },
    });
    expect(updateBlockPropertiesMock).not.toHaveBeenCalled();
    expect(sent.some((m) => m.type === 'ERROR' && /not valid/.test(String(m.error)))).toBe(true);
  });

  it('coalesces a rapid burst for the same element:stage into one Strom PATCH', async () => {
    const { ws } = makeWs();
    const ctx = { audioBlockId: AUDIO_BLOCK };
    // Three nudges within the debounce window — only the last should land.
    await handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'eq', params: { bands: [{ band: 3, gain: 4 }] } }), ctx);
    await handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'eq', params: { bands: [{ band: 3, gain: 8 }] } }), ctx);
    await handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'eq', params: { bands: [{ band: 3, gain: 12 }] } }), ctx);
    await new Promise((r) => setTimeout(r, 250));

    expect(updateBlockPropertiesMock).toHaveBeenCalledTimes(1);
    expect(updateBlockPropertiesMock).toHaveBeenCalledWith(FLOW, AUDIO_BLOCK, { properties: { ch1_eq3_gain: 12 } });
  });

  it('emits ACK accepted then executed for a cmdId, and NACK on a bad value', async () => {
    // Success path: accepted + executed
    const ok = makeWs();
    await send(ok.ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'gate', params: { enabled: true }, cmdId: 'c-1',
    });
    const acks = ok.sent.filter((m) => m.type === 'ACK' && m.cmdId === 'c-1').map((m) => m.phase);
    expect(acks).toEqual(['accepted', 'executed']);

    // Rejected path: accepted then NACK, no Strom write
    updateBlockPropertiesMock.mockClear();
    const bad = makeWs();
    await send(bad.ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'gate', params: { threshold: 10 }, cmdId: 'c-2',
    });
    expect(bad.sent.some((m) => m.type === 'NACK' && m.cmdId === 'c-2')).toBe(true);
    expect(updateBlockPropertiesMock).not.toHaveBeenCalled();
  });

  it('HPF on/off only (construction-time) persists but writes nothing live', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'hpf', params: { enabled: true },
    });
    // enabled is construction-time → no live PATCH, but it is persisted.
    expect(updateBlockPropertiesMock).not.toHaveBeenCalled();
    expect(mockUpdateProductionDoc).toHaveBeenCalledWith(PROD, {
      audioProcessing: { ch1: { hpf: { enabled: true } } },
    });
  });
});
