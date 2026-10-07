/**
 * Unit tests for the stored ↔ compact vision-mixer pad translation (issue #463).
 */
import { describe, it, expect } from 'vitest';
import {
  storedPadIndex,
  mixerInputToStromPad,
  storedPadToStromPad,
  expandToStoredPadIndex,
} from '../lib/mixer-input-map.js';

// 4 cameras + 2 guest slots (video_in_15 = Guest 1, video_in_14 = Guest 2),
// compacted to a dense 0..5 range.
const MAP = {
  video_in_0: 0,
  video_in_1: 1,
  video_in_2: 2,
  video_in_3: 3,
  video_in_14: 4,
  video_in_15: 5,
};

describe('storedPadIndex', () => {
  it('parses the trailing numeric pad index', () => {
    expect(storedPadIndex('video_in_15')).toBe(15);
    expect(storedPadIndex('video_in_0')).toBe(0);
  });
  it('returns null for a non-matching name', () => {
    expect(storedPadIndex('not_a_pad')).toBeNull();
  });
});

describe('mixerInputToStromPad (forward, by name)', () => {
  it('maps a stored guest pad to its compact Strom pad', () => {
    expect(mixerInputToStromPad('video_in_15', MAP)).toBe(5);
    expect(mixerInputToStromPad('video_in_14', MAP)).toBe(4);
    expect(mixerInputToStromPad('video_in_0', MAP)).toBe(0);
  });
  it('falls back to the stored numeric index when not in the map', () => {
    expect(mixerInputToStromPad('video_in_7', MAP)).toBe(7);
  });
  it('is identity when no map is present', () => {
    expect(mixerInputToStromPad('video_in_15', undefined)).toBe(15);
  });
});

describe('storedPadToStromPad (forward, by numeric index)', () => {
  it('maps a stored numeric pad to its compact Strom pad', () => {
    expect(storedPadToStromPad(15, MAP)).toBe(5);
    expect(storedPadToStromPad(3, MAP)).toBe(3);
  });
  it('is identity for an unmapped index or no map', () => {
    expect(storedPadToStromPad(9, MAP)).toBe(9);
    expect(storedPadToStromPad(15, undefined)).toBe(15);
  });
});

describe('expandToStoredPadIndex (inverse)', () => {
  it('re-expands a compact Strom array back to stored pad indices', () => {
    // Strom reports resolutions indexed by compact pad 0..5.
    const compact = ['r0', 'r1', 'r2', 'r3', 'r14', 'r15'];
    const expanded = expandToStoredPadIndex(compact, MAP);
    expect(expanded[0]).toBe('r0');
    expect(expanded[3]).toBe('r3');
    // Guests re-land on their stored pads.
    expect(expanded[14]).toBe('r14');
    expect(expanded[15]).toBe('r15');
    // The gap pads (5..13) are null, not undefined.
    expect(expanded[5]).toBeNull();
    expect(expanded[13]).toBeNull();
  });
  it('passes the array through unchanged when no map is present', () => {
    const compact = ['a', 'b'];
    expect(expandToStoredPadIndex(compact, undefined)).toEqual(['a', 'b']);
  });
});
