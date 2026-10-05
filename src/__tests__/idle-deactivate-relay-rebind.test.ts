/**
 * The idle auto-deactivate records the flow it tears down, like the explicit
 * deactivate: meter and clip relays started on that flow by a controller
 * connecting mid-teardown are rebound by the next start with the new flow.
 *
 * Drives the real `deactivateProduction` and the real relays, with the relay
 * `ws` sockets, Strom and the DB mocked.
 */

import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

vi.mock('../config.js', () => ({
  config: { idleTimeoutSec: 30, idleWarningLeadSec: 10, stromUrl: 'http://localhost:9999', stromToken: undefined },
}));

const broadcasts: Array<Record<string, unknown>> = [];
vi.mock('../services/tally.service.js', () => ({
  getSubscriberCount: () => 0,
  broadcast: (_id: string, msg: unknown) => { broadcasts.push(msg as Record<string, unknown>); },
}));

const PROD = 'prod-idle-rebind';
vi.mock('../db/index.js', () => ({
  getDb: () => ({
    get: vi.fn(async () => ({ _id: PROD, type: 'production', status: 'active', stromFlowId: 'flow-A' })),
    findTrusted: vi.fn().mockResolvedValue({ docs: [] }),
  }),
  isDbConnected: vi.fn().mockReturnValue(true),
}));
vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/flow-generator.js', () => ({ deactivateStromFlow: vi.fn() }));
vi.mock('../routes/productions.js', () => ({
  activationAbortControllers: new Map(),
  updateProductionDoc: vi.fn().mockResolvedValue(undefined),
  emitProductionStatus: vi.fn(),
}));
vi.mock('../services/pfl-state.js', () => ({ clearProductionPflState: vi.fn() }));
vi.mock('../services/guest-sweep.js', () => ({ sweepGuestsOnProductionEnd: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../ws/controller.js', () => ({ clearAudioState: vi.fn(), clearPipState: vi.fn(), clearFxState: vi.fn() }));

type WsHandler = (...args: unknown[]) => void;
const messageHandlers: WsHandler[] = [];
vi.mock('ws', () => {
  class FakeWebSocket {
    constructor(_url: string, _opts?: unknown) {}
    on(event: string, cb: WsHandler) { if (event === 'message') messageHandlers.push(cb); }
    close() {}
  }
  return { WebSocket: FakeWebSocket };
});

const { deactivateProduction } = await import('../services/idle-watchdog.js');
const { startMeterRelay } = await import('../services/meter-relay.js');
const { startClipRelay } = await import('../services/clip-relay.js');
const { setClipStateEntry } = await import('../services/clip-state.service.js');

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

function push(frame: unknown): void {
  for (const handler of messageHandlers) handler(Buffer.from(JSON.stringify(frame)));
}

describe('idle auto-deactivate and the relays', () => {
  it('relays started on the idle-torn-down flow are rebound by the next start', async () => {
    await deactivateProduction(PROD, silentLog);

    // Connect mid-teardown, then a connect after reactivation.
    startMeterRelay(PROD, 'flow-A', 'mixer');
    startClipRelay(PROD, 'flow-A', new Map([['player', 'input1']]));
    await Promise.resolve();
    await Promise.resolve();
    startMeterRelay(PROD, 'flow-B', 'mixer');
    startClipRelay(PROD, 'flow-B', new Map([['player', 'input1']]));

    broadcasts.length = 0;
    push({ type: 'MeterData', data: { flow_id: 'flow-B', element_id: 'mixer:meter:1', rms: -20, peak: -10 } });
    expect(broadcasts.filter((m) => m.type === 'METER_DATA')).toHaveLength(1);

    setClipStateEntry(PROD, { mixerInput: 'input1', state: 'playing', clipId: 'c1' });
    push({ type: 'MediaPlayerStateChanged', data: { flow_id: 'flow-B', block_id: 'player', state: 'paused' } });
    expect(broadcasts.filter((m) => m.type === 'CLIP_STATE').at(-1)).toMatchObject({ mixerInput: 'input1', state: 'paused' });
  });
});
