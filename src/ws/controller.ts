import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { z } from 'zod';
import { getDb, getSourcesDb } from '../db/index.js';
import { updateProductionDoc } from '../routes/productions.js';
import type { ProductionDoc } from '../db/types.js';
import { getTally, setTally, subscribe, unsubscribe, broadcast } from '../services/tally.service.js';
import { startMeterRelay, stopMeterRelay } from '../services/meter-relay.js';
import { StromClient, StromClientError, type TransitionType as StromTransitionType, type PipZone, type PipConfig, type PipTransforms, type VideoEffect, type EffectTarget, type SetVideoEffectRequest } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';
import { notifySubscriberJoin } from '../services/idle-watchdog.js';
import { activePflByProduction, activeAflByProduction, anySoloActive, numAudioChannelsByProduction } from '../services/pfl-state.js';

function stromErrorMessage(err: unknown): string {
  if (err instanceof StromClientError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// Mirror of MAX_DB_WRITE_RETRIES in routes/productions.ts — the number of
// insert attempts a mixer write makes before giving up on a CouchDB 409.
const MAX_DB_WRITE_RETRIES = 3;

function isConflictError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'statusCode' in err &&
    (err as { statusCode?: number }).statusCode === 409
  );
}

/**
 * Durably persist a mixer mutation to a ProductionDoc.
 *
 * CouchDB rejects an insert with 409 when the doc's `_rev` is stale (a
 * concurrent write landed first). Previously these mixer writes swallowed the
 * 409 and moved on, so the broadcast reflected a cut/transition that was never
 * saved. Here we re-read the latest doc and re-apply the mutation against the
 * fresh `_rev` before each retry, so the change actually lands. `mutate`
 * receives the freshly read doc and returns the updated doc to insert;
 * `updatedAt` is stamped automatically. If every attempt still conflicts the
 * failure is logged at warn (with productionId + action) instead of silently
 * dropped — it is no longer thrown, to keep the mixer broadcast path unchanged.
 */
async function persistMixerMutation(
  productionId: string,
  action: string,
  mutate: (doc: ProductionDoc) => ProductionDoc,
): Promise<void> {
  const db = getDb();
  for (let attempt = 0; attempt < MAX_DB_WRITE_RETRIES; attempt++) {
    try {
      const current = await db.get(productionId);
      const updated: ProductionDoc = {
        ...mutate(current),
        updatedAt: new Date().toISOString(),
      };
      await db.insert(updated);
      return;
    } catch (err) {
      // On a revision conflict, loop to re-read the latest _rev and re-apply.
      if (isConflictError(err) && attempt < MAX_DB_WRITE_RETRIES - 1) continue;
      console.warn(
        `[controller] Failed to persist mixer mutation after ${attempt + 1} attempt(s)`,
        { productionId, action },
        err,
      );
      return;
    }
  }
}

type InboundMessage =
  | { type: 'CUT'; mixerInput: string; afvRampUpMs?: number; afvRampDownMs?: number }
  | { type: 'TRANSITION'; mixerInput: string; transitionType: string; durationMs?: number; afvRampUpMs?: number; afvRampDownMs?: number }
  | { type: 'TAKE'; pip?: number; transitionType?: string; durationMs?: number; afvRampUpMs?: number; afvRampDownMs?: number }
  | { type: 'SET_PVW'; mixerInput: string }
  | { type: 'FTB'; active?: boolean; durationMs?: number }
  | { type: 'SET_OVL'; alpha: number }
  | { type: 'GO_LIVE' }
  | { type: 'CUT_STREAM' }
  | { type: 'GRAPHIC_ON'; overlayId: string }
  | { type: 'GRAPHIC_OFF'; overlayId: string }
  | { type: 'DSK_TOGGLE'; layer: number; visible?: boolean }
  | { type: 'MACRO_EXEC'; macroId: string }
  | { type: 'AUDIO_SET'; elementId: string; property: 'volume' | 'mute'; value: unknown; ramp_ms?: number }
  | { type: 'AFV_SET'; mixerInput: string; enabled: boolean }
  | { type: 'AFV_RAMP_SET'; rampUpMs: number; rampDownMs: number }
  | { type: 'PFL_SET'; elementId: string; enabled: boolean; volume?: number }
  | { type: 'AFL_SET'; elementId: string; enabled: boolean }
  | { type: 'AUX_SEND_SET'; elementId: string; auxBus: number; level: number; enabled: boolean; pre?: boolean }
  | { type: 'AUX_MASTER_SET'; auxBus: number; volume: number; muted: boolean }
  | { type: 'GRP_SEND_SET'; elementId: string; grpBus: number; level: number; enabled: boolean }
  | { type: 'GRP_MASTER_SET'; grpBus: number; volume: number; muted: boolean }
  | { type: 'MONITOR_SET'; volume: number; muted: boolean }
  | { type: 'SOURCE_OFFSET_SET'; mixerInput: string; offsetMs: number }
  | { type: 'SOURCE_AUDIO_OFFSET_SET'; mixerInput: string; offsetMs: number }
  | { type: 'LOUDNESS_RESET' }
  | { type: 'SELECT_PVW_PIP'; pip: number }
  | { type: 'SET_PIP'; pip: number; bg: number | null; zones: PipZone[]; transforms?: PipTransforms }
  | { type: 'SET_EFFECT'; target: EffectTarget; effect: VideoEffect };

// ---------------------------------------------------------------------------
// Runtime schema validation for inbound WS messages
// ---------------------------------------------------------------------------

const mixerInputSchema = z.string().regex(/^video_in_\d{1,2}$/).max(20);
const elementIdSchema = z.string().min(1).max(128);
const pipIndexSchema = z.number().int().min(0).max(3);
const layerSchema = z.number().int().min(0).max(3);
const alphaSchema = z.number().min(0).max(1);
const levelSchema = z.number().min(0).max(1);
const faderSchema = z.number().min(0).max(10); // Strom mixer ceiling
const busSchema = z.number().int().min(1).max(8);
const rampMsSchema = z.number().int().min(0).max(60000);
const offsetMsSchema = z.number().int().min(0).max(60000);

const PipZoneSchema = z.object({
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  capacity: z.number().nullable(),
  sources: z.array(z.number().int().min(0).max(15)),
  border: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'Must be #RRGGBB or #RRGGBBAA'), width: z.number().int().min(0).max(64) }).nullish(),
});

const TransitionTypeSchema = z.enum([
  'cut', 'fade', 'dip_to_black',
  'slide_left', 'slide_right', 'slide_up', 'slide_down',
  'push_left', 'push_right', 'push_up', 'push_down',
  'wipe_left', 'wipe_right', 'wipe_up', 'wipe_down',
  'iris_open', 'iris_close', 'clock_wipe', 'blinds', 'checker',
  'noise_dissolve', 'luma_wipe', 'barn_doors', 'star_wipe',
  'pinwheel', 'crosshatch', 'hex_dissolve', 'warp_wipe', 'melt', 'heart_iris',
  'glitch_cut', 'flash_dissolve', 'whip_pan_left', 'whip_pan_right',
  'punch_zoom', 'pixelate_take', 'zoom_blur', 'spin', 'tv_roll',
  'negative_flash', 'ripple',
]);

const InboundMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CUT'), mixerInput: mixerInputSchema, afvRampUpMs: rampMsSchema.optional(), afvRampDownMs: rampMsSchema.optional() }),
  z.object({ type: z.literal('TRANSITION'), mixerInput: mixerInputSchema, transitionType: TransitionTypeSchema, durationMs: rampMsSchema.optional(), afvRampUpMs: rampMsSchema.optional(), afvRampDownMs: rampMsSchema.optional() }),
  z.object({ type: z.literal('TAKE'), pip: pipIndexSchema.optional(), transitionType: TransitionTypeSchema.optional(), durationMs: rampMsSchema.optional(), afvRampUpMs: rampMsSchema.optional(), afvRampDownMs: rampMsSchema.optional() }),
  z.object({ type: z.literal('SET_PVW'), mixerInput: mixerInputSchema }),
  z.object({ type: z.literal('FTB'), active: z.boolean().optional(), durationMs: rampMsSchema.optional() }),
  z.object({ type: z.literal('SET_OVL'), alpha: alphaSchema }),
  z.object({ type: z.literal('GO_LIVE') }),
  z.object({ type: z.literal('CUT_STREAM') }),
  z.object({ type: z.literal('GRAPHIC_ON'), overlayId: z.string().min(1).max(128) }),
  z.object({ type: z.literal('GRAPHIC_OFF'), overlayId: z.string().min(1).max(128) }),
  z.object({ type: z.literal('DSK_TOGGLE'), layer: layerSchema, visible: z.boolean().optional() }),
  z.object({ type: z.literal('MACRO_EXEC'), macroId: z.string().min(1).max(128) }),
  z.object({
    type: z.literal('AUDIO_SET'),
    elementId: elementIdSchema,
    property: z.enum(['volume', 'mute']),
    value: z.union([z.number().min(0).max(10), z.boolean()]),
    ramp_ms: rampMsSchema.optional(),
  }),
  z.object({ type: z.literal('AFV_SET'), mixerInput: mixerInputSchema, enabled: z.boolean() }),
  z.object({ type: z.literal('AFV_RAMP_SET'), rampUpMs: rampMsSchema, rampDownMs: rampMsSchema }),
  z.object({ type: z.literal('PFL_SET'), elementId: elementIdSchema, enabled: z.boolean(), volume: levelSchema.optional() }),
  z.object({ type: z.literal('AFL_SET'), elementId: elementIdSchema, enabled: z.boolean() }),
  z.object({ type: z.literal('AUX_SEND_SET'), elementId: elementIdSchema, auxBus: busSchema, level: levelSchema, enabled: z.boolean(), pre: z.boolean().optional() }),
  z.object({ type: z.literal('AUX_MASTER_SET'), auxBus: busSchema, volume: faderSchema, muted: z.boolean() }),
  z.object({ type: z.literal('GRP_SEND_SET'), elementId: elementIdSchema, grpBus: busSchema, level: levelSchema, enabled: z.boolean() }),
  z.object({ type: z.literal('GRP_MASTER_SET'), grpBus: busSchema, volume: faderSchema, muted: z.boolean() }),
  z.object({ type: z.literal('MONITOR_SET'), volume: faderSchema, muted: z.boolean() }),
  z.object({ type: z.literal('SOURCE_OFFSET_SET'), mixerInput: mixerInputSchema, offsetMs: offsetMsSchema }),
  z.object({ type: z.literal('SOURCE_AUDIO_OFFSET_SET'), mixerInput: mixerInputSchema, offsetMs: offsetMsSchema }),
  z.object({ type: z.literal('LOUDNESS_RESET') }),
  z.object({ type: z.literal('SELECT_PVW_PIP'), pip: pipIndexSchema }),
  z.object({
    type: z.literal('SET_PIP'),
    pip: pipIndexSchema,
    bg: z.number().int().min(0).max(15).nullable(),
    zones: z.array(PipZoneSchema).max(15),
    transforms: z.record(z.string(), z.object({ left: z.number().min(0).max(1), top: z.number().min(0).max(1), right: z.number().min(0).max(1), bottom: z.number().min(0).max(1) })).optional(),
  }),
  z.object({
    type: z.literal('SET_EFFECT'),
    target: z.union([z.object({ input: z.number().int().min(0).max(15) }), z.literal('master')]),
    effect: z.discriminatedUnion('type', [
      z.object({ type: z.literal('none') }),
      z.object({ type: z.literal('chroma_key'), key_color: z.string().optional(), similarity: z.number().optional(), smoothness: z.number().optional(), spill: z.number().optional() }),
      z.object({ type: z.literal('pixelate'), block_size: z.number().int().min(1).max(512).optional() }),
      z.object({ type: z.literal('blur'), radius: z.number().min(0).max(100).optional() }),
      z.object({ type: z.literal('duotone'), low: z.string().optional(), high: z.string().optional(), mix: z.number().min(0).max(1).optional() }),
      z.object({ type: z.literal('vignette'), amount: z.number().min(0).max(1).optional(), softness: z.number().min(0).max(1).optional() }),
      z.object({ type: z.literal('vhs'), intensity: z.number().min(0).max(1).optional() }),
      z.object({ type: z.literal('old_film'), intensity: z.number().min(0).max(1).optional() }),
      z.object({ type: z.literal('edge_glow'), color: z.string().optional(), intensity: z.number().min(0).max(1).optional() }),
      z.object({ type: z.literal('crt'), intensity: z.number().min(0).max(1).optional() }),
      z.object({ type: z.literal('halftone'), dot_size: z.number().min(1).max(64).optional() }),
      z.object({ type: z.literal('thermal'), intensity: z.number().min(0).max(1).optional() }),
      z.object({ type: z.literal('night_vision'), intensity: z.number().min(0).max(1).optional() }),
      z.object({ type: z.literal('posterize'), levels: z.number().int().min(2).max(256).optional() }),
      z.object({ type: z.literal('underwater'), intensity: z.number().min(0).max(1).optional() }),
      z.object({ type: z.literal('color_correct'), brightness: z.number().optional(), contrast: z.number().optional(), saturation: z.number().optional(), hue: z.number().optional(), gamma: z.number().optional(), temperature: z.number().optional(), tint: z.number().optional() }),
    ]),
  }),
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the numeric index from a mixer pad name like "video_in_2" → 2.
 * Returns null if the pad name doesn't match the expected format.
 */
function padToIndex(mixerInput: string): number | null {
  const match = /video_in_(\d+)$/.exec(mixerInput);
  return match ? parseInt(match[1], 10) : null;
}

function toStromTransition(type: string): StromTransitionType {
  return type || 'cut';
}

async function makeStromClient(): Promise<StromClient> {
  const token = await getStromToken(config.stromToken).catch(() => undefined)
  return new StromClient({ baseUrl: config.stromUrl, token })
}

async function stromTransition(
  doc: ProductionDoc,
  fromMixerInput: string | null,
  toMixerInput: string | null,
  transitionType: StromTransitionType,
  durationMs?: number,
): Promise<void> {
  if (!doc.stromFlowId || !doc.mixerBlockId) return;
  if (!toMixerInput) {
    console.warn('[controller] Strom transition skipped — no toMixerInput');
    return;
  }
  const toIndex = padToIndex(toMixerInput);
  if (toIndex === null) {
    console.warn('[controller] Strom transition skipped — cannot parse index from pad:', toMixerInput);
    return;
  }
  // Set Strom's PVW to the target input first, then fire the transition.
  // Strom's trigger_transition uses from_input/to_input directly — selectPreview
  // call is belt-and-suspenders so Strom's own UI also reflects the new PVW.
  const fromIndex = fromMixerInput ? (padToIndex(fromMixerInput) ?? toIndex) : toIndex;
  const strom = await makeStromClient();
  try {
    // selectPreview is belt-and-suspenders so Strom's own UI reflects the new
    // PVW. It can legitimately fail (400) when the target input is already the
    // sole program source (e.g. cutting away from a PiP overlay whose background
    // is the same real input). Treat the failure as non-fatal and still fire the
    // transition so the actual cut always reaches Strom.
    await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { input: toIndex } });
  } catch (err) {
    console.debug('[controller] Strom selectPreview (non-fatal, transition will still fire):', err);
  }
  try {
    await strom.mixer.transition(doc.stromFlowId, doc.mixerBlockId, {
      from_input: fromIndex,
      to_input: toIndex,
      transition_type: transitionType,
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    });
  } catch (err) {
    console.warn('[controller] Strom transition error:', err);
  }
}

// ---------------------------------------------------------------------------
// Audio volume debounce
// ---------------------------------------------------------------------------

// Debounce rapid volume nudges so back-to-back AUDIO_SET volume messages don't
// flood Strom's HTTP connection pool. Mute changes skip the debounce.
const pendingVolume = new Map<string, NodeJS.Timeout>()

// ---------------------------------------------------------------------------
// Audio follow — AFV registry
// ---------------------------------------------------------------------------

/**
 * Per-production set of mixerInput values that have AFV enabled.
 * Populated by AFV_SET messages from the frontend. Only channels in this set
 * have their routing updated on cuts — channels not in the set are under
 * manual operator control and are never touched by the switcher.
 */
const afvChannelsByProduction = new Map<string, Set<string>>()

/**
 * Per-production set of elementIds (e.g. "ch1") whose ON/OFF is currently OFF.
 * ON/OFF muting targets to_main_vol_N (routing layer) so that volume_N:mute
 * stays false — keeping the channel signal alive and meters visible even when
 * a strip is muted. This registry lets the backend restore mute state on
 * reconnect without reading from Strom (which would return routing-layer values
 * commingled with AFV routing).
 */
const mutedElementsByProduction = new Map<string, Set<string>>()

/**
 * Last-seen stromFlowId per production.
 * A changed flowId means the pipeline was rebuilt (sources remapped, etc.) so
 * any cached channel-index state is invalid and must be cleared immediately
 * even if a client stayed connected across the restart.
 */
const activeFlowIdByProduction = new Map<string, string>()

/**
 * Per-production channel fader level cache.
 * Maps productionId → (elementId → level). elementId is 'ch1', 'ch2', ..., 'main'.
 * Updated immediately on every AUDIO_SET volume message so reconnecting clients
 * receive the last-known fader position even if Strom's block properties don't
 * persist dynamically-set ch${N}_fader values.
 */
const channelLevelsByProduction = new Map<string, Map<string, number>>()

/**
 * Per-production runtime offset registry.
 * Maps productionId → (mixerInput → offsetMs).
 * Populated by SOURCE_OFFSET_SET messages; sent to new clients on connect.
 */
const sourceOffsetsByProduction = new Map<string, Map<string, number>>()

/**
 * Per-production runtime audio offset registry.
 * Maps productionId → (mixerInput → offsetMs).
 * Populated by SOURCE_AUDIO_OFFSET_SET messages; sent to new clients on connect.
 */
const sourceAudioOffsetsByProduction = new Map<string, Map<string, number>>()

/**
 * Per-production AFV ramp settings.
 * Maps productionId → { rampUpMs, rampDownMs }.
 * Populated by AFV_RAMP_SET messages; sent to new clients on connect.
 */
const afvRampByProduction = new Map<string, { rampUpMs: number; rampDownMs: number }>()

/**
 * Per-production AUX send state cache.
 * Maps productionId → (`ch{N}_aux{M}` → { level, enabled, pre }).
 * Updated on every AUX_SEND_SET so reconnecting clients restore the full per-channel
 * send state (fader position, ON/OFF, and pre/post toggle).
 */
const auxSendByProduction = new Map<string, Map<string, { level: number; enabled: boolean; pre: boolean }>>()

/**
 * Per-production AUX master state cache.
 * Maps productionId → (auxBus(1-indexed) → { volume, muted }).
 * Supplements the Strom block-property fallback so restores work even when Strom
 * is unreachable and the value is authoritative for the current operator session.
 */
const auxMasterByProduction = new Map<string, Map<number, { volume: number; muted: boolean }>>()

/**
 * Per-production GRP send (assignment) state cache.
 * Maps productionId → (`ch{N}_grp{M}` → { level, enabled }).
 * Populated by GRP_SEND_SET messages so the G1/G2 button state survives reconnects.
 */
const grpSendByProduction = new Map<string, Map<string, { level: number; enabled: boolean }>>()

/**
 * Per-production GRP master state cache.
 * Maps productionId → (grpBus(1-indexed) → { volume, muted }).
 */
const grpMasterByProduction = new Map<string, Map<number, { volume: number; muted: boolean }>>()
const monitorByProduction   = new Map<string, { volume: number; muted: boolean }>()

const pgmPipByProduction    = new Map<string, number | null>()
const pvwPipByProduction    = new Map<string, number | null>()
const pipConfigsByProduction = new Map<string, PipConfig[]>()

/** productionId → per-input effects (index = mixerInput index) */
const inputEffectsByProduction = new Map<string, VideoEffect[]>();
/** productionId → master output effect */
const masterEffectByProduction = new Map<string, VideoEffect>();
/** productionId → whether FX engine is available (GPU backend) */
const fxAvailableByProduction = new Map<string, boolean>();

const overlayAlphaByProduction = new Map<string, number>()
const dskLayersByProduction    = new Map<string, Record<number, boolean>>()

/**
 * PVW mixer-input pad that was on PVW immediately before SELECT_PVW_PIP was
 * received.  Stored so the PiP TAKE can pass it as `to_input` to Strom,
 * which becomes Strom's `pgm_input` (real background behind the PiP) after
 * the swap — keeping pgm_input ≠ pvw_input and avoiding the 400 "sole
 * program source" error on the next selectPreview call.
 */
const pvwBeforePipByProduction = new Map<string, string | null>()

/**
 * Strom's real pgm_input (background behind the PiP) while a PiP is on PGM.
 * Set when a PiP TAKE completes; cleared when a real-source CUT/TRANSITION
 * removes the PiP from PGM.  Used as `fromMixerInput` in stromTransition so
 * the cut has the correct from_input instead of defaulting to toIndex.
 */
const pgmBgByProduction = new Map<string, string | null>()


/** Wipe all per-production audio state. Called when the pipeline changes or production deactivates. */
export function clearAudioState(productionId: string): void {
  afvChannelsByProduction.delete(productionId)
  afvRampByProduction.delete(productionId)
  mutedElementsByProduction.delete(productionId)
  activeFlowIdByProduction.delete(productionId)
  sourceOffsetsByProduction.delete(productionId)
  sourceAudioOffsetsByProduction.delete(productionId)
  numAudioChannelsByProduction.delete(productionId)
  channelLevelsByProduction.delete(productionId)
  auxSendByProduction.delete(productionId)
  auxMasterByProduction.delete(productionId)
  grpSendByProduction.delete(productionId)
  grpMasterByProduction.delete(productionId)
  monitorByProduction.delete(productionId)
  pvwBeforePipByProduction.delete(productionId)
  pgmBgByProduction.delete(productionId)
  pgmPipByProduction.delete(productionId)
  pvwPipByProduction.delete(productionId)
}

/**
 * Flush all PiP state on deactivation — zone configs, pgm/pvw selection.
 * Strom resets its own PiP config on flow teardown, so preserving zones would
 * cause a UI/Strom mismatch on restart.
 * Broadcasts PIP_STATE so all connected clients reset their PiP indicators.
 */
export function clearPipState(productionId: string): void {
  pipConfigsByProduction.delete(productionId)
  pgmPipByProduction.delete(productionId)
  pvwPipByProduction.delete(productionId)
  pvwBeforePipByProduction.delete(productionId)
  pgmBgByProduction.delete(productionId)
  overlayAlphaByProduction.delete(productionId)
  dskLayersByProduction.delete(productionId)
  broadcast(productionId, {
    type: 'PIP_STATE',
    pgmPip: null,
    pvwPip: null,
    pips: [],
  })
}

/**
 * Read-only view of the in-memory PiP layout cache for a production.
 * Exported for tests.
 */
export function getPipConfigs(productionId: string): PipConfig[] | undefined {
  return pipConfigsByProduction.get(productionId)
}

/**
 * Store one PiP slot's layout in the in-memory cache and return the updated
 * array. Does not persist to the DB — callers own persistence.
 */
export function setPipConfigSlot(productionId: string, pip: number, cfg: PipConfig): PipConfig[] {
  const pips = (pipConfigsByProduction.get(productionId) ?? []).slice()
  pips[pip] = cfg
  pipConfigsByProduction.set(productionId, pips)
  return pips
}

/**
 * Hydrate the in-memory PiP cache for a production from its persisted
 * ProductionDoc.pipConfigs (issue #177). Only runs when the cache is cold, so
 * live edits are never clobbered. Falls back to empty slots seeded from
 * num_pips when nothing was persisted.
 *
 * Returns the restored persisted layout when it was populated from the doc
 * (so the caller can re-push it to Strom), otherwise null.
 */
export function hydratePipConfigsFromDoc(doc: ProductionDoc): PipConfig[] | null {
  if (pipConfigsByProduction.has(doc._id)) return null
  const rawNumPips = doc.values?.num_pips
  const numPips = typeof rawNumPips === 'number' ? Math.max(0, Math.round(rawNumPips))
    : typeof rawNumPips === 'string' ? Math.max(0, parseInt(rawNumPips, 10) || 0)
    : 0
  const persisted = doc.pipConfigs
  if (persisted && persisted.length > 0) {
    // Pad/truncate to the currently configured slot count so the cache matches
    // num_pips even if it changed since the layout was saved.
    const restored = Array.from({ length: Math.max(numPips, persisted.length) }, (_, i) =>
      persisted[i] ?? { bg: null, zones: [], transforms: {} })
    pipConfigsByProduction.set(doc._id, restored)
    return restored
  }
  if (numPips > 0) {
    pipConfigsByProduction.set(doc._id, Array.from({ length: numPips }, () => ({ bg: null, zones: [], transforms: {} })))
  }
  return null
}

/** Wipe all per-production FX state. Called when the pipeline changes or production deactivates. */
export function clearFxState(productionId: string): void {
  inputEffectsByProduction.delete(productionId)
  masterEffectByProduction.delete(productionId)
  fxAvailableByProduction.delete(productionId)
}

/**
 * Returns the 0-based audio channel index for a given mixerInput, or null if
 * the source has no audio channel (test sources are skipped).
 * WHIP and HTML sources carry audio and are included.
 */
async function resolveAudioChannelIndex(doc: ProductionDoc, mixerInput: string): Promise<number | null> {
  const sorted = [...doc.sources].sort((a, b) => a.mixerInput.localeCompare(b.mixerInput));
  const sourcesDb = getSourcesDb();
  let audioIdx = 0;
  for (const assignment of sorted) {
    let streamType: string | undefined;
    try {
      const src = await sourcesDb.get(assignment.sourceId);
      streamType = src.streamType;
    } catch {
      // "Whip" is a virtual WHIP source that carries audio — treat it as 'whip'
      if (assignment.sourceId === 'Whip') {
        streamType = 'whip';
      } else {
        continue; // other virtual sources (test1, test2) have no audio
      }
    }
    if (streamType === 'test1' || streamType === 'test2') continue;
    if (assignment.mixerInput === mixerInput) return audioIdx;
    audioIdx++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Audio follow
// ---------------------------------------------------------------------------

/**
 * Updates the routing mute (to_main_vol_N:mute) for channels that have AFV
 * enabled so that only the PGM source is audible. Channels without AFV are
 * skipped — they remain under manual operator control via the ON/OFF button.
 * At initial connect (no AFV channels registered yet) it routes only the PGM
 * source so the production starts in a sane state.
 */
async function applyAudioFollow(
  productionId: string,
  doc: ProductionDoc,
  newPgmMixerInput: string | null,
  stromFlowId: string,
  audioBlockId: string,
  strom: StromClient,
  rampUpMs = 300,
  rampDownMs = 50,
): Promise<void> {
  // Default to empty set — an uninitialised registry never routes all channels.
  const afvChannels = afvChannelsByProduction.get(productionId) ?? new Set<string>();
  const sorted = [...doc.sources].sort((a, b) => a.mixerInput.localeCompare(b.mixerInput));
  const sourcesDb = getSourcesDb();

  let audioIdx = 0;
  const properties: Record<string, unknown> = {};
  const ramp_ms_overrides: Record<string, number> = {};
  for (const assignment of sorted) {
    let streamType: string | undefined;
    try {
      const src = await sourcesDb.get(assignment.sourceId);
      streamType = src.streamType;
    } catch {
      // "Whip" is a virtual WHIP source that carries audio — treat it as 'whip'
      if (assignment.sourceId === 'Whip') {
        streamType = 'whip';
      } else {
        continue; // other virtual sources (test1, test2) have no audio
      }
    }
    if (streamType === 'test1' || streamType === 'test2') continue;

    const chIdx = ++audioIdx;
    // Only update routing for channels the operator has opted into AFV.
    // Channels with AFV off are never touched by the switcher.
    if (!afvChannels.has(assignment.mixerInput)) continue;

    const routed = newPgmMixerInput === null || assignment.mixerInput === newPgmMixerInput;
    const key = `ch${chIdx}_to_main`;
    properties[key] = routed;
    ramp_ms_overrides[key] = routed ? rampUpMs : rampDownMs;
  }
  if (Object.keys(properties).length > 0) {
    await strom.flows.updateBlockProperties(stromFlowId, audioBlockId, { properties, ramp_ms_overrides })
      .catch((err) => console.warn('[controller] audio follow error:', String(err)));
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function handleMessage(
  productionId: string,
  ws: WebSocket,
  raw: string,
  ctx: { audioBlockId?: string },
): Promise<void> {
  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(raw);
  } catch {
    ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid JSON' }));
    return;
  }
  const parseResult = InboundMessageSchema.safeParse(rawParsed);
  if (!parseResult.success) {
    ws.send(JSON.stringify({ type: 'ERROR', error: parseResult.error.issues[0]?.message ?? 'Invalid message' }));
    return;
  }
  const msg: InboundMessage = parseResult.data as unknown as InboundMessage;


  const db = getDb();
  let doc: ProductionDoc;
  try {
    doc = await db.get(productionId);
  } catch {
    ws.send(JSON.stringify({ type: 'ERROR', error: 'Production not found' }));
    return;
  }

  switch (msg.type) {
    case 'CUT': {
      const tally = getTally(productionId);
      // When a PiP is on PGM, tally.pgm is null. Use the tracked Strom PGM
      // background input so stromTransition has a valid from_input.
      const curPgmPipCut = pgmPipByProduction.get(productionId) ?? null;
      const fromPadCut = (curPgmPipCut !== null && tally.pgm === null)
        ? (pgmBgByProduction.get(productionId) ?? null)
        : tally.pgm;
      const newTally = { pgm: msg.mixerInput, pvw: tally.pgm };
      setTally(productionId, newTally);
      const curPvwPipCut = pvwPipByProduction.get(productionId) ?? null;
      if (curPgmPipCut !== null) {
        // PiP was on PGM → moves to PVW
        pgmPipByProduction.set(productionId, null);
        pvwPipByProduction.set(productionId, curPgmPipCut);
        pvwBeforePipByProduction.set(productionId, pgmBgByProduction.get(productionId) ?? null);
        pgmBgByProduction.delete(productionId);
        broadcast(productionId, { type: 'PIP_STATE', pgmPip: null, pvwPip: curPgmPipCut, pips: pipConfigsByProduction.get(productionId) ?? [] });
      } else if (curPvwPipCut !== null) {
        // PiP was in PVW — cutting a real source to PGM replaces PVW, so clear it
        pvwPipByProduction.set(productionId, null);
        broadcast(productionId, { type: 'PIP_STATE', pgmPip: null, pvwPip: null, pips: pipConfigsByProduction.get(productionId) ?? [] });
      }
      await persistMixerMutation(productionId, 'CUT', (d) => ({ ...d, tally: newTally }));
      broadcast(productionId, { type: 'TALLY', ...newTally });
      await stromTransition(doc, fromPadCut, msg.mixerInput, 'cut');
      if (curPgmPipCut !== null && doc.stromFlowId && doc.mixerBlockId) {
        try {
          const strom = await makeStromClient();
          await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { pip: curPgmPipCut } });
        } catch (err) {
          console.warn('[controller] Strom selectPreview (pip restore after cut) error:', err);
        }
      }
      if (doc.stromFlowId && ctx.audioBlockId) {
        void applyAudioFollow(productionId, doc, msg.mixerInput, doc.stromFlowId, ctx.audioBlockId, await makeStromClient(), msg.afvRampUpMs, msg.afvRampDownMs);
      }
      break;
    }
    case 'TRANSITION': {
      const tally = getTally(productionId);
      const curPgmPipTrans = pgmPipByProduction.get(productionId) ?? null;
      const fromPadTrans = (curPgmPipTrans !== null && tally.pgm === null)
        ? (pgmBgByProduction.get(productionId) ?? null)
        : tally.pgm;
      const newTally = { pgm: msg.mixerInput, pvw: tally.pgm };
      setTally(productionId, newTally);
      if (curPgmPipTrans !== null) {
        pgmPipByProduction.set(productionId, null);
        pvwPipByProduction.set(productionId, curPgmPipTrans);
        pvwBeforePipByProduction.set(productionId, pgmBgByProduction.get(productionId) ?? null);
        pgmBgByProduction.delete(productionId);
        broadcast(productionId, { type: 'PIP_STATE', pgmPip: null, pvwPip: curPgmPipTrans, pips: pipConfigsByProduction.get(productionId) ?? [] });
      }
      await persistMixerMutation(productionId, 'TRANSITION', (d) => ({ ...d, tally: newTally }));
      broadcast(productionId, { type: 'TALLY', ...newTally, transitionType: msg.transitionType, durationMs: msg.durationMs });
      await stromTransition(doc, fromPadTrans, msg.mixerInput, toStromTransition(msg.transitionType), msg.durationMs);
      if (curPgmPipTrans !== null && doc.stromFlowId && doc.mixerBlockId) {
        try {
          const strom = await makeStromClient();
          await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { pip: curPgmPipTrans } });
        } catch (err) {
          console.warn('[controller] Strom selectPreview (pip restore after transition) error:', err);
        }
      }
      if (doc.stromFlowId && ctx.audioBlockId) {
        void applyAudioFollow(productionId, doc, msg.mixerInput, doc.stromFlowId, ctx.audioBlockId, await makeStromClient(), msg.afvRampUpMs, msg.afvRampDownMs);
      }
      break;
    }
    case 'TAKE': {
      const tally = getTally(productionId);
      // Atomic PiP take: pip supplied directly so no SELECT_PVW_PIP is needed,
      // avoiding the concurrent-broadcast race that puts the PiP in both PGM and PVW.
      if (msg.pip !== undefined) {
        if (tally.pvw !== null) {
          // Save the real PVW source as the background behind the PiP, then
          // null out the tally PVW so the swap below produces { pgm: null, pvw: old_pgm }.
          pvwBeforePipByProduction.set(productionId, tally.pvw);
          (tally as { pvw: string | null }).pvw = null;
        }
        pvwPipByProduction.set(productionId, msg.pip);
      }
      const curPvwPip = pvwPipByProduction.get(productionId) ?? null;
      const curPgmPip = pgmPipByProduction.get(productionId) ?? null;
      const newTally = { pgm: tally.pvw, pvw: tally.pgm };
      const newPgmPip = curPvwPip;
      const newPvwPip = curPgmPip;
      setTally(productionId, newTally);
      pgmPipByProduction.set(productionId, newPgmPip);
      pvwPipByProduction.set(productionId, newPvwPip);
      await persistMixerMutation(productionId, 'TAKE', (d) => ({ ...d, tally: newTally }));
      broadcast(productionId, { type: 'TALLY', ...newTally });
      broadcast(productionId, { type: 'PIP_STATE', pgmPip: newPgmPip, pvwPip: newPvwPip, pips: pipConfigsByProduction.get(productionId) ?? [] });
      const takeTransition = toStromTransition(msg.transitionType ?? 'cut');
      if (curPvwPip !== null) {
        // PiP is on PVW → moving to PGM.
        // from_input: the real source currently on PGM (will move to PVW).
        // to_input: the real source that was on PVW *before* the PiP was
        //   selected.  This becomes Strom's pgm_input (background behind the
        //   PiP) after the swap, ensuring pgm_input ≠ pvw_input so subsequent
        //   selectPreview calls don't hit the "sole program source" 400.
        if (doc.stromFlowId && doc.mixerBlockId) {
          try {
            const strom = await makeStromClient();
            const fromInputIndex = tally.pgm ? (padToIndex(tally.pgm) ?? 0) : 0;
            const pvwBeforePip = pvwBeforePipByProduction.get(productionId) ?? null;
            const toInputIndex = pvwBeforePip !== null ? (padToIndex(pvwBeforePip) ?? fromInputIndex) : fromInputIndex;
            await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { pip: curPvwPip } });
            await strom.mixer.transition(doc.stromFlowId, doc.mixerBlockId, {
              from_input: fromInputIndex,
              to_input: toInputIndex,
              transition_type: takeTransition,
              ...(msg.durationMs !== undefined ? { duration_ms: msg.durationMs } : {}),
            });
            // Track the new Strom PGM background (pvwBeforePip) so CUT/TRANSITION
            // can pass the correct from_input while the PiP remains on PGM.
            pgmBgByProduction.set(productionId, pvwBeforePip);
            pvwBeforePipByProduction.delete(productionId);
          } catch (err) {
            console.warn('[controller] Strom PiP transition error:', err);
          }
        }
      } else if (curPgmPip !== null) {
        // PiP is on PGM → taking to a real input; PiP moves to PVW.
        // Use the tracked PGM background as from_input (tally.pgm is null while a
        // PiP occupies PGM).  Save pgmBg as pvwBeforePip so the next forward PiP
        // take has a valid to_input ≠ from_input (avoids "sole program source" 400).
        const pgmBg = pgmBgByProduction.get(productionId) ?? null;
        pvwBeforePipByProduction.set(productionId, pgmBg);
        pgmBgByProduction.delete(productionId);
        if (doc.stromFlowId && doc.mixerBlockId) {
          try {
            const strom = await makeStromClient();
            const fromInputIndex = pgmBg ? (padToIndex(pgmBg) ?? 0) : 0;
            const toInputIndex = tally.pvw ? (padToIndex(tally.pvw) ?? fromInputIndex) : fromInputIndex;
            await strom.mixer.transition(doc.stromFlowId, doc.mixerBlockId, {
              from_input: fromInputIndex,
              to_input: toInputIndex,
              transition_type: takeTransition,
              ...(msg.durationMs !== undefined ? { duration_ms: msg.durationMs } : {}),
            });
            // Restore the PiP to Strom's preview so subsequent forward takes work.
            await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { pip: curPgmPip } });
          } catch (err) {
            console.warn('[controller] Strom reverse-PiP transition error:', err);
          }
        }
      } else {
        // No PiP involved: clear any stale PGM background tracking.
        pgmBgByProduction.delete(productionId);
        await stromTransition(doc, tally.pgm, tally.pvw, takeTransition, msg.durationMs);
      }
      if (doc.stromFlowId && ctx.audioBlockId) {
        void applyAudioFollow(productionId, doc, tally.pvw, doc.stromFlowId, ctx.audioBlockId, await makeStromClient(), msg.afvRampUpMs, msg.afvRampDownMs);
      }
      break;
    }
    case 'SET_PVW': {
      const tally = getTally(productionId);
      pvwPipByProduction.set(productionId, null);
      // A real source is going on PVW: discard any saved pre-PiP PVW reference.
      pvwBeforePipByProduction.delete(productionId);
      const newTally = { pgm: tally.pgm, pvw: msg.mixerInput };
      setTally(productionId, newTally);
      await persistMixerMutation(productionId, 'SET_PVW', (d) => ({ ...d, tally: newTally }));
      broadcast(productionId, { type: 'TALLY', ...newTally });
      broadcast(productionId, { type: 'PIP_STATE', pgmPip: pgmPipByProduction.get(productionId) ?? null, pvwPip: null, pips: pipConfigsByProduction.get(productionId) ?? [] });
      if (doc.stromFlowId && doc.mixerBlockId) {
        const inputIndex = padToIndex(msg.mixerInput);
        if (inputIndex !== null) {
          try {
            const strom = await makeStromClient();
            await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { input: inputIndex } });
          } catch (err) {
            console.warn('[controller] Strom selectPreview error:', err);
          }
        }
      }
      break;
    }
    case 'SELECT_PVW_PIP': {
      const tally = getTally(productionId);
      // Save the current PVW real source before the PiP takes over. The TAKE
      // handler uses this as to_input in trigger_transition so Strom ends up
      // with pgm_input ≠ pvw_input (avoids "sole program source" 400 errors).
      pvwBeforePipByProduction.set(productionId, tally.pvw);
      pvwPipByProduction.set(productionId, msg.pip);
      const newTally = { pgm: tally.pgm, pvw: null };
      setTally(productionId, newTally);
      await persistMixerMutation(productionId, 'SELECT_PVW_PIP', (d) => ({ ...d, tally: newTally }));
      broadcast(productionId, { type: 'TALLY', ...newTally });
      broadcast(productionId, { type: 'PIP_STATE', pgmPip: pgmPipByProduction.get(productionId) ?? null, pvwPip: msg.pip, pips: pipConfigsByProduction.get(productionId) ?? [] });
      if (doc.stromFlowId && doc.mixerBlockId) {
        try {
          const strom = await makeStromClient();
          // Strom 0.5+: PiPs are first-class sources — address via { pip: N }, not by offset into inputs.
          await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { pip: msg.pip } });
        } catch (err) {
          console.warn('[controller] Strom selectPreview (pip) error:', err);
        }
      }
      break;
    }
    case 'SET_PIP': {
      if (!doc.stromFlowId || !doc.mixerBlockId) break;
      try {
        const strom = await makeStromClient();
        const transforms: PipTransforms = msg.transforms ?? {};

        const pips = setPipConfigSlot(productionId, msg.pip, { bg: msg.bg, zones: msg.zones, transforms });
        broadcast(productionId, { type: 'PIP_STATE', pgmPip: pgmPipByProduction.get(productionId) ?? null, pvwPip: pvwPipByProduction.get(productionId) ?? null, pips });

        const resp = await strom.mixer.updatePipConfig(doc.stromFlowId, doc.mixerBlockId, msg.pip, {
          bg: msg.bg,
          zones: msg.zones,
          transforms,
        });
        // Sync back Strom-clamped transforms (may differ due to clamping)
        if (resp?.transforms && Object.keys(resp.transforms).length > 0) {
          const current = pipConfigsByProduction.get(productionId)?.[msg.pip];
          if (current) {
            setPipConfigSlot(productionId, msg.pip, { ...current, transforms: resp.transforms });
          }
        }

        // Persist the PiP layout to the ProductionDoc so it survives
        // deactivate/reactivate and server restarts (issue #177). The in-memory
        // cache is authoritative for the write; updateProductionDoc is 409-safe.
        await updateProductionDoc(productionId, {
          pipConfigs: pipConfigsByProduction.get(productionId) ?? [],
        }).catch((err) => console.warn('[controller] persist pipConfigs error:', err));
      } catch (err) {
        console.warn('[controller] Strom SET_PIP error:', err);
        ws.send(JSON.stringify({ type: 'ERROR', error: stromErrorMessage(err) }));
      }
      break;
    }
    case 'FTB': {
      if (!doc.stromFlowId || !doc.mixerBlockId) break;
      try {
        const strom = await makeStromClient();
        const result = await strom.mixer.fadeToBlack(doc.stromFlowId, doc.mixerBlockId, { active: msg.active ?? true, duration_ms: msg.durationMs ?? 1000 });
        broadcast(productionId, { type: 'FTB_STATE', active: result.active });
      } catch (err) {
        console.warn('[controller] Strom FTB error:', err);
        ws.send(JSON.stringify({ type: 'ERROR', error: 'FTB failed' }));
      }
      break;
    }
    case 'SET_OVL': {
      overlayAlphaByProduction.set(productionId, msg.alpha);
      if (!doc.stromFlowId || !doc.mixerBlockId) break;
      try {
        const strom = await makeStromClient();
        await strom.mixer.setOverlayAlpha(doc.stromFlowId, doc.mixerBlockId, { alpha: msg.alpha });
      } catch (err) {
        console.warn('[controller] Strom setOverlayAlpha error:', err);
      }
      break;
    }
    case 'GO_LIVE': {
      if (!doc.stromFlowId) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Production is not activated' }));
        break;
      }
      const updated: ProductionDoc = { ...doc, status: 'active', updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'ON_AIR', value: true });
      break;
    }
    case 'CUT_STREAM': {
      if (!doc.stromFlowId) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Production is not activated' }));
        break;
      }
      const updated: ProductionDoc = { ...doc, status: 'active', updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'ON_AIR', value: false });
      break;
    }
    case 'GRAPHIC_ON':
    case 'GRAPHIC_OFF': {
      const graphic = doc.graphics.find((g) => g.id === msg.overlayId);
      if (!graphic) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Overlay not found' }));
        break;
      }
      const active = msg.type === 'GRAPHIC_ON';
      const updated: ProductionDoc = {
        ...doc,
        graphics: doc.graphics.map((g) =>
          g.id === msg.overlayId ? { ...g, active } : g
        ),
        updatedAt: new Date().toISOString(),
      };
      await db.insert(updated);
      broadcast(productionId, { type: 'GRAPHIC', overlayId: msg.overlayId, active });
      break;
    }
    case 'DSK_TOGGLE': {
      if (!doc.stromFlowId || !doc.mixerBlockId) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Pipeline not active or mixer block not resolved' }));
        break;
      }
      const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      const result = await strom.mixer.toggleDsk(doc.stromFlowId, doc.mixerBlockId, {
        dsk: msg.layer + 1,
        enabled: msg.visible ?? true,
      });
      const layer0 = result.dsk - 1;
      const dskMap = dskLayersByProduction.get(productionId) ?? {}
      dskLayersByProduction.set(productionId, { ...dskMap, [layer0]: result.enabled })
      broadcast(productionId, { type: 'DSK_STATE', layer: layer0, visible: result.enabled });
      break;
    }
    case 'MACRO_EXEC': {
      const macro = (doc.macros ?? []).find((m) => m.id === msg.macroId);
      if (!macro) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Macro not found' }));
        break;
      }
      const strom = await makeStromClient();
      let failedAt = -1;
      let failError = '';
      for (let i = 0; i < macro.actions.length; i++) {
        const action = macro.actions[i];
        try {
          const currentDoc = await getDb().get(productionId);
          // Macros reference sourceId; resolve to mixerInput for tally/Strom
          const resolveInput = (sourceId: string) =>
            currentDoc.sources.find((s) => s.sourceId === sourceId)?.mixerInput ?? null;
          if (action.type === 'CUT' && action.sourceId) {
            const mixerInput = resolveInput(action.sourceId);
            if (!mixerInput) break;
            const tally = getTally(productionId);
            const newTally = { pgm: mixerInput, pvw: tally.pgm };
            setTally(productionId, newTally);
            await persistMixerMutation(productionId, 'MACRO_EXEC:CUT', (d) => ({ ...d, tally: newTally }));
            broadcast(productionId, { type: 'TALLY', ...newTally });
            await stromTransition(currentDoc, tally.pgm, mixerInput, 'cut');
          } else if (action.type === 'TRANSITION' && action.sourceId) {
            const mixerInput = resolveInput(action.sourceId);
            if (!mixerInput) break;
            const tally = getTally(productionId);
            const newTally = { pgm: mixerInput, pvw: tally.pgm };
            setTally(productionId, newTally);
            await persistMixerMutation(productionId, 'MACRO_EXEC:TRANSITION', (d) => ({ ...d, tally: newTally }));
            broadcast(productionId, { type: 'TALLY', ...newTally, transitionType: action.transitionType, durationMs: action.durationMs });
            await stromTransition(currentDoc, tally.pgm, mixerInput, toStromTransition(action.transitionType ?? 'cut'), action.durationMs);
          } else if (action.type === 'TAKE') {
            const tally = getTally(productionId);
            const newTally = { pgm: tally.pvw, pvw: tally.pgm };
            setTally(productionId, newTally);
            await persistMixerMutation(productionId, 'MACRO_EXEC:TAKE', (d) => ({ ...d, tally: newTally }));
            broadcast(productionId, { type: 'TALLY', ...newTally });
            await stromTransition(currentDoc, tally.pgm, tally.pvw, 'cut');
          } else if (action.type === 'GRAPHIC_ON' && action.overlayId) {
            await persistMixerMutation(productionId, 'MACRO_EXEC:GRAPHIC_ON', (d) => ({
              ...d,
              graphics: d.graphics.map((g) => g.id === action.overlayId ? { ...g, active: true } : g),
            }));
            broadcast(productionId, { type: 'GRAPHIC', overlayId: action.overlayId, active: true });
          } else if (action.type === 'GRAPHIC_OFF' && action.overlayId) {
            await persistMixerMutation(productionId, 'MACRO_EXEC:GRAPHIC_OFF', (d) => ({
              ...d,
              graphics: d.graphics.map((g) => g.id === action.overlayId ? { ...g, active: false } : g),
            }));
            broadcast(productionId, { type: 'GRAPHIC', overlayId: action.overlayId, active: false });
          } else if (action.type === 'DSK_TOGGLE') {
            if (!currentDoc.stromFlowId || !currentDoc.mixerBlockId) {
              throw new Error('Pipeline not active or mixer block not resolved');
            }
            await strom.mixer.toggleDsk(currentDoc.stromFlowId, currentDoc.mixerBlockId, {
              dsk: (action.layer ?? 0) + 1,
              enabled: action.visible ?? true,
            });
          }
        } catch (err) {
          failedAt = i;
          failError = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      if (failedAt !== -1) {
        ws.send(JSON.stringify({ type: 'MACRO_ERROR', macroId: msg.macroId, failedActionIndex: failedAt, error: failError }));
      } else {
        broadcast(productionId, { type: 'MACRO_EXECUTED', macroId: msg.macroId });
      }
      break;
    }
    case 'AUDIO_SET': {
      if (!doc.stromFlowId) break;
      try {
        const strom = await makeStromClient();
        // Resolve audio block ID from cache; fetch flow only if not yet known
        if (!ctx.audioBlockId) {
          const { flow } = await strom.flows.get(doc.stromFlowId);
          const audioBlock = (flow.blocks ?? []).find((b) => b.block_definition_id === 'builtin.mixer');
          if (audioBlock) ctx.audioBlockId = audioBlock.id;
        }
        if (!ctx.audioBlockId) {
          console.warn('[controller] AUDIO_SET: builtin.mixer block not found');
          break;
        }
        if (msg.property === 'volume') {
          // Debounce: coalesce rapid nudges into one Strom PATCH.
          // Broadcast immediately for UI responsiveness; only the final value is sent to Strom.
          broadcast(productionId, { type: 'AUDIO_STATE', elementId: msg.elementId, property: msg.property, value: msg.value });
          // Cache fader level immediately so reconnecting clients get the correct position.
          if (typeof msg.value === 'number') {
            if (!channelLevelsByProduction.has(productionId)) channelLevelsByProduction.set(productionId, new Map());
            channelLevelsByProduction.get(productionId)!.set(msg.elementId, msg.value as number);
          }
          // Extract ch number before closure (only valid when elementId !== 'main')
          const chMatch = msg.elementId !== 'main' ? /^ch(\d+)$/.exec(msg.elementId) : null;
          if (msg.elementId !== 'main' && !chMatch) {
            ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid audio channel id' }));
            break;
          }
          const ch = chMatch ? parseInt(chMatch[1], 10) : null;
          const debounceKey = `${productionId}:vol:${msg.elementId}`;
          const prev = pendingVolume.get(debounceKey);
          if (prev) clearTimeout(prev);
          const flowId = doc.stromFlowId;
          const capturedAudioBlockId = ctx.audioBlockId;
          const capturedValue = msg.value;
          const capturedLogicalId = msg.elementId;
          pendingVolume.set(debounceKey, setTimeout(async () => {
            pendingVolume.delete(debounceKey);
            try {
              const s = await makeStromClient();
              const propName = capturedLogicalId === 'main' ? 'main_fader' : `ch${ch}_fader`;
              await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
                properties: { [propName]: capturedValue },
              });
            } catch (err) {
              console.warn('[controller] Strom audio update error:', err);
              broadcast(productionId, { type: 'AUDIO_STATE', elementId: capturedLogicalId, property: 'volume', value: capturedValue });
            }
          }, 150));
        } else {
          // Update mute registry for state restoration on reconnect
          if (msg.elementId !== 'main') {
            const mutedSet = mutedElementsByProduction.get(productionId);
            if (mutedSet) {
              if (msg.value === true) mutedSet.add(msg.elementId);
              else mutedSet.delete(msg.elementId);
            }
          }
          let props: Record<string, unknown>;
          if (msg.elementId === 'main') {
            props = { main_mute: msg.value };
          } else {
            const chMatch = /^ch(\d+)$/.exec(msg.elementId);
            if (!chMatch) {
              ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid audio channel id' }));
              break;
            }
            const ch = parseInt(chMatch[1], 10);
            // to_main = !mute (true=ON routing, false=OFF routing)
            props = { [`ch${ch}_to_main`]: !msg.value };
          }
          await strom.flows.updateBlockProperties(doc.stromFlowId, ctx.audioBlockId, {
            properties: props,
            ...(msg.ramp_ms !== undefined && { ramp_ms: msg.ramp_ms }),
          });
          broadcast(productionId, { type: 'AUDIO_STATE', elementId: msg.elementId, property: msg.property, value: msg.value });
        }
      } catch (err) {
        console.warn('[controller] Strom audio update error:', err);
      }
      break;
    }
    case 'AFV_SET': {
      // Register or deregister this mixer input in the per-production AFV set
      // so that applyAudioFollow knows which channels to route on cuts.
      if (!afvChannelsByProduction.has(productionId)) {
        afvChannelsByProduction.set(productionId, new Set());
      }
      const afvSet = afvChannelsByProduction.get(productionId)!;

      if (msg.enabled) {
        afvSet.add(msg.mixerInput);
        // Immediately apply routing based on current tally so the channel
        // doesn't have to wait for the next cut to take effect.
        if (doc.stromFlowId && ctx.audioBlockId) {
          const tally = getTally(productionId);
          const isOnPgm = tally.pgm === msg.mixerInput;
          const chIdx = await resolveAudioChannelIndex(doc, msg.mixerInput);
          if (chIdx !== null) {
            // Clear this channel from the manual mute registry — AFV now owns routing.
            // Broadcast the cleared mute so all clients (including the sender's own
            // store for any reconnect scenario) reflect the correct state.
            const elementId = `ch${chIdx + 1}`;
            mutedElementsByProduction.get(productionId)?.delete(elementId);
            broadcast(productionId, { type: 'AUDIO_STATE', elementId, property: 'mute', value: false });
            const strom = await makeStromClient();
            await strom.flows.updateBlockProperties(doc.stromFlowId, `${ctx.audioBlockId}`, {
              properties: { [`ch${chIdx + 1}_to_main`]: isOnPgm },
            }).catch((err) => console.warn('[controller] AFV_SET routing error:', err));
          }
        }
      } else {
        afvSet.delete(msg.mixerInput);
        // No Strom call here — the frontend sends AUDIO_SET mute immediately after
        // AFV_SET disable to set the desired routing state (ON → open, OFF → closed).
        // Letting AFV_SET touch to_main_vol_N would race with that message.
      }
      // Broadcast to all connected clients so every operator's UI stays in sync.
      broadcast(productionId, { type: 'AFV_STATE', mixerInput: msg.mixerInput, enabled: msg.enabled });
      break;
    }
    case 'AFV_RAMP_SET': {
      const rampUpMs   = Math.max(0, Math.min(5000, Math.round(msg.rampUpMs)));
      const rampDownMs = Math.max(0, Math.min(5000, Math.round(msg.rampDownMs)));
      afvRampByProduction.set(productionId, { rampUpMs, rampDownMs });
      broadcast(productionId, { type: 'AFV_RAMP_STATE', rampUpMs, rampDownMs });
      break;
    }
    case 'PFL_SET': {
      if (!activePflByProduction.has(productionId)) activePflByProduction.set(productionId, new Set());
      const activeSet = activePflByProduction.get(productionId)!;
      if (msg.enabled) activeSet.add(msg.elementId); else activeSet.delete(msg.elementId);

      // Mutually exclusive per strip — enabling PFL cancels AFL on the same channel
      if (msg.enabled) activeAflByProduction.get(productionId)?.delete(msg.elementId);

      const chMatch = /^ch(\d+)$/.exec(msg.elementId);
      if (chMatch && doc.stromFlowId && ctx.audioBlockId) {
        const strom = await makeStromClient();
        const props: Record<string, unknown> = { [`ch${chMatch[1]}_pfl`]: msg.enabled };
        if (msg.enabled) props[`ch${chMatch[1]}_afl`] = false;
        await strom.flows.updateBlockProperties(doc.stromFlowId, ctx.audioBlockId, {
          properties: props,
          ramp_ms: 50,
        }).catch((err: unknown) => console.warn('[controller] PFL_SET block props error:', err));
      }

      broadcast(productionId, { type: 'PFL_STATE', elementId: msg.elementId, enabled: msg.enabled });
      if (msg.enabled) broadcast(productionId, { type: 'AFL_STATE', elementId: msg.elementId, enabled: false });
      break;
    }
    case 'AFL_SET': {
      if (!activeAflByProduction.has(productionId)) activeAflByProduction.set(productionId, new Set());
      const activeAflSet = activeAflByProduction.get(productionId)!;
      if (msg.enabled) activeAflSet.add(msg.elementId); else activeAflSet.delete(msg.elementId);

      // Mutually exclusive per strip — enabling AFL cancels PFL on the same channel
      if (msg.enabled) activePflByProduction.get(productionId)?.delete(msg.elementId);

      const aflChMatch = /^ch(\d+)$/.exec(msg.elementId);
      if (aflChMatch && doc.stromFlowId && ctx.audioBlockId) {
        const strom = await makeStromClient();
        const aflProps: Record<string, unknown> = { [`ch${aflChMatch[1]}_afl`]: msg.enabled };
        if (msg.enabled) aflProps[`ch${aflChMatch[1]}_pfl`] = false;
        await strom.flows.updateBlockProperties(doc.stromFlowId, ctx.audioBlockId, {
          properties: aflProps,
          ramp_ms: 50,
        }).catch((err: unknown) => console.warn('[controller] AFL_SET block props error:', err));
      }

      broadcast(productionId, { type: 'AFL_STATE', elementId: msg.elementId, enabled: msg.enabled });
      if (msg.enabled) broadcast(productionId, { type: 'PFL_STATE', elementId: msg.elementId, enabled: false });
      break;
    }
    case 'AUX_SEND_SET': {
      // Set aux_send_{chIdx}_{auxIdx}:volume on the audio mixer for the given AUX bus.
      // elementId is the API channel ID, e.g. 'ch1' (1-indexed) → chIdx=0.
      // auxBus is 1-indexed on the wire (AUX 1 → auxIdx=0).
      // Strom receives enabled ? level : 0.  The fader position (level) is always
      // broadcast so all clients preserve the saved level across ON/OFF.
      //
      // IMPORTANT: ch{N}_aux{M}_pre is a build-time topology property (element_id: "_block")
      // that controls which tee (pre_fader_tee vs post_fader_tee) the send is wired to.
      // It CANNOT be applied to a running pipeline — only the level property maps to a live
      // GStreamer element. We send pre and level as SEPARATE updateBlockProperties calls so
      // that a pre rejection never silences the level update.
      const chMatch = /^ch(\d+)$/.exec(msg.elementId);
      if (chMatch && doc.stromFlowId && ctx.audioBlockId) {
        const chIdx = parseInt(chMatch[1], 10) - 1;     // 0-based
        const chNum = chIdx + 1;
        const stromValue = msg.enabled ? msg.level : 0;
        const flowId = doc.stromFlowId;
        const capturedAudioBlockId = ctx.audioBlockId;
        const capturedAuxBus = msg.auxBus;
        const capturedPre = msg.pre;
        const debounceKey = `${productionId}:aux:ch${chNum}_aux${capturedAuxBus}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            // Send level update first — this IS live-applicable (aux_send element volume).
            await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
              properties: { [`ch${chNum}_aux${capturedAuxBus}_level`]: stromValue },
            });
            // Send pre separately — this is a build-time property stored in the flow JSON
            // so it takes effect on next production start. Keeping it separate means a
            // rejection of pre (non-live topology change) never blocks the level update.
            if (capturedPre !== undefined) {
              await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
                properties: { [`ch${chNum}_aux${capturedAuxBus}_pre`]: capturedPre },
              }).catch((err) => console.warn('[controller] AUX pre update error (non-live, stored for next start):', err));
            }
          } catch (err) {
            console.warn('[controller] AUX_SEND_SET error:', err);
          }
        }, 150));
      }
      // Cache for reconnect restore — keyed by 'ch{N}_aux{M}'
      if (/^ch\d+$/.test(msg.elementId)) {
        const cache = auxSendByProduction.get(productionId) ?? new Map()
        cache.set(`${msg.elementId}_aux${msg.auxBus}`, { level: msg.level, enabled: msg.enabled, pre: msg.pre ?? true })
        auxSendByProduction.set(productionId, cache)
      }
      // Broadcast level + enabled (+ pre when set) so all clients stay in sync
      broadcast(productionId, { type: 'AUX_SEND_STATE', elementId: msg.elementId, auxBus: msg.auxBus, level: msg.level, enabled: msg.enabled, ...(msg.pre !== undefined && { pre: msg.pre }) });
      break;
    }
    case 'AUX_MASTER_SET': {
      // Set aux{N}_volume:volume on the audio mixer (the AUX bus master fader).
      // auxBus is 1-indexed; Strom element is 0-indexed: aux1 → aux0_volume.
      // When muted, Strom receives 0; the fader level is always broadcast so all
      // clients preserve the saved level even while the master is silenced.
      if (doc.stromFlowId && ctx.audioBlockId) {
        const flowId = doc.stromFlowId;
        const capturedAudioBlockId = ctx.audioBlockId;
        const debounceKey = `${productionId}:aux-master:${msg.auxBus}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
              properties: {
                [`aux${msg.auxBus}_fader`]: msg.muted ? 0 : msg.volume,
              },
            });
          } catch (err) {
            console.warn('[controller] AUX_MASTER_SET error:', err);
          }
        }, 150));
      }
      // Cache for reconnect restore
      const amCache = auxMasterByProduction.get(productionId) ?? new Map()
      amCache.set(msg.auxBus, { volume: msg.volume, muted: msg.muted })
      auxMasterByProduction.set(productionId, amCache)
      broadcast(productionId, { type: 'AUX_MASTER_STATE', auxBus: msg.auxBus, volume: msg.volume, muted: msg.muted });
      break;
    }
    case 'GRP_SEND_SET': {
      // Set to_grp{grpIdx}_vol_{chIdx}:volume on the audio mixer.
      // elementId is API channel ID e.g. 'ch1' (1-indexed) → chIdx=0.
      // grpBus is 1-indexed (GRP 1 → grpIdx=0).
      // Strom receives enabled ? level : 0. Fader position always broadcast for multi-client sync.
      const chMatch = /^ch(\d+)$/.exec(msg.elementId);
      if (chMatch && doc.stromFlowId && ctx.audioBlockId) {
        const chIdx = parseInt(chMatch[1], 10) - 1;
        const flowId = doc.stromFlowId;
        const capturedAudioBlockId = ctx.audioBlockId;
        const debounceKey = `${productionId}:grp:ch${chIdx + 1}_grp${msg.grpBus}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
              properties: { [`ch${chIdx + 1}_to_grp${msg.grpBus}`]: msg.enabled },
            });
          } catch (err) {
            console.warn('[controller] GRP_SEND_SET error:', err);
          }
        }, 150));
      }
      // Cache for reconnect restore — keyed by 'ch{N}_grp{M}'
      if (/^ch\d+$/.test(msg.elementId)) {
        const cache = grpSendByProduction.get(productionId) ?? new Map()
        cache.set(`${msg.elementId}_grp${msg.grpBus}`, { level: msg.level, enabled: msg.enabled })
        grpSendByProduction.set(productionId, cache)
      }
      broadcast(productionId, { type: 'GRP_SEND_STATE', elementId: msg.elementId, grpBus: msg.grpBus, level: msg.level, enabled: msg.enabled });
      break;
    }
    case 'GRP_MASTER_SET': {
      // Set group{N}_fader on the audio mixer (group bus master fader).
      // grpBus is 1-indexed; Strom element is 0-indexed: grp1 → group0_volume.
      // Groups auto-feed into main — the group master fader controls contribution to PGM output.
      //
      // Use fader=0 for the muted state — never set group{N}_mute=true.
      // Strom's VolumeRampManager.apply_mute(true) sets the GStreamer GAP flag which kills meters.
      // apply_mute(false) restores the pre-mute volume (defaults to 1.0), overriding fader=0.
      // fader=0 alone ramps to silence without GAP, keeping meters alive.
      if (doc.stromFlowId && ctx.audioBlockId) {
        const flowId = doc.stromFlowId;
        const capturedAudioBlockId = ctx.audioBlockId;
        const debounceKey = `${productionId}:grp-master:${msg.grpBus}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
              properties: {
                [`group${msg.grpBus}_fader`]: msg.muted ? 0 : msg.volume,
              },
            });
          } catch (err) {
            console.warn('[controller] GRP_MASTER_SET error:', err);
          }
        }, 150));
      }
      // Cache for reconnect restore
      const gmCache = grpMasterByProduction.get(productionId) ?? new Map()
      gmCache.set(msg.grpBus, { volume: msg.volume, muted: msg.muted })
      grpMasterByProduction.set(productionId, gmCache)
      broadcast(productionId, { type: 'GRP_MASTER_STATE', grpBus: msg.grpBus, volume: msg.volume, muted: msg.muted });
      break;
    }
    case 'MONITOR_SET': {
      // Set monitor_fader on the builtin.mixer block.
      // The monitor bus (monitor_out pad) is the operator's local listening feed —
      // zero effect on the programme mix or any output bus.
      // NOTE: Strom only exposes 'monitor_fader' — there is no 'monitor_mute' property.
      // Use fader=0 for the muted state. Do NOT call apply_mute(false): Strom's VolumeRampManager
      // treats that as an unmute, restoring the pre-mute volume (default 1.0) and overriding fader=0.
      // fader=0 alone ramps to silence without the GStreamer GAP flag, keeping meters alive.
      if (doc.stromFlowId && ctx.audioBlockId) {
        const flowId = doc.stromFlowId;
        const capturedAudioBlockId = ctx.audioBlockId;
        const debounceKey = `${productionId}:monitor`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
              properties: {
                monitor_fader: msg.muted ? 0 : msg.volume,
              },
            });
          } catch (err) {
            console.warn('[controller] MONITOR_SET error:', err);
          }
        }, 150));
      }
      // Cache for reconnect restore
      monitorByProduction.set(productionId, { volume: msg.volume, muted: msg.muted })
      broadcast(productionId, { type: 'MONITOR_STATE', volume: msg.volume, muted: msg.muted });
      break;
    }
    case 'SOURCE_OFFSET_SET': {
      // Apply a time offset (ms) to the builtin.time_offset block for this mixer input.
      // The offset is applied live to the running Strom flow and stored in the runtime
      // registry so newly-connected clients receive the current value on connect.
      const { mixerInput, offsetMs } = msg;
      if (!Number.isFinite(offsetMs)) break;

      // Update runtime registry
      const offsets = sourceOffsetsByProduction.get(productionId) ?? new Map<string, number>();
      offsets.set(mixerInput, offsetMs);
      sourceOffsetsByProduction.set(productionId, offsets);

      // Apply to Strom if the flow is running and we know the block ID.
      // offset_ms is a synthetic property on builtin.time_offset blocks — Strom stores it
      // via pad.set_offset() on the identity element's src pad (not a GStreamer element property).
      if (!doc.stromFlowId) {
        console.warn('[controller] SOURCE_OFFSET_SET: production not active, offset stored in registry only');
      } else if (!doc.sourceOffsetBlockIds?.[mixerInput]) {
        console.warn(`[controller] SOURCE_OFFSET_SET: no offset block for ${mixerInput} — re-activate production to pick up time_offset blocks`);
      } else {
        const offsetBlockId = doc.sourceOffsetBlockIds[mixerInput];
        const flowId = doc.stromFlowId;
        const debounceKey = `${productionId}:offset:${mixerInput}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.properties.updateElement(flowId, `${offsetBlockId}:offset_identity`, {
              property_name: 'offset_ms',
              value: offsetMs,
            });
          } catch (err) {
            console.warn(`[controller] SOURCE_OFFSET_SET error (${mixerInput}):`, String(err));
          }
        }, 150));
      }

      broadcast(productionId, { type: 'SOURCE_OFFSET_STATE', mixerInput, offsetMs });
      break;
    }
    case 'SOURCE_AUDIO_OFFSET_SET': {
      const { mixerInput, offsetMs } = msg;
      if (!Number.isFinite(offsetMs)) break;

      const audioOffsets = sourceAudioOffsetsByProduction.get(productionId) ?? new Map<string, number>();
      audioOffsets.set(mixerInput, offsetMs);
      sourceAudioOffsetsByProduction.set(productionId, audioOffsets);

      if (!doc.stromFlowId) {
        console.warn('[controller] SOURCE_AUDIO_OFFSET_SET: production not active, offset stored in registry only');
      } else if (!doc.sourceAudioOffsetBlockIds?.[mixerInput]) {
        console.warn(`[controller] SOURCE_AUDIO_OFFSET_SET: no audio offset block for ${mixerInput} — re-activate production to pick up time_offset blocks`);
      } else {
        const offsetBlockId = doc.sourceAudioOffsetBlockIds[mixerInput];
        const flowId = doc.stromFlowId;
        const debounceKey = `${productionId}:audio-offset:${mixerInput}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            await s.properties.updateElement(flowId, `${offsetBlockId}:offset_identity`, {
              property_name: 'offset_ms',
              value: offsetMs,
            });
          } catch (err) {
            console.warn(`[controller] SOURCE_AUDIO_OFFSET_SET error (${mixerInput}):`, String(err));
          }
        }, 150));
      }

      broadcast(productionId, { type: 'SOURCE_AUDIO_OFFSET_STATE', mixerInput, offsetMs });
      break;
    }
    case 'LOUDNESS_RESET': {
      if (!doc.stromFlowId || !doc.loudnessMainBlockId) {
        console.warn('[controller] LOUDNESS_RESET: no active loudness block');
        break;
      }
      try {
        const strom = await makeStromClient();
        await strom.loudness.reset(doc.stromFlowId, doc.loudnessMainBlockId);
      } catch (err) {
        console.warn('[controller] LOUDNESS_RESET error:', String(err));
      }
      break;
    }
    case 'SET_EFFECT': {
      if (!doc.stromFlowId || !doc.mixerBlockId) break;
      const target = msg.target;
      const effect = msg.effect as VideoEffect;
      try {
        const strom = await makeStromClient();
        await strom.mixer.setVideoEffect(doc.stromFlowId, doc.mixerBlockId, { target, effect });
        // Update in-memory state
        if (target === 'master') {
          masterEffectByProduction.set(productionId, effect);
        } else if (typeof target === 'object' && 'input' in target) {
          const effects = inputEffectsByProduction.get(productionId) ?? [];
          effects[target.input] = effect;
          inputEffectsByProduction.set(productionId, effects);
        }
        broadcast(productionId, {
          type: 'FX_STATE',
          fxAvailable: fxAvailableByProduction.get(productionId) ?? false,
          inputEffects: inputEffectsByProduction.get(productionId) ?? [],
          masterEffect: masterEffectByProduction.get(productionId) ?? { type: 'none' },
        });
      } catch (err) {
        const message = err instanceof StromClientError ? err.message : String(err);
        ws.send(JSON.stringify({ type: 'ERROR', error: `FX: ${message}` }));
      }
      break;
    }
    default: {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Unknown message type' }));
    }
  }
}

const controllerWs: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    '/ws/productions/:id/controller',
    { websocket: true },
    async (socket, req) => {
      const { id } = req.params;
      subscribe(id, socket);
      notifySubscriberJoin(id);

      // Per-connection context — mutable so the audio block ID can be populated
      // at connect time and reused on every subsequent AUDIO_SET without a flow fetch.
      const ctx: { audioBlockId?: string } = {};

      // Register message/close handlers immediately so no messages are dropped
      // while we perform the async connect-time sync below.
      socket.on('message', (raw: Buffer | string) => {
        handleMessage(id, socket, raw.toString(), ctx).catch((err) => {
          console.error('[controller] unhandled message error:', err);
        });
      });

      socket.on('close', () => {
        unsubscribe(id, socket);
        stopMeterRelay(id);
        // Audio state registries are kept in memory so other connected clients
        // and future reconnects inherit the current AFV/mute configuration.
        // State is only wiped when the pipeline changes (new stromFlowId).
      });

      // Fetch production doc once for connect-time sync
      let connectDoc: ProductionDoc | null = null;
      try {
        connectDoc = await getDb().get(id) as ProductionDoc;
      } catch { /* production not found */ }

      // Detect pipeline change (new stromFlowId = sources remapped or flow rebuilt).
      // If the pipeline changed while a client stayed connected across the restart,
      // stale channel-index registries would apply mutes/AFV to the wrong channels.
      // Wipe immediately so this connect is treated as a fresh start.
      if (connectDoc?.stromFlowId) {
        const lastFlowId = activeFlowIdByProduction.get(id)
        if (lastFlowId && lastFlowId !== connectDoc.stromFlowId) {
          clearAudioState(id)
        }
        activeFlowIdByProduction.set(id, connectDoc.stromFlowId)
      }

      // Restore tally from DB if not already in memory (e.g. after server restart)
      let tally = getTally(id);
      if (tally.pgm === null && tally.pvw === null && connectDoc?.tally) {
        if (connectDoc.tally.pgm !== null || connectDoc.tally.pvw !== null) {
          tally = connectDoc.tally;
          setTally(id, tally);
        }
      }
      socket.send(JSON.stringify({ type: 'TALLY', ...tally }));

      const cachedAlpha = overlayAlphaByProduction.get(id);
      if (cachedAlpha !== undefined) {
        socket.send(JSON.stringify({ type: 'OVL_STATE', alpha: cachedAlpha }));
      }

      // Sync PiP state from in-memory server cache (populated by SET_PIP / SELECT_PVW_PIP).
      // If the cache is cold (fresh connect after deactivate or server restart),
      // hydrate it from the persisted pipConfigs on the ProductionDoc (issue #177)
      // so the operator's PiP layout is restored. If nothing was persisted, seed
      // empty slots from num_pips so the PipPanel shows the correct number of slots
      // without requiring a SET_PIP first.
      const restoredPipConfigs = connectDoc ? hydratePipConfigsFromDoc(connectDoc) : null;
      socket.send(JSON.stringify({
        type: 'PIP_STATE',
        pgmPip: pgmPipByProduction.get(id) ?? null,
        pvwPip: pvwPipByProduction.get(id) ?? null,
        pips:   pipConfigsByProduction.get(id) ?? [],
      }));

      // On the first connect after (re)activation, Strom's PiP slots start empty
      // (flow-generator only sets num_pips). Re-push any restored persisted layout
      // to Strom so what the operator saved is actually rendered (issue #177).
      if (restoredPipConfigs && connectDoc?.stromFlowId && connectDoc.mixerBlockId) {
        try {
          const strom = await makeStromClient();
          const flowId = connectDoc.stromFlowId;
          const mixerBlockId = connectDoc.mixerBlockId;
          for (let i = 0; i < restoredPipConfigs.length; i++) {
            const cfg = restoredPipConfigs[i];
            // Skip empty slots — nothing to restore.
            if (!cfg || (cfg.bg === null && cfg.zones.length === 0)) continue;
            await strom.mixer.updatePipConfig(flowId, mixerBlockId, i, {
              bg: cfg.bg,
              zones: cfg.zones,
              transforms: cfg.transforms,
            }).catch((err) => console.warn('[controller] restore pipConfig error:', err));
          }
        } catch (err) {
          console.warn('[controller] restore pipConfigs to Strom error:', err);
        }
      }

      const cachedDskLayers = dskLayersByProduction.get(id);
      if (cachedDskLayers) {
        for (const [layer, visible] of Object.entries(cachedDskLayers)) {
          socket.send(JSON.stringify({ type: 'DSK_STATE', layer: Number(layer), visible }));
        }
      }

      // Sync audio channel state and start meter relay using the audio mixer block
      if (connectDoc?.stromFlowId) {
        try {
          const strom = await makeStromClient();
          const { flow } = await strom.flows.get(connectDoc.stromFlowId);
          const blocks = flow.blocks ?? [];
          // Prefer the persisted audioMixerBlockId; fall back to scanning live flow blocks
          const audioBlockId = connectDoc.audioMixerBlockId ?? blocks.find((b) => b.block_definition_id === 'builtin.mixer')?.id;
          const mixerBlock = audioBlockId ? blocks.find((b) => b.id === audioBlockId) : undefined;
          if (audioBlockId) {
            ctx.audioBlockId = audioBlockId;
            const rawNumCh = mixerBlock?.properties?.num_channels;
            const numChannels = typeof rawNumCh === 'number' ? rawNumCh
              : typeof rawNumCh === 'string' ? parseInt(rawNumCh, 10)
              : 0;
            numAudioChannelsByProduction.set(id, numChannels);
            // Only initialise registries on first connect for this production.
            // Subsequent connects (refresh, second operator) inherit existing state.
            const isFirstConnect = !afvChannelsByProduction.has(id);
            if (isFirstConnect) {
              afvChannelsByProduction.set(id, new Set());
              mutedElementsByProduction.set(id, new Set());
              // All channels: open at unity gain, routed to main, unmuted.
              // Explicitly set faders so the UI always shows a consistent 1.0 on fresh start
              // regardless of what Strom's internal default happens to be.
              const initProps: Record<string, unknown> = {};
              const levelCache = channelLevelsByProduction.get(id) ?? new Map<string, number>();
              for (let i = 1; i <= numChannels; i++) {
                initProps[`ch${i}_fader`]   = 1.0;
                initProps[`ch${i}_mute`]    = false;
                initProps[`ch${i}_to_main`] = true;
                levelCache.set(`ch${i}`, 1.0);
              }
              initProps['main_fader'] = 1.0;
              levelCache.set('main', 1.0);
              channelLevelsByProduction.set(id, levelCache);
              await strom.flows.updateBlockProperties(connectDoc.stromFlowId!, audioBlockId, { properties: initProps })
                .catch((err) => console.warn('[controller] init channel props error:', err));
            }
            // Restore fader levels and mute state.
            // Server-side cache (channelLevelsByProduction) is authoritative — it is updated
            // on every AUDIO_SET volume and survives page refreshes / new tabs within the
            // same server session. Strom block properties are used as a fallback for
            // values set before the server started (e.g. pipeline defaults).
            const mutedSet = mutedElementsByProduction.get(id) ?? new Set<string>();
            const levelCache = channelLevelsByProduction.get(id);
            const blockProps = await strom.flows.getBlockProperties(connectDoc.stromFlowId, audioBlockId).catch(() => null);
            for (let i = 1; i <= numChannels; i++) {
              const cachedLevel = levelCache?.get(`ch${i}`);
              const stromLevel = blockProps?.properties[`ch${i}_fader`];
              const volume = cachedLevel ?? (typeof stromLevel === 'number' ? stromLevel : undefined);
              if (volume !== undefined) {
                socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: `ch${i}`, property: 'volume', value: volume }));
              }
              const isMuted = mutedSet.has(`ch${i}`);
              socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: `ch${i}`, property: 'mute', value: isMuted }));
            }
            // Restore main fader level
            const cachedMain = levelCache?.get('main');
            const stromMain = blockProps?.properties['main_fader'];
            const mainVolume = cachedMain ?? (typeof stromMain === 'number' ? stromMain : undefined);
            if (mainVolume !== undefined) {
              socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: 'main', property: 'volume', value: mainVolume }));
            }
            // Restore AUX master state — prefer in-memory cache (set by this session's
            // AUX_MASTER_SET messages), fall back to Strom block properties for the first
            // connect after a server restart when the cache is empty.
            const cachedAuxMasters = auxMasterByProduction.get(id);
            const props = blockProps?.properties ?? {};
            if (cachedAuxMasters && cachedAuxMasters.size > 0) {
              for (const [auxBus, { volume, muted }] of cachedAuxMasters) {
                socket.send(JSON.stringify({ type: 'AUX_MASTER_STATE', auxBus, volume, muted }));
              }
            } else {
              for (const [key, value] of Object.entries(props)) {
                const auxMatch = /^aux(\d+)_fader$/.exec(key);
                if (auxMatch && typeof value === 'number') {
                  const auxBus = parseInt(auxMatch[1], 10);
                  const muted = props[`aux${auxBus}_mute`] === true;
                  socket.send(JSON.stringify({ type: 'AUX_MASTER_STATE', auxBus, volume: value, muted }));
                }
              }
            }
            // Restore GRP master state — same cache-first pattern
            const cachedGrpMasters = grpMasterByProduction.get(id);
            if (cachedGrpMasters && cachedGrpMasters.size > 0) {
              for (const [grpBus, { volume, muted }] of cachedGrpMasters) {
                socket.send(JSON.stringify({ type: 'GRP_MASTER_STATE', grpBus, volume, muted }));
              }
            } else {
              for (const [key, value] of Object.entries(props)) {
                const grpMatch = /^group(\d+)_fader$/.exec(key);
                if (grpMatch && typeof value === 'number') {
                  const grpBus = parseInt(grpMatch[1], 10);
                  const muted = props[`group${grpBus}_mute`] === true;
                  socket.send(JSON.stringify({ type: 'GRP_MASTER_STATE', grpBus, volume: value, muted }));
                }
              }
            }
            // Restore monitor master state — prefer in-memory cache, fall back to Strom block props
            const cachedMonitor = monitorByProduction.get(id);
            if (cachedMonitor) {
              socket.send(JSON.stringify({ type: 'MONITOR_STATE', volume: cachedMonitor.volume, muted: cachedMonitor.muted }));
            } else {
              const monVol = props['monitor_fader'];
              if (typeof monVol === 'number') {
                const monMuted = props['monitor_mute'] === true;
                socket.send(JSON.stringify({ type: 'MONITOR_STATE', volume: monVol, muted: monMuted }));
              }
            }
            // Restore per-channel AUX send state (fader level, ON/OFF, pre/post)
            const cachedAuxSends = auxSendByProduction.get(id);
            if (cachedAuxSends) {
              for (const [key, { level, enabled, pre }] of cachedAuxSends) {
                // key format: 'ch{N}_aux{M}'
                const m = /^(ch\d+)_aux(\d+)$/.exec(key);
                if (m) {
                  socket.send(JSON.stringify({ type: 'AUX_SEND_STATE', elementId: m[1], auxBus: parseInt(m[2], 10), level, enabled, pre }));
                }
              }
            }
            // Restore per-channel GRP send state (G1/G2 assignments + fader level).
            // If there are no cached assignments (fresh production start or after deactivation),
            // send GRP_STATE_RESET so the client clears any stale state it retained from a
            // previous session — the deactivation broadcast may have been missed if the socket
            // reconnected after clearAudioState was called.
            const cachedGrpSends = grpSendByProduction.get(id);
            if (cachedGrpSends && cachedGrpSends.size > 0) {
              for (const [key, { level, enabled }] of cachedGrpSends) {
                // key format: 'ch{N}_grp{M}'
                const m = /^(ch\d+)_grp(\d+)$/.exec(key);
                if (m) {
                  socket.send(JSON.stringify({ type: 'GRP_SEND_STATE', elementId: m[1], grpBus: parseInt(m[2], 10), level, enabled }));
                }
              }
            } else {
              socket.send(JSON.stringify({ type: 'GRP_STATE_RESET' }));
            }
            // Send current AFV state to this connecting client so it can restore
            // its store without the operator having to re-enable AFV per strip.
            const currentAfvSet = afvChannelsByProduction.get(id) ?? new Set<string>();
            for (const mixerInput of currentAfvSet) {
              socket.send(JSON.stringify({ type: 'AFV_STATE', mixerInput, enabled: true }));
            }
            // Send current PFL/AFL state so newly-connected clients show correct button state.
            for (const elId of (activePflByProduction.get(id) ?? [])) {
              socket.send(JSON.stringify({ type: 'PFL_STATE', elementId: elId, enabled: true }));
            }
            for (const elId of (activeAflByProduction.get(id) ?? [])) {
              socket.send(JSON.stringify({ type: 'AFL_STATE', elementId: elId, enabled: true }));
            }
            // Send current source offset state so newly-connected clients inherit
            // any offsets set by other operators without needing a round-trip.
            const currentOffsets = sourceOffsetsByProduction.get(id);
            if (currentOffsets) {
              for (const [mixerInput, offsetMs] of currentOffsets) {
                socket.send(JSON.stringify({ type: 'SOURCE_OFFSET_STATE', mixerInput, offsetMs }));
              }
            }
            const currentAudioOffsets = sourceAudioOffsetsByProduction.get(id);
            if (currentAudioOffsets) {
              for (const [mixerInput, offsetMs] of currentAudioOffsets) {
                socket.send(JSON.stringify({ type: 'SOURCE_AUDIO_OFFSET_STATE', mixerInput, offsetMs }));
              }
            }
            // Send current AFV ramp settings — prefer runtime registry, fall back to
            const rampEntry = afvRampByProduction.get(id);
            const rampUpMs   = rampEntry?.rampUpMs   ?? 300;
            const rampDownMs = rampEntry?.rampDownMs ?? 50;
            socket.send(JSON.stringify({ type: 'AFV_RAMP_STATE', rampUpMs, rampDownMs }));
            // Fetch live FX state from Strom on connect so fxAvailable is authoritative
            try {
              const stromFx = await makeStromClient();
              const mixerState = await stromFx.mixer.getState(connectDoc.stromFlowId!, connectDoc.mixerBlockId!);
              if (mixerState.fx_available !== undefined) {
                fxAvailableByProduction.set(id, mixerState.fx_available);
              }
              if (Array.isArray(mixerState.input_effects)) {
                inputEffectsByProduction.set(id, mixerState.input_effects);
              }
              if (mixerState.master_effect) {
                masterEffectByProduction.set(id, mixerState.master_effect);
              }
            } catch {
              // Non-fatal — older Strom versions may not support this endpoint
            }
            const fxAvailable = fxAvailableByProduction.get(id) ?? false;
            socket.send(JSON.stringify({
              type: 'FX_STATE',
              fxAvailable,
              inputEffects: inputEffectsByProduction.get(id) ?? [],
              masterEffect: masterEffectByProduction.get(id) ?? { type: 'none' },
            }));
            startMeterRelay(id, connectDoc.stromFlowId, audioBlockId, connectDoc.loudnessMainBlockId);
          }
        } catch (err) {
          console.warn('[controller] audio sync error:', err);
        }
      }
    }
  );
};

export default controllerWs;
