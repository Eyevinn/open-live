/**
 * Idle pre-deactivation warning + keep-alive (issue #290).
 *
 * Verifies the watchdog emits a single IDLE_WARNING (carrying remainingSec +
 * deadlineMs) over the controller WS channel once the idle timer crosses the
 * warning lead threshold, and that a keep-alive / activity reset cancels a
 * pending warning with an IDLE_WARNING_CLEARED. The tally.service broadcast +
 * subscriber-count surface is mocked so the tick can be driven deterministically
 * with fake timers. Pairs with open-live-studio#131 / #130.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

// Small, fast timings: deadline 30s, warn at T-10s → the single warning fires
// on the first tick where remaining <= 10s (i.e. once idle >= 20s).
vi.mock('../config.js', () => ({
  config: { idleTimeoutSec: 30, idleWarningLeadSec: 10, stromUrl: 'http://localhost:9999', stromToken: undefined },
}));

// Controllable subscriber count + a broadcast spy — the only tally.service
// surface the watchdog touches.
const mockGetSubscriberCount = vi.fn<(id: string) => number>();
const mockBroadcast = vi.fn();
vi.mock('../services/tally.service.js', () => ({
  getSubscriberCount: (id: string) => mockGetSubscriberCount(id),
  broadcast: (id: string, msg: unknown) => mockBroadcast(id, msg),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), findTrusted: vi.fn().mockResolvedValue({ docs: [] }) }),
  isDbConnected: vi.fn().mockReturnValue(true),
}));
vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/strom.js', () => ({ StromClient: vi.fn() }));
vi.mock('../lib/flow-generator.js', () => ({ deactivateStromFlow: vi.fn() }));
vi.mock('../routes/productions.js', () => ({
  activationAbortControllers: new Map(),
  updateProductionDoc: vi.fn().mockResolvedValue(undefined),
  emitProductionStatus: vi.fn(),
}));
vi.mock('../services/pfl-state.js', () => ({ clearProductionPflState: vi.fn() }));
vi.mock('../ws/controller.js', () => ({ clearAudioState: vi.fn(), clearPipState: vi.fn(), clearFxState: vi.fn() }));

import {
  notifyProductionActivated,
  notifyProductionDeactivated,
  resetIdleTimer,
  startIdleWatchdog,
  stopIdleWatchdog,
} from '../services/idle-watchdog.js';

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

describe('idle pre-deactivation warning (#290)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetSubscriberCount.mockReset();
    mockBroadcast.mockReset();
  });
  afterEach(() => {
    // Tear down the interval so the next test starts a fresh one under its own
    // fake-timer context (the watchdog is a module-level singleton).
    stopIdleWatchdog();
    vi.useRealTimers();
  });

  it('emits exactly one IDLE_WARNING with remainingSec + deadlineMs before the deadline', async () => {
    const id = 'prod-warn';
    mockGetSubscriberCount.mockReturnValue(0); // always idle
    notifyProductionActivated(id);
    startIdleWatchdog(silentLog);

    // Ticks run every 10s. t=10s starts the idle timer; t=20s → idleMs=10s
    // (remaining 20s, no warn); t=30s → idleMs=20s (remaining 10s <= 10s lead)
    // fires the single warning; t=40s would deactivate. Advance to 35s to land
    // the warning tick without reaching the deadline.
    await vi.advanceTimersByTimeAsync(35_000);

    const warnings = mockBroadcast.mock.calls.filter(([, m]) => (m as { type: string }).type === 'IDLE_WARNING');
    expect(warnings.length).toBe(1);
    const [, msg] = warnings[0];
    const warn = msg as { type: string; productionId: string; remainingSec: number; deadlineMs: number };
    expect(warn.productionId).toBe(id);
    expect(typeof warn.remainingSec).toBe('number');
    expect(warn.remainingSec).toBeGreaterThan(0);
    expect(warn.remainingSec).toBeLessThanOrEqual(10);
    expect(typeof warn.deadlineMs).toBe('number');
    expect(warn.deadlineMs).toBeGreaterThan(Date.now());

    notifyProductionDeactivated(id);
  });

  it('resetIdleTimer cancels a pending warning and emits IDLE_WARNING_CLEARED once', async () => {
    const id = 'prod-clear';
    mockGetSubscriberCount.mockReturnValue(0);
    notifyProductionActivated(id);
    startIdleWatchdog(silentLog);

    // Reach the warning (see timing note in the test above).
    await vi.advanceTimersByTimeAsync(35_000);
    expect(mockBroadcast.mock.calls.some(([, m]) => (m as { type: string }).type === 'IDLE_WARNING')).toBe(true);

    mockBroadcast.mockClear();
    // A keep-alive / activity reset cancels the pending warning.
    resetIdleTimer(id);
    const cleared = mockBroadcast.mock.calls.filter(([, m]) => (m as { type: string }).type === 'IDLE_WARNING_CLEARED');
    expect(cleared.length).toBe(1);
    expect((cleared[0][1] as { productionId: string }).productionId).toBe(id);

    // A second reset with no warning pending is silent.
    mockBroadcast.mockClear();
    resetIdleTimer(id);
    expect(mockBroadcast.mock.calls.some(([, m]) => (m as { type: string }).type === 'IDLE_WARNING_CLEARED')).toBe(false);

    notifyProductionDeactivated(id);
  });

  it('does not warn while a subscriber is present (activity keeps the timer reset)', async () => {
    const id = 'prod-active';
    mockGetSubscriberCount.mockReturnValue(1); // never idle
    notifyProductionActivated(id);
    startIdleWatchdog(silentLog);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockBroadcast.mock.calls.some(([, m]) => (m as { type: string }).type === 'IDLE_WARNING')).toBe(false);

    notifyProductionDeactivated(id);
  });
});
