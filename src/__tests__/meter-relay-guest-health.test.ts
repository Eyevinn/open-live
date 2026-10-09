/**
 * The meter relay re-reads the flow's block_health each time its Strom socket
 * opens, so a guest health change sent while the socket was down is not lost,
 * and a live event that lands during the re-read is not overwritten by it.
 *
 * Fakes `ws` (so the test fires `open` itself) and `fetch` (the flow GET).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const broadcasts: Array<Record<string, unknown>> = [];
vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return {
    ...actual,
    broadcast: (_id: string, message: unknown) => { broadcasts.push(message as Record<string, unknown>); },
  };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

type WsHandler = (...args: unknown[]) => void;
const wsHandlers = new Map<string, WsHandler>();
vi.mock('ws', () => {
  class FakeWebSocket {
    constructor(_url: string, _opts?: unknown) {}
    on(event: string, cb: WsHandler) { wsHandlers.set(event, cb); }
    close() {}
  }
  return { WebSocket: FakeWebSocket };
});

const { startMeterRelay, forceStopMeterRelay } = await import('../services/meter-relay.js');

const PROD = 'prod-relay-health';
const FLOW = 'flow-relay-health';
const G1 = 'b-input-15-relayhea';
const G2 = 'b-input-14-relayhea';
const guestBlocks = new Map([[G1, 'video_in_15'], [G2, 'video_in_14']]);

let releaseFlowGet: (() => void) | null = null;
let blockHealth: Array<Record<string, unknown>> = [];

function health() {
  return broadcasts.filter((m) => m.type === 'GUEST_HEALTH');
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  broadcasts.length = 0;
  wsHandlers.clear();
  blockHealth = [];
  releaseFlowGet = null;
  forceStopMeterRelay(PROD, 'flow-none');
  vi.stubGlobal('fetch', vi.fn(async () => {
    await new Promise<void>((resolve) => { releaseFlowGet = resolve; });
    return new Response(JSON.stringify({ flow: { id: FLOW, block_health: blockHealth } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  startMeterRelay(PROD, FLOW, 'mixer', null, guestBlocks);
  await flush();
});

afterEach(() => {
  forceStopMeterRelay(PROD, 'flow-none');
  vi.unstubAllGlobals();
});

describe('meter relay guest health re-read on open', () => {
  it('broadcasts every guest seat from the flow block_health when the socket opens', async () => {
    const causes = [{ kind: 'whip_medium', slot: 0, medium: 'audio', fault: 'publisher_stopped' }];
    blockHealth = [{ block_id: G1, status: 'failed', detail: 'no audio', causes }];
    wsHandlers.get('open')!();
    await flush();
    releaseFlowGet!();
    await flush();
    expect(health()).toEqual([
      { type: 'GUEST_HEALTH', mixerInput: 'video_in_15', blockId: G1, status: 'failed', detail: 'no audio', causes },
      { type: 'GUEST_HEALTH', mixerInput: 'video_in_14', blockId: G2, status: 'ok' },
    ]);
  });

  it('does not let the re-read overwrite a live event that arrived while it was in flight', async () => {
    blockHealth = [{ block_id: G1, status: 'failed', detail: 'stale' }];
    wsHandlers.get('open')!();
    await flush();
    wsHandlers.get('message')!(Buffer.from(JSON.stringify({ type: 'BlockHealthChanged', data: { flow_id: FLOW, block_id: G1, status: 'ok', detail: null } })));
    releaseFlowGet!();
    await flush();
    expect(health()).toEqual([
      { type: 'GUEST_HEALTH', mixerInput: 'video_in_15', blockId: G1, status: 'ok' },
      { type: 'GUEST_HEALTH', mixerInput: 'video_in_14', blockId: G2, status: 'ok' },
    ]);
  });
});
