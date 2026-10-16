/**
 * Audio processing control contract (issue #527, OL-25).
 *
 * The Strom `builtin.mixer` block exposes per-channel input gain, high-pass
 * filter, gate, compressor and 4-band parametric EQ, plus a compressor, 4-band
 * EQ and limiter on the main bus. Open Live drives these through the controller
 * WebSocket (`AUDIO_PROC_SET` / `AUDIO_PROC_STATE`) and the REST audio route.
 *
 * This module is the single source of truth for:
 *   - the per-stage parameter schemas and their RANGES, mirrored EXACTLY from
 *     Strom's own mixer surface at SHA `8fce2ee`
 *     (`backend/src/blocks/builtin/mixer/definition.rs` + `types/src/mixer.rs`,
 *     cross-checked against the Strom mixer UI slider ranges in
 *     `frontend/src/mixer/detail.rs`). `GET /api/blocks` on a running Strom is
 *     authoritative; these ranges reproduce it. Out-of-range values are
 *     REJECTED (no silent clamp — issue §"Proposed scope v1").
 *   - which stages are valid on a channel vs. the main bus;
 *   - the mapping from a validated `(elementId, stage, params)` tuple to the
 *     flat Strom block-property keys (`chN_*` / `main_*`), split into LIVE keys
 *     (applied immediately on the running pipeline) and CONSTRUCTION-TIME keys
 *     (only `chN_hpf_enabled`, which Strom marks `live: false` — it is applied
 *     at flow build time and "takes effect on next activation");
 *   - the stage DEFAULTS, so persisted state can be replayed on connect with
 *     complete values and a never-touched production reports nothing.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Stages and parameter schemas (ranges mirror Strom @8fce2ee exactly)
// ---------------------------------------------------------------------------

export const AUDIO_PROC_STAGES = ['gain', 'hpf', 'gate', 'comp', 'eq', 'limiter'] as const;
export type AudioProcStage = (typeof AUDIO_PROC_STAGES)[number];

/** EQ band: `band` is 1..4; freq/gain/q are partial so a single knob can move. */
const eqBandSchema = z
  .object({
    band: z.number().int().min(1).max(4),
    freq: z.number().min(20).max(20000).optional(),
    gain: z.number().min(-15).max(15).optional(),
    q: z.number().min(0.1).max(10).optional(),
  })
  .strict();

/**
 * Per-stage parameter schemas. Every numeric parameter is partial (except the
 * single `gain`) so a client can move one knob per message. `.strict()` rejects
 * unknown keys with a clear error, so a typo never silently reaches Strom.
 */
export const stageParamSchemas: Record<AudioProcStage, z.ZodTypeAny> = {
  // ch{N}_gain — dB, -20 to +20 (definition.rs:512-525)
  gain: z.object({ gain: z.number().min(-20).max(20) }).strict(),
  // ch{N}_hpf_freq — Hz, 20 to 500 (live); ch{N}_hpf_enabled — construction-time
  hpf: z
    .object({
      enabled: z.boolean().optional(),
      freq: z.number().min(20).max(500).optional(),
    })
    .strict(),
  // ch{N}_gate_* — threshold dB -60..0, attack ms 0.1..200, release ms 10..1000
  gate: z
    .object({
      enabled: z.boolean().optional(),
      threshold: z.number().min(-60).max(0).optional(),
      attack: z.number().min(0.1).max(200).optional(),
      release: z.number().min(10).max(1000).optional(),
    })
    .strict(),
  // {ch{N}|main}_comp_* — threshold dB -60..0, ratio 1..20, attack ms 0.1..200,
  // release ms 10..1000, makeup dB 0..24, knee dB -24..0
  comp: z
    .object({
      enabled: z.boolean().optional(),
      threshold: z.number().min(-60).max(0).optional(),
      ratio: z.number().min(1).max(20).optional(),
      attack: z.number().min(0.1).max(200).optional(),
      release: z.number().min(10).max(1000).optional(),
      makeup: z.number().min(0).max(24).optional(),
      knee: z.number().min(-24).max(0).optional(),
    })
    .strict(),
  // {ch{N}|main}_eq* — 4 bands: freq Hz 20..20000, gain dB -15..15, Q 0.1..10
  eq: z
    .object({
      enabled: z.boolean().optional(),
      bands: z.array(eqBandSchema).max(4).optional(),
    })
    .strict(),
  // main_limiter_* — threshold dB -20..0 (main bus only)
  limiter: z
    .object({
      enabled: z.boolean().optional(),
      threshold: z.number().min(-20).max(0).optional(),
    })
    .strict(),
};

export type StageParams = Record<string, unknown>;

/** Parse (and range-validate) raw params for a stage. */
export function parseStageParams(
  stage: AudioProcStage,
  params: unknown,
): { ok: true; params: StageParams } | { ok: false; error: string } {
  const result = stageParamSchemas[stage].safeParse(params);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    return { ok: false, error: `${path}${issue?.message ?? 'Invalid audio processing parameters'}` };
  }
  return { ok: true, params: result.data as StageParams };
}

// ---------------------------------------------------------------------------
// Element / stage compatibility
// ---------------------------------------------------------------------------

export function isChannelElement(elementId: string): boolean {
  return /^ch\d+$/.test(elementId);
}

export function isMainElement(elementId: string): boolean {
  return elementId === 'main';
}

/**
 * Stage/element compatibility (issue §"Proposed scope v1"):
 *   - gain, hpf, gate   → channel only
 *   - comp, eq          → channel OR main
 *   - limiter           → main only
 */
export function stageAllowedOnElement(stage: AudioProcStage, elementId: string): boolean {
  const main = isMainElement(elementId);
  const ch = isChannelElement(elementId);
  if (!main && !ch) return false;
  switch (stage) {
    case 'gain':
    case 'hpf':
    case 'gate':
      return ch;
    case 'comp':
    case 'eq':
      return ch || main;
    case 'limiter':
      return main;
  }
}

// ---------------------------------------------------------------------------
// Mapping to Strom block properties
// ---------------------------------------------------------------------------

export interface StromProcProps {
  /** Live-settable keys — applied immediately on the running pipeline. */
  live: Record<string, unknown>;
  /** Construction-time keys (only `chN_hpf_enabled`) — applied at flow build. */
  construct: Record<string, unknown>;
}

/**
 * Translate validated params into the flat Strom block-property keys. The
 * `elementId` ('ch1' | 'main') is already the Strom property prefix, so e.g.
 * `main` + `comp` + `{ threshold: -24 }` → `{ main_comp_threshold: -24 }`.
 *
 * Only `ch{N}_hpf_enabled` lands in `construct`: Strom marks it `live: false`
 * (definition.rs:674-690), so a live write would be rejected. It is applied at
 * flow build (flow-generator) and takes effect on the next activation.
 */
export function stageToStromProps(
  elementId: string,
  stage: AudioProcStage,
  params: StageParams,
): StromProcProps {
  const live: Record<string, unknown> = {};
  const construct: Record<string, unknown> = {};
  const p = elementId; // 'ch1' | 'main' — matches Strom property naming

  switch (stage) {
    case 'gain':
      if (params.gain !== undefined) live[`${p}_gain`] = params.gain;
      break;
    case 'hpf':
      if (params.enabled !== undefined) construct[`${p}_hpf_enabled`] = params.enabled;
      if (params.freq !== undefined) live[`${p}_hpf_freq`] = params.freq;
      break;
    case 'gate':
      if (params.enabled !== undefined) live[`${p}_gate_enabled`] = params.enabled;
      if (params.threshold !== undefined) live[`${p}_gate_threshold`] = params.threshold;
      if (params.attack !== undefined) live[`${p}_gate_attack`] = params.attack;
      if (params.release !== undefined) live[`${p}_gate_release`] = params.release;
      break;
    case 'comp':
      if (params.enabled !== undefined) live[`${p}_comp_enabled`] = params.enabled;
      if (params.threshold !== undefined) live[`${p}_comp_threshold`] = params.threshold;
      if (params.ratio !== undefined) live[`${p}_comp_ratio`] = params.ratio;
      if (params.attack !== undefined) live[`${p}_comp_attack`] = params.attack;
      if (params.release !== undefined) live[`${p}_comp_release`] = params.release;
      if (params.makeup !== undefined) live[`${p}_comp_makeup`] = params.makeup;
      if (params.knee !== undefined) live[`${p}_comp_knee`] = params.knee;
      break;
    case 'eq':
      if (params.enabled !== undefined) live[`${p}_eq_enabled`] = params.enabled;
      for (const band of (params.bands as Array<Record<string, unknown>> | undefined) ?? []) {
        const b = band.band as number;
        if (band.freq !== undefined) live[`${p}_eq${b}_freq`] = band.freq;
        if (band.gain !== undefined) live[`${p}_eq${b}_gain`] = band.gain;
        if (band.q !== undefined) live[`${p}_eq${b}_q`] = band.q;
      }
      break;
    case 'limiter':
      if (params.enabled !== undefined) live[`${p}_limiter_enabled`] = params.enabled;
      if (params.threshold !== undefined) live[`${p}_limiter_threshold`] = params.threshold;
      break;
  }
  return { live, construct };
}

// ---------------------------------------------------------------------------
// Defaults (Strom types/src/mixer.rs @8fce2ee) + state merge / persistence
// ---------------------------------------------------------------------------

/** Default EQ band frequencies (Hz): Low, Low-Mid, Hi-Mid, High. */
const DEFAULT_EQ_FREQS = [80, 400, 2000, 8000];

/** Default params for a stage — used to complete replayed state. */
export function defaultStageParams(stage: AudioProcStage): StageParams {
  switch (stage) {
    case 'gain':
      return { gain: 0 };
    case 'hpf':
      return { enabled: false, freq: 80 };
    case 'gate':
      return { enabled: false, threshold: -40, attack: 5, release: 100 };
    case 'comp':
      return { enabled: false, threshold: -20, ratio: 4, attack: 10, release: 100, makeup: 0, knee: -6 };
    case 'eq':
      return {
        enabled: false,
        bands: DEFAULT_EQ_FREQS.map((freq, i) => ({ band: i + 1, freq, gain: 0, q: 1 })),
      };
    case 'limiter':
      return { enabled: false, threshold: -3 };
  }
}

/** Stages that may carry persisted state on a given element. */
export function stagesForElement(elementId: string): AudioProcStage[] {
  return AUDIO_PROC_STAGES.filter((s) => stageAllowedOnElement(s, elementId));
}

/**
 * Persisted processing state, stored on the production document under
 * `audioProcessing`. Keyed by elementId ('ch1' | 'main'), then by stage. Only
 * stages an operator has actually set are present — a never-touched production
 * stores nothing and reports defaults.
 */
export type AudioProcessingStore = Record<string, Partial<Record<AudioProcStage, StageParams>>>;

/**
 * Merge incoming (already-validated, partial) params into the existing stored
 * params for a stage. For EQ, bands are merged per band number so moving one
 * band's gain does not wipe another band's freq.
 */
export function mergeStageParams(
  stage: AudioProcStage,
  existing: StageParams | undefined,
  incoming: StageParams,
): StageParams {
  if (stage === 'eq') {
    const bands = new Map<number, Record<string, unknown>>();
    for (const b of (existing?.bands as Array<Record<string, unknown>> | undefined) ?? []) {
      bands.set(b.band as number, { ...b });
    }
    for (const b of (incoming.bands as Array<Record<string, unknown>> | undefined) ?? []) {
      const num = b.band as number;
      bands.set(num, { ...bands.get(num), ...b });
    }
    const merged: StageParams = { ...existing, ...incoming };
    if (bands.size > 0) {
      merged.bands = [...bands.values()].sort((a, b) => (a.band as number) - (b.band as number));
    }
    return merged;
  }
  return { ...existing, ...incoming };
}

/**
 * Produce a new store with `(elementId, stage)` merged in. Returns a fresh
 * object (does not mutate the input) so it is safe to persist.
 */
export function mergeIntoStore(
  store: AudioProcessingStore | undefined,
  elementId: string,
  stage: AudioProcStage,
  params: StageParams,
): AudioProcessingStore {
  const next: AudioProcessingStore = { ...(store ?? {}) };
  const elem = { ...(next[elementId] ?? {}) };
  elem[stage] = mergeStageParams(stage, elem[stage], params);
  next[elementId] = elem;
  return next;
}

/** A single stage's current (default-completed) params for replay / REST. */
export interface ProcStageView {
  elementId: string;
  stage: AudioProcStage;
  params: StageParams;
}

/**
 * The stored stages for an element, each merged onto its defaults so the
 * emitted params are complete. Only stages actually present in the store are
 * returned — "every stage that differs from default" (issue §scope 2): a
 * never-set stage is absent.
 */
export function storedStagesForElement(
  store: AudioProcessingStore | undefined,
  elementId: string,
): ProcStageView[] {
  const elem = store?.[elementId];
  if (!elem) return [];
  const out: ProcStageView[] = [];
  for (const stage of stagesForElement(elementId)) {
    const stored = elem[stage];
    if (stored === undefined) continue;
    out.push({ elementId, stage, params: mergeStageParams(stage, defaultStageParams(stage), stored) });
  }
  return out;
}

/** Every stored stage across all elements (for connect replay). */
export function allStoredStages(store: AudioProcessingStore | undefined): ProcStageView[] {
  if (!store) return [];
  const out: ProcStageView[] = [];
  for (const elementId of Object.keys(store)) {
    out.push(...storedStagesForElement(store, elementId));
  }
  return out;
}

/**
 * Collect the LIVE Strom block properties for every stored stage, to re-apply
 * on a running flow (connect-time / reactivation). Construction-time keys
 * (`chN_hpf_enabled`) are excluded — they are applied by the flow generator.
 */
export function liveStromPropsFromStore(store: AudioProcessingStore | undefined): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const { elementId, stage, params } of allStoredStages(store)) {
    Object.assign(props, stageToStromProps(elementId, stage, params).live);
  }
  return props;
}

/**
 * Collect ALL Strom block properties (live + construction-time) for every
 * stored stage, to seed the mixer block at flow BUILD time (flow-generator), so
 * processing — including the construction-time HPF on/off — is restored on
 * every activation.
 */
export function buildStromPropsFromStore(store: AudioProcessingStore | undefined): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const { elementId, stage, params } of allStoredStages(store)) {
    const { live, construct } = stageToStromProps(elementId, stage, params);
    Object.assign(props, live, construct);
  }
  return props;
}
