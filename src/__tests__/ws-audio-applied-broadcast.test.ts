/**
 * Issue #453: the WS audio paths broadcast the operator's fader/parameter moves
 * as they arrive, but the write to Strom is debounced (~150 ms) so Strom only
 * ever receives the final value. Clients saw every drag step; Strom made one
 * short change, and nothing told clients what actually reached Strom.
 *
 * Fix: after a debounced Strom write *succeeds*, re-broadcast the value that was
 * written, marked `applied: true`. This covers the AUDIO_SET volume fader plus
 * the AUX send/master, GRP send/master, MONITOR and SOURCE_OFFSET paths.
 *
 * Refusal handling (what to do when Strom rejects a write) is out of scope here
 * (#394) — these tests only assert the success-path `applied: true` broadcast.
 *
 * Drives `handleMessage` directly, as `aux-pre-post-persist.test.ts` does, with
 * CouchDB, `updateProductionDoc`, the Strom client and `broadcast` all mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockUpdateProductionDoc = vi.fn().mockResolvedValue(undefined);
const updateBlockPropertiesMock = vi.fn().mockResolvedValue({});
const updateElementMock = vi.fn().mockResolvedValue({});
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
    properties = { updateElement: updateElementMock };
  }
  return { ...actual, StromClient };
});

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return { ...actual, broadcast: broadcastMock };
});

const { handleMessage } = await import('../ws/controller.js');

const PROD = 'prod-applied-1';
const FLOW = 'flow-applied-1';
const AUDIO_BLOCK = 'audio-block-1';
const OFFSET_BLOCK = 'offset-block-1';
const MIXER_INPUT = 'video_in_1';

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Applied Broadcast Test',
    status: 'active',
    stromFlowId: FLOW,
    sources: [],
    values: {},
    sourceOffsetBlockIds: { [MIXER_INPUT]: OFFSET_BLOCK },
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
  const ws = {
    send: (data: string) => { sent.push(JSON.parse(data)); },
  } as unknown as import('@fastify/websocket').WebSocket;
  return { ws, sent };
}

/** All `broadcast()` payloads carrying `applied: true`. */
function appliedBroadcasts(): Array<Record<string, unknown>> {
  return broadcastMock.mock.calls
    .map((c) => c[1] as Record<string, unknown>)
    .filter((m) => m && m.applied === true);
}

async function send(ws: import('@fastify/websocket').WebSocket, ctx: { audioBlockId?: string }, msg: Record<string, unknown>) {
  await handleMessage(PROD, ws, JSON.stringify(msg), ctx);
  // Let the 150 ms debounce on the live Strom write fire.
  await new Promise((r) => setTimeout(r, 220));
}

describe('audio applied-broadcast after debounced Strom write (issue #453)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue(makeDoc());
    mockUpdateProductionDoc.mockClear();
    updateBlockPropertiesMock.mockClear();
    updateElementMock.mockClear();
    broadcastMock.mockClear();
  });

  it('AUDIO_SET volume broadcasts the written value as applied after the debounced write', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, { type: 'AUDIO_SET', elementId: 'ch1', property: 'volume', value: 0.7 });

    expect(updateBlockPropertiesMock).toHaveBeenCalledTimes(1);
    expect(updateBlockPropertiesMock).toHaveBeenCalledWith(FLOW, AUDIO_BLOCK, { properties: { ch1_fader: 0.7 } });

    const applied = appliedBroadcasts();
    expect(applied).toContainEqual({ type: 'AUDIO_STATE', elementId: 'ch1', property: 'volume', value: 0.7, applied: true });
  });

  it('AUX_SEND_SET broadcasts the send state as applied after the debounced write', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, { type: 'AUX_SEND_SET', elementId: 'ch1', auxBus: 1, level: 0.8, enabled: true });

    expect(updateBlockPropertiesMock).toHaveBeenCalledTimes(1);
    const applied = appliedBroadcasts();
    expect(applied).toContainEqual({ type: 'AUX_SEND_STATE', elementId: 'ch1', auxBus: 1, level: 0.8, enabled: true, applied: true });
  });

  it('AUX_MASTER_SET broadcasts the master state as applied after the debounced write', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, { type: 'AUX_MASTER_SET', auxBus: 1, volume: 0.5, muted: false });

    expect(updateBlockPropertiesMock).toHaveBeenCalledTimes(1);
    const applied = appliedBroadcasts();
    expect(applied).toContainEqual({ type: 'AUX_MASTER_STATE', auxBus: 1, volume: 0.5, muted: false, applied: true });
  });

  it('GRP_SEND_SET broadcasts the send state as applied after the debounced write', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, { type: 'GRP_SEND_SET', elementId: 'ch1', grpBus: 1, level: 0.9, enabled: true });

    expect(updateBlockPropertiesMock).toHaveBeenCalledTimes(1);
    const applied = appliedBroadcasts();
    expect(applied).toContainEqual({ type: 'GRP_SEND_STATE', elementId: 'ch1', grpBus: 1, level: 0.9, enabled: true, applied: true });
  });

  it('GRP_MASTER_SET broadcasts the master state as applied after the debounced write', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, { type: 'GRP_MASTER_SET', grpBus: 1, volume: 0.6, muted: false });

    expect(updateBlockPropertiesMock).toHaveBeenCalledTimes(1);
    const applied = appliedBroadcasts();
    expect(applied).toContainEqual({ type: 'GRP_MASTER_STATE', grpBus: 1, volume: 0.6, muted: false, applied: true });
  });

  it('MONITOR_SET broadcasts the monitor state as applied after the debounced write', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, { type: 'MONITOR_SET', volume: 0.4, muted: false });

    expect(updateBlockPropertiesMock).toHaveBeenCalledTimes(1);
    const applied = appliedBroadcasts();
    expect(applied).toContainEqual({ type: 'MONITOR_STATE', volume: 0.4, muted: false, applied: true });
  });

  it('SOURCE_OFFSET_SET broadcasts the offset as applied after the debounced write', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, { type: 'SOURCE_OFFSET_SET', mixerInput: MIXER_INPUT, offsetMs: 120 });

    expect(updateElementMock).toHaveBeenCalledTimes(1);
    const applied = appliedBroadcasts();
    expect(applied).toContainEqual({ type: 'SOURCE_OFFSET_STATE', mixerInput: MIXER_INPUT, offsetMs: 120, applied: true });
  });

  it('does not broadcast applied when the Strom write fails', async () => {
    updateBlockPropertiesMock.mockRejectedValueOnce(new Error('strom down'));
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, { type: 'MONITOR_SET', volume: 0.4, muted: false });

    expect(appliedBroadcasts()).toHaveLength(0);
  });
});
