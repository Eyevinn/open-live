/**
 * Tests the reactive clip-state relay mapping (epic #206, issue #307 / OQ2):
 * Strom's pushed `MediaPlayerStateChanged` / `MediaPlayerPosition` events are
 * translated to `CLIP_STATE` broadcasts, keyed back to the mixerInput, WITHOUT
 * clobbering controller-owned states (cued/completed/error) that Strom cannot
 * observe. This is the primary completion/position mechanism; the controller
 * poll is only a reconciliation fallback.
 *
 * Exercises the pure `applyReactiveState` / `applyReactivePosition` mappers
 * against the real in-memory clip-state service, with tally.broadcast and the
 * cue-store mocked so we assert exactly what is emitted/persisted.
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

const clearPersistedClipCue = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/clip-cue-store.js', () => ({
  persistClipCue: vi.fn().mockResolvedValue(undefined),
  clearPersistedClipCue,
}));

// Avoid any real token exchange when the relay opens its WS.
vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

// Mock the `ws` WebSocket so we can capture the handlers `connectWebSocket`
// registers and drive raw JSON frames (exactly as Strom sends them) through the
// real onEvent path in strom.ts -> clip-relay.ts.
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

/** Feed a raw JSON string through the captured `message` handler. */
function pushRawFrame(json: string): void {
  const handler = wsHandlers.get('message');
  if (!handler) throw new Error('no ws message handler registered');
  handler(Buffer.from(json));
}

const { applyReactiveState, applyReactivePosition, startClipRelay, forceStopClipRelay } = await import('../services/clip-relay.js');
const { setClipStateEntry, getClipStateEntry, clearClipState } = await import('../services/clip-state.service.js');

const PROD = 'prod-relay-01';
const INPUT = 'video_in_0';

function clipStates() {
  return broadcasts.filter((m) => m.type === 'CLIP_STATE');
}

beforeEach(() => {
  broadcasts.length = 0;
  clearPersistedClipCue.mockClear();
  clearClipState(PROD);
});

describe('reactive MediaPlayerStateChanged mapping', () => {
  it('emits playing with position on a play push', () => {
    setClipStateEntry(PROD, { mixerInput: INPUT, state: 'cued', clipId: 'c1', durationMs: 8000 });
    applyReactiveState(PROD, INPUT, 'playing', 120, 8000);
    expect(clipStates().at(-1)).toMatchObject({ type: 'CLIP_STATE', mixerInput: INPUT, state: 'playing', positionMs: 120, durationMs: 8000, clipId: 'c1' });
    expect(getClipStateEntry(PROD, INPUT)?.state).toBe('playing');
  });

  it('maps a stopped push while playing to completed and clears the persisted cue', () => {
    setClipStateEntry(PROD, { mixerInput: INPUT, state: 'playing', clipId: 'c1', durationMs: 8000 });
    applyReactiveState(PROD, INPUT, 'stopped', 8000, 8000);
    expect(clipStates().at(-1)).toMatchObject({ state: 'completed', positionMs: 8000 });
    expect(clearPersistedClipCue).toHaveBeenCalledWith(PROD, INPUT);
  });

  it('emits paused on a pause push', () => {
    setClipStateEntry(PROD, { mixerInput: INPUT, state: 'playing', clipId: 'c1' });
    applyReactiveState(PROD, INPUT, 'paused', 500);
    expect(clipStates().at(-1)).toMatchObject({ state: 'paused', positionMs: 500 });
  });

  it('does NOT downgrade a cued clip on a raw stopped/paused push', () => {
    setClipStateEntry(PROD, { mixerInput: INPUT, state: 'cued', clipId: 'c1' });
    applyReactiveState(PROD, INPUT, 'stopped', 0);
    applyReactiveState(PROD, INPUT, 'paused', 0);
    expect(clipStates()).toHaveLength(0);
    expect(getClipStateEntry(PROD, INPUT)?.state).toBe('cued');
  });

  it('does NOT downgrade a completed clip on a raw stopped push', () => {
    setClipStateEntry(PROD, { mixerInput: INPUT, state: 'completed', clipId: 'c1' });
    applyReactiveState(PROD, INPUT, 'stopped', 8000);
    expect(clipStates()).toHaveLength(0);
  });

  it('allows a cued clip to transition to playing on a play push', () => {
    setClipStateEntry(PROD, { mixerInput: INPUT, state: 'cued', clipId: 'c1' });
    applyReactiveState(PROD, INPUT, 'playing', 10);
    expect(clipStates().at(-1)).toMatchObject({ state: 'playing' });
  });
});

describe('reactive MediaPlayerPosition mapping', () => {
  it('emits position updates only while playing', () => {
    setClipStateEntry(PROD, { mixerInput: INPUT, state: 'playing', clipId: 'c1', durationMs: 8000 });
    applyReactivePosition(PROD, INPUT, 3000, 8000);
    expect(clipStates().at(-1)).toMatchObject({ state: 'playing', positionMs: 3000, durationMs: 8000 });
  });

  it('ignores position ticks when not playing', () => {
    setClipStateEntry(PROD, { mixerInput: INPUT, state: 'cued', clipId: 'c1' });
    applyReactivePosition(PROD, INPUT, 3000);
    expect(clipStates()).toHaveLength(0);
  });

  it('ignores position ticks for an untracked input', () => {
    applyReactivePosition(PROD, INPUT, 3000);
    expect(clipStates()).toHaveLength(0);
  });
});

// End-to-end through the real connectWebSocket onEvent handler in strom.ts:
// a raw Strom frame (type+data envelope, routed by block_id) must produce the
// right CLIP_STATE. These fail if the routing field name or ns→ms handling is
// wrong — they exercise `event.data.block_id`, not the pure mappers.
describe('raw Strom frame through connectWebSocket -> clip-relay', () => {
  const FLOW = 'flow-abc';
  const BLOCK = 'mediaplayer-1';

  async function startRelay() {
    startClipRelay(PROD, FLOW, new Map([[BLOCK, INPUT]]));
    // Flush the getStromToken().then() microtask that registers the WS handlers.
    await Promise.resolve();
    await Promise.resolve();
  }

  beforeEach(() => {
    wsHandlers.clear();
    forceStopClipRelay(PROD);
  });

  it('routes MediaPlayerStateChanged by block_id to a playing CLIP_STATE', async () => {
    setClipStateEntry(PROD, { mixerInput: INPUT, state: 'cued', clipId: 'c1' });
    await startRelay();
    pushRawFrame(JSON.stringify({
      type: 'MediaPlayerStateChanged',
      data: { flow_id: FLOW, block_id: BLOCK, state: 'playing', current_file: '/media/c1.mp4' },
    }));
    expect(clipStates().at(-1)).toMatchObject({ type: 'CLIP_STATE', mixerInput: INPUT, state: 'playing' });
    expect(getClipStateEntry(PROD, INPUT)?.state).toBe('playing');
  });

  it('maps a raw stopped frame (while playing) to completed', async () => {
    setClipStateEntry(PROD, { mixerInput: INPUT, state: 'playing', clipId: 'c1' });
    await startRelay();
    pushRawFrame(JSON.stringify({
      type: 'MediaPlayerStateChanged',
      data: { flow_id: FLOW, block_id: BLOCK, state: 'stopped', current_file: null },
    }));
    expect(clipStates().at(-1)).toMatchObject({ state: 'completed' });
  });

  it('does NOT route a frame whose block_id is unknown (wrong-field guard)', async () => {
    setClipStateEntry(PROD, { mixerInput: INPUT, state: 'cued', clipId: 'c1' });
    await startRelay();
    pushRawFrame(JSON.stringify({
      type: 'MediaPlayerStateChanged',
      data: { flow_id: FLOW, block_id: 'some-other-block', state: 'playing' },
    }));
    expect(clipStates()).toHaveLength(0);
    expect(getClipStateEntry(PROD, INPUT)?.state).toBe('cued');
  });

  it('converts MediaPlayerPosition position_ns (ns) to positionMs (ms) while playing', async () => {
    setClipStateEntry(PROD, { mixerInput: INPUT, state: 'playing', clipId: 'c1' });
    await startRelay();
    pushRawFrame(JSON.stringify({
      type: 'MediaPlayerPosition',
      data: {
        flow_id: FLOW,
        block_id: BLOCK,
        position_ns: 3_000_000_000, // 3 s
        duration_ns: 8_000_000_000, // 8 s
        current_file_index: 0,
        total_files: 1,
      },
    }));
    expect(clipStates().at(-1)).toMatchObject({ state: 'playing', positionMs: 3000, durationMs: 8000 });
  });
});
