/**
 * Tests the meter relay's lifecycle across a deactivate→reactivate cycle
 * (issue #416).
 *
 * The relay filters Strom `MeterData`/`LoudnessData` by flow + mixer block.
 * Reactivation builds a NEW flow, so the relay must follow it: deactivate
 * force-stops the relay regardless of refCount, and a start with a different
 * flow rebinds an existing relay instead of only ref-counting into it.
 *
 * Drives raw Strom frames through the real `connectWebSocket` onEvent path with
 * `ws` + the token exchange mocked, exactly like clip-relay.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

function pushRawFrame(json: string): void {
  const handler = wsHandlers.get('message');
  if (!handler) throw new Error('no ws message handler registered');
  handler(Buffer.from(json));
}

const { startMeterRelay, stopMeterRelay, forceStopMeterRelay } = await import('../services/meter-relay.js');

const PROD = 'prod-meter-01';

function meters() {
  return broadcasts.filter((m) => m.type === 'METER_DATA');
}
function loudness() {
  return broadcasts.filter((m) => m.type === 'LOUDNESS_DATA');
}

/** Start a relay and flush the getStromToken().then() microtasks that register
 *  the WS handlers. */
async function startAndFlush(flowId: string, mixerBlockId: string, loudnessBlockId?: string | null): Promise<void> {
  startMeterRelay(PROD, flowId, mixerBlockId, loudnessBlockId);
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  broadcasts.length = 0;
  wsHandlers.clear();
  // Ensure no relay or torn-down flow survives from a prior test.
  forceStopMeterRelay(PROD, 'flow-none');
});

describe('meter relay frame routing', () => {
  it('broadcasts METER_DATA for the started flow and ignores other flows', async () => {
    await startAndFlush('flow-A', 'mixer-A');
    pushRawFrame(JSON.stringify({ type: 'MeterData', data: { flow_id: 'flow-A', element_id: 'mixer-A:meter:1', rms: -20, peak: -10 } }));
    expect(meters().at(-1)).toMatchObject({ type: 'METER_DATA', elementId: 'ch1', peak: -10, rms: -20 });

    broadcasts.length = 0;
    pushRawFrame(JSON.stringify({ type: 'MeterData', data: { flow_id: 'other-flow', element_id: 'mixer-A:meter:1', rms: -5, peak: -1 } }));
    expect(meters()).toHaveLength(0);
  });

  it('broadcasts LOUDNESS_DATA only for the matching flow + loudness block', async () => {
    await startAndFlush('flow-A', 'mixer-A', 'loud-A');
    pushRawFrame(JSON.stringify({ type: 'LoudnessData', data: { flow_id: 'flow-A', element_id: 'loud-A', momentary: -23, shortterm: -22, integrated: -24, loudness_range: 3, true_peak: -1 } }));
    expect(loudness().at(-1)).toMatchObject({ type: 'LOUDNESS_DATA', elementId: 'main', integrated: -24 });

    broadcasts.length = 0;
    pushRawFrame(JSON.stringify({ type: 'LoudnessData', data: { flow_id: 'other-flow', element_id: 'loud-A', momentary: -1, shortterm: -1, integrated: -1, loudness_range: 1, true_peak: 0 } }));
    expect(loudness()).toHaveLength(0);
  });
});

describe('deactivate→reactivate rebind (issue #416)', () => {
  it('a relay started on the torn-down flow is rebound by the next start', async () => {
    forceStopMeterRelay(PROD, 'flow-A'); // deactivate
    await startAndFlush('flow-A', 'mixer-A', 'loud-A'); // connect mid-teardown
    startMeterRelay(PROD, 'flow-B', 'mixer-B', 'loud-B'); // connect after reactivation

    pushRawFrame(JSON.stringify({ type: 'MeterData', data: { flow_id: 'flow-A', element_id: 'mixer-A:meter:1', rms: -30, peak: -15 } }));
    expect(meters()).toHaveLength(0);
    pushRawFrame(JSON.stringify({ type: 'MeterData', data: { flow_id: 'flow-B', element_id: 'mixer-B:meter:1', rms: -30, peak: -15 } }));
    expect(meters().at(-1)).toMatchObject({ type: 'METER_DATA', elementId: 'ch1', peak: -15, rms: -30 });
    pushRawFrame(JSON.stringify({ type: 'LoudnessData', data: { flow_id: 'flow-B', element_id: 'loud-B', momentary: -23, shortterm: -22, integrated: -24, loudness_range: 3, true_peak: -1 } }));
    expect(loudness().at(-1)).toMatchObject({ elementId: 'main', integrated: -24 });

    // Both starts hold a ref: the relay survives the first stop.
    stopMeterRelay(PROD);
    broadcasts.length = 0;
    pushRawFrame(JSON.stringify({ type: 'MeterData', data: { flow_id: 'flow-B', element_id: 'mixer-B:meter:2', rms: -30, peak: -15 } }));
    expect(meters().at(-1)).toMatchObject({ elementId: 'ch2' });
  });

  it('a late start with the torn-down flow does not pull the relay off the new flow', async () => {
    forceStopMeterRelay(PROD, 'flow-A');
    await startAndFlush('flow-B', 'mixer-B', 'loud-B');
    // A connect that read the doc before the deactivate finishes its sync late.
    startMeterRelay(PROD, 'flow-A', 'mixer-A', 'loud-A');

    pushRawFrame(JSON.stringify({ type: 'MeterData', data: { flow_id: 'flow-B', element_id: 'mixer-B:meter:1', rms: -30, peak: -15 } }));
    expect(meters().at(-1)).toMatchObject({ elementId: 'ch1' });
    pushRawFrame(JSON.stringify({ type: 'LoudnessData', data: { flow_id: 'flow-B', element_id: 'loud-B', momentary: -23, shortterm: -22, integrated: -24, loudness_range: 3, true_peak: -1 } }));
    expect(loudness().at(-1)).toMatchObject({ elementId: 'main', integrated: -24 });
    broadcasts.length = 0;
    pushRawFrame(JSON.stringify({ type: 'MeterData', data: { flow_id: 'flow-A', element_id: 'mixer-A:meter:1', rms: -30, peak: -15 } }));
    expect(meters()).toHaveLength(0);
  });

  it('forceStop + restart binds to the new flow', async () => {
    await startAndFlush('flow-A', 'mixer-A');
    forceStopMeterRelay(PROD);
    await startAndFlush('flow-B', 'mixer-B');
    pushRawFrame(JSON.stringify({ type: 'MeterData', data: { flow_id: 'flow-B', element_id: 'mixer-B:meter:2', rms: -30, peak: -15 } }));
    expect(meters().at(-1)).toMatchObject({ type: 'METER_DATA', elementId: 'ch2', peak: -15, rms: -30 });
  });

  it('forceStopMeterRelay tears down even with refCount > 1, and a later stop does not underflow', async () => {
    await startAndFlush('flow-A', 'mixer-A');
    startMeterRelay(PROD, 'flow-A', 'mixer-A'); // refCount now 2
    forceStopMeterRelay(PROD);
    // A stray close after a force-stop must be a no-op (entry already deleted).
    expect(() => stopMeterRelay(PROD)).not.toThrow();
    // A fresh start rebuilds the relay and relaying resumes.
    broadcasts.length = 0;
    await startAndFlush('flow-A', 'mixer-A');
    pushRawFrame(JSON.stringify({ type: 'MeterData', data: { flow_id: 'flow-A', element_id: 'mixer-A:meter:main', rms: -20, peak: -10 } }));
    expect(meters().at(-1)).toMatchObject({ elementId: 'main' });
  });
});
