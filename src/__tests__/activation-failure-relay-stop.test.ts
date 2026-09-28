/**
 * Regression for issue #435: a failed activation must force-stop the meter and
 * clip relays bound to its (dying) flow, exactly as deactivate does (#433).
 *
 * The bug: runActivationFlow persists `stromFlowId` on the doc while status is
 * still `activating`. A controller connecting in that window starts both relays
 * on that flow. If the activation then FAILS (poll error / timeout / failed
 * final write) — not aborted, so deactivate never runs — the old catch path
 * tore down the flow and reset the doc but left the relays bound to the dead
 * flow. The next successful activation's starts then only ref-counted the stale
 * relay (it never rebinds off a flow that was not recorded as retired), so no
 * client received METER_DATA / LOUDNESS_DATA / reactive CLIP_STATE until every
 * controller disconnected.
 *
 * This drives the REAL activate route with a failing Strom poll and the REAL
 * meter/clip relays (only `ws` transport, Strom HTTP, flow-generator and the DB
 * are mocked), and asserts that a relay started on the next flow actually
 * delivers events — which only happens if the failed flow was force-stopped and
 * recorded as retired.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../server.js';

// ---------------------------------------------------------------------------
// Capture broadcasts (relays + routes push through tally.service.broadcast)
// ---------------------------------------------------------------------------

const broadcasts: Array<Record<string, unknown>> = [];
vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return {
    ...actual,
    broadcast: (_id: string, msg: unknown) => {
      broadcasts.push(msg as Record<string, unknown>);
    },
  };
});

// ---------------------------------------------------------------------------
// Mock CouchDB — stateful so the 'activating' write and the stromFlowId persist
// are seen by the subsequent get inside runActivationFlow.
// ---------------------------------------------------------------------------

let currentDoc: Record<string, unknown>;
const mockInsert = vi.fn(async (d: Record<string, unknown>) => {
  currentDoc = { ...d };
  return { rev: `rev-${Date.now()}`, ok: true, id: d._id as string };
});
const mockGet = vi.fn(async () => ({ ...currentDoc }));
const mockFindTrusted = vi.fn().mockResolvedValue({ docs: [] });

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: mockFindTrusted, findTrusted: mockFindTrusted }),
  getSourcesDb: () => ({ get: mockGet }),
  getOutputsDb: () => ({ get: mockGet }),
  getRecordingsDb: () => ({ get: mockGet }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// Mock WS controller (avoids startup side effects). reinitConnectedControllers
// is only reached on the success path, which this test never takes.
// ---------------------------------------------------------------------------

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
  clearClipStateForProduction: vi.fn(),
  reinitConnectedControllers: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock flow-generator
// ---------------------------------------------------------------------------

const mockActivateStromFlow = vi.fn();
const mockDeactivateStromFlow = vi.fn();
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: (...args: unknown[]) => mockActivateStromFlow(...args),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));

// ---------------------------------------------------------------------------
// Mock StromClient — capture the relay's WS onEvent handlers directly, and
// drive the activation poll via flows.get.
// ---------------------------------------------------------------------------

type FlowEvent = { type: string; data: Record<string, unknown> };
const messageHandlers: Array<(event: FlowEvent) => void> = [];
const mockStromFlowsGet = vi.fn();

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = { version: vi.fn().mockResolvedValue({}), iceServers: vi.fn().mockResolvedValue({ ice_servers: [] }) };
    flows = {
      get: mockStromFlowsGet,
      start: vi.fn().mockResolvedValue({}),
      stop: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    mixer = { multiviewEndpoint: vi.fn().mockResolvedValue({ endpoint: '/whep/x' }) };
    connectWebSocket(onEvent: (event: FlowEvent) => void): () => void {
      messageHandlers.push(onEvent);
      return () => {
        const i = messageHandlers.indexOf(onEvent);
        if (i >= 0) messageHandlers.splice(i, 1);
      };
    }
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue('test-token') }));

// Real relays + clip-state registry.
const { startMeterRelay } = await import('../services/meter-relay.js');
const { startClipRelay } = await import('../services/clip-relay.js');
const { setClipStateEntry } = await import('../services/clip-state.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'prod-435',
    _rev: '1-abc',
    type: 'production',
    name: 'Test Production',
    status: 'inactive',
    sources: [],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeActivationResult(flowId: string, mixerBlockId: string) {
  return {
    flowId,
    mixerBlockId,
    audioMixerBlockId: undefined,
    loudnessMainBlockId: undefined,
    recorderBlockId: undefined,
    whepOutputEntries: [],
    pgmWhepEndpointId: undefined,
    warnings: [],
    sourceOffsetBlockIds: {},
    sourceAudioOffsetBlockIds: {},
    clipPlayerBlockIds: {},
    returnBuses: [],
    returnWhepEntries: [],
    mixerInputMap: {},
  };
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function push(event: FlowEvent): void {
  for (const handler of [...messageHandlers]) handler(event);
}

describe('activation failure force-stops the meter/clip relays on the dying flow (issue #435)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    broadcasts.length = 0;
    messageHandlers.length = 0;
    currentDoc = makeProductionDoc();
    mockFindTrusted.mockResolvedValue({ docs: [] });
    mockDeactivateStromFlow.mockResolvedValue(undefined);
  });

  it('a controller-bound relay on the failed flow is released so the next activation moves it', async () => {
    // Park the run at activateStromFlow, then at the first flows.get poll, so a
    // controller can connect while status is 'activating' with the flow persisted.
    const activateDeferred = makeDeferred<ReturnType<typeof makeActivationResult>>();
    const pollDeferred = makeDeferred<{ flow: Record<string, unknown> }>();
    mockActivateStromFlow.mockReturnValue(activateDeferred.promise);
    mockStromFlowsGet.mockReturnValue(pollDeferred.promise);

    const app = await buildServer();
    const flush = async (n = 6) => {
      for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
    };

    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-435/activate' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('activating');
    await flush();

    // Flow is created and persisted on the doc (status still 'activating').
    activateDeferred.resolve(makeActivationResult('flow-A', 'mixer-A'));
    await flush();
    expect(currentDoc.stromFlowId).toBe('flow-A');
    expect(currentDoc.status).toBe('activating');

    // A controller connects in that window → both relays start on flow-A.
    startMeterRelay('prod-435', 'flow-A', 'mixer-A');
    startClipRelay('prod-435', 'flow-A', new Map([['player', 'video_in_1']]));
    await flush();

    // Sanity: the relays are live on flow-A.
    broadcasts.length = 0;
    push({ type: 'MeterData', data: { flow_id: 'flow-A', element_id: 'mixer-A:meter:1', rms: -20, peak: -10 } });
    expect(broadcasts.filter((m) => m.type === 'METER_DATA')).toHaveLength(1);

    // The activation now FAILS (Strom poll error) — not aborted, so deactivate
    // never runs. The catch path must force-stop both relays on flow-A.
    pollDeferred.reject(new Error('Strom unreachable'));
    await flush();
    expect(currentDoc.status).toBe('inactive');
    expect(currentDoc.stromFlowId).toBeUndefined();

    // The next activation brings up flow-B and its controllers start relays on
    // it. Because flow-A was force-stopped + recorded retired, these move the
    // relays to flow-B instead of only ref-counting a stale flow-A relay.
    startMeterRelay('prod-435', 'flow-B', 'mixer-B');
    startClipRelay('prod-435', 'flow-B', new Map([['player', 'video_in_1']]));
    await flush();

    broadcasts.length = 0;

    // Meter data on the NEW flow now reaches clients.
    push({ type: 'MeterData', data: { flow_id: 'flow-B', element_id: 'mixer-B:meter:1', rms: -18, peak: -8 } });
    expect(broadcasts.filter((m) => m.type === 'METER_DATA')).toHaveLength(1);

    // Stale events on the dead flow must NOT broadcast (the relay moved off it).
    push({ type: 'MeterData', data: { flow_id: 'flow-A', element_id: 'mixer-A:meter:1', rms: -99, peak: -99 } });
    expect(broadcasts.filter((m) => m.type === 'METER_DATA')).toHaveLength(1);

    // Reactive clip state on the new flow reaches clients too.
    setClipStateEntry('prod-435', { mixerInput: 'video_in_1', state: 'playing', clipId: 'c1' });
    push({ type: 'MediaPlayerStateChanged', data: { flow_id: 'flow-B', block_id: 'player', state: 'paused' } });
    expect(broadcasts.filter((m) => m.type === 'CLIP_STATE').at(-1)).toMatchObject({
      mixerInput: 'video_in_1',
      state: 'paused',
    });
  });
});
