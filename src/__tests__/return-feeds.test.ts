/**
 * Unit tests for the per-guest return-feed (mix-minus) send-matrix construction
 * and to_main mirroring (epic #208, issue #300).
 */

import { describe, it, expect } from 'vitest';
import {
  assignReturnBuses,
  returnSendMatrix,
  mirrorToMainForPersistedReturns,
  RETURN_SEND_OPEN,
  RETURN_SEND_CLOSED,
  type PersistedReturnBus,
} from '../lib/return-feeds.js';
import type { ProductionSourceAssignment } from '../db/types.js';

const src = (name: string) => ({ streamType: 'whip' as const, name });

describe('assignReturnBuses — bus numbering invariant', () => {
  it('numbers return buses strictly after the crew aux buses, in mixerInput order', () => {
    const assignments: ProductionSourceAssignment[] = [
      { sourceId: 'a', mixerInput: 'video_in_0' }, // ch0, no return
      { sourceId: 'b', mixerInput: 'video_in_1', returnFeed: { synced: 'program-minus' } }, // ch1
      { sourceId: 'c', mixerInput: 'video_in_2', returnFeed: { synced: 'program' } }, // ch2
    ];
    const returns = assignReturnBuses(assignments, () => src('x'), 2 /* crew aux buses */);
    expect(returns).toHaveLength(2);
    // Crew aux buses are 1,2 → returns start at 3.
    expect(returns[0]).toMatchObject({ ownChannel: 1, auxBus: 3, mode: 'program-minus' });
    expect(returns[1]).toMatchObject({ ownChannel: 2, auxBus: 4, mode: 'program' });
  });

  it('ignores assignments without a returnFeed and inputs without audio', () => {
    const assignments: ProductionSourceAssignment[] = [
      { sourceId: 'a', mixerInput: 'video_in_0', returnFeed: { synced: 'program-minus' } },
      { sourceId: 'missing', mixerInput: 'video_in_1', returnFeed: { synced: 'program' } },
    ];
    // 'missing' resolves to undefined → no audio channel → no return bus.
    const returns = assignReturnBuses(
      assignments,
      (id) => (id === 'missing' ? undefined : src('x')),
      0,
    );
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({ ownChannel: 0, auxBus: 1 });
  });
});

describe('returnSendMatrix — send construction', () => {
  it('program-minus closes the guest own send and opens every other channel', () => {
    const m = returnSendMatrix(3 /* auxBus */, 1 /* ownChannel */, 'program-minus', 3);
    expect(m).toEqual({
      ch1_aux3_level: RETURN_SEND_OPEN,   // other channel — open
      ch2_aux3_level: RETURN_SEND_CLOSED, // own channel (0-based 1) — closed
      ch3_aux3_level: RETURN_SEND_OPEN,
    });
  });

  it('program opens every send including the guest own channel', () => {
    const m = returnSendMatrix(3, 1, 'program', 3);
    expect(m).toEqual({
      ch1_aux3_level: RETURN_SEND_OPEN,
      ch2_aux3_level: RETURN_SEND_OPEN, // own channel now open
      ch3_aux3_level: RETURN_SEND_OPEN,
    });
  });

  it('a channel off program (to_main false) stays closed even in program mode', () => {
    const toMain = new Map<number, boolean>([[0, true], [1, true], [2, false]]);
    const m = returnSendMatrix(3, 1, 'program', 3, toMain);
    expect(m['ch3_aux3_level']).toBe(RETURN_SEND_CLOSED); // ch2 (0-based) off program
    expect(m['ch1_aux3_level']).toBe(RETURN_SEND_OPEN);
  });
});

describe('mirrorToMainForPersistedReturns — crew mute/AFV mirroring', () => {
  const returns: PersistedReturnBus[] = [
    { mixerInput: 'video_in_1', auxBus: 3, ownChannel: 1, mode: 'program-minus' },
    { mixerInput: 'video_in_2', auxBus: 4, ownChannel: 2, mode: 'program' },
  ];

  it('closes a channel taken off program in every return', () => {
    const props = mirrorToMainForPersistedReturns(returns, new Map([[0, false]]));
    expect(props['ch1_aux3_level']).toBe(RETURN_SEND_CLOSED);
    expect(props['ch1_aux4_level']).toBe(RETURN_SEND_CLOSED);
  });

  it('reopens a channel put back on program, except a return own channel in program-minus', () => {
    // Put channel 1 (0-based) back on program.
    const props = mirrorToMainForPersistedReturns(returns, new Map([[1, true]]));
    // Return on video_in_1 owns channel 1 and is program-minus → stays closed.
    expect(props['ch2_aux3_level']).toBe(RETURN_SEND_CLOSED);
    // Return on video_in_2 does not own channel 1 → reopens.
    expect(props['ch2_aux4_level']).toBe(RETURN_SEND_OPEN);
  });

  it('produces no props when there are no returns', () => {
    expect(mirrorToMainForPersistedReturns([], new Map([[0, false]]))).toEqual({});
  });
});
