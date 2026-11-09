/**
 * The idle auto-deactivate ends a production the same way an explicit
 * Deactivate does (issue #625): the Open Intercom talkback sessions are swept
 * and the grouping deleted, the live clip state (registry + completion-poll
 * timers) is cleared while a cued clip's persisted cue point is kept, and the
 * stored doc has the same live-session fields cleared as `deactivatedDoc()`.
 *
 * Drives the real `deactivateProduction` with the real `productions.ts`
 * helpers and the real clip-state registry. CouchDB, Strom, the guest sweep and
 * the intercom-manager HTTP calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { ProductionDoc } from '../db/types.js';

const PROD = 'prod-idle-625';
const ORIGIN = 'https://intercom.example.com';
const CONN = {
  source: 'stored' as const,
  url: `${ORIGIN}/api/v1`,
  origin: ORIGIN,
  mode: 'bearer',
  modeOverridden: false,
  credential: 'ic-token',
};

let stored: ProductionDoc | undefined;
const mockGet = vi.fn(async () => structuredClone(stored!));
const mockInsert = vi.fn(async (doc: ProductionDoc) => {
  stored = { ...doc, _rev: '2-x' };
  return { ok: true, id: doc._id, rev: '2-x' };
});

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn(), findTrusted: vi.fn().mockResolvedValue({ docs: [] }) }),
  getOutputsDb: () => ({ get: vi.fn(), find: vi.fn(), insert: vi.fn(), destroy: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn(), find: vi.fn() }),
  getRecordingsDb: () => ({ get: vi.fn(), find: vi.fn(), insert: vi.fn() }),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

const broadcasts: Array<Record<string, unknown>> = [];
vi.mock('../services/tally.service.js', () => ({
  getSubscriberCount: () => 0,
  getWatcherCount: () => 0,
  setTally: vi.fn(),
  broadcast: (_id: string, msg: unknown) => { broadcasts.push(msg as Record<string, unknown>); },
}));

vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue(undefined) }));
const mockDeactivateStromFlow = vi.fn();
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));
const mockSweepGuests = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/guest-sweep.js', () => ({ sweepGuestsOnProductionEnd: (...a: unknown[]) => mockSweepGuests(...a) }));

const calls: string[] = [];
const mockSweepTalkback = vi.fn(async (id: string) => { calls.push(`sweep:${id}`); return { ended: 0, failed: 0 }; });
const mockTeardownIntercom = vi.fn(async (id: string) => { calls.push(`delete:${id}`); });
vi.mock('../lib/intercom-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/intercom-manager.js')>()),
  sweepTalkbackSessions: (...a: [string]) => mockSweepTalkback(...a),
  teardownIntercomProduction: (...a: [string]) => mockTeardownIntercom(...a),
}));

const mockActiveConn = vi.fn();
vi.mock('../lib/intercom-connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/intercom-connection.js')>()),
  activeIntercomConnection: () => mockActiveConn(),
}));

const { deactivateProduction } = await import('../services/idle-watchdog.js');
const { IntercomManagerError } = await import('../lib/intercom-manager.js');
const { startClipPoll } = await import('../ws/controller.js');
const { setClipStateEntry, getAllClipStates } = await import('../services/clip-state.service.js');

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as unknown as FastifyBaseLogger;

function liveDoc(overrides: Partial<ProductionDoc> = {}): ProductionDoc {
  return {
    _id: PROD,
    _rev: '1-x',
    type: 'production',
    name: 'Idle show',
    status: 'active',
    stromFlowId: 'flow-A',
    mixerBlockId: 'mixer',
    clipPlayerBlockIds: { input2: 'player-2' },
    mixerInputMap: { input1: 0, input2: 1 },
    returnBuses: [{ id: 'rb1' }],
    returnWhepUrls: { rb1: 'https://strom.example.com/whep/rb1' },
    intercomProductionId: 'ic-42',
    intercomManagerOrigin: ORIGIN,
    clipCues: { input3: { clipId: 'clip-cued', positionMs: 1500 } },
    sources: [],
    ...overrides,
  } as unknown as ProductionDoc;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  broadcasts.length = 0;
  mockActiveConn.mockResolvedValue(CONN);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('idle auto-deactivate tears down Open Intercom (issue #625)', () => {
  it('sweeps the talkback sessions, then deletes the grouping, and clears the grouping on the doc', async () => {
    stored = liveDoc();
    await deactivateProduction(PROD, log);

    expect(calls).toEqual(['sweep:ic-42', 'delete:ic-42']);
    expect(mockSweepTalkback).toHaveBeenCalledWith('ic-42', log, CONN);
    expect(mockTeardownIntercom).toHaveBeenCalledWith('ic-42', CONN);
    // Teardown runs after the Strom flow stop and before the guest sweep.
    expect(mockDeactivateStromFlow.mock.invocationCallOrder[0]).toBeLessThan(mockSweepTalkback.mock.invocationCallOrder[0]);
    expect(mockTeardownIntercom.mock.invocationCallOrder[0]).toBeLessThan(mockSweepGuests.mock.invocationCallOrder[0]);

    expect(stored).toMatchObject({ status: 'ended', endedReason: 'idle', autoDeactivated: true });
    expect(stored!.intercomProductionId).toBeUndefined();
    expect(stored!.intercomManagerOrigin).toBeUndefined();
    // The rest of what deactivatedDoc() clears, which the old idle patch left set.
    expect(stored!.clipPlayerBlockIds).toBeUndefined();
    expect(stored!.mixerInputMap).toBeUndefined();
    expect(stored!.returnBuses).toBeUndefined();
    expect(stored!.returnWhepUrls).toBeUndefined();
    expect(stored!.stromFlowId).toBeUndefined();
    expect(broadcasts.map((m) => m.type)).toContain('PRODUCTION_DEACTIVATED');
  });

  it('skips the teardown and still completes when the manager was repointed', async () => {
    stored = liveDoc();
    mockActiveConn.mockResolvedValue({ ...CONN, origin: 'https://other-intercom.example.com' });
    await deactivateProduction(PROD, log);

    expect(mockSweepTalkback).not.toHaveBeenCalled();
    expect(mockTeardownIntercom).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ status: 'ended', endedReason: 'idle' });
    expect(stored!.intercomProductionId).toBeUndefined();
  });

  it('skips the teardown and still completes when the connection was cleared', async () => {
    stored = liveDoc();
    mockActiveConn.mockResolvedValue(undefined);
    await deactivateProduction(PROD, log);

    expect(mockSweepTalkback).not.toHaveBeenCalled();
    expect(mockTeardownIntercom).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ status: 'ended', endedReason: 'idle' });
    expect(stored!.intercomProductionId).toBeUndefined();
  });

  it.each([404, 409, 500])('a %i from the grouping delete does not block the stop', async (status) => {
    stored = liveDoc();
    mockTeardownIntercom.mockRejectedValueOnce(new IntercomManagerError('manager said no', status));
    await expect(deactivateProduction(PROD, log)).resolves.toBeUndefined();

    expect(mockSweepTalkback).toHaveBeenCalledOnce();
    expect(stored).toMatchObject({ status: 'ended', endedReason: 'idle' });
    expect(stored!.intercomProductionId).toBeUndefined();
  });

  it('a failure resolving the connection does not block the stop', async () => {
    stored = liveDoc();
    mockActiveConn.mockRejectedValue(new Error('settings db down'));
    await expect(deactivateProduction(PROD, log)).resolves.toBeUndefined();
    expect(stored).toMatchObject({ status: 'ended', endedReason: 'idle' });
  });

  it('does not drop a grouping a guest created after the read (conflict guard)', async () => {
    stored = liveDoc();
    const conflict = Object.assign(new Error('conflict'), { statusCode: 409 });
    mockInsert.mockImplementationOnce(async () => {
      stored = { ...liveDoc(), _rev: '2-y', intercomProductionId: 'ic-new' };
      throw conflict;
    });
    await expect(deactivateProduction(PROD, log)).rejects.toBe(conflict);
    expect(stored!.intercomProductionId).toBe('ic-new');
  });
});

describe('idle auto-deactivate clears the live clip state (issue #625)', () => {
  it('drops playing clip state and its poll timer, and keeps the cued clip', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    stored = liveDoc();
    setClipStateEntry(PROD, { mixerInput: 'input2', state: 'playing', clipId: 'clip-live' });
    startClipPoll(PROD, 'input2', 'clip-live');
    expect(vi.getTimerCount()).toBe(1);

    await deactivateProduction(PROD, log);

    expect(getAllClipStates(PROD)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    // The cue point lives on the doc and survives the stop (#336, #307).
    expect(stored!.clipCues).toEqual({ input3: { clipId: 'clip-cued', positionMs: 1500 } });
  });
});

describe('idle auto-deactivate without a grouping or clips (issue #625)', () => {
  it('behaves as before: no intercom calls, ended by idle', async () => {
    stored = liveDoc({ intercomProductionId: undefined, intercomManagerOrigin: undefined, clipCues: undefined, clipPlayerBlockIds: undefined });
    await deactivateProduction(PROD, log);

    expect(mockActiveConn).not.toHaveBeenCalled();
    expect(mockSweepTalkback).not.toHaveBeenCalled();
    expect(mockTeardownIntercom).not.toHaveBeenCalled();
    expect(mockDeactivateStromFlow).toHaveBeenCalledWith('flow-A', expect.anything());
    expect(stored).toMatchObject({ status: 'ended', endedReason: 'idle', autoDeactivated: true, tally: { pgm: null, pvw: null } });
    expect(stored!.stromFlowId).toBeUndefined();
    expect(stored!.activatedAt).toBeUndefined();
  });

  it('a production still activating becomes inactive with no endedReason', async () => {
    stored = liveDoc({ status: 'activating', intercomProductionId: undefined, intercomManagerOrigin: undefined });
    await deactivateProduction(PROD, log);
    expect(stored).toMatchObject({ status: 'inactive', autoDeactivated: true });
    expect(stored!.endedReason).toBeUndefined();
  });

  it('skips a production that is no longer active', async () => {
    stored = liveDoc({ status: 'ended' });
    await deactivateProduction(PROD, log);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockSweepTalkback).not.toHaveBeenCalled();
  });
});
