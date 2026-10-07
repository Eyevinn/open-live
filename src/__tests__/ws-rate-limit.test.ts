/**
 * Tests for per-connection WebSocket message rate limiting (issue #52).
 *
 * HTTP routes are protected by @fastify/rate-limit, but WS message throughput
 * used to be unbounded — a single client could flood commands and saturate the
 * Strom backend. handleMessage now enforces a sliding-window limit per
 * connection: a general cap (20/s) plus a stricter cap (5/s) on expensive
 * commands (MACRO_EXEC, GO_LIVE, CUT_STREAM).
 *
 * These tests drive real inbound messages through handleMessage sharing a
 * single per-connection ctx (as the live plugin does) and assert that once a
 * cap is hit the controller emits an ERROR frame and stops processing. Time is
 * controlled with vi.setSystemTime so the sliding window is deterministic.
 * CouchDB is mocked; the production doc is intentionally NOT activated so cheap
 * commands short-circuit before any Strom call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockInsert = vi.fn().mockResolvedValue({ ok: true });

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
}));

vi.mock('../routes/productions.js', () => ({
  updateProductionDoc: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return { ...actual, broadcast: () => {} };
});

// Capture SET_EFFECT writes so the "last value wins after a burst" test can
// assert the final value reached Strom (issue #469). Other tests use a
// non-activated doc so this is never called.
const setVideoEffectMock = vi.fn().mockResolvedValue({});

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class StromClient {
    mixer = { setVideoEffect: setVideoEffectMock };
    flows = { get: vi.fn(), updateBlockProperties: vi.fn().mockResolvedValue({}) };
  }
  return { ...actual, StromClient };
});

const { handleMessage } = await import('../ws/controller.js');

const PROD = 'prod-rate-1';
const FLOW = 'flow-rate-1';
const MIXER_BLOCK = 'mixer-block-1';

// A non-activated production: GO_LIVE short-circuits with an ERROR and never
// calls Strom, so every accepted message is a pure control-path exercise.
function makeDoc() {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Rate Test',
    status: 'idle',
    // no stromFlowId → GO_LIVE returns "not activated" without Strom
    sources: [],
    pipeline: { stromConfig: null, status: 'idle' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// An activated production so SET_EFFECT actually calls Strom and we can observe
// which value landed.
function makeActiveDoc() {
  return {
    ...makeDoc(),
    status: 'live',
    stromFlowId: FLOW,
    mixerBlockId: MIXER_BLOCK,
    mixerInputMap: null,
  };
}

function makeWs() {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    send: (data: string) => { sent.push(JSON.parse(data)); },
  } as unknown as import('@fastify/websocket').WebSocket;
  return { ws, sent };
}

function rateLimitFrames(sent: Array<Record<string, unknown>>) {
  return sent.filter((m) => m.type === 'ERROR' && m.error === 'Rate limit exceeded');
}

describe('WebSocket per-connection rate limiting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    mockGet.mockReset();
    mockGet.mockResolvedValue(makeDoc());
    setVideoEffectMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to the general cap then coalesces excess to a single ERROR frame', async () => {
    const { ws, sent } = makeWs();
    const ctx: Record<string, unknown> = {};

    // 25 cheap SET_OVL messages within the same window. First 20 pass, rest
    // drop — but the 5 drops now share ONE coalesced ERROR frame (issue #469).
    for (let i = 0; i < 25; i++) {
      await handleMessage(PROD, ws, JSON.stringify({ type: 'SET_OVL', alpha: 0.5 }), ctx);
    }

    expect(rateLimitFrames(sent)).toHaveLength(1);
  });

  it('does not process a message that exceeds the limit', async () => {
    const { ws } = makeWs();
    const ctx: Record<string, unknown> = {};

    for (let i = 0; i < 25; i++) {
      await handleMessage(PROD, ws, JSON.stringify({ type: 'SET_OVL', alpha: 0.5 }), ctx);
    }

    // The DB was fetched only for the 20 accepted messages; the 5 dropped ones
    // never reached the switch (db.get is called after the rate check).
    expect(mockGet).toHaveBeenCalledTimes(20);
  });

  it('applies a stricter cap to expensive commands (GO_LIVE)', async () => {
    const { ws, sent } = makeWs();
    const ctx: Record<string, unknown> = {};

    // 6 GO_LIVE (expensive, cap 5). Under the general cap of 20, so only the
    // expensive limit can trip: the 6th is dropped.
    for (let i = 0; i < 6; i++) {
      await handleMessage(PROD, ws, JSON.stringify({ type: 'GO_LIVE' }), ctx);
    }

    expect(rateLimitFrames(sent)).toHaveLength(1);
  });

  it('refills after the sliding window elapses', async () => {
    const { ws, sent } = makeWs();
    const ctx: Record<string, unknown> = {};

    for (let i = 0; i < 6; i++) {
      await handleMessage(PROD, ws, JSON.stringify({ type: 'GO_LIVE' }), ctx);
    }
    expect(rateLimitFrames(sent)).toHaveLength(1);

    // Advance past the window; earlier timestamps age out and new sends pass.
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
    await handleMessage(PROD, ws, JSON.stringify({ type: 'GO_LIVE' }), ctx);

    expect(rateLimitFrames(sent)).toHaveLength(1);
  });

  it('keeps rate-limit state independent per connection', async () => {
    const a = makeWs();
    const b = makeWs();
    const ctxA: Record<string, unknown> = {};
    const ctxB: Record<string, unknown> = {};

    for (let i = 0; i < 6; i++) {
      await handleMessage(PROD, a.ws, JSON.stringify({ type: 'GO_LIVE' }), ctxA);
    }
    // Connection B is fresh and unaffected by A's flood.
    await handleMessage(PROD, b.ws, JSON.stringify({ type: 'GO_LIVE' }), ctxB);

    expect(rateLimitFrames(a.sent)).toHaveLength(1);
    expect(rateLimitFrames(b.sent)).toHaveLength(0);
  });

  // --- Coalesced drop handling (issue #469) ----------------------------------

  it('coalesces a SET_EFFECT burst to a single ERROR per window', async () => {
    mockGet.mockResolvedValue(makeActiveDoc());
    const { ws, sent } = makeWs();
    const ctx: Record<string, unknown> = {};

    // 30 SET_EFFECT to the same target: 20 pass, 10 drop. The 10 drops share one
    // ERROR frame rather than producing one toast each.
    for (let i = 0; i < 30; i++) {
      await handleMessage(
        PROD,
        ws,
        JSON.stringify({ type: 'SET_EFFECT', target: { input: 1 }, effect: { type: 'blur', radius: i } }),
        ctx,
      );
    }

    expect(rateLimitFrames(sent)).toHaveLength(1);
  });

  it('logs the aggregate drop count at warn when the window drains', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { ws } = makeWs();
      const ctx: Record<string, unknown> = {};

      // 25 cheap messages: 20 pass, 5 drop. Nothing is logged until the window
      // drains, then a single aggregated warn carries the count.
      for (let i = 0; i < 25; i++) {
        await handleMessage(PROD, ws, JSON.stringify({ type: 'SET_OVL', alpha: 0.5 }), ctx);
      }

      const dropWarnsBeforeDrain = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes('rate limit: dropped'),
      );
      expect(dropWarnsBeforeDrain).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1000);

      const dropWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('rate limit: dropped'));
      expect(dropWarns).toHaveLength(1);
      expect(String(dropWarns[0][0])).toContain('dropped 5 message(s)');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps the last setter value: the final SET_EFFECT of a burst is applied after the window drains', async () => {
    mockGet.mockResolvedValue(makeActiveDoc());
    const { ws } = makeWs();
    const ctx: Record<string, unknown> = {};

    // 30 SET_EFFECT to one target with blur radius 0..29. First 20 reach Strom;
    // radii 20..29 are dropped, with 29 (the final position) retained.
    for (let i = 0; i < 30; i++) {
      await handleMessage(
        PROD,
        ws,
        JSON.stringify({ type: 'SET_EFFECT', target: { input: 1 }, effect: { type: 'blur', radius: i } }),
        ctx,
      );
    }

    // Before the window drains the retained final value has NOT landed yet: the
    // newest value Strom has seen is the last one that passed (radius 19).
    const radiiBeforeDrain = setVideoEffectMock.mock.calls.map((c) => c[2].effect.radius);
    expect(radiiBeforeDrain).toHaveLength(20);
    expect(Math.max(...radiiBeforeDrain)).toBe(19);

    // Drain the window: the retained final value is re-applied so it is never lost.
    await vi.advanceTimersByTimeAsync(1000);

    const radiiAfterDrain = setVideoEffectMock.mock.calls.map((c) => c[2].effect.radius);
    expect(radiiAfterDrain).toHaveLength(21);
    // The very last write to Strom is the final slider position, not a stale value.
    expect(radiiAfterDrain[radiiAfterDrain.length - 1]).toBe(29);
  });

  it('still NACKs each correlated (cmdId) command individually when rate-limited', async () => {
    const { ws, sent } = makeWs();
    const ctx: Record<string, unknown> = {};

    // GO_LIVE is expensive (cap 5). Six carry distinct cmdIds; the 6th is dropped
    // and — to preserve the automation contract's per-cmdId resolution — gets its
    // own NACK rather than being folded into the coalesced ERROR.
    for (let i = 0; i < 6; i++) {
      await handleMessage(PROD, ws, JSON.stringify({ type: 'GO_LIVE', cmdId: `cmd-${i}` }), ctx);
    }

    const nacks = sent.filter((m) => m.type === 'NACK' && m.error === 'Rate limit exceeded');
    expect(nacks).toHaveLength(1);
    expect(nacks[0].cmdId).toBe('cmd-5');
    // No bare ERROR frame for a correlated drop.
    expect(rateLimitFrames(sent)).toHaveLength(0);
  });
});
