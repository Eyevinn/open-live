/**
 * Regression test for issue #395: "AUX pre/post setting is refused by Strom on
 * every change".
 *
 * AUX_SEND_SET's `pre` field selects which fader tee (pre-fader vs post-fader)
 * a channel's aux send is wired to. `ch{N}_aux{M}_pre` is a build-time Strom
 * block property (`live: false`) — Strom rejects every attempt to set it on a
 * running flow. The handler used to send it as a live `updateBlockProperties`
 * call anyway and log a misleading "stored for next start" warning on the
 * ensuing `StromPropertiesRejectedError`, when nothing was actually stored.
 *
 * Fix (Option 1, backend-only): controller.ts no longer attempts a live
 * `_pre` write. Instead it persists the choice on the production doc's
 * `values` (`ch{N}_aux{M}_pre`), and flow-generator.ts reads it back at flow
 * (re)build time — see `aux-pre-post-flow-build.test.ts` for that half.
 *
 * Drives `handleMessage` directly — the same harness `ws-rate-limit.test.ts`
 * uses — with CouchDB, `updateProductionDoc`, and the Strom client mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockUpdateProductionDoc = vi.fn().mockResolvedValue(undefined);
const updateBlockPropertiesMock = vi.fn().mockResolvedValue({});

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
    flows = { updateBlockProperties: updateBlockPropertiesMock };
  }
  return { ...actual, StromClient };
});

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return { ...actual, broadcast: () => {} };
});

const { handleMessage } = await import('../ws/controller.js');

const PROD = 'prod-aux-pre-1';
const FLOW = 'flow-aux-pre-1';
const AUDIO_BLOCK = 'audio-block-1';

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'AUX Pre Test',
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
  const ws = {
    send: (data: string) => { sent.push(JSON.parse(data)); },
  } as unknown as import('@fastify/websocket').WebSocket;
  return { ws, sent };
}

async function sendAuxSendSet(ws: import('@fastify/websocket').WebSocket, ctx: { audioBlockId?: string }, msg: Record<string, unknown>) {
  await handleMessage(PROD, ws, JSON.stringify({ type: 'AUX_SEND_SET', ...msg }), ctx);
  // Let the 150ms debounce on the live level write fire.
  await new Promise((r) => setTimeout(r, 220));
}

describe('AUX_SEND_SET pre/post persistence (issue #395)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockUpdateProductionDoc.mockClear();
    updateBlockPropertiesMock.mockClear();
  });

  it('persists the pre/post choice on production.values instead of writing it live', async () => {
    mockGet.mockResolvedValue(makeDoc({ values: { num_aux_buses: 2 } }));
    const { ws } = makeWs();
    const ctx: { audioBlockId?: string } = { audioBlockId: AUDIO_BLOCK };

    await sendAuxSendSet(ws, ctx, { elementId: 'ch1', auxBus: 2, level: 0.8, enabled: true, pre: false });

    expect(mockUpdateProductionDoc).toHaveBeenCalledTimes(1);
    expect(mockUpdateProductionDoc).toHaveBeenCalledWith(PROD, {
      values: { num_aux_buses: 2, ch1_aux2_pre: false },
    });

    // Only the live-applicable level property is ever sent to Strom — never a
    // ch1_aux2_pre write (that's the futile call issue #395 is about), and
    // never a second updateBlockProperties call for this command.
    expect(updateBlockPropertiesMock).toHaveBeenCalledTimes(1);
    expect(updateBlockPropertiesMock).toHaveBeenCalledWith(FLOW, AUDIO_BLOCK, {
      properties: { ch1_aux2_level: 0.8 },
    });
  });

  it('persists pre even when no flow is active yet, so it is picked up on first build', async () => {
    mockGet.mockResolvedValue(makeDoc({ stromFlowId: undefined, values: {} }));
    const { ws } = makeWs();
    const ctx: { audioBlockId?: string } = {}; // no audioBlockId — flow not active

    await sendAuxSendSet(ws, ctx, { elementId: 'ch2', auxBus: 1, level: 1, enabled: true, pre: false });

    expect(mockUpdateProductionDoc).toHaveBeenCalledWith(PROD, {
      values: { ch2_aux1_pre: false },
    });
    expect(updateBlockPropertiesMock).not.toHaveBeenCalled();
  });

  it('never logs the misleading "stored for next start" message on a pre change', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGet.mockResolvedValue(makeDoc({ values: {} }));
    const { ws } = makeWs();
    const ctx: { audioBlockId?: string } = { audioBlockId: AUDIO_BLOCK };

    await sendAuxSendSet(ws, ctx, { elementId: 'ch1', auxBus: 1, level: 0.5, enabled: true, pre: true });

    const messages = warnSpy.mock.calls.map((args) => args.map(String).join(' '));
    expect(messages.some((m) => m.includes('stored for next start'))).toBe(false);
    warnSpy.mockRestore();
  });

  it('does not persist anything when pre is omitted (level/enabled-only updates are unaffected)', async () => {
    mockGet.mockResolvedValue(makeDoc({ values: { num_aux_buses: 1 } }));
    const { ws } = makeWs();
    const ctx: { audioBlockId?: string } = { audioBlockId: AUDIO_BLOCK };

    await sendAuxSendSet(ws, ctx, { elementId: 'ch1', auxBus: 1, level: 0.3, enabled: true });

    expect(mockUpdateProductionDoc).not.toHaveBeenCalled();
    expect(updateBlockPropertiesMock).toHaveBeenCalledTimes(1);
    expect(updateBlockPropertiesMock).toHaveBeenCalledWith(FLOW, AUDIO_BLOCK, {
      properties: { ch1_aux1_level: 0.3 },
    });
  });
});
