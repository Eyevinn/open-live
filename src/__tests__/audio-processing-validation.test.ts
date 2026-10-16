/**
 * Issue #527 (OL-25): unit tests for the audio-processing contract
 * (`src/lib/audio-processing.ts`) — per-stage range validation, stage/element
 * compatibility, the mapping to Strom block-property keys (live vs
 * construction-time), and the persistence merge / connect-replay helpers.
 *
 * Ranges mirror Strom @8fce2ee exactly (definition.rs + types/src/mixer.rs,
 * cross-checked against the mixer UI slider ranges in frontend/src/mixer/detail.rs).
 */

import { describe, it, expect } from 'vitest';
import {
  parseStageParams,
  stageAllowedOnElement,
  stageToStromProps,
  mergeStageParams,
  mergeIntoStore,
  storedStagesForElement,
  allStoredStages,
  liveStromPropsFromStore,
  buildStromPropsFromStore,
  type AudioProcessingStore,
} from '../lib/audio-processing.js';

describe('audio-processing range validation (#527)', () => {
  it('accepts in-range comp params', () => {
    const r = parseStageParams('comp', { enabled: true, threshold: -24, ratio: 4 });
    expect(r.ok).toBe(true);
  });

  it('rejects comp ratio above the Strom range (1:1..20:1) — acceptance #4', () => {
    const r = parseStageParams('comp', { enabled: true, threshold: -24, ratio: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ratio/);
  });

  it('rejects gain outside -20..+20 dB', () => {
    expect(parseStageParams('gain', { gain: 21 }).ok).toBe(false);
    expect(parseStageParams('gain', { gain: -20 }).ok).toBe(true);
    expect(parseStageParams('gain', { gain: 20 }).ok).toBe(true);
  });

  it('rejects HPF freq outside 20..500 Hz', () => {
    expect(parseStageParams('hpf', { freq: 19 }).ok).toBe(false);
    expect(parseStageParams('hpf', { freq: 501 }).ok).toBe(false);
    expect(parseStageParams('hpf', { freq: 120 }).ok).toBe(true);
  });

  it('rejects EQ band gain outside -15..+15 dB and freq outside 20..20000 Hz', () => {
    expect(parseStageParams('eq', { bands: [{ band: 3, gain: 16 }] }).ok).toBe(false);
    expect(parseStageParams('eq', { bands: [{ band: 3, freq: 25000 }] }).ok).toBe(false);
    expect(parseStageParams('eq', { bands: [{ band: 3, freq: 1000, gain: -12, q: 2 }] }).ok).toBe(true);
  });

  it('rejects EQ band number outside 1..4', () => {
    expect(parseStageParams('eq', { bands: [{ band: 5, gain: 1 }] }).ok).toBe(false);
    expect(parseStageParams('eq', { bands: [{ band: 0, gain: 1 }] }).ok).toBe(false);
  });

  it('rejects limiter threshold outside -20..0 dB', () => {
    expect(parseStageParams('limiter', { threshold: -21 }).ok).toBe(false);
    expect(parseStageParams('limiter', { threshold: 1 }).ok).toBe(false);
    expect(parseStageParams('limiter', { enabled: true, threshold: -6 }).ok).toBe(true);
  });

  it('rejects unknown properties (no silent pass-through)', () => {
    expect(parseStageParams('comp', { threshold: -24, bogus: 1 }).ok).toBe(false);
  });
});

describe('stage/element compatibility (#527)', () => {
  it('limiter is main-only', () => {
    expect(stageAllowedOnElement('limiter', 'main')).toBe(true);
    expect(stageAllowedOnElement('limiter', 'ch1')).toBe(false);
  });

  it('gain/hpf/gate are channel-only', () => {
    for (const stage of ['gain', 'hpf', 'gate'] as const) {
      expect(stageAllowedOnElement(stage, 'ch1')).toBe(true);
      expect(stageAllowedOnElement(stage, 'main')).toBe(false);
    }
  });

  it('comp/eq are allowed on both channel and main', () => {
    for (const stage of ['comp', 'eq'] as const) {
      expect(stageAllowedOnElement(stage, 'ch2')).toBe(true);
      expect(stageAllowedOnElement(stage, 'main')).toBe(true);
    }
  });

  it('rejects an unknown element id', () => {
    expect(stageAllowedOnElement('comp', 'bus7')).toBe(false);
  });
});

describe('mapping to Strom block properties (#527)', () => {
  it('maps main comp params to main_comp_* live keys', () => {
    const { live, construct } = stageToStromProps('main', 'comp', { enabled: true, threshold: -24, ratio: 4 });
    expect(live).toEqual({ main_comp_enabled: true, main_comp_threshold: -24, main_comp_ratio: 4 });
    expect(construct).toEqual({});
  });

  it('maps channel gate params to chN_gate_* live keys', () => {
    const { live } = stageToStromProps('ch1', 'gate', { enabled: true, threshold: -40, attack: 5, release: 100 });
    expect(live).toEqual({ ch1_gate_enabled: true, ch1_gate_threshold: -40, ch1_gate_attack: 5, ch1_gate_release: 100 });
  });

  it('routes HPF enabled to construction-time, freq to live', () => {
    const { live, construct } = stageToStromProps('ch3', 'hpf', { enabled: true, freq: 120 });
    expect(construct).toEqual({ ch3_hpf_enabled: true });
    expect(live).toEqual({ ch3_hpf_freq: 120 });
  });

  it('maps EQ bands to chN_eqB_freq/gain/q', () => {
    const { live } = stageToStromProps('ch1', 'eq', {
      enabled: true,
      bands: [{ band: 3, freq: 1000, gain: -12, q: 2 }],
    });
    expect(live).toEqual({ ch1_eq_enabled: true, ch1_eq3_freq: 1000, ch1_eq3_gain: -12, ch1_eq3_q: 2 });
  });
});

describe('persistence merge + connect replay (#527)', () => {
  it('merges partial params per stage without wiping untouched values', () => {
    const merged = mergeStageParams('comp', { threshold: -24, ratio: 4 }, { ratio: 6 });
    expect(merged).toEqual({ threshold: -24, ratio: 6 });
  });

  it('merges EQ bands per band number', () => {
    const merged = mergeStageParams(
      'eq',
      { bands: [{ band: 1, gain: 3 }, { band: 2, gain: -2 }] },
      { bands: [{ band: 1, freq: 100 }] },
    );
    expect(merged.bands).toEqual([{ band: 1, gain: 3, freq: 100 }, { band: 2, gain: -2 }]);
  });

  it('mergeIntoStore returns a fresh store with the stage merged', () => {
    const s0: AudioProcessingStore = {};
    const s1 = mergeIntoStore(s0, 'ch1', 'comp', { threshold: -24 });
    const s2 = mergeIntoStore(s1, 'ch1', 'comp', { ratio: 4 });
    expect(s0).toEqual({}); // original untouched
    expect(s2.ch1!.comp).toEqual({ threshold: -24, ratio: 4 });
  });

  it('replays only stored stages, completed with defaults', () => {
    const store = mergeIntoStore({}, 'ch1', 'comp', { enabled: true, threshold: -24 });
    const views = storedStagesForElement(store, 'ch1');
    expect(views).toHaveLength(1);
    expect(views[0].stage).toBe('comp');
    // default-completed: ratio/attack/release/makeup/knee present
    expect(views[0].params).toMatchObject({ enabled: true, threshold: -24, ratio: 4, makeup: 0, knee: -6 });
    // a never-set element replays nothing
    expect(storedStagesForElement(store, 'main')).toHaveLength(0);
  });

  it('allStoredStages spans every element in the store', () => {
    let store: AudioProcessingStore = {};
    store = mergeIntoStore(store, 'ch1', 'gate', { enabled: true });
    store = mergeIntoStore(store, 'main', 'limiter', { enabled: true, threshold: -3 });
    const views = allStoredStages(store);
    expect(views.map((v) => `${v.elementId}:${v.stage}`).sort()).toEqual(['ch1:gate', 'main:limiter']);
  });

  it('liveStromPropsFromStore excludes construction-time HPF enabled; build includes it', () => {
    const store = mergeIntoStore({}, 'ch1', 'hpf', { enabled: true, freq: 100 });
    expect(liveStromPropsFromStore(store)).toEqual({ ch1_hpf_freq: 100 });
    expect(buildStromPropsFromStore(store)).toEqual({ ch1_hpf_enabled: true, ch1_hpf_freq: 100 });
  });
});
