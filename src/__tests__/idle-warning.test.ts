/**
 * Unit tests for the idle pre-deactivation warning (issue #290).
 *
 * The idle watchdog emits a single `IDLE_WARNING` broadcast when a
 * zero-subscriber production's countdown crosses into the warning window
 * (`IDLE_WARNING_LEAD_SECONDS` before `IDLE_TIMEOUT_SECONDS`), before it
 * auto-deactivates with `endedReason: 'idle'`. Activity (a subscriber
 * (re)joining) resets the timer and cancels the pending warning.
 *
 * These tests drive the watchdog via the test-exported `tick()` with fake
 * timers so the countdown can be crossed deterministically without waiting for
 * the real 10s poll / 5min timeout. CouchDB and Strom are mocked; the warning
 * path does not touch either (it only reads the in-memory subscriber count and
 * calls broadcast()).
 *
 * The watchdog reads its timeout/lead from config at module-eval time; these
 * tests use the shipped defaults — 300s idle timeout, 60s warning lead — so the
 * assertions stay valid regardless of test-runner env injection ordering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockFindTrusted = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, findTrusted: mockFindTrusted }),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

// Fully mock the tally service so the watchdog's imported `broadcast` and
// `getSubscriberCount` bindings resolve to the mocks (ESM named-import interop).
let subscriberCount = 0;
const mockBroadcast = vi.fn();
vi.mock('../services/tally.service.js', () => ({
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
  getSubscriberCount: () => subscriberCount,
}));

vi.mock('../ws/controller.js', () => ({
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

vi.mock('../lib/flow-generator.js', () => ({ deactivateStromFlow: vi.fn() }));
vi.mock('../lib/strom.js', () => ({ StromClient: class {} }));
vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue('t') }));
vi.mock('../services/pfl-state.js', () => ({ clearProductionPflState: vi.fn() }));
vi.mock('../routes/productions.js', () => ({
  activationAbortControllers: new Map(),
  updateProductionDoc: vi.fn().mockResolvedValue(undefined),
  emitProductionStatus: vi.fn(),
}));

import {
  tick,
  notifyProductionActivated,
  notifyProductionDeactivated,
  notifySubscriberJoin,
} from '../services/idle-watchdog.js';

const silentLog = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} as unknown as import('fastify').FastifyBaseLogger;

const PID = 'prod-idle-1';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-16T08:00:00.000Z'));
  subscriberCount = 0;
  mockBroadcast.mockReset();
  mockGet.mockReset();
  mockInsert.mockReset();
});

afterEach(() => {
  notifyProductionDeactivated(PID); // clear watchdog in-memory state between tests
  vi.useRealTimers();
});

function idleWarnings() {
  const calls = mockBroadcast.mock.calls as unknown as Array<[string, { type?: string }]>;
  return calls.filter((call) => call[1]?.type === 'IDLE_WARNING');
}

describe('idle pre-deactivation warning (issue #290)', () => {
  it('broadcasts a single IDLE_WARNING when the countdown crosses the lead window, then deactivates', async () => {
    notifyProductionActivated(PID);

    // t=0: first zero-subscriber tick starts the idle timer.
    await tick(silentLog);
    expect(idleWarnings()).toHaveLength(0);

    // t=250s: remaining = 300 - 250 = 50s (<= 60s lead) → warning fires.
    vi.setSystemTime(new Date('2026-09-16T08:04:10.000Z'));
    await tick(silentLog);

    const warnings = idleWarnings();
    expect(warnings).toHaveLength(1);
    const msg = warnings[0][1] as Record<string, unknown>;
    expect(msg.type).toBe('IDLE_WARNING');
    expect(msg.reason).toBe('idle');
    expect(msg.secondsRemaining).toBe(50);
    // Deadline = idleSince (t=0) + 300s = 08:05:00.
    expect(msg.deadline).toBe('2026-09-16T08:05:00.000Z');

    // t=260s: still within the window but already warned → no second warning.
    vi.setSystemTime(new Date('2026-09-16T08:04:20.000Z'));
    await tick(silentLog);
    expect(idleWarnings()).toHaveLength(1);

    // t=305s: deadline passed → auto-deactivate runs.
    mockGet.mockResolvedValue({
      _id: PID, _rev: '1', type: 'production', status: 'active', stromFlowId: undefined,
      outputAssignments: [],
    });
    vi.setSystemTime(new Date('2026-09-16T08:05:05.000Z'));
    await tick(silentLog);
    expect(mockGet).toHaveBeenCalledWith(PID);
    // Warning was emitted before deactivation (still exactly one).
    expect(idleWarnings()).toHaveLength(1);
  });

  it('does not warn before the countdown enters the lead window', async () => {
    notifyProductionActivated(PID);
    await tick(silentLog); // t=0 starts timer

    // t=200s: remaining = 100s > 60s lead → no warning yet.
    vi.setSystemTime(new Date('2026-09-16T08:03:20.000Z'));
    await tick(silentLog);
    expect(idleWarnings()).toHaveLength(0);
  });

  it('a subscriber (re)joining resets the timer and cancels the pending warning', async () => {
    notifyProductionActivated(PID);
    await tick(silentLog); // t=0 starts timer

    // Activity: a controller socket connects → resets idle + clears warned.
    notifySubscriberJoin(PID);
    subscriberCount = 1;

    // t=250s but a subscriber is present → timer cleared, no warning.
    vi.setSystemTime(new Date('2026-09-16T08:04:10.000Z'));
    await tick(silentLog);
    expect(idleWarnings()).toHaveLength(0);

    // Subscriber leaves; timer restarts from now (t=250s).
    subscriberCount = 0;
    await tick(silentLog); // restarts idleSince at t=250s
    expect(idleWarnings()).toHaveLength(0);

    // t=500s: remaining = 300 - 250 = 50s → a fresh warning fires.
    vi.setSystemTime(new Date('2026-09-16T08:08:20.000Z'));
    await tick(silentLog);
    expect(idleWarnings()).toHaveLength(1);
  });
});
