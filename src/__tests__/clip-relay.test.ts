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

const { applyReactiveState, applyReactivePosition } = await import('../services/clip-relay.js');
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
