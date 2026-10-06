import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { z } from 'zod';
import { getDb, getSourcesDb, getGuestSessionsDb, getGuestInvitesDb } from '../db/index.js';
import { updateProductionDoc } from '../routes/productions.js';
import type { ProductionDoc, ClipState, SourceDoc, GuestSessionState } from '../db/types.js';
import { getTally, setTally, subscribe, unsubscribe, broadcast, nextSeq, currentSeq, getOperatorSockets } from '../services/tally.service.js';
import {
  cueClip, playClip, stopClip, pauseClip, seekClip,
  resolveClipSource, resolveClipTarget,
  ClipNotFoundError, ClipNotActivatedError, ClipNotCuedError, ClipMediaError,
} from '../lib/clip-control.js';
import { getClipStateEntry, getAllClipStates, setClipStateEntry, clearClipState } from '../services/clip-state.service.js';
import { persistClipCue, clearPersistedClipCue } from '../services/clip-cue-store.js';
import { startClipRelay, stopClipRelay, reconcileClipRelay } from '../services/clip-relay.js';
import { CONTRACT_VERSION, computeTallyContributions } from '../services/automation-contract.js';
import { startMeterRelay, stopMeterRelay, reconcileMeterRelay } from '../services/meter-relay.js';
import { StromClient, StromClientError, StromPropertiesRejectedError, type TransitionType as StromTransitionType, type PipZone, type PipConfig, type PipTransforms, type VideoEffect, type EffectTarget, type SetVideoEffectRequest } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { graphicUrl } from '../lib/url-validation.js';
import { decryptAddressPassphrase } from '../lib/srt-passphrase-crypto.js';
import { loadAudioChannels } from '../lib/audio-channels.js';
import {
  mirrorToMainForPersistedReturns,
  returnSendMatrix,
  type PersistedReturnBus,
  type ReturnMode,
} from '../lib/return-feeds.js';
import { config } from '../config.js';
import { notifySubscriberJoin, resetIdleTimer } from '../services/idle-watchdog.js';
import { activePflByProduction, activeAflByProduction, anySoloActive, numAudioChannelsByProduction } from '../services/pfl-state.js';
import { buildProductionStatusEvent, deriveOutputSnapshot } from '../lib/production-health.js';
import { getWhipIngestState } from '../services/whip-ingest-state.js';

function stromErrorMessage(err: unknown): string {
  if (err instanceof StromClientError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Per-connection message rate limiting
// ---------------------------------------------------------------------------
//
// HTTP routes are protected by @fastify/rate-limit, but WebSocket message
// throughput was previously unbounded: a single authenticated client could
// flood commands (each of which may trigger a downstream Strom API call),
// causing DoS for other operators. We apply a sliding-window limit per
// connection — a general cap plus a stricter cap on expensive commands.

/** General cap: max inbound messages per connection per window. */
const RATE_LIMIT_GENERAL_MAX = 20;
/** Stricter cap for expensive commands (each triggers heavy Strom work). */
const RATE_LIMIT_EXPENSIVE_MAX = 5;
/** Sliding-window size in milliseconds. */
const RATE_LIMIT_WINDOW_MS = 1000;

/** Message types whose processing is expensive enough to warrant a tighter cap. */
const EXPENSIVE_MESSAGE_TYPES = new Set(['MACRO_EXEC', 'GO_LIVE', 'CUT_STREAM', 'HTML_SOURCE_EVENT']);

/** Per-connection sliding-window timestamps. Lives on the connection ctx so it
 * is garbage-collected when the socket closes (no global registry to leak). */
interface RateLimitState {
  general: number[];
  expensive: number[];
}

/**
 * Records the message against the sliding windows and reports whether it is
 * allowed. Old timestamps outside the window are pruned on every call, so state
 * stays bounded for the lifetime of the connection.
 */
function checkRateLimit(state: RateLimitState, isExpensive: boolean, now: number): boolean {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;

  state.general = state.general.filter((t) => t > cutoff);
  if (state.general.length >= RATE_LIMIT_GENERAL_MAX) return false;

  if (isExpensive) {
    state.expensive = state.expensive.filter((t) => t > cutoff);
    if (state.expensive.length >= RATE_LIMIT_EXPENSIVE_MAX) return false;
    state.expensive.push(now);
  }

  state.general.push(now);
  return true;
}

// ---------------------------------------------------------------------------
// Command acknowledgement helpers (automation contract §2)
// ---------------------------------------------------------------------------
//
// Two-phase ACK: clients attach an optional `cmdId` to any inbound command.
// The server sends:
//   ACK { cmdId, phase: 'accepted', seq, ts }  — passed validation + dispatched
//   ACK { cmdId, phase: 'executed', seq, ts }  — Strom call returned / state persisted
//   NACK { cmdId, error, seq, ts }             — rejected (validation or runtime error)
//
// Clients that omit `cmdId` see the existing behaviour unchanged.
// ACK/NACK events go only to the originating socket, not broadcast to all subscribers.

/**
 * Send an ACK frame directly to the originating socket.
 * `seq` and `ts` are stamped here so they are consistent with the broadcast envelope.
 */
function sendAck(ws: WebSocket, productionId: string, cmdId: string, phase: 'accepted' | 'executed'): void {
  const seq = nextSeq(productionId);
  ws.send(JSON.stringify({ type: 'ACK', cmdId, phase, seq, ts: new Date().toISOString() }));
}

/**
 * Send a NACK frame directly to the originating socket.
 */
function sendNack(ws: WebSocket, productionId: string, cmdId: string, error: string): void {
  const seq = nextSeq(productionId);
  ws.send(JSON.stringify({ type: 'NACK', cmdId, error, seq, ts: new Date().toISOString() }));
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
 * failure is logged at warn (with productionId + action) and swallowed — a
 * deliberate decision to keep the mixer broadcast path unchanged. Non-conflict
 * errors (500s, transport failures, a not_found from the db.get) are NOT
 * swallowed; they propagate to the socket handler's catch-all as before #175.
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
      if (isConflictError(err)) {
        // On a revision conflict, loop to re-read the latest _rev and re-apply.
        if (attempt < MAX_DB_WRITE_RETRIES - 1) continue;
        // Exhausted conflict retries: deliberately logged and swallowed to
        // keep the mixer broadcast path unchanged (accepted decision).
        console.warn(
          `[controller] Failed to persist mixer mutation after ${attempt + 1} conflict attempt(s)`,
          { productionId, action },
          err,
        );
        return;
      }
      // Non-conflict errors (500s, socket resets, not_found from db.get, …)
      // propagate to the socket handler's catch-all, as before #175.
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Optional client-supplied command correlation id (automation contract §2).
// Clients that want two-phase ACK (accepted → executed) attach a cmdId to
// any inbound command. The server echoes it in ACK/NACK events. Additive /
// backward-compatible: clients that do not send cmdId see unchanged behaviour.
// ---------------------------------------------------------------------------

type InboundMessage =
  | { type: 'CUT'; mixerInput: string; afvRampUpMs?: number; afvRampDownMs?: number; cmdId?: string }
  | { type: 'TRANSITION'; mixerInput: string; transitionType: string; durationMs?: number; afvRampUpMs?: number; afvRampDownMs?: number; cmdId?: string }
  | { type: 'TAKE'; pip?: number; transitionType?: string; durationMs?: number; afvRampUpMs?: number; afvRampDownMs?: number; cmdId?: string }
  | { type: 'SET_PVW'; mixerInput: string; cmdId?: string }
  | { type: 'FTB'; active?: boolean; durationMs?: number; cmdId?: string }
  | { type: 'SET_OVL'; alpha: number; cmdId?: string }
  | { type: 'GO_LIVE'; cmdId?: string }
  | { type: 'CUT_STREAM'; cmdId?: string }
  | { type: 'GRAPHIC_ON'; overlayId: string; cmdId?: string }
  | { type: 'GRAPHIC_OFF'; overlayId: string; cmdId?: string }
  | { type: 'DSK_TOGGLE'; layer: number; visible?: boolean; cmdId?: string }
  | { type: 'MACRO_EXEC'; macroId: string; cmdId?: string }
  | { type: 'AUDIO_SET'; elementId: string; property: 'volume' | 'mute'; value: unknown; ramp_ms?: number; cmdId?: string }
  | { type: 'AFV_SET'; mixerInput: string; enabled: boolean; cmdId?: string }
  | { type: 'AFV_RAMP_SET'; rampUpMs: number; rampDownMs: number; cmdId?: string }
  | { type: 'PFL_SET'; elementId: string; enabled: boolean; volume?: number; cmdId?: string }
  | { type: 'AFL_SET'; elementId: string; enabled: boolean; cmdId?: string }
  | { type: 'AUX_SEND_SET'; elementId: string; auxBus: number; level: number; enabled: boolean; pre?: boolean; cmdId?: string }
  | { type: 'AUX_MASTER_SET'; auxBus: number; volume: number; muted: boolean; cmdId?: string }
  | { type: 'GRP_SEND_SET'; elementId: string; grpBus: number; level: number; enabled: boolean; cmdId?: string }
  | { type: 'GRP_MASTER_SET'; grpBus: number; volume: number; muted: boolean; cmdId?: string }
  | { type: 'MONITOR_SET'; volume: number; muted: boolean; cmdId?: string }
  | { type: 'SOURCE_OFFSET_SET'; mixerInput: string; offsetMs: number; cmdId?: string }
  | { type: 'SOURCE_AUDIO_OFFSET_SET'; mixerInput: string; offsetMs: number; cmdId?: string }
  | { type: 'LOUDNESS_RESET'; cmdId?: string }
  | { type: 'SELECT_PVW_PIP'; pip: number; cmdId?: string }
  | { type: 'SET_PIP'; pip: number; bg: number | null; zones: PipZone[]; transforms?: PipTransforms; cmdId?: string }
  | { type: 'SET_EFFECT'; target: EffectTarget; effect: VideoEffect; cmdId?: string }
  | { type: 'HTML_SOURCE_EVENT'; sourceId: string; params: Record<string, string>; mode?: 'replace' | 'merge'; cmdId?: string }
  | { type: 'CLIP_CUE'; mixerInput: string; clipId?: string; cmdId?: string }
  | { type: 'CLIP_PLAY'; mixerInput: string; cmdId?: string }
  | { type: 'CLIP_STOP'; mixerInput: string; cmdId?: string }
  | { type: 'CLIP_PAUSE'; mixerInput: string; cmdId?: string }
  | { type: 'CLIP_SEEK'; mixerInput: string; positionMs: number; cmdId?: string }
  | { type: 'RETURN_SET'; mixerInput: string; mode: ReturnMode; cmdId?: string }
  | { type: 'KEEP_ALIVE'; cmdId?: string };

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

// Optional client-supplied correlation id for two-phase ACK. UUID-like string,
// capped at 128 chars to prevent oversized strings from reaching the handler.
const cmdIdSchema = z.string().min(1).max(128).optional();

const InboundMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CUT'), mixerInput: mixerInputSchema, afvRampUpMs: rampMsSchema.optional(), afvRampDownMs: rampMsSchema.optional(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('TRANSITION'), mixerInput: mixerInputSchema, transitionType: TransitionTypeSchema, durationMs: rampMsSchema.optional(), afvRampUpMs: rampMsSchema.optional(), afvRampDownMs: rampMsSchema.optional(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('TAKE'), pip: pipIndexSchema.optional(), transitionType: TransitionTypeSchema.optional(), durationMs: rampMsSchema.optional(), afvRampUpMs: rampMsSchema.optional(), afvRampDownMs: rampMsSchema.optional(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('SET_PVW'), mixerInput: mixerInputSchema, cmdId: cmdIdSchema }),
  z.object({ type: z.literal('FTB'), active: z.boolean().optional(), durationMs: rampMsSchema.optional(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('SET_OVL'), alpha: alphaSchema, cmdId: cmdIdSchema }),
  z.object({ type: z.literal('GO_LIVE'), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('CUT_STREAM'), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('GRAPHIC_ON'), overlayId: z.string().min(1).max(128), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('GRAPHIC_OFF'), overlayId: z.string().min(1).max(128), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('DSK_TOGGLE'), layer: layerSchema, visible: z.boolean().optional(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('MACRO_EXEC'), macroId: z.string().min(1).max(128), cmdId: cmdIdSchema }),
  z.object({
    type: z.literal('AUDIO_SET'),
    elementId: elementIdSchema,
    property: z.enum(['volume', 'mute']),
    value: z.union([z.number().min(0).max(10), z.boolean()]),
    ramp_ms: rampMsSchema.optional(),
    cmdId: cmdIdSchema,
  }),
  z.object({ type: z.literal('AFV_SET'), mixerInput: mixerInputSchema, enabled: z.boolean(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('AFV_RAMP_SET'), rampUpMs: rampMsSchema, rampDownMs: rampMsSchema, cmdId: cmdIdSchema }),
  z.object({ type: z.literal('PFL_SET'), elementId: elementIdSchema, enabled: z.boolean(), volume: levelSchema.optional(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('AFL_SET'), elementId: elementIdSchema, enabled: z.boolean(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('AUX_SEND_SET'), elementId: elementIdSchema, auxBus: busSchema, level: levelSchema, enabled: z.boolean(), pre: z.boolean().optional(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('AUX_MASTER_SET'), auxBus: busSchema, volume: faderSchema, muted: z.boolean(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('GRP_SEND_SET'), elementId: elementIdSchema, grpBus: busSchema, level: levelSchema, enabled: z.boolean(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('GRP_MASTER_SET'), grpBus: busSchema, volume: faderSchema, muted: z.boolean(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('MONITOR_SET'), volume: faderSchema, muted: z.boolean(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('SOURCE_OFFSET_SET'), mixerInput: mixerInputSchema, offsetMs: offsetMsSchema, cmdId: cmdIdSchema }),
  z.object({ type: z.literal('SOURCE_AUDIO_OFFSET_SET'), mixerInput: mixerInputSchema, offsetMs: offsetMsSchema, cmdId: cmdIdSchema }),
  z.object({ type: z.literal('LOUDNESS_RESET'), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('SELECT_PVW_PIP'), pip: pipIndexSchema, cmdId: cmdIdSchema }),
  z.object({
    type: z.literal('SET_PIP'),
    pip: pipIndexSchema,
    bg: z.number().int().min(0).max(15).nullable(),
    zones: z.array(PipZoneSchema).max(15),
    transforms: z.record(z.string(), z.object({ left: z.number().min(0).max(1), top: z.number().min(0).max(1), right: z.number().min(0).max(1), bottom: z.number().min(0).max(1) })).optional(),
    cmdId: cmdIdSchema,
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
    cmdId: cmdIdSchema,
  }),
  // Generic HTML-source event-forwarding surface (issue #268, spec
  // docs/specs/html-source-event-forwarding.md). Thin transport only: params
  // are opaque key/value query parameters — Open Live never interprets graphic
  // semantics. The resulting effective URL is re-validated with graphicUrl().
  z.object({
    type: z.literal('HTML_SOURCE_EVENT'),
    sourceId: z.string().min(1).max(128),          // references SourceDoc._id ("src-<uuid>")
    params: z.record(
      z.string().min(1).max(64),                   // param key
      z.string().max(1024),                        // param value (opaque to Open Live)
    ),
    mode: z.enum(['replace', 'merge']).default('merge').optional(),
    cmdId: cmdIdSchema,
  }),
  // Clip cue/play control (epic #206, issue #278). Reuses mixerInputSchema;
  // handlers delegate to the shared src/lib/clip-control.ts module.
  z.object({ type: z.literal('CLIP_CUE'), mixerInput: mixerInputSchema, clipId: z.string().min(1).max(256).optional(), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('CLIP_PLAY'), mixerInput: mixerInputSchema, cmdId: cmdIdSchema }),
  z.object({ type: z.literal('CLIP_STOP'), mixerInput: mixerInputSchema, cmdId: cmdIdSchema }),
  z.object({ type: z.literal('CLIP_PAUSE'), mixerInput: mixerInputSchema, cmdId: cmdIdSchema }),
  z.object({ type: z.literal('CLIP_SEEK'), mixerInput: mixerInputSchema, positionMs: z.number().int().min(0).max(24 * 60 * 60 * 1000), cmdId: cmdIdSchema }),
  // Crew switches a guest's synced return mode (epic #208, issue #301). Shares
  // applyReturnMode with the crew REST route and guest token route: persist +
  // apply live + broadcast RETURN_STATE. v1 only program/program-minus.
  z.object({ type: z.literal('RETURN_SET'), mixerInput: mixerInputSchema, mode: z.enum(['program', 'program-minus']), cmdId: cmdIdSchema }),
  z.object({ type: z.literal('KEEP_ALIVE'), cmdId: cmdIdSchema }),
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the numeric index from a mixer pad name like "video_in_2" → 2.
 * Returns null if the pad name doesn't match the expected format.
 */
/**
 * True when `mixerInput` is already the on-air source. A CUT or TRANSITION
 * to it is a no-op, like pressing the PGM button of the source that is
 * already on air. Without this guard the tally became `{pgm: X, pvw: X}` and
 * the Strom take ran with `from_input === to_input`, which Strom treats as a
 * PGM/PVW swap, so the picture flipped to the previous preview.
 *
 * While a PiP is on PGM this always returns false (the pre-#347 rule, restored
 * in #353): a CUT/TRANSITION to *any* real input — including the background
 * tracked behind the PiP — is a genuine change, because it must take the PiP off
 * program. The target-equals-background case is handled explicitly by the
 * CUT/TRANSITION/macro paths via `takePipOffToBackground`, which avoids the
 * degenerate `from_input === to_input` take (issue #342) without dropping the
 * command. #347 returned true here when the target equalled the background,
 * which silently dropped the command and left the Studio tally split (#353).
 */
function isAlreadyOnProgram(productionId: string, mixerInput: string): boolean {
  const pgmPip = pgmPipByProduction.get(productionId) ?? null;
  if (pgmPip !== null) {
    return false;
  }
  return getTally(productionId).pgm === mixerInput;
}

function padToIndex(mixerInput: string): number | null {
  const match = /video_in_(\d+)$/.exec(mixerInput);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Computes the effective HTML-source URL from a base address and forwarded
 * params (issue #268). `merge` updates/adds the given keys on the base URL's
 * current query; `replace` sets the query to exactly `params`. The resulting
 * URL is re-validated with `graphicUrl()` — the same SSRF/scheme gate that
 * guards source creation — so event-forwarding cannot smuggle a private-IP
 * host, a `javascript:`/`file:` scheme, or a `data:text/html` target past it.
 *
 * Exported for tests. Throws on an unparseable base address, an oversized
 * query, or a `graphicUrl()` rejection.
 */
export function buildHtmlSourceUrl(
  baseAddress: string,
  currentParams: Record<string, string>,
  params: Record<string, string>,
  mode: 'replace' | 'merge',
): { effectiveUrl: string; params: Record<string, string> } {
  let parsed: URL;
  try {
    parsed = new URL(baseAddress);
  } catch {
    throw new Error('HTML source address is not a valid URL');
  }
  // Effective params: 'replace' uses exactly the incoming params; 'merge'
  // layers the incoming params over the current effective set.
  const effective: Record<string, string> =
    mode === 'replace' ? { ...params } : { ...currentParams, ...params };

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(effective)) {
    search.set(key, value);
  }
  const query = search.toString();
  if (query.length > HTML_SOURCE_MAX_QUERY_LENGTH) {
    throw new Error('HTML source query too long');
  }
  parsed.search = query;
  const effectiveUrl = parsed.toString();
  // Re-validate the resulting URL — non-negotiable SSRF guard (spec Risks).
  graphicUrl(effectiveUrl);
  return { effectiveUrl, params: effective };
}

function toStromTransition(type: string): StromTransitionType {
  return type || 'cut';
}

async function makeStromClient(): Promise<StromClient> {
  const token = await getStromToken(config.stromToken).catch(() => undefined)
  return new StromClient({ baseUrl: config.stromUrl, token, blockPropertiesReadTimeoutMs: config.stromBlockPropertiesReadTimeoutMs })
}

// Returns true when the transition either reached Strom successfully or there
// was nothing to send (no flow configured / a degenerate skip) — i.e. nothing
// Strom could disagree with. Returns false only when Strom actively rejected
// the /transition call, so callers can suppress the PiP-displacement broadcast
// and the preview restore that would otherwise contradict Strom (issue #355).
async function stromTransition(
  doc: ProductionDoc,
  fromMixerInput: string | null,
  toMixerInput: string | null,
  transitionType: StromTransitionType,
  durationMs?: number,
): Promise<boolean> {
  if (!doc.stromFlowId || !doc.mixerBlockId) return true;
  if (!toMixerInput) {
    console.warn('[controller] Strom transition skipped — no toMixerInput');
    return true;
  }
  const toIndex = padToIndex(toMixerInput);
  if (toIndex === null) {
    console.warn('[controller] Strom transition skipped — cannot parse index from pad:', toMixerInput);
    return true;
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
    return false;
  }
  return true;
}

/**
 * #353: a CUT/TRANSITION whose target is exactly the real input already tracked
 * behind an on-program PiP (`pgmBgByProduction`). Pre-#347 this took the PiP off
 * program; #347 re-classified it as "already on program" in `isAlreadyOnProgram`,
 * so the CUT/TRANSITION handlers only acked and broke — no TALLY, no PIP_STATE,
 * no Strom call. The command was silently dropped, so the client's optimistic
 * swap was never corrected and the Studio tally was left split (PGM showing both
 * the real source and the PiP, PVW empty). This restores the pre-#347 behaviour:
 * the background stays on PGM, PVW clears, and the PiP moves to PVW.
 *
 * Tally + PiP state are mutated and broadcast synchronously (before any Strom
 * await), matching the non-background PiP path in the CUT/TRANSITION handlers.
 *
 * Strom: we deliberately do NOT fire a mixer transition here. The target input
 * equals the on-air background, so a transition would carry
 * `from_input === to_input`, which Strom treats as a degenerate PGM/PVW swap
 * (issue #342) and which flips the picture to the previous preview. This client's
 * Strom mixer API (`src/lib/strom.ts`) exposes only `transition` and
 * `selectPreview`; there is no dedicated "clear the on-program PiP overlay"
 * endpoint, and the transition model swaps the PVW/PGM buses, so removing the
 * overlay while keeping the same background on program cannot be expressed
 * without that forbidden degenerate transition. We therefore select the PiP on
 * Strom's preview (mirroring the `pvwPip` state we just broadcast and the
 * pip-restore step the other PiP paths use), treating any error as non-fatal.
 *
 * OPEN QUESTION: fully decompositing the on-program PiP inside Strom for this
 * exact "take the background out from under the PiP" case likely needs a
 * Strom-side primitive this client does not yet expose (a non-degenerate
 * program-overlay clear). Until then the controller tally/PiP state and the
 * TALLY/PIP_STATE broadcasts are always corrected so optimistically-swapped
 * clients are made consistent. See issue #353.
 */
async function takePipOffToBackground(
  productionId: string,
  doc: ProductionDoc,
  target: string,
  pgmPip: number,
  persistLabel: string,
  transitionMeta?: { transitionType?: string; durationMs?: number },
): Promise<void> {
  const newTally = { pgm: target, pvw: null };
  setTally(productionId, newTally);
  // PiP leaves PGM and lands on PVW; the background it sat over stays on PGM.
  pgmPipByProduction.set(productionId, null);
  pvwPipByProduction.set(productionId, pgmPip);
  pvwBeforePipByProduction.set(productionId, target);
  pgmBgByProduction.delete(productionId);
  broadcast(productionId, { type: 'PIP_STATE', pgmPip: null, pvwPip: pgmPip, pips: pipConfigsByProduction.get(productionId) ?? [] });
  await persistMixerMutation(productionId, persistLabel, (d) => ({ ...d, tally: newTally }));
  broadcast(productionId, {
    type: 'TALLY',
    ...buildTallyPayload(productionId, newTally, doc),
    ...(transitionMeta?.transitionType ? { transitionType: transitionMeta.transitionType, durationMs: transitionMeta.durationMs } : {}),
  });
  if (doc.stromFlowId && doc.mixerBlockId) {
    try {
      const strom = await makeStromClient();
      await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { pip: pgmPip } });
    } catch (err) {
      console.debug('[controller] Strom selectPreview (PiP off to background, non-fatal):', err);
    }
  }
}

/**
 * #353 item 3: never drop a CUT/TRANSITION silently. On the genuine no-op path
 * (the target is already the sole on-air source, no PiP involved) re-broadcast
 * the current TALLY and PIP_STATE so a client that optimistically swapped
 * PGM/PVW is corrected back to the real state.
 */
function rebroadcastMixerState(productionId: string, doc: ProductionDoc): void {
  broadcast(productionId, { type: 'TALLY', ...buildTallyPayload(productionId, getTally(productionId), doc) });
  broadcast(productionId, {
    type: 'PIP_STATE',
    pgmPip: pgmPipByProduction.get(productionId) ?? null,
    pvwPip: pvwPipByProduction.get(productionId) ?? null,
    pips: pipConfigsByProduction.get(productionId) ?? [],
  });
}

// ---------------------------------------------------------------------------
// #430: rolling back a switch Strom rejected
//
// A CUT/TRANSITION/TAKE mutates the tally, the PiP maps, and the persisted doc,
// then broadcasts TALLY *before* awaiting Strom's /transition. #355 already
// stopped the controller from *announcing a displaced PiP* (the deferred
// PIP_STATE + preview restore) when that transition is rejected, but the tally,
// the PiP-map mutations, and the persisted doc were still left on the new value.
// Clients were therefore told the new source is on program (via the already-sent
// TALLY) while Strom kept airing the old one, until the next successful switch.
//
// `snapshotSwitchState` captures the pre-switch state before any mutation, and
// `restoreSwitchState` rolls all of it back and re-broadcasts the authoritative
// TALLY + PIP_STATE so every client drops the switch it optimistically showed.
// Applied on every CUT/TRANSITION/TAKE path, interactive and macro.
// ---------------------------------------------------------------------------

interface SwitchStateSnapshot {
  tally: { pgm: string | null; pvw: string | null };
  pgmPip: number | null;
  pvwPip: number | null;
  pvwBeforePip: string | null;
  pgmBg: string | null;
}

/**
 * Snapshot the controller's switch-related state so a rejected transition can be
 * rolled back. Must be called before the handler mutates any of it. The tally is
 * copied (getTally returns the live stored object, which some handlers mutate in
 * place).
 */
function snapshotSwitchState(productionId: string): SwitchStateSnapshot {
  return {
    tally: { ...getTally(productionId) },
    pgmPip: pgmPipByProduction.get(productionId) ?? null,
    pvwPip: pvwPipByProduction.get(productionId) ?? null,
    pvwBeforePip: pvwBeforePipByProduction.get(productionId) ?? null,
    pgmBg: pgmBgByProduction.get(productionId) ?? null,
  };
}

/**
 * Restore the pre-switch snapshot after Strom rejected the transition (#430):
 * roll back the tally, the four PiP maps, and the persisted doc, then re-broadcast
 * the authoritative TALLY and PIP_STATE. The absent-key and null-value readings of
 * these maps are equivalent everywhere they are consumed (reads coalesce with
 * `?? null`), so restoring with `set` is faithful.
 */
async function restoreSwitchState(
  productionId: string,
  doc: ProductionDoc,
  snapshot: SwitchStateSnapshot,
): Promise<void> {
  setTally(productionId, { pgm: snapshot.tally.pgm, pvw: snapshot.tally.pvw });
  pgmPipByProduction.set(productionId, snapshot.pgmPip);
  pvwPipByProduction.set(productionId, snapshot.pvwPip);
  pvwBeforePipByProduction.set(productionId, snapshot.pvwBeforePip);
  pgmBgByProduction.set(productionId, snapshot.pgmBg);
  await persistMixerMutation(productionId, 'SWITCH_REJECTED_ROLLBACK', (d) => ({ ...d, tally: snapshot.tally }));
  broadcast(productionId, { type: 'TALLY', ...buildTallyPayload(productionId, snapshot.tally, doc) });
  broadcast(productionId, {
    type: 'PIP_STATE',
    pgmPip: snapshot.pgmPip,
    pvwPip: snapshot.pvwPip,
    pips: pipConfigsByProduction.get(productionId) ?? [],
  });
}

/**
 * Tell the operator a switch was rejected by Strom. Mirrors the not-found guard:
 * a NACK when the command carried a cmdId (two-phase ACK), an ERROR frame
 * otherwise. The caller must NOT also send an `executed` ACK — the switch never
 * reached air.
 */
function notifySwitchRejected(ws: WebSocket, productionId: string, cmdId: string | undefined): void {
  const error = 'Switch rejected by Strom';
  if (cmdId) {
    sendNack(ws, productionId, cmdId, error);
  } else {
    ws.send(JSON.stringify({ type: 'ERROR', error }));
  }
}

// ---------------------------------------------------------------------------
// Audio volume debounce
// ---------------------------------------------------------------------------

// Debounce rapid volume nudges so back-to-back AUDIO_SET volume messages don't
// flood Strom's HTTP connection pool. Mute changes skip the debounce.
const pendingVolume = new Map<string, NodeJS.Timeout>()

// Latest volume write per debounce key, numbered from one counter so a newer
// move is recognised even when it repeats the refused level.
let volumeWriteCounter = 0
const latestVolumeWrite = new Map<string, number>()

/**
 * Mute writes in flight per `${productionId}:${elementId}`. `settled` is the
 * best known Strom state so far; when the last outstanding write finishes, the
 * mute registry is set from it. When writes overlapped or one got no clear
 * answer, Strom's state is read back before settling. The newest write shows
 * its result as soon as it applies; `shown` is the state last broadcast, so
 * the settle only broadcasts a correction.
 */
const muteWritesInFlight = new Map<string, {
  pending: number; latest: number; settled: boolean; overlapped: boolean; unclear: boolean; shown?: boolean;
}>()
let muteWriteCounter = 0
/** Newest mute write per key, kept while a read-back is out so a stale answer is recognised. */
const latestMuteWrite = new Map<string, number>()

/** Strom's mute state for a mixer element from a block-properties reply, if present. */
function stromMuteState(elementId: string, props: Record<string, unknown>): boolean | undefined {
  if (elementId === 'main') return typeof props['main_mute'] === 'boolean' ? props['main_mute'] : undefined
  const toMain = props[`${elementId}_to_main`]
  return typeof toMain === 'boolean' ? !toMain : undefined
}

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
 * Effective HTML-source query parameters per production, keyed by sourceId
 * (SourceDoc._id). Transient in-memory operator state — mirrors
 * `overlayAlphaByProduction` (issue #268, ADR-002): replayed on connect,
 * reset on server restart, never persisted to CouchDB.
 */
interface HtmlSourceState {
  params: Record<string, string>;
  effectiveUrl: string;
  updatedAt: string;
}
const htmlSourceParamsByProduction = new Map<string, Map<string, HtmlSourceState>>()

/** Max serialized query length applied to a forwarded HTML-source URL. Bounds cefsrc URL size. */
const HTML_SOURCE_MAX_QUERY_LENGTH = 4096;

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

/**
 * The real input sitting behind a PiP that is on program, or null.
 *
 * While a PiP occupies PGM, `tally.pgm` is null, so without this a subscriber
 * cannot tell "nothing on program" from "a PiP over input 3". The value is
 * never re-broadcast on its own, so a client attaching mid-show has no other
 * way to recover it.
 */
const pgmBgOf = (productionId: string): string | null =>
  pgmBgByProduction.get(productionId) ?? null

/**
 * Builds the contribution-based tally payload (automation contract §3).
 *
 * Returns the fields to spread into a TALLY broadcast — backward-compatible:
 * the existing `pgm` / `pvw` / `pgmBg` fields are still present; the new
 * `program` / `preview` / `contributions` fields are additive.
 *
 * @param productionId - the production
 * @param tally        - current {pgm, pvw} tally
 * @param doc          - current ProductionDoc (for graphics state)
 */
function buildTallyPayload(
  productionId: string,
  tally: { pgm: string | null; pvw: string | null },
  doc: ProductionDoc,
): {
  pgm: string | null;
  pvw: string | null;
  pgmBg: string | null;
  program: string[];
  preview: string[];
  contributions: Array<{ source: string; role: string }>;
} {
  const pgmBg = pgmBgOf(productionId);
  const pgmPip = pgmPipByProduction.get(productionId) ?? null;
  const pvwPip = pvwPipByProduction.get(productionId) ?? null;
  const pvwBefore = pvwBeforePipByProduction.get(productionId) ?? null;
  const pipConfigs = pipConfigsByProduction.get(productionId);
  const dskLayers = dskLayersByProduction.get(productionId);
  const activeGraphics = (doc.graphics ?? []).filter((g) => g.active).map((g) => g.id);

  const { program, preview, contributions } = computeTallyContributions(
    tally.pgm,
    tally.pvw,
    pgmPip,
    pvwPip,
    pgmBg,
    pvwBefore,
    pipConfigs,
    dskLayers,
    activeGraphics,
  );

  return { pgm: tally.pgm, pvw: tally.pvw, pgmBg, program, preview, contributions };
}


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
  // A write still in flight keeps its own record and settles on its own; it
  // must not count as overlapping with writes made after reactivation.
  const keyPrefix = `${productionId}:`
  for (const map of [muteWritesInFlight, latestMuteWrite, latestVolumeWrite]) {
    for (const key of map.keys()) if (key.startsWith(keyPrefix)) map.delete(key)
  }
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
 * Tells every connected socket the mixer state after first-connect init. Levels
 * come from the cache rather than the init defaults, so a fader moved while the
 * init write was in flight is not reported back at unity.
 */
function broadcastAudioReset(productionId: string, numChannels: number, muted: Set<string>): void {
  const levels = channelLevelsByProduction.get(productionId);
  // A fader Strom refused is absent from the cache; skip it rather than report unity.
  const sendLevel = (elementId: string) => {
    const level = levels?.get(elementId);
    if (level !== undefined) broadcast(productionId, { type: 'AUDIO_STATE', elementId, property: 'volume', value: level });
  };
  for (let i = 1; i <= numChannels; i++) {
    sendLevel(`ch${i}`);
    broadcast(productionId, { type: 'AUDIO_STATE', elementId: `ch${i}`, property: 'mute', value: muted.has(`ch${i}`) });
  }
  sendLevel('main');
}

/**
 * The flow whose meter/clip relay each operator socket holds one ref on. A
 * socket releases on close only what it holds, and reinit takes refs on behalf
 * of sockets that stayed open across a reactivation.
 */
const relayHolds = new WeakMap<WebSocket, { meter?: string; clip?: string }>();

function relayHold(ws: WebSocket): { meter?: string; clip?: string } {
  let hold = relayHolds.get(ws);
  if (!hold) {
    hold = {};
    relayHolds.set(ws, hold);
  }
  return hold;
}

/**
 * Re-run first-connect audio init and restart the meter/clip relays for a
 * production that has just (re)activated with a NEW Strom flow, targeting the
 * controller operators that stayed connected across a deactivate→reactivate
 * cycle (issue #416).
 *
 * On deactivate both relays are force-stopped and `clearAudioState` wipes the
 * per-production registries, but a controller socket that stays open is never
 * re-run through the WS connect handler. Without this, such a socket sits on the
 * OLD flow's (now torn-down) relays — so no client gets METER_DATA/LOUDNESS_DATA
 * or CLIP_STATE — and on an un-initialised mixer whose NEXT fresh connect would
 * run first-connect init and reset every channel to fader 1.0 / unmuted / to
 * main, clobbering any change made since reactivation.
 *
 * Fixing it here: when at least one controller is connected, initialise the new
 * flow's audio ONCE (so a later fresh connect inherits rather than re-inits) and
 * restart both relays bound to the new flow, taking one ref per connected
 * operator socket that does not already hold one on this flow, so each relay is
 * torn down only when the last of those sockets closes. Watch-only sockets
 * neither trigger init nor hold relay refs. A no-op when no operator is
 * connected — the next connect runs the normal path.
 */
export async function reinitConnectedControllers(productionId: string): Promise<void> {
  if (getOperatorSockets(productionId).length === 0) return;

  let doc: ProductionDoc;
  try {
    doc = await getDb().get(productionId) as ProductionDoc;
  } catch {
    return;
  }
  if (!doc.stromFlowId) return;
  const flowId = doc.stromFlowId;

  // Mark the new flow as current so a subsequent fresh connect does not treat it
  // as a pipeline change and wipe the state we are about to initialise.
  activeFlowIdByProduction.set(productionId, flowId);

  try {
    const strom = await makeStromClient();
    const { flow } = await strom.flows.get(flowId);
    const blocks = flow.blocks ?? [];
    const audioBlockId = doc.audioMixerBlockId ?? blocks.find((b) => b.block_definition_id === 'builtin.mixer')?.id;
    if (audioBlockId) {
      const mixerBlock = blocks.find((b) => b.id === audioBlockId);
      const rawNumCh = mixerBlock?.properties?.num_channels;
      const numChannels = typeof rawNumCh === 'number' ? rawNumCh
        : typeof rawNumCh === 'string' ? parseInt(rawNumCh, 10)
        : 0;
      numAudioChannelsByProduction.set(productionId, numChannels);

      // Initialise ONCE. If clearAudioState already ran (deactivate) the registry
      // is cold; if some fresh connect raced ahead and initialised the new flow,
      // leave its state untouched.
      const isFirstInit = !afvChannelsByProduction.has(productionId);
      if (isFirstInit) {
        afvChannelsByProduction.set(productionId, new Set());
        const muted = new Set<string>();
        mutedElementsByProduction.set(productionId, muted);
        const initProps: Record<string, unknown> = {};
        const levelCache = channelLevelsByProduction.get(productionId) ?? new Map<string, number>();
        for (let i = 1; i <= numChannels; i++) {
          initProps[`ch${i}_fader`] = 1.0;
          initProps[`ch${i}_mute`] = false;
          initProps[`ch${i}_to_main`] = true;
          levelCache.set(`ch${i}`, 1.0);
        }
        initProps['main_fader'] = 1.0;
        levelCache.set('main', 1.0);
        channelLevelsByProduction.set(productionId, levelCache);
        // Mirror the first-connect guard (#396): a channel Strom refused to route
        // to main is reported muted rather than falsely told live.
        const seedMutes = (rejected: Record<string, unknown>, current: Record<string, unknown>) => {
          for (let i = 1; i <= numChannels; i++) {
            const toMainKey = `ch${i}_to_main`;
            if (Object.hasOwn(rejected, toMainKey) || current[toMainKey] === false) muted.add(`ch${i}`);
          }
        };
        const applied = await strom.flows.updateBlockProperties(flowId, audioBlockId, { properties: initProps })
          .then((res) => { seedMutes(res.rejected ?? {}, res.properties ?? {}); return true; })
          .catch((err) => {
            console.warn('[controller] reinit channel props error:', err);
            // Keys are independent, so keep what applied; forget a refused fader's
            // unity level so it is not broadcast below.
            if (!(err instanceof StromPropertiesRejectedError)) return false;
            for (const key of Object.keys(err.rejected)) {
              const fader = /^(ch\d+|main)_fader$/.exec(key);
              if (fader) levelCache.delete(fader[1]);
            }
            seedMutes(err.rejected, err.current);
            return true;
          });
        // Push the freshly-initialised defaults to every connected socket so one
        // that stayed open across reactivation drops its stale mixer view.
        // Skipped when the write failed outright: Strom still holds the old values.
        if (applied) broadcastAudioReset(productionId, numChannels, muted);
        broadcast(productionId, { type: 'GRP_STATE_RESET' });
      }

      // Restart the meter relay against the NEW flow. Deactivate force-stopped
      // (and forgot) the relay while leaving each socket's per-socket hold in
      // place, and a connect mid-teardown may have re-created it on the retired
      // flow. Reconcile to one ref per operator socket on the new flow rather
      // than taking a per-socket ref: the latter both fails to re-create a
      // force-stopped relay for an operator that stayed open AND double-counts
      // the mid-teardown socket, orphaning a ref that never reaches zero
      // (issue #434). Every operator socket then releases exactly one ref on
      // close, landing the relay back at zero.
      const meterOperators = getOperatorSockets(productionId);
      reconcileMeterRelay(productionId, flowId, audioBlockId, doc.loudnessMainBlockId, meterOperators.length);
      for (const ws of meterOperators) relayHold(ws).meter = flowId;
    }
  } catch (err) {
    console.warn('[controller] reinit audio/meter error:', err);
  }

  // Restart the clip relay against the NEW flow (same ref-count reasoning).
  if (doc.clipPlayerBlockIds) {
    const blockToInput = new Map<string, string>();
    for (const [mixerInput, blockId] of Object.entries(doc.clipPlayerBlockIds)) {
      blockToInput.set(blockId, mixerInput);
    }
    if (blockToInput.size > 0) {
      // Same reconciliation as the meter relay above (issue #434).
      const clipOperators = getOperatorSockets(productionId);
      reconcileClipRelay(productionId, flowId, blockToInput, clipOperators.length);
      for (const ws of clipOperators) relayHold(ws).clip = flowId;
    }
  }
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
  htmlSourceParamsByProduction.delete(productionId)
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
  const { configs, persisted } = pipConfigsFromDoc(doc)
  if (configs) pipConfigsByProduction.set(doc._id, configs)
  return persisted ? configs : null
}

/** The PiP layout the doc implies, without touching the cache. */
function pipConfigsFromDoc(doc: ProductionDoc): { configs: PipConfig[] | null; persisted: boolean } {
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
    return { configs: restored, persisted: true }
  }
  if (numPips > 0) {
    return { configs: Array.from({ length: numPips }, () => ({ bg: null, zones: [], transforms: {} })), persisted: false }
  }
  return { configs: null, persisted: false }
}

/** Wipe all per-production FX state. Called when the pipeline changes or production deactivates. */
export function clearFxState(productionId: string): void {
  inputEffectsByProduction.delete(productionId)
  masterEffectByProduction.delete(productionId)
  fxAvailableByProduction.delete(productionId)
}

// ---------------------------------------------------------------------------
// Clip completion polling — reconciliation fallback only (epic #206, issue #307 / OQ2).
//
// Strom's media_player DOES push player-state transitions and playhead position
// over its WS API (`MediaPlayerStateChanged` / `MediaPlayerPosition`), which the
// reactive clip-relay (services/clip-relay.ts) consumes to emit CLIP_STATE — the
// primary mechanism. This poll is retained ONLY as a reconciliation safety net:
// if the push channel is briefly unavailable (relay reconnecting) a slow
// `player.getState` tick still converges a `playing` clip to `completed` when
// Strom reports end-of-media. It is therefore tolerant of transient tick errors
// and does NOT self-terminate on a single failure — that stuck-state bug
// (a poll error stranding the clip as `playing`) is exactly what OQ2 called out.
// Timers are keyed `productionId:mixerInput` and cleaned up on
// stop/disconnect/deactivate.
//
// The same tick also runs the stall WATCHDOG (issue #351): Strom's
// `MediaPlayerState::state()` reports `playing` whenever the player is not
// paused and the playlist is non-empty, even if the pipeline never produced a
// frame — the root cause of "PLAYING at 0:00/0:00 indefinitely" with no error.
// A `position_ms` that hasn't moved for `config.clipStallTimeoutMs` moves the
// clip to `error` instead of leaving it stuck as `playing` forever.
// ---------------------------------------------------------------------------
const clipPollTimers = new Map<string, ReturnType<typeof setInterval>>()
/** Last observed position + when it was last seen to change, keyed like clipPollTimers. */
const clipLastPosition = new Map<string, { positionMs: number; since: number }>()

function clipPollKey(productionId: string, mixerInput: string): string {
  return `${productionId}:${mixerInput}`
}

/** Stops (and forgets) the completion poll timer for a clip, if one is running. */
export function stopClipPoll(productionId: string, mixerInput: string): void {
  const key = clipPollKey(productionId, mixerInput)
  const timer = clipPollTimers.get(key)
  if (timer) {
    clearInterval(timer)
    clipPollTimers.delete(key)
  }
  clipLastPosition.delete(key)
}

/**
 * Starts (or restarts) the completion reconciliation poll for a playing clip.
 * The reactive clip-relay is the primary path; this is the safety net. On each
 * tick it reads the player state; when Strom reports `stopped` (and the clip is
 * still locally `playing`, i.e. the relay didn't already converge it) it
 * records/broadcasts a `completed` CLIP_STATE and stops the timer.
 *
 * A transient tick error (Strom hiccup, token refresh) is logged and SWALLOWED —
 * the timer keeps running so the clip is not stranded as `playing` on a single
 * failure (the stuck-state bug OQ2 called out). The poll self-stops only when it
 * has done its job (converged to `completed`) or when the clip is no longer
 * locally `playing` (relay/stop/pause already took it out of the playing state).
 */
export function startClipPoll(productionId: string, mixerInput: string, clipId?: string): void {
  stopClipPoll(productionId, mixerInput)
  const key = clipPollKey(productionId, mixerInput)
  const timer = setInterval(() => {
    void (async () => {
      // If the reactive relay (or an explicit stop/pause) already moved the clip
      // out of `playing`, the reconciliation poll has nothing left to do.
      const current = getClipStateEntry(productionId, mixerInput)
      if (current && current.state !== 'playing') {
        stopClipPoll(productionId, mixerInput)
        return
      }
      try {
        const doc = await getDb().get(productionId)
        const { flowId, blockId } = resolveClipTarget(doc, mixerInput)
        const strom = await makeStromClient()
        const player = await strom.player.getState(flowId, blockId)
        if (player.state === 'stopped') {
          const state: ClipState = {
            mixerInput,
            state: 'completed',
            ...(clipId !== undefined ? { clipId } : {}),
            // Strom reports position/duration in nanoseconds; the contract is ms.
            ...(player.position_ns !== undefined ? { positionMs: Math.round(player.position_ns / 1e6) } : {}),
            ...(player.duration_ns !== undefined ? { durationMs: Math.round(player.duration_ns / 1e6) } : {}),
          }
          setClipStateEntry(productionId, state)
          broadcast(productionId, { type: 'CLIP_STATE', ...state })
          stopClipPoll(productionId, mixerInput)
          // A completed clip is no longer cued — drop the persisted cue point.
          await clearPersistedClipCue(productionId, mixerInput)
          return
        }
        if (player.state !== 'playing') {
          // Paused (or another non-terminal state): nothing to watchdog this
          // tick — reset the stall tracker so a resumed play doesn't inherit a
          // stale "unchanged since" timestamp from before the pause.
          clipLastPosition.delete(key)
          return
        }
        // Stall watchdog (issue #351): `player.state === 'playing'` here can
        // still mean the pipeline never produced a frame (root cause of the
        // reported bug) — a position that hasn't advanced for
        // `clipStallTimeoutMs` is the only observable signal available.
        // Strom reports position/duration in nanoseconds; the contract is ms.
        const positionMs = player.position_ns !== undefined ? Math.round(player.position_ns / 1e6) : 0
        const last = clipLastPosition.get(key)
        const now = Date.now()
        if (!last || last.positionMs !== positionMs) {
          clipLastPosition.set(key, { positionMs, since: now })
        } else if (now - last.since >= config.clipStallTimeoutMs) {
          const state: ClipState = {
            mixerInput,
            state: 'error',
            error: 'Clip playback stalled — position has not advanced',
            ...(clipId !== undefined ? { clipId } : {}),
            positionMs,
            ...(player.duration_ns !== undefined ? { durationMs: Math.round(player.duration_ns / 1e6) } : {}),
          }
          setClipStateEntry(productionId, state)
          broadcast(productionId, { type: 'CLIP_STATE', ...state })
          stopClipPoll(productionId, mixerInput)
          await clearPersistedClipCue(productionId, mixerInput)
        }
      } catch (err) {
        // Transient error: log and keep polling. Never self-terminate on a single
        // failure — that would strand the clip as `playing` (issue #307 / OQ2).
        console.warn(`[controller] clip poll error (${mixerInput}), continuing:`, String(err))
      }
    })()
  }, config.clipStatePollMs)
  clipPollTimers.set(key, timer)
}

/**
 * Clears the LIVE clip state for a production: stops every completion poll timer
 * and wipes the in-memory registry. Called on deactivate (mirrors clearPipState /
 * clearAudioState / clearFxState).
 *
 * Deliberately does NOT touch the persisted `ProductionDoc.clipCues` — a cued
 * clip must survive deactivate/reactivate (issue #307 / OQ3), so the cue point is
 * left on the doc to be restored on the next connect.
 */
export function clearClipStateForProduction(productionId: string): void {
  for (const key of clipPollTimers.keys()) {
    if (key.startsWith(`${productionId}:`)) {
      clearInterval(clipPollTimers.get(key)!)
      clipPollTimers.delete(key)
      clipLastPosition.delete(key)
    }
  }
  clearClipState(productionId)
}

/** Returns the 0-based audio channel index for a given mixerInput, or null if it has no channel. */
async function resolveAudioChannelIndex(doc: ProductionDoc, mixerInput: string): Promise<number | null> {
  const channels = await loadAudioChannels(doc.sources);
  return channels.find((c) => c.assignment.mixerInput === mixerInput)?.channel ?? null;
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
  const properties: Record<string, unknown> = {};
  const ramp_ms_overrides: Record<string, number> = {};
  const toMainChanges = new Map<number, boolean>();
  for (const { channel, assignment } of await loadAudioChannels(doc.sources)) {
    // Only update routing for channels the operator has opted into AFV.
    // Channels with AFV off are never touched by the switcher.
    if (!afvChannels.has(assignment.mixerInput)) continue;

    const routed = newPgmMixerInput === null || assignment.mixerInput === newPgmMixerInput;
    const key = `ch${channel + 1}_to_main`;
    properties[key] = routed;
    ramp_ms_overrides[key] = routed ? rampUpMs : rampDownMs;
    toMainChanges.set(channel, routed);
  }
  // Mirror the AFV routing into every guest return in the same update so a return
  // never keeps a channel AFV just took off program (spec §"Mirror `to_main`").
  Object.assign(properties, mirrorToMainForPersistedReturns(
    (doc.returnBuses ?? []) as PersistedReturnBus[],
    toMainChanges,
  ));
  if (Object.keys(properties).length > 0) {
    const result = await strom.flows.updateBlockProperties(stromFlowId, audioBlockId, { properties, ramp_ms_overrides })
      .catch((err) => { console.warn('[controller] audio follow error:', String(err)); return null; });
    // Tell clients what actually reached Strom, in the same AUDIO_STATE mute shape
    // as AFV_SET / manual mute (mute = !chN_to_main), instead of leaving them to
    // infer the mix from AFV_STATE + TALLY (#452). Skipped when the write failed;
    // a channel Strom refused is reported at the value it kept (as in #396), and
    // omitted if Strom gave no value back for it.
    if (result) {
      for (const [channel, routed] of toMainChanges) {
        const key = `ch${channel + 1}_to_main`;
        const reported = result.properties?.[key];
        const rejected = Object.prototype.hasOwnProperty.call(result.rejected ?? {}, key);
        const actual = typeof reported === 'boolean' ? reported : rejected ? null : routed;
        if (actual === null) continue;
        broadcast(productionId, { type: 'AUDIO_STATE', elementId: `ch${channel + 1}`, property: 'mute', value: !actual });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Guest return feeds — shared mode handler (epic #208, issue #300)
// ---------------------------------------------------------------------------

/** Result of a return-mode change request. */
export type ReturnModeResult =
  | { ok: true; mixerInput: string; mode: ReturnMode }
  | { ok: false; code: 'not_found' | 'invalid_mode' | 'inactive' };

/**
 * The single mode-change entry point shared by the crew REST route, the guest
 * token route and the WS `RETURN_SET` command (issue #301 calls this). It:
 *   1. validates the input has a return bus (v1 only `program`/`program-minus`),
 *   2. persists the mode on the assignment's `returnFeed` and `doc.returnBuses`,
 *   3. applies the send matrix live if the flow is active — respecting channels
 *      the crew has currently muted so a switch to `program` never reopens a
 *      muted channel, and
 *   4. broadcasts `RETURN_STATE` (the WS surface #301 completes; this is a
 *      minimal, correct hook — persist + apply + broadcast).
 *
 * NOTE: AFV-driven closures are re-mirrored continuously by applyAudioFollow, so
 * a channel AFV has taken off program self-corrects on the next cut; this switch
 * factors in operator mutes (the persistent off-program state) precisely.
 */
export async function applyReturnMode(
  productionId: string,
  mixerInput: string,
  mode: ReturnMode,
): Promise<ReturnModeResult> {
  if (mode !== 'program' && mode !== 'program-minus') {
    return { ok: false, code: 'invalid_mode' };
  }
  let doc: ProductionDoc;
  try {
    doc = await getDb().get(productionId);
  } catch {
    return { ok: false, code: 'not_found' };
  }
  const assignment = doc.sources.find((s) => s.mixerInput === mixerInput);
  if (!assignment || !assignment.returnFeed) {
    return { ok: false, code: 'not_found' };
  }

  // Persist the mode on the assignment and on the resolved return-bus cache.
  const nextSources = doc.sources.map((s) =>
    s.mixerInput === mixerInput
      ? { ...s, returnFeed: { ...s.returnFeed!, synced: mode } }
      : s,
  );
  const nextReturnBuses = (doc.returnBuses ?? []).map((rb) =>
    rb.mixerInput === mixerInput ? { ...rb, mode } : rb,
  );
  await updateProductionDoc(productionId, {
    sources: nextSources,
    ...(nextReturnBuses.length > 0 && { returnBuses: nextReturnBuses }),
  }).catch((err) => console.warn('[controller] persist return mode error:', err));

  // Apply live if the flow is active and this input has a resolved return bus.
  const rb = nextReturnBuses.find((r) => r.mixerInput === mixerInput);
  if (rb && doc.stromFlowId && doc.audioMixerBlockId) {
    const numChannels = numAudioChannelsByProduction.get(productionId)
      ?? (await loadAudioChannels(doc.sources)).length;
    // Honour operator mutes: a muted channel (element ch{N}) stays closed even in
    // program mode. AFV self-corrects on the next cut via applyAudioFollow.
    const muted = mutedElementsByProduction.get(productionId) ?? new Set<string>();
    const toMainByChannel = new Map<number, boolean>();
    for (let ch = 0; ch < numChannels; ch++) {
      toMainByChannel.set(ch, !muted.has(`ch${ch + 1}`));
    }
    const props = returnSendMatrix(rb.auxBus, rb.ownChannel, mode, numChannels, toMainByChannel);
    try {
      const strom = await makeStromClient();
      await strom.flows.updateBlockProperties(doc.stromFlowId, doc.audioMixerBlockId, { properties: props });
    } catch (err) {
      console.warn('[controller] apply return mode error:', err);
    }
  }

  broadcast(productionId, { type: 'RETURN_STATE', mixerInput, mode });
  return { ok: true, mixerInput, mode };
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

/**
 * Commands that mutate the vision mixer (issue #431). Each one reads the
 * production doc, calls Strom, and persists the resulting tally. Two of them
 * racing — e.g. a CUT whose DB write is slow, then a TAKE sent 20 ms later —
 * could otherwise reach Strom in the opposite order the operator pressed them,
 * leaving Strom on one program while open-live reports another. They are
 * serialised per production (see `runSerializedSwitcherCommand`) so one
 * command's Strom calls and DB write finish before the next reads the doc.
 *
 * MACRO_EXEC is included because a macro inlines its own CUT/TRANSITION/TAKE
 * sub-commands (it never re-enters `handleMessage`), so holding the lock for a
 * whole macro serialises the macro's switcher effects without any risk of the
 * macro deadlocking on its own queue.
 */
const SWITCHER_MESSAGE_TYPES = new Set([
  'CUT',
  'TRANSITION',
  'TAKE',
  'SET_PVW',
  'SELECT_PVW_PIP',
  'SET_PIP',
  'MACRO_EXEC',
]);

/**
 * Per-production tail of the switcher-command chain. Each entry is a
 * never-rejecting promise that settles when the production's most recently
 * queued switcher command finishes; the entry is pruned once the chain drains.
 */
const switcherCommandChains = new Map<string, Promise<unknown>>();

/**
 * Run `task` after the previous switcher command for the same production has
 * fully settled (success or failure), guaranteeing per-production ordering of
 * the doc read → Strom call → DB write sequence. The caller still observes its
 * own task's outcome via the returned promise; the internal chain tail swallows
 * rejections so one failed command never stalls the queue.
 */
function runSerializedSwitcherCommand(
  productionId: string,
  task: () => Promise<void>,
): Promise<void> {
  const prev = switcherCommandChains.get(productionId) ?? Promise.resolve();
  const result = prev.then(() => task());
  const tail = result.catch(() => {});
  switcherCommandChains.set(productionId, tail);
  void tail.then(() => {
    if (switcherCommandChains.get(productionId) === tail) {
      switcherCommandChains.delete(productionId);
    }
  });
  return result;
}

/** Exported for tests: drives one inbound message against a production. */
export async function handleMessage(
  productionId: string,
  ws: WebSocket,
  raw: string,
  ctx: { audioBlockId?: string; rateLimit?: RateLimitState },
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

  // Per-connection rate limiting: drop (do not process) messages that exceed
  // the sliding-window caps and inform the client via the standard ERROR frame.
  if (!ctx.rateLimit) ctx.rateLimit = { general: [], expensive: [] };
  if (!checkRateLimit(ctx.rateLimit, EXPENSIVE_MESSAGE_TYPES.has(msg.type), Date.now())) {
    const rateLimitError = 'Rate limit exceeded';
    if ('cmdId' in msg && msg.cmdId) {
      sendNack(ws, productionId, msg.cmdId, rateLimitError);
    } else {
      ws.send(JSON.stringify({ type: 'ERROR', error: rateLimitError }));
    }
    return;
  }

  // Phase 1 ACK: command passed schema validation and is being dispatched.
  // Sent before any async work so the automation client can record the accepted time.
  const cmdId = 'cmdId' in msg ? (msg.cmdId as string | undefined) : undefined;
  if (cmdId) {
    sendAck(ws, productionId, cmdId, 'accepted');
  }

  // KEEP_ALIVE is a pure liveness/activity signal (issue #290): it resets the
  // idle timer and cancels any pending idle warning (triggering an
  // IDLE_WARNING_CLEARED broadcast when a warning was outstanding). It needs no
  // production doc and touches no Strom flow, so handle it before the DB fetch
  // that the mixer/audio/clip commands below require.
  if (msg.type === 'KEEP_ALIVE') {
    resetIdleTimer(productionId);
    if (cmdId) sendAck(ws, productionId, cmdId, 'executed');
    return;
  }

  // Everything below reads the production doc, may call Strom, and persists the
  // result. For switcher-mutating commands this closure runs through the
  // per-production serialisation chain (issue #431) so commands sent close
  // together cannot reach Strom out of order; all other command types run
  // immediately, exactly as before.
  const dispatch = async (): Promise<void> => {
  const db = getDb();
  let doc: ProductionDoc;
  try {
    doc = await db.get(productionId);
  } catch {
    const notFoundError = 'Production not found';
    if (cmdId) {
      sendNack(ws, productionId, cmdId, notFoundError);
    } else {
      ws.send(JSON.stringify({ type: 'ERROR', error: notFoundError }));
    }
    return;
  }

  switch (msg.type) {
    case 'CUT': {
      // #353: taking the real source out from under an on-program PiP (target
      // equals the tracked background). Handle before the general path so we
      // never fall through to a degenerate from_input === to_input take.
      const curPgmPipBgCut = pgmPipByProduction.get(productionId) ?? null;
      if (curPgmPipBgCut !== null && (pgmBgByProduction.get(productionId) ?? null) === msg.mixerInput) {
        await takePipOffToBackground(productionId, doc, msg.mixerInput, curPgmPipBgCut, 'CUT');
        if (cmdId) sendAck(ws, productionId, cmdId, 'executed');
        break;
      }
      if (isAlreadyOnProgram(productionId, msg.mixerInput)) {
        // #353 item 3: never drop the command silently — re-broadcast current
        // state so a client that optimistically swapped PGM/PVW is corrected.
        rebroadcastMixerState(productionId, doc);
        if (cmdId) sendAck(ws, productionId, cmdId, 'executed');
        break;
      }
      const tally = getTally(productionId);
      // When a PiP is on PGM, tally.pgm is null. Use the tracked Strom PGM
      // background input so stromTransition has a valid from_input.
      const curPgmPipCut = pgmPipByProduction.get(productionId) ?? null;
      const fromPadCut = (curPgmPipCut !== null && tally.pgm === null)
        ? (pgmBgByProduction.get(productionId) ?? null)
        : tally.pgm;
      // Snapshot before any mutation so a Strom rejection can be rolled back (#430).
      const preSwitchCut = snapshotSwitchState(productionId);
      const newTally = { pgm: msg.mixerInput, pvw: tally.pgm };
      setTally(productionId, newTally);
      const curPvwPipCut = pvwPipByProduction.get(productionId) ?? null;
      // Update the in-memory PiP maps now — the Strom round trip below reads them
      // for the #341 concurrent-PVW guard — but defer the PIP_STATE broadcast
      // until the persist and Strom transition have both succeeded so clients are
      // never told a PiP left program when the DB write throws or Strom rejects
      // the cut (issue #355).
      let cutPipEvent: { pvwPip: number | null } | null = null;
      if (curPgmPipCut !== null) {
        // PiP was on PGM → moves to PVW
        pgmPipByProduction.set(productionId, null);
        pvwPipByProduction.set(productionId, curPgmPipCut);
        pvwBeforePipByProduction.set(productionId, pgmBgByProduction.get(productionId) ?? null);
        pgmBgByProduction.delete(productionId);
        cutPipEvent = { pvwPip: curPgmPipCut };
      } else if (curPvwPipCut !== null) {
        // PiP was in PVW — cutting a real source to PGM replaces PVW, so clear it
        pvwPipByProduction.set(productionId, null);
        cutPipEvent = { pvwPip: null };
      }
      await persistMixerMutation(productionId, 'CUT', (d) => ({ ...d, tally: newTally }));
      broadcast(productionId, { type: 'TALLY', ...buildTallyPayload(productionId, newTally, doc) });
      const cutTransitionOk = await stromTransition(doc, fromPadCut, msg.mixerInput, 'cut');
      if (!cutTransitionOk) {
        // Strom rejected the cut, so it never reached air: roll the tally, PiP
        // maps and persisted doc back to the pre-switch state, re-broadcast, and
        // tell the operator (#430).
        await restoreSwitchState(productionId, doc, preSwitchCut);
        notifySwitchRejected(ws, productionId, cmdId);
        break;
      }
      // Announce the PiP move and restore it into Strom's preview only after the
      // transition succeeded (#355) and only if the operator has not changed PVW
      // during the Strom round trip (#341): a concurrent SET_PVW / SELECT_PVW_PIP
      // has already broadcast the authoritative PVW, so a stale displacement
      // broadcast or restore must not clobber it.
      if (cutPipEvent
          && (pvwPipByProduction.get(productionId) ?? null) === cutPipEvent.pvwPip) {
        broadcast(productionId, { type: 'PIP_STATE', pgmPip: null, pvwPip: cutPipEvent.pvwPip, pips: pipConfigsByProduction.get(productionId) ?? [] });
        if (curPgmPipCut !== null && doc.stromFlowId && doc.mixerBlockId) {
          try {
            const strom = await makeStromClient();
            await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { pip: curPgmPipCut } });
          } catch (err) {
            console.warn('[controller] Strom selectPreview (pip restore after cut) error:', err);
          }
        }
      }
      if (doc.stromFlowId && ctx.audioBlockId) {
        void applyAudioFollow(productionId, doc, msg.mixerInput, doc.stromFlowId, ctx.audioBlockId, await makeStromClient(), msg.afvRampUpMs, msg.afvRampDownMs);
      }
      if (cmdId) sendAck(ws, productionId, cmdId, 'executed');
      break;
    }
    case 'TRANSITION': {
      // #353: same as CUT — a TRANSITION whose target is the background under an
      // on-program PiP takes the PiP off program instead of being dropped.
      const curPgmPipBgTrans = pgmPipByProduction.get(productionId) ?? null;
      if (curPgmPipBgTrans !== null && (pgmBgByProduction.get(productionId) ?? null) === msg.mixerInput) {
        await takePipOffToBackground(productionId, doc, msg.mixerInput, curPgmPipBgTrans, 'TRANSITION', { transitionType: msg.transitionType, durationMs: msg.durationMs });
        if (cmdId) sendAck(ws, productionId, cmdId, 'executed');
        break;
      }
      if (isAlreadyOnProgram(productionId, msg.mixerInput)) {
        // #353 item 3: never drop the command silently — re-broadcast current state.
        rebroadcastMixerState(productionId, doc);
        if (cmdId) sendAck(ws, productionId, cmdId, 'executed');
        break;
      }
      const tally = getTally(productionId);
      const curPgmPipTrans = pgmPipByProduction.get(productionId) ?? null;
      const fromPadTrans = (curPgmPipTrans !== null && tally.pgm === null)
        ? (pgmBgByProduction.get(productionId) ?? null)
        : tally.pgm;
      // Snapshot before any mutation so a Strom rejection can be rolled back (#430).
      const preSwitchTrans = snapshotSwitchState(productionId);
      const newTally = { pgm: msg.mixerInput, pvw: tally.pgm };
      setTally(productionId, newTally);
      const curPvwPipTrans = pvwPipByProduction.get(productionId) ?? null;
      // Defer the PIP_STATE broadcast until persist and the Strom transition have
      // both succeeded (issue #355); the maps update now for the #341 guard.
      let transPipEvent: { pvwPip: number | null } | null = null;
      if (curPgmPipTrans !== null) {
        pgmPipByProduction.set(productionId, null);
        pvwPipByProduction.set(productionId, curPgmPipTrans);
        pvwBeforePipByProduction.set(productionId, pgmBgByProduction.get(productionId) ?? null);
        pgmBgByProduction.delete(productionId);
        transPipEvent = { pvwPip: curPgmPipTrans };
      } else if (curPvwPipTrans !== null) {
        // PiP was in PVW — transitioning a real source to PGM replaces PVW, so clear it (matches CUT)
        pvwPipByProduction.set(productionId, null);
        transPipEvent = { pvwPip: null };
      }
      await persistMixerMutation(productionId, 'TRANSITION', (d) => ({ ...d, tally: newTally }));
      broadcast(productionId, { type: 'TALLY', ...buildTallyPayload(productionId, newTally, doc), transitionType: msg.transitionType, durationMs: msg.durationMs });
      const transTransitionOk = await stromTransition(doc, fromPadTrans, msg.mixerInput, toStromTransition(msg.transitionType), msg.durationMs);
      if (!transTransitionOk) {
        // Strom rejected the transition — roll back and notify (#430).
        await restoreSwitchState(productionId, doc, preSwitchTrans);
        notifySwitchRejected(ws, productionId, cmdId);
        break;
      }
      // Announce + restore only after the transition succeeded (#355) and only if
      // PVW was not changed during the Strom round trip (#341).
      if (transPipEvent
          && (pvwPipByProduction.get(productionId) ?? null) === transPipEvent.pvwPip) {
        broadcast(productionId, { type: 'PIP_STATE', pgmPip: null, pvwPip: transPipEvent.pvwPip, pips: pipConfigsByProduction.get(productionId) ?? [] });
        if (curPgmPipTrans !== null && doc.stromFlowId && doc.mixerBlockId) {
          try {
            const strom = await makeStromClient();
            await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { pip: curPgmPipTrans } });
          } catch (err) {
            console.warn('[controller] Strom selectPreview (pip restore after transition) error:', err);
          }
        }
      }
      if (doc.stromFlowId && ctx.audioBlockId) {
        void applyAudioFollow(productionId, doc, msg.mixerInput, doc.stromFlowId, ctx.audioBlockId, await makeStromClient(), msg.afvRampUpMs, msg.afvRampDownMs);
      }
      if (cmdId) sendAck(ws, productionId, cmdId, 'executed');
      break;
    }
    case 'TAKE': {
      // Snapshot before any mutation so a Strom rejection can be rolled back (#430).
      // Taken first because the atomic-PiP block below mutates the live tally in place.
      const preSwitchTake = snapshotSwitchState(productionId);
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
      // The background behind the PiP after this take. Derived from what is in
      // scope, because `pgmBgByProduction` still holds the previous state here.
      const pvwBeforePip = pvwBeforePipByProduction.get(productionId) ?? null;
      // Falls back to the outgoing PGM input, matching the `to_input` the Strom
      // transition below computes: with no PVW source displaced, the mixer
      // composites the PiP over whatever was already on program.
      const newPgmBg = newPgmPip !== null ? (pvwBeforePip ?? tally.pgm) : null;
      // Set here rather than in the Strom block below: the connect handler
      // reads this map, and it must hold the background the take just
      // broadcast even when Strom is unconfigured or its call throws.
      if (newPgmPip !== null) pgmBgByProduction.set(productionId, newPgmBg);
      // When the PiP was on PGM (curPgmPip set, curPvwPip null) this take moves
      // it to PVW. Update the PiP maps *before* building the TALLY so the
      // broadcast reflects the new state (`pgmBg: null` and the background that
      // was under the PiP now surfaced in `preview`) rather than the stale
      // pre-take state. Mirrors the ordering CUT / TRANSITION and the macro TAKE
      // already use. (issue #356)
      const reversePipTake = curPvwPip === null && curPgmPip !== null;
      const reversePgmBg = reversePipTake ? (pgmBgByProduction.get(productionId) ?? null) : null;
      if (reversePipTake) {
        pvwBeforePipByProduction.set(productionId, reversePgmBg);
        pgmBgByProduction.delete(productionId);
      }
      // The transition type/duration actually sent to Strom below, surfaced on the
      // TALLY so a controller-socket recorder can re-render the exact transition
      // (issue #451), mirroring the TRANSITION broadcast at ~1598. Additive fields.
      const takeTransition = toStromTransition(msg.transitionType ?? 'cut');
      broadcast(productionId, { type: 'TALLY', ...buildTallyPayload(productionId, newTally, doc), transitionType: takeTransition, durationMs: msg.durationMs });
      // Defer the PIP_STATE displacement broadcast until the Strom round trip
      // below reports success (issue #370, same class as #355/PR #369): announcing
      // the new PiP state before Strom has accepted the transition leaves clients
      // and Strom disagreeing when Strom rejects the /transition. The persist above
      // has already committed, so a DB failure never reaches this point.
      let takeTransitionOk = true;
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
            const toInputIndex = pvwBeforePip !== null ? (padToIndex(pvwBeforePip) ?? fromInputIndex) : fromInputIndex;
            await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { pip: curPvwPip } });
            await strom.mixer.transition(doc.stromFlowId, doc.mixerBlockId, {
              from_input: fromInputIndex,
              to_input: toInputIndex,
              transition_type: takeTransition,
              ...(msg.durationMs !== undefined ? { duration_ms: msg.durationMs } : {}),
            });
            pvwBeforePipByProduction.delete(productionId);
          } catch (err) {
            console.warn('[controller] Strom PiP transition error:', err);
            takeTransitionOk = false;
          }
        }
      } else if (curPgmPip !== null) {
        // PiP is on PGM → taking to a real input; PiP moves to PVW.
        // Use the tracked PGM background as from_input (tally.pgm is null while a
        // PiP occupies PGM). `pvwBeforePipByProduction` was already set to this
        // background and `pgmBgByProduction` cleared above (before the TALLY
        // broadcast), so the next forward PiP take has a valid to_input ≠
        // from_input (avoids "sole program source" 400). Reuse the captured value.
        const pgmBg = reversePgmBg;
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
          } catch (err) {
            console.warn('[controller] Strom reverse-PiP transition error:', err);
            takeTransitionOk = false;
          }
        }
      } else {
        // No PiP involved: clear any stale PGM background tracking.
        pgmBgByProduction.delete(productionId);
        takeTransitionOk = await stromTransition(doc, tally.pgm, tally.pvw, takeTransition, msg.durationMs);
      }
      if (!takeTransitionOk) {
        // Strom rejected the take — roll back the tally, PiP maps and persisted
        // doc, re-broadcast, and tell the operator (#430).
        await restoreSwitchState(productionId, doc, preSwitchTake);
        notifySwitchRejected(ws, productionId, cmdId);
        break;
      }
      // Announce the take's new PiP state, and restore a displaced PGM PiP into
      // Strom's preview, only after the transition succeeded (#370/#355) and only
      // if the operator has not changed PVW during the Strom round trip (#341): a
      // concurrent SET_PVW / SELECT_PVW_PIP has already broadcast the authoritative
      // PVW, so a stale displacement broadcast or restore must not clobber it.
      if ((pvwPipByProduction.get(productionId) ?? null) === newPvwPip) {
        broadcast(productionId, { type: 'PIP_STATE', pgmPip: newPgmPip, pvwPip: newPvwPip, pips: pipConfigsByProduction.get(productionId) ?? [] });
        // Reverse-PiP take (PiP was on PGM, nothing waiting in PVW): put the PiP
        // back on Strom's preview so subsequent forward takes work.
        if (curPgmPip !== null && curPvwPip === null && doc.stromFlowId && doc.mixerBlockId) {
          try {
            const strom = await makeStromClient();
            await strom.mixer.selectPreview(doc.stromFlowId, doc.mixerBlockId, { source: { pip: curPgmPip } });
          } catch (err) {
            console.warn('[controller] Strom selectPreview (pip restore after take) error:', err);
          }
        }
      }
      if (doc.stromFlowId && ctx.audioBlockId) {
        void applyAudioFollow(productionId, doc, tally.pvw, doc.stromFlowId, ctx.audioBlockId, await makeStromClient(), msg.afvRampUpMs, msg.afvRampDownMs);
      }
      if (cmdId) sendAck(ws, productionId, cmdId, 'executed');
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
      broadcast(productionId, { type: 'TALLY', ...buildTallyPayload(productionId, newTally, doc) });
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
      if (cmdId) sendAck(ws, productionId, cmdId, 'executed');
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
      broadcast(productionId, { type: 'TALLY', ...buildTallyPayload(productionId, newTally, doc) });
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
      if (cmdId) sendAck(ws, productionId, cmdId, 'executed');
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
        broadcast(productionId, { type: 'FTB_STATE', active: result.active, durationMs: msg.durationMs ?? 1000 });
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
            const curPgmPipBg = pgmPipByProduction.get(productionId) ?? null;
            if (curPgmPipBg !== null && (pgmBgByProduction.get(productionId) ?? null) === mixerInput) {
              // #353: macro CUT to the background under an on-program PiP takes
              // the PiP off program instead of being silently skipped.
              await takePipOffToBackground(productionId, currentDoc, mixerInput, curPgmPipBg, 'MACRO_EXEC:CUT');
            } else if (!isAlreadyOnProgram(productionId, mixerInput)) {
              const tally = getTally(productionId);
              const curPgmPip = pgmPipByProduction.get(productionId) ?? null;
              // tally.pgm is null while a PiP is on PGM, so pass the tracked
              // background input. Strom takes from its own overlay state and
              // reads from_input only when that state is missing.
              const fromPad = (curPgmPip !== null && tally.pgm === null)
                ? (pgmBgByProduction.get(productionId) ?? null)
                : tally.pgm;
              // Snapshot before any mutation so a Strom rejection can be rolled back (#430).
              const preSwitchMacroCut = snapshotSwitchState(productionId);
              const newTally = { pgm: mixerInput, pvw: tally.pgm };
              setTally(productionId, newTally);
              const curPvwPip = pvwPipByProduction.get(productionId) ?? null;
              // Defer the PIP_STATE broadcast until persist and the Strom
              // transition have both succeeded (issue #355); the maps update now
              // for the #341 guard.
              let macroCutPipEvent: { pvwPip: number | null } | null = null;
              if (curPgmPip !== null) {
                // PiP was on PGM → moves to PVW
                pgmPipByProduction.set(productionId, null);
                pvwPipByProduction.set(productionId, curPgmPip);
                pvwBeforePipByProduction.set(productionId, pgmBgByProduction.get(productionId) ?? null);
                pgmBgByProduction.delete(productionId);
                macroCutPipEvent = { pvwPip: curPgmPip };
              } else if (curPvwPip !== null) {
                // PiP was in PVW — cutting a real source to PGM replaces PVW, so clear it
                pvwPipByProduction.set(productionId, null);
                macroCutPipEvent = { pvwPip: null };
              }
              await persistMixerMutation(productionId, 'MACRO_EXEC:CUT', (d) => ({ ...d, tally: newTally }));
              broadcast(productionId, { type: 'TALLY', ...buildTallyPayload(productionId, newTally, currentDoc) });
              const macroCutTransitionOk = await stromTransition(currentDoc, fromPad, mixerInput, 'cut');
              if (!macroCutTransitionOk) {
                // Strom rejected the cut — roll back and surface it as a macro
                // action failure (the catch below reports MACRO_ERROR) (#430).
                await restoreSwitchState(productionId, currentDoc, preSwitchMacroCut);
                throw new Error('Switch rejected by Strom');
              }
              // Announce + restore only after the transition succeeded (#355) and
              // only if PVW was not changed during the Strom round trip (#341).
              if (macroCutPipEvent
                  && (pvwPipByProduction.get(productionId) ?? null) === macroCutPipEvent.pvwPip) {
                broadcast(productionId, { type: 'PIP_STATE', pgmPip: null, pvwPip: macroCutPipEvent.pvwPip, pips: pipConfigsByProduction.get(productionId) ?? [] });
                if (curPgmPip !== null && currentDoc.stromFlowId && currentDoc.mixerBlockId) {
                  try {
                    await strom.mixer.selectPreview(currentDoc.stromFlowId, currentDoc.mixerBlockId, { source: { pip: curPgmPip } });
                  } catch (err) {
                    console.warn('[controller] Strom selectPreview (pip restore after macro cut) error:', err);
                  }
                }
              }
            }
          } else if (action.type === 'TRANSITION' && action.sourceId) {
            const mixerInput = resolveInput(action.sourceId);
            if (!mixerInput) break;
            const curPgmPipBg = pgmPipByProduction.get(productionId) ?? null;
            if (curPgmPipBg !== null && (pgmBgByProduction.get(productionId) ?? null) === mixerInput) {
              // #353: macro TRANSITION to the background under an on-program PiP.
              await takePipOffToBackground(productionId, currentDoc, mixerInput, curPgmPipBg, 'MACRO_EXEC:TRANSITION', { transitionType: action.transitionType, durationMs: action.durationMs });
            } else if (!isAlreadyOnProgram(productionId, mixerInput)) {
              const tally = getTally(productionId);
              const curPgmPip = pgmPipByProduction.get(productionId) ?? null;
              const fromPad = (curPgmPip !== null && tally.pgm === null)
                ? (pgmBgByProduction.get(productionId) ?? null)
                : tally.pgm;
              // Snapshot before any mutation so a Strom rejection can be rolled back (#430).
              const preSwitchMacroTrans = snapshotSwitchState(productionId);
              const newTally = { pgm: mixerInput, pvw: tally.pgm };
              setTally(productionId, newTally);
              const curPvwPip = pvwPipByProduction.get(productionId) ?? null;
              // Defer the PIP_STATE broadcast until persist and the Strom
              // transition have both succeeded (issue #355); the maps update now
              // for the #341 guard.
              let macroTransPipEvent: { pvwPip: number | null } | null = null;
              if (curPgmPip !== null) {
                // PiP was on PGM → moves to PVW
                pgmPipByProduction.set(productionId, null);
                pvwPipByProduction.set(productionId, curPgmPip);
                pvwBeforePipByProduction.set(productionId, pgmBgByProduction.get(productionId) ?? null);
                pgmBgByProduction.delete(productionId);
                macroTransPipEvent = { pvwPip: curPgmPip };
              } else if (curPvwPip !== null) {
                // PiP was in PVW — transitioning a real source to PGM replaces PVW, so clear it
                pvwPipByProduction.set(productionId, null);
                macroTransPipEvent = { pvwPip: null };
              }
              await persistMixerMutation(productionId, 'MACRO_EXEC:TRANSITION', (d) => ({ ...d, tally: newTally }));
              broadcast(productionId, { type: 'TALLY', ...buildTallyPayload(productionId, newTally, currentDoc), transitionType: action.transitionType, durationMs: action.durationMs });
              const macroTransTransitionOk = await stromTransition(currentDoc, fromPad, mixerInput, toStromTransition(action.transitionType ?? 'cut'), action.durationMs);
              if (!macroTransTransitionOk) {
                // Strom rejected the transition — roll back and surface it as a
                // macro action failure (the catch below reports MACRO_ERROR) (#430).
                await restoreSwitchState(productionId, currentDoc, preSwitchMacroTrans);
                throw new Error('Switch rejected by Strom');
              }
              // Announce + restore only after the transition succeeded (#355) and
              // only if PVW was not changed during the Strom round trip (#341).
              if (macroTransPipEvent
                  && (pvwPipByProduction.get(productionId) ?? null) === macroTransPipEvent.pvwPip) {
                broadcast(productionId, { type: 'PIP_STATE', pgmPip: null, pvwPip: macroTransPipEvent.pvwPip, pips: pipConfigsByProduction.get(productionId) ?? [] });
                if (curPgmPip !== null && currentDoc.stromFlowId && currentDoc.mixerBlockId) {
                  try {
                    await strom.mixer.selectPreview(currentDoc.stromFlowId, currentDoc.mixerBlockId, { source: { pip: curPgmPip } });
                  } catch (err) {
                    console.warn('[controller] Strom selectPreview (pip restore after macro transition) error:', err);
                  }
                }
              }
            }
          } else if (action.type === 'TAKE') {
            const tally = getTally(productionId);
            // Displace a PGM PiP only when a real source is waiting to replace
            // it. A PiP waiting in PVW is not promoted here, and with nothing
            // in PVW no transition is sent.
            const curPgmPip = tally.pvw !== null
              ? (pgmPipByProduction.get(productionId) ?? null)
              : null;
            const fromPad = (curPgmPip !== null && tally.pgm === null)
              ? (pgmBgByProduction.get(productionId) ?? null)
              : tally.pgm;
            // Snapshot before any mutation so a Strom rejection can be rolled back (#430).
            const preSwitchMacroTake = snapshotSwitchState(productionId);
            const newTally = { pgm: tally.pvw, pvw: tally.pgm };
            setTally(productionId, newTally);
            // Defer the PIP_STATE broadcast until persist and the Strom transition
            // have both succeeded (issue #370, same class as #355/PR #369); the
            // maps update now for the #341 guard.
            let macroTakePipEvent: { pvwPip: number | null } | null = null;
            if (curPgmPip !== null) {
              // PiP was on PGM → moves to PVW
              pgmPipByProduction.set(productionId, null);
              pvwPipByProduction.set(productionId, curPgmPip);
              pvwBeforePipByProduction.set(productionId, pgmBgByProduction.get(productionId) ?? null);
              pgmBgByProduction.delete(productionId);
              macroTakePipEvent = { pvwPip: curPgmPip };
            }
            await persistMixerMutation(productionId, 'MACRO_EXEC:TAKE', (d) => ({ ...d, tally: newTally }));
            // A macro TAKE always cuts (no transitionType on the action), so
            // surface 'cut' on the TALLY to match the interactive TAKE (#451)
            // and the value sent to Strom below.
            broadcast(productionId, { type: 'TALLY', ...buildTallyPayload(productionId, newTally, currentDoc), transitionType: 'cut' });
            const macroTakeTransitionOk = await stromTransition(currentDoc, fromPad, tally.pvw, 'cut');
            if (!macroTakeTransitionOk) {
              // Strom rejected the take — roll back and surface it as a macro
              // action failure (the catch below reports MACRO_ERROR) (#430).
              await restoreSwitchState(productionId, currentDoc, preSwitchMacroTake);
              throw new Error('Switch rejected by Strom');
            }
            // Announce + restore only after the transition succeeded (#370/#355) and
            // only if PVW was not changed during the Strom round trip (#341).
            if (macroTakePipEvent
                && (pvwPipByProduction.get(productionId) ?? null) === macroTakePipEvent.pvwPip) {
              broadcast(productionId, { type: 'PIP_STATE', pgmPip: null, pvwPip: macroTakePipEvent.pvwPip, pips: pipConfigsByProduction.get(productionId) ?? [] });
              if (curPgmPip !== null && currentDoc.stromFlowId && currentDoc.mixerBlockId) {
                try {
                  await strom.mixer.selectPreview(currentDoc.stromFlowId, currentDoc.mixerBlockId, { source: { pip: curPgmPip } });
                } catch (err) {
                  console.warn('[controller] Strom selectPreview (pip restore after macro take) error:', err);
                }
              }
            }
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
            const result = await strom.mixer.toggleDsk(currentDoc.stromFlowId, currentDoc.mixerBlockId, {
              dsk: (action.layer ?? 0) + 1,
              enabled: action.visible ?? true,
            });
            // Mirror the interactive DSK_TOGGLE handler: record the keyed layer
            // so buildTallyPayload includes it, and tell clients it changed.
            const layer0 = result.dsk - 1;
            const dskMap = dskLayersByProduction.get(productionId) ?? {};
            dskLayersByProduction.set(productionId, { ...dskMap, [layer0]: result.enabled });
            broadcast(productionId, { type: 'DSK_STATE', layer: layer0, visible: result.enabled });
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
          const writeId = ++volumeWriteCounter;
          latestVolumeWrite.set(debounceKey, writeId);
          pendingVolume.set(debounceKey, setTimeout(async () => {
            pendingVolume.delete(debounceKey);
            const propName = capturedLogicalId === 'main' ? 'main_fader' : `ch${ch}_fader`;
            try {
              const s = await makeStromClient();
              await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
                properties: { [propName]: capturedValue },
              });
            } catch (err) {
              console.warn('[controller] Strom audio update error:', err);
              if (err instanceof StromPropertiesRejectedError) {
                // Put the cache and every UI back on Strom's actual level, unless a
                // newer fader move, or a deactivate, has already replaced the refused value.
                if (latestVolumeWrite.get(debounceKey) !== writeId) return;
                let actual = err.current[propName];
                if (actual === undefined) {
                  actual = await makeStromClient()
                    .then((s) => s.flows.getBlockProperties(flowId, capturedAudioBlockId))
                    .then((res) => res.properties?.[propName], () => undefined);
                }
                const levels = channelLevelsByProduction.get(productionId);
                if (!levels || typeof actual !== 'number' || latestVolumeWrite.get(debounceKey) !== writeId) return;
                levels.set(capturedLogicalId, actual);
                broadcast(productionId, { type: 'AUDIO_STATE', elementId: capturedLogicalId, property: 'volume', value: actual });
                return;
              }
              broadcast(productionId, { type: 'AUDIO_STATE', elementId: capturedLogicalId, property: 'volume', value: capturedValue });
            } finally {
              if (latestVolumeWrite.get(debounceKey) === writeId) latestVolumeWrite.delete(debounceKey);
            }
          }, 150));
        } else {
          let props: Record<string, unknown>;
          let primaryKey: string;
          if (msg.elementId === 'main') {
            primaryKey = 'main_mute';
            props = { main_mute: msg.value };
          } else {
            const chMatch = /^ch(\d+)$/.exec(msg.elementId);
            if (!chMatch) {
              ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid audio channel id' }));
              break;
            }
            const ch = parseInt(chMatch[1], 10);
            // to_main = !mute (true=ON routing, false=OFF routing)
            primaryKey = `ch${ch}_to_main`;
            props = { [primaryKey]: !msg.value };
            // Mirror the routing change into every guest return in the SAME update
            // (spec §"Mirror `to_main` into return sends") so a return never keeps
            // a channel the crew just muted. ch is 1-based here; returns are 0-based.
            Object.assign(props, mirrorToMainForPersistedReturns(
              (doc.returnBuses ?? []) as PersistedReturnBus[],
              new Map([[ch - 1, !msg.value]]),
            ));
          }
          // Update the mute registry before the write so a concurrent RETURN_SET
          // already sees the mute. Once no write for this element is outstanding,
          // the registry and the UIs take the state Strom holds.
          const mutedSet = msg.elementId === 'main' ? undefined : mutedElementsByProduction.get(productionId);
          const elementId = msg.elementId;
          const flowId = doc.stromFlowId;
          const blockId = ctx.audioBlockId;
          const requested = msg.value === true;
          const replyError = (err: unknown) => {
            const errText = `Audio: ${stromErrorMessage(err)}`;
            if (cmdId) sendNack(ws, productionId, cmdId, errText);
            else ws.send(JSON.stringify({ type: 'ERROR', error: errText }));
          };
          const muteKey = `${productionId}:${elementId}`;
          const writes = muteWritesInFlight.get(muteKey) ?? { pending: 0, latest: 0, settled: mutedSet?.has(elementId) ?? false, overlapped: false, unclear: false };
          if (++writes.pending > 1) writes.overlapped = true;
          const writeId = writes.latest = ++muteWriteCounter;
          latestMuteWrite.set(muteKey, writeId);
          muteWritesInFlight.set(muteKey, writes);
          if (requested) mutedSet?.add(elementId);
          else mutedSet?.delete(elementId);
          let failure: unknown;
          let applied = false;
          let unclear = false;
          try {
            await strom.flows.updateBlockProperties(flowId, blockId, {
              properties: props,
              ...(msg.ramp_ms !== undefined && { ramp_ms: msg.ramp_ms }),
            });
            writes.settled = requested;
            applied = true;
          } catch (err) {
            console.warn('[controller] Strom audio update error:', err);
            if (err instanceof StromPropertiesRejectedError && !(primaryKey in err.rejected)) {
              // Program routing went through and only return-mirror sends were
              // refused: the change took effect on program, but not in a return.
              writes.settled = requested;
              applied = true;
              const detail = requested
                ? 'is muted on program, but a guest return still carries it'
                : 'is live on program, but a guest return did not reopen it';
              ws.send(JSON.stringify({ type: 'ERROR', error: `Audio: ${elementId} ${detail}. ${err.message}` }));
            } else if (err instanceof StromPropertiesRejectedError) {
              failure = err;
              writes.settled = stromMuteState(elementId, err.current) ?? writes.settled;
            } else if (err instanceof StromClientError && err.status >= 400 && err.status < 500) {
              // Strom answered and did not apply the write (block gone, bad request).
              failure = err;
            } else {
              // No answer on whether the write landed: assume it did unless a
              // read-back below says otherwise.
              failure = err;
              writes.settled = requested;
              writes.unclear = unclear = true;
            }
          }
          // Strom answered that the write was not applied: tell the sender now,
          // whatever the overlapping writes do.
          const refused = failure !== undefined && !unclear;
          if (refused) replyError(failure);
          if (--writes.pending > 0) {
            // Older writes are still outstanding and settle the state when they
            // finish. The newest write shows its applied result now.
            if (applied && writes.latest === writeId) {
              writes.shown = requested;
              broadcast(productionId, { type: 'AUDIO_STATE', elementId, property: 'mute', value: requested });
            }
            break;
          }
          if (muteWritesInFlight.get(muteKey) === writes) muteWritesInFlight.delete(muteKey);
          let state = writes.settled;
          if (writes.overlapped || writes.unclear) {
            const read = await strom.flows.getBlockProperties(flowId, blockId)
              .then((res) => stromMuteState(elementId, res.properties ?? {}), () => undefined);
            if (read !== undefined) state = read;
            // A write that started during the read, even one already finished,
            // settles the state itself.
            if (latestMuteWrite.get(muteKey) !== writes.latest) break;
          }
          if (latestMuteWrite.get(muteKey) === writes.latest) latestMuteWrite.delete(muteKey);
          // Re-fetch the registry: a deactivate/reactivate while the write was
          // stalled replaces the Set captured above (#402). A miss means the
          // production is no longer active, so there is nothing to record.
          const currentMutedSet = elementId === 'main' ? undefined : mutedElementsByProduction.get(productionId);
          if (state) currentMutedSet?.add(elementId);
          else currentMutedSet?.delete(elementId);
          const failed = refused || (failure !== undefined && state !== requested);
          if (failed && !refused) replyError(failure);
          const frame = { type: 'AUDIO_STATE', elementId, property: 'mute', value: state };
          // A failure without overlapping writes changed nothing for other
          // clients; only the sender flipped its toggle optimistically. After
          // overlap, other clients only need a frame if the shown state is wrong.
          if (failed && !writes.overlapped) ws.send(JSON.stringify(frame));
          else if (state !== writes.shown) broadcast(productionId, frame);
          else if (failed) ws.send(JSON.stringify(frame));
        }
      } catch (err) {
        console.warn('[controller] Strom audio update error:', err);
        const errText = `Audio: ${stromErrorMessage(err)}`;
        if (cmdId) sendNack(ws, productionId, cmdId, errText);
        else ws.send(JSON.stringify({ type: 'ERROR', error: errText }));
        // The sender's UI flips mute optimistically; put it back on the unchanged state.
        if (msg.property === 'mute') {
          const mutedSet = msg.elementId === 'main' ? undefined : mutedElementsByProduction.get(productionId);
          const value = mutedSet ? mutedSet.has(msg.elementId) : !msg.value;
          ws.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: msg.elementId, property: 'mute', value }));
        }
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
              properties: {
                [`ch${chIdx + 1}_to_main`]: isOnPgm,
                // Mirror into returns in the same update (spec §"Mirror `to_main`").
                ...mirrorToMainForPersistedReturns(
                  (doc.returnBuses ?? []) as PersistedReturnBus[],
                  new Map([[chIdx, isOnPgm]]),
                ),
              },
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
      // Strom marks it `live: false` and refuses it on a running pipeline every time
      // (issue #395) — a prior version of this handler sent it as a live
      // updateBlockProperties call anyway and logged a misleading "stored for next
      // start" warning on the resulting rejection, when nothing was actually stored.
      // Instead, persist the choice on the production doc (`ch{N}_aux{M}_pre` in
      // `values`, read by `flow-generator.ts` at build time) so it is wired correctly
      // the next time the flow is built — see the per-channel override there.
      const chMatch = /^ch(\d+)$/.exec(msg.elementId);
      if (chMatch && msg.pre !== undefined) {
        const chNum = parseInt(chMatch[1], 10);
        const preKey = `ch${chNum}_aux${msg.auxBus}_pre`;
        updateProductionDoc(productionId, {
          values: { ...(doc.values ?? {}), [preKey]: msg.pre },
        }).catch((err) => console.warn(`[controller] AUX pre persist error (${preKey} will not apply on next flow build):`, err));
      }
      if (chMatch && doc.stromFlowId && ctx.audioBlockId) {
        const chNum = parseInt(chMatch[1], 10);
        const stromValue = msg.enabled ? msg.level : 0;
        const flowId = doc.stromFlowId;
        const capturedAudioBlockId = ctx.audioBlockId;
        const capturedAuxBus = msg.auxBus;
        const debounceKey = `${productionId}:aux:ch${chNum}_aux${capturedAuxBus}`;
        const prev = pendingVolume.get(debounceKey);
        if (prev) clearTimeout(prev);
        pendingVolume.set(debounceKey, setTimeout(async () => {
          pendingVolume.delete(debounceKey);
          try {
            const s = await makeStromClient();
            // This IS live-applicable (aux_send element volume) — pre/post is handled
            // above, as a persisted build-time property, not a live write.
            await s.flows.updateBlockProperties(flowId, capturedAudioBlockId, {
              properties: { [`ch${chNum}_aux${capturedAuxBus}_level`]: stromValue },
            });
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
    case 'HTML_SOURCE_EVENT': {
      // Thin, generic event-forwarding surface for HTML sources (issue #268,
      // spec docs/specs/html-source-event-forwarding.md). Open Live stays a
      // transport: it only mutates the source's effective URL query string and
      // reloads the running cefsrc — no per-graphic logic.
      const mode: 'replace' | 'merge' = msg.mode ?? 'merge';

      // The production must be active (a running flow) for a live reload.
      if (!doc.stromFlowId) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Production is not activated' }));
        break;
      }

      // Resolve the source assignment (sourceId → mixerInput) on this production.
      const assignment = doc.sources.find((s) => s.sourceId === msg.sourceId);
      if (!assignment) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Source not found in production' }));
        break;
      }

      // Fetch the SourceDoc to confirm it is an HTML source and get its base URL.
      let sourceDoc;
      try {
        sourceDoc = await getSourcesDb().get(msg.sourceId);
      } catch {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Source not found' }));
        break;
      }
      if (sourceDoc.streamType !== 'html') {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Source is not an HTML source' }));
        break;
      }
      // HTML addresses are stored plaintext (only SRT passphrases are encrypted),
      // but decrypt defensively for parity with the flow generator.
      const baseAddress = decryptAddressPassphrase(sourceDoc.address);

      // Compute effective params + URL, re-validating through graphicUrl().
      const bySource = htmlSourceParamsByProduction.get(productionId);
      const currentParams = bySource?.get(msg.sourceId)?.params ?? {};
      let effectiveUrl: string;
      let effectiveParams: Record<string, string>;
      try {
        const built = buildHtmlSourceUrl(baseAddress, currentParams, msg.params, mode);
        effectiveUrl = built.effectiveUrl;
        effectiveParams = built.params;
      } catch (err) {
        ws.send(JSON.stringify({ type: 'ERROR', error: err instanceof Error ? err.message : 'Invalid HTML source URL' }));
        break;
      }

      // Reload the running cefsrc element by updating its `url` property live.
      // The element id is deterministic (flow-generator.ts:527):
      //   e-html-<padIndex>-<endpointSuffix>
      // where padIndex derives from the mixerInput (video_in_N) and
      // endpointSuffix from the production id.
      const padIndex = padToIndex(assignment.mixerInput);
      if (padIndex === null) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Source has no mixer input' }));
        break;
      }
      const endpointSuffix = productionId.replace(/^prod-/, '').slice(0, 8);
      const elementId = `e-html-${padIndex}-${endpointSuffix}`;
      try {
        const strom = await makeStromClient();
        await strom.properties.updateElement(doc.stromFlowId, elementId, {
          property_name: 'url',
          value: effectiveUrl,
        });
      } catch (err) {
        ws.send(JSON.stringify({ type: 'ERROR', error: `HTML source reload failed: ${stromErrorMessage(err)}` }));
        break;
      }

      // Persist effective state in the per-production in-memory registry and echo.
      const updatedAt = new Date().toISOString();
      const map = htmlSourceParamsByProduction.get(productionId) ?? new Map<string, HtmlSourceState>();
      map.set(msg.sourceId, { params: effectiveParams, effectiveUrl, updatedAt });
      htmlSourceParamsByProduction.set(productionId, map);
      broadcast(productionId, {
        type: 'HTML_SOURCE_STATE',
        sourceId: msg.sourceId,
        params: effectiveParams,
        effectiveUrl,
        updatedAt,
      });
      break;
    }
    case 'CLIP_CUE':
    case 'CLIP_PLAY':
    case 'CLIP_STOP':
    case 'CLIP_PAUSE':
    case 'CLIP_SEEK': {
      const mixerInput = msg.mixerInput;
      try {
        const strom = await makeStromClient();
        let state: ClipState;
        switch (msg.type) {
          case 'CLIP_CUE': {
            const source = await resolveClipSource(doc, mixerInput, (sid) => getSourcesDb().get(sid) as Promise<SourceDoc>);
            // A new cue supersedes any in-flight completion poll.
            stopClipPoll(productionId, mixerInput);
            state = await cueClip(strom, doc, source, mixerInput, msg.clipId);
            // Persist the cue point so it survives deactivate/reactivate and
            // server restart, restored to `cued` and never auto-played
            // (issue #307 / OQ3). Mirrors the pipConfigs persistence pattern:
            // in-memory registry is authoritative for the write, and
            // updateProductionDoc is 409-safe. Best-effort — a failed persist
            // must not fail the cue itself.
            if (state.clipId) {
              await persistClipCue(productionId, mixerInput, {
                clipId: state.clipId,
                ...(state.positionMs !== undefined ? { positionMs: state.positionMs } : {}),
                ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}),
              });
            }
            break;
          }
          case 'CLIP_PLAY': {
            const tracked = getClipStateEntry(productionId, mixerInput);
            if (!tracked || tracked.state === 'idle') throw new ClipNotCuedError();
            state = await playClip(strom, doc, mixerInput, tracked.clipId);
            // Begin (or restart) polling for end-of-media completion.
            startClipPoll(productionId, mixerInput, state.clipId ?? tracked.clipId);
            break;
          }
          case 'CLIP_PAUSE': {
            const tracked = getClipStateEntry(productionId, mixerInput);
            state = await pauseClip(strom, doc, mixerInput, tracked?.clipId);
            stopClipPoll(productionId, mixerInput);
            break;
          }
          case 'CLIP_STOP': {
            const tracked = getClipStateEntry(productionId, mixerInput);
            state = await stopClip(strom, doc, mixerInput, tracked?.clipId);
            stopClipPoll(productionId, mixerInput);
            // A stop clears the cue — there is nothing left cued to restore.
            await clearPersistedClipCue(productionId, mixerInput);
            break;
          }
          case 'CLIP_SEEK': {
            const tracked = getClipStateEntry(productionId, mixerInput);
            state = await seekClip(strom, doc, mixerInput, msg.positionMs, tracked?.clipId);
            break;
          }
        }
        setClipStateEntry(productionId, state);
        broadcast(productionId, { type: 'CLIP_STATE', ...state });
      } catch (err) {
        // Typed clip errors carry a human-readable message; Strom transport
        // errors are surfaced via stromErrorMessage (502/503-style text).
        let errText: string;
        if (
          err instanceof ClipNotFoundError ||
          err instanceof ClipNotActivatedError ||
          err instanceof ClipNotCuedError ||
          err instanceof ClipMediaError
        ) {
          errText = err.message;
        } else {
          errText = `Clip: ${stromErrorMessage(err)}`;
        }
        // Also record + broadcast the error transition so subscribers converge.
        const errorState: ClipState = { mixerInput, state: 'error', error: errText };
        setClipStateEntry(productionId, errorState);
        broadcast(productionId, { type: 'CLIP_STATE', ...errorState });
        ws.send(JSON.stringify({ type: 'ERROR', error: errText }));
      }
      break;
    }
    case 'RETURN_SET': {
      // Delegate to the single shared mode-change entry point (issue #300); it
      // persists, applies the send matrix live, and broadcasts RETURN_STATE to
      // all subscribers — so no extra broadcast is needed here.
      const result = await applyReturnMode(productionId, msg.mixerInput, msg.mode);
      if (!result.ok) {
        const errText =
          result.code === 'invalid_mode' ? 'Invalid return mode'
          : result.code === 'inactive' ? 'Production is not activated'
          : 'No return feed on that input';
        if (cmdId) sendNack(ws, productionId, cmdId, errText);
        else ws.send(JSON.stringify({ type: 'ERROR', error: errText }));
        break;
      }
      if (cmdId) sendAck(ws, productionId, cmdId, 'executed');
      break;
    }
    default: {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Unknown message type' }));
    }
  }
  };

  if (SWITCHER_MESSAGE_TYPES.has(msg.type)) {
    return runSerializedSwitcherCommand(productionId, dispatch);
  }
  return dispatch();
}

/**
 * Best-effort display state for a guest (epic #208, issue #301). `previewing`/
 * `on-air` are DERIVED from the live vision-mixer contribution set (#209): a
 * guest whose mixerInput contributes to program reads `on-air`, to preview
 * `previewing`, otherwise the persisted `joined`. `left`/`error` are
 * authoritative and pass through unchanged.
 *
 * LIMITATION (per issue #301): a guest composited as a PiP *inset* contributes
 * to the tally set as its source id, not its `video_in_N` pad, so this derives
 * `joined` rather than `on-air`/`previewing` for that case until the PiP-inset
 * tally gap #209 raises is closed. It also re-derives only at connect-time and
 * on lifecycle events, not continuously on every mixer take.
 */
export function deriveGuestDisplayState(
  persisted: GuestSessionState,
  mixerInput: string,
  program: string[],
  preview: string[],
): GuestSessionState {
  if (persisted === 'left' || persisted === 'error') return persisted;
  if (program.includes(mixerInput)) return 'on-air';
  if (preview.includes(mixerInput)) return 'previewing';
  return 'joined';
}

/**
 * Watch-only connections may not send commands. Every inbound frame is
 * answered with a NACK when it carries a cmdId, otherwise an ERROR, so a client
 * that sends commands by mistake finds out instead of being silently ignored.
 */
function rejectWatchOnlyMessage(productionId: string, ws: WebSocket, raw: string): void {
  const error = 'Watch-only connection: commands are not accepted';
  let cmdId: unknown;
  try {
    cmdId = (JSON.parse(raw) as { cmdId?: unknown } | null)?.cmdId;
  } catch { /* not JSON: plain ERROR below */ }
  if (typeof cmdId === 'string' && cmdId) {
    sendNack(ws, productionId, cmdId, error);
  } else {
    ws.send(JSON.stringify({ type: 'ERROR', error }));
  }
}

const controllerWs: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string }; Querystring: { mode?: string; [key: string]: unknown } }>(
    '/ws/productions/:id/controller',
    { websocket: true },
    async (socket, req) => {
      const { id } = req.params;
      const { mode } = req.query;
      // Fail closed on a query key that is confusable with `mode` — a case
      // variant (`Mode`, `MODE`) or array-bracket syntax (`mode[]`). The exact
      // `mode` key is handled below; any genuinely unrelated param (a
      // cache-buster, etc.) is left untouched and the connection proceeds. A
      // passive client (e.g. a tally logger) that typo'd the key must not
      // silently open as an operator and run first-connect audio init (#424).
      const confusableModeKey = Object.keys(req.query).find(
        (key) => key !== 'mode' && /^mode(\[.*\])?$/i.test(key),
      );
      if (confusableModeKey !== undefined) {
        socket.send(JSON.stringify({ type: 'ERROR', error: `Ambiguous controller mode query key: ${confusableModeKey}` }));
        socket.close(1008, 'ambiguous mode key');
        return;
      }
      // Fail closed on an unknown mode: a mistyped `watch` must not fall back to
      // an operator connection that can run first-connect audio init.
      if (mode !== undefined && mode !== 'watch') {
        socket.send(JSON.stringify({ type: 'ERROR', error: `Unknown controller mode: ${mode}` }));
        socket.close(1008, 'unknown mode');
        return;
      }
      // Watch-only connections receive the snapshot and broadcasts but never
      // write: no commands, no Strom writes, no registry/cache seeding that would
      // change what a later operator connect does, no idle-timer reset, and they
      // are not counted as operators.
      const watchOnly = mode === 'watch';
      subscribe(id, socket, { watchOnly });
      if (!watchOnly) notifySubscriberJoin(id);

      // Per-connection context — mutable so the audio block ID can be populated
      // at connect time and reused on every subsequent AUDIO_SET without a flow fetch.
      const ctx: { audioBlockId?: string; rateLimit?: RateLimitState } = {};

      // Register message/close handlers immediately so no messages are dropped
      // while we perform the async connect-time sync below.
      socket.on('message', (raw: Buffer | string) => {
        if (watchOnly) {
          rejectWatchOnlyMessage(id, socket, raw.toString());
          return;
        }
        handleMessage(id, socket, raw.toString(), ctx).catch((err) => {
          console.error('[controller] unhandled message error:', err);
        });
      });

      let socketClosed = false;
      socket.on('close', () => {
        socketClosed = true;
        unsubscribe(id, socket);
        // Relays are ref-counted, so only release what this socket holds.
        const hold = relayHolds.get(socket);
        if (hold?.meter) stopMeterRelay(id);
        if (hold?.clip) stopClipRelay(id);
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
      if (connectDoc?.stromFlowId && !watchOnly) {
        const lastFlowId = activeFlowIdByProduction.get(id)
        if (lastFlowId && lastFlowId !== connectDoc.stromFlowId) {
          clearAudioState(id)
        }
        activeFlowIdByProduction.set(id, connectDoc.stromFlowId)
      }

      // -----------------------------------------------------------------------
      // Automation contract §4: Connect-time snapshot (spec §4).
      // Emit HELLO first so clients know the contract version before any state.
      // All snapshot frames are single-socket sends (not broadcast) because they
      // are point-to-point resync, not production-wide state changes.
      // -----------------------------------------------------------------------
      socket.send(JSON.stringify({
        type: 'HELLO',
        contractVersion: CONTRACT_VERSION,
        productionId: id,
        seq: nextSeq(id),
        ts: new Date().toISOString(),
      }));

      // Restore tally from DB if not already in memory (e.g. after server restart)
      let tally = getTally(id);
      if (tally.pgm === null && tally.pvw === null && connectDoc?.tally) {
        if (connectDoc.tally.pgm !== null || connectDoc.tally.pvw !== null) {
          tally = connectDoc.tally;
          setTally(id, tally);
        }
      }
      // Send TALLY with full contribution-based fields (spec §3 + §4).
      // The helper reads from in-memory maps which are already populated above.
      {
        const tallyPayload = connectDoc
          ? buildTallyPayload(id, tally, connectDoc)
          : { pgm: tally.pgm, pvw: tally.pvw, pgmBg: pgmBgOf(id), program: tally.pgm ? [tally.pgm] : [], preview: tally.pvw ? [tally.pvw] : [], contributions: [] as Array<{ source: string; role: string }> };
        const seq = nextSeq(id);
        socket.send(JSON.stringify({ type: 'TALLY', ...tallyPayload, seq, ts: new Date().toISOString() }));
      }

      // Connect snapshot for the production lifecycle (issue #255, spec §3):
      // emit one PRODUCTION_STATUS with the current status + per-output health so a
      // single-source downstream consumer attaching mid-broadcast learns the state
      // immediately without a REST round-trip. Sent directly to this socket (not
      // broadcast), so we stamp `ts` here to match the broadcast() envelope; `seq`
      // rides the #209 envelope once it lands (not yet — carries `ts` only for now).
      if (connectDoc) {
        const productionActive = connectDoc.status === 'active';
        const outputs = deriveOutputSnapshot({
          outputIds: (connectDoc.outputAssignments ?? []).map((a) => a.outputId),
          stromKnown: true,
          productionActive,
          flowRunning: productionActive && !!connectDoc.stromFlowId,
        });
        socket.send(JSON.stringify({
          ts: new Date().toISOString(),
          ...buildProductionStatusEvent(id, connectDoc.status, outputs),
        }));
      }

      const cachedAlpha = overlayAlphaByProduction.get(id);
      if (cachedAlpha !== undefined) {
        socket.send(JSON.stringify({ type: 'OVL_STATE', alpha: cachedAlpha }));
      }

      // Replay current HTML-source forwarded params so a freshly-connected
      // Studio/Companion client shows the effective parameters (issue #268).
      const cachedHtmlParams = htmlSourceParamsByProduction.get(id);
      if (cachedHtmlParams) {
        for (const [sourceId, state] of cachedHtmlParams) {
          socket.send(JSON.stringify({
            type: 'HTML_SOURCE_STATE',
            sourceId,
            params: state.params,
            effectiveUrl: state.effectiveUrl,
            updatedAt: state.updatedAt,
          }));
        }
      }

      // Replay the current WHIP live-ingest state for this production's assigned
      // sources, so a freshly-connected controller immediately knows which WHIP
      // publishers are sending (issue #439, interim — parent #437). Only sources
      // with a recorded state (offer/teardown already observed) are emitted; the
      // state is in-memory only and resets on server restart. KNOWN INTERIM
      // LIMITATION: a `connected` here may be stale if a publisher dropped
      // without sending DELETE — see `src/services/whip-ingest-state.ts`.
      if (connectDoc) {
        for (const assignment of connectDoc.sources) {
          const liveIngest = getWhipIngestState(assignment.sourceId);
          if (liveIngest) {
            socket.send(JSON.stringify({
              type: 'SOURCE_INGEST_STATE',
              sourceId: assignment.sourceId,
              state: liveIngest.state,
              changedAt: liveIngest.changedAt,
            }));
          }
        }
      }

      // Sync PiP state from in-memory server cache (populated by SET_PIP / SELECT_PVW_PIP).
      // If the cache is cold (fresh connect after deactivate or server restart),
      // hydrate it from the persisted pipConfigs on the ProductionDoc (issue #177)
      // so the operator's PiP layout is restored. If nothing was persisted, seed
      // empty slots from num_pips so the PipPanel shows the correct number of slots
      // without requiring a SET_PIP first.
      // A watcher reads the doc's layout without caching it: a warm cache would
      // make the next operator connect skip the Strom re-push below.
      const restoredPipConfigs = connectDoc && !watchOnly ? hydratePipConfigsFromDoc(connectDoc) : null;
      const watcherPips = watchOnly && connectDoc && !pipConfigsByProduction.has(id)
        ? pipConfigsFromDoc(connectDoc).configs
        : null;
      socket.send(JSON.stringify({
        type: 'PIP_STATE',
        pgmPip: pgmPipByProduction.get(id) ?? null,
        pvwPip: pvwPipByProduction.get(id) ?? null,
        pips:   pipConfigsByProduction.get(id) ?? watcherPips ?? [],
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
            if (!watchOnly) numAudioChannelsByProduction.set(id, numChannels);
            // Only initialise registries on first connect for this production.
            // Subsequent connects (refresh, second operator) inherit existing state.
            // A watcher never initialises; the first operator connect does.
            const isFirstConnect = !watchOnly && !afvChannelsByProduction.has(id);
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
              // Strom may refuse to route a channel to main on this reset (e.g. a guard
              // left over from an earlier session where the channel was deliberately taken
              // off program). Seed the mute registry from what Strom reports, so the client
              // is not told a still-muted channel is live (#396).
              const seedMutes = (rejected: Record<string, unknown>, current: Record<string, unknown>) => {
                const initMuted = mutedElementsByProduction.get(id) ?? new Set<string>();
                for (let i = 1; i <= numChannels; i++) {
                  const toMainKey = `ch${i}_to_main`;
                  if (Object.hasOwn(rejected, toMainKey) || current[toMainKey] === false) initMuted.add(`ch${i}`);
                }
                mutedElementsByProduction.set(id, initMuted);
              };
              const applied = await strom.flows.updateBlockProperties(connectDoc.stromFlowId!, audioBlockId, { properties: initProps })
                .then((res) => { seedMutes(res.rejected ?? {}, res.properties ?? {}); return true; })
                .catch((err) => {
                  console.warn('[controller] init channel props error:', err);
                  // Keys are independent, so keep what applied; forget a refused fader's
                  // unity level so the restore below reports Strom's value instead.
                  if (!(err instanceof StromPropertiesRejectedError)) return false;
                  for (const key of Object.keys(err.rejected)) {
                    const fader = /^(ch\d+|main)_fader$/.exec(key);
                    if (fader) levelCache.delete(fader[1]);
                  }
                  seedMutes(err.rejected, err.current);
                  return true;
                });
              // Watchers that connected first were shown Strom's pre-reset values.
              // Skipped when the write failed outright: Strom still holds those values.
              if (applied) broadcastAudioReset(id, numChannels, mutedElementsByProduction.get(id) ?? new Set<string>());
            }
            // Restore fader levels and mute state.
            // Server-side cache (channelLevelsByProduction) is authoritative — it is updated
            // on every AUDIO_SET volume and survives page refreshes / new tabs within the
            // same server session. Strom block properties are used as a fallback for
            // values set before the server started (e.g. pipeline defaults).
            const mutedSet = mutedElementsByProduction.get(id);
            const levelCache = channelLevelsByProduction.get(id);
            const blockProps = await strom.flows.getBlockProperties(connectDoc.stromFlowId, audioBlockId).catch(() => null);
            for (let i = 1; i <= numChannels; i++) {
              const cachedLevel = levelCache?.get(`ch${i}`);
              const stromLevel = blockProps?.properties[`ch${i}_fader`];
              const volume = cachedLevel ?? (typeof stromLevel === 'number' ? stromLevel : undefined);
              if (volume !== undefined) {
                socket.send(JSON.stringify({ type: 'AUDIO_STATE', elementId: `ch${i}`, property: 'volume', value: volume }));
              }
              // No registry yet (only a watcher has connected): report Strom's routing.
              const isMuted = mutedSet
                ? mutedSet.has(`ch${i}`)
                : blockProps?.properties[`ch${i}_to_main`] === false;
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
            // Watchers get meters only while an operator's relay is running. A socket
            // that closed during the connect sync must not take a ref it never releases.
            if (!watchOnly && !socketClosed) {
              startMeterRelay(id, connectDoc.stromFlowId, audioBlockId, connectDoc.loudnessMainBlockId);
              relayHold(socket).meter = connectDoc.stromFlowId;
            }
          }
        } catch (err) {
          console.warn('[controller] audio sync error:', err);
        }
      }

      // -----------------------------------------------------------------------
      // Automation contract §4: GRAPHIC_STATE snapshot (spec §4).
      // This was the one piece missing from the original connect sync.
      // Emits the active state of each graphics overlay so automation clients
      // get the full picture on connect (not just changes thereafter).
      // -----------------------------------------------------------------------
      if (connectDoc) {
        const graphicsState = (connectDoc.graphics ?? []).map((g) => ({
          overlayId: g.id,
          name: g.name,
          active: g.active,
        }));
        socket.send(JSON.stringify({
          type: 'GRAPHIC_STATE',
          graphics: graphicsState,
          seq: nextSeq(id),
          ts: new Date().toISOString(),
        }));
      }

      // -----------------------------------------------------------------------
      // Clip state snapshot + reactive relay (epic #206, issues #278/#307).
      // For each clip source (a mixerInput present in clipPlayerBlockIds) send the
      // current CLIP_STATE alongside the TALLY / PIP_STATE / DSK_STATE / OVL_STATE
      // sync. Restore order for a cold registry (server restart / first connect):
      //   1. a PERSISTED cue (ProductionDoc.clipCues, OQ3) — re-cue Strom to the
      //      cue point and restore to `cued`, NEVER auto-playing;
      //   2. otherwise Strom's live player.getState.
      // Then start the reactive clip-relay (OQ2) so subsequent transitions/
      // position are pushed, with the poll only as a reconciliation fallback.
      // -----------------------------------------------------------------------
      if (connectDoc?.clipPlayerBlockIds) {
        const clipInputs = Object.keys(connectDoc.clipPlayerBlockIds);
        let clipStrom: StromClient | null = null;
        for (const mixerInput of clipInputs) {
          const tracked = getClipStateEntry(id, mixerInput);
          if (tracked) {
            socket.send(JSON.stringify({ type: 'CLIP_STATE', ...tracked }));
            continue;
          }
          // Cold registry: prefer restoring a persisted cue (OQ3) before falling
          // back to Strom's live state. A restored cue is put back into `cued` at
          // the cue point and MUST NOT auto-play. A watcher leaves the re-cue
          // (a Strom write) to the next operator connect.
          const persistedCue = connectDoc.clipCues?.[mixerInput];
          if (persistedCue && !watchOnly) {
            try {
              if (!clipStrom) clipStrom = await makeStromClient();
              const source = await resolveClipSource(connectDoc, mixerInput, (sid) => getSourcesDb().get(sid) as Promise<SourceDoc>);
              // Re-cue Strom (setPlaylist + goto) so the player is actually ready
              // at the cue point, then seek to a non-zero cue position if any.
              await cueClip(clipStrom, connectDoc, source, mixerInput, persistedCue.clipId);
              if (persistedCue.positionMs && persistedCue.positionMs > 0) {
                await clipStrom.player.seek(connectDoc.stromFlowId!, resolveClipTarget(connectDoc, mixerInput).blockId, { position_ns: persistedCue.positionMs * 1e6 });
              }
              const state: ClipState = {
                mixerInput,
                state: 'cued',
                clipId: persistedCue.clipId,
                ...(persistedCue.positionMs !== undefined ? { positionMs: persistedCue.positionMs } : {}),
                ...(persistedCue.durationMs !== undefined ? { durationMs: persistedCue.durationMs } : {}),
              };
              setClipStateEntry(id, state);
              socket.send(JSON.stringify({ type: 'CLIP_STATE', ...state }));
              continue;
            } catch (err) {
              console.warn(`[controller] clip cue restore error (${mixerInput}):`, String(err));
              // Fall through to Strom live-state restore below.
            }
          }
          // No persisted cue (or restore failed): restore from Strom's live state.
          try {
            if (!clipStrom) clipStrom = await makeStromClient();
            const { flowId, blockId } = resolveClipTarget(connectDoc, mixerInput);
            const player = await clipStrom.player.getState(flowId, blockId);
            const state: ClipState = {
              mixerInput,
              state: player.state === 'playing' ? 'playing' : player.state === 'paused' ? 'paused' : 'stopped',
              // Strom reports position/duration in nanoseconds; the contract is ms.
              ...(player.position_ns !== undefined ? { positionMs: Math.round(player.position_ns / 1e6) } : {}),
              ...(player.duration_ns !== undefined ? { durationMs: Math.round(player.duration_ns / 1e6) } : {}),
            };
            // Not cached for a watcher: a warm registry would skip the operator's cue restore.
            if (!watchOnly) setClipStateEntry(id, state);
            socket.send(JSON.stringify({ type: 'CLIP_STATE', ...state }));
          } catch (err) {
            console.warn(`[controller] clip state connect sync error (${mixerInput}):`, String(err));
          }
        }

        // Start the reactive clip-relay for this production's clip player blocks
        // (OQ2). blockToInput is the inverse of clipPlayerBlockIds. Ref-counted:
        // one WS per production, stopped on the last controller disconnect.
        // The relay writes the registry, so a watcher does not start it.
        if (connectDoc.stromFlowId && !watchOnly && !socketClosed) {
          const blockToInput = new Map<string, string>();
          for (const [mixerInput, blockId] of Object.entries(connectDoc.clipPlayerBlockIds)) {
            blockToInput.set(blockId, mixerInput);
          }
          startClipRelay(id, connectDoc.stromFlowId, blockToInput);
          relayHold(socket).clip = connectDoc.stromFlowId;
        }
      }

      // -----------------------------------------------------------------------
      // Guest-calling snapshot (epic #208, issue #301). Emits the current guest
      // set (GUEST_STATE per live session) and per-input return-feed modes
      // (RETURN_STATE) so a controller attaching mid-production learns them
      // without a REST round-trip. previewing/on-air are DERIVED from the live
      // tally contribution set; `left` sessions are excluded.
      // -----------------------------------------------------------------------
      if (connectDoc) {
        try {
          const sessionsResult = await getGuestSessionsDb().find({
            selector: { type: 'guest-session', productionId: id },
          });
          const sessions = (Array.isArray(sessionsResult?.docs) ? sessionsResult.docs : [])
            .filter((s) => s.state !== 'left');
          if (sessions.length > 0) {
            const invitesResult = await getGuestInvitesDb().find({
              selector: { type: 'guest-invite', productionId: id },
            });
            const labelByInvite = new Map(
              (Array.isArray(invitesResult?.docs) ? invitesResult.docs : [])
                .map((inv) => [inv._id, inv.label] as const),
            );
            const tallyNow = getTally(id);
            const { program, preview } = buildTallyPayload(id, tallyNow, connectDoc);
            for (const s of sessions) {
              const label = labelByInvite.get(s.inviteId);
              socket.send(JSON.stringify({
                type: 'GUEST_STATE',
                guestId: s._id,
                mixerInput: s.mixerInput,
                state: deriveGuestDisplayState(s.state, s.mixerInput, program, preview),
                muted: !!s.muted,
                ...(label ? { label } : {}),
                ...(s.intercomLineId ? { intercomLine: s.intercomLineId } : {}),
                seq: nextSeq(id),
                ts: new Date().toISOString(),
              }));
            }
          }
          // Return-feed modes. Prefer the resolved returnBuses cache; fall back
          // to the modes persisted on the source assignments' returnFeed.
          const returnModes = connectDoc.returnBuses?.length
            ? connectDoc.returnBuses.map((rb) => ({ mixerInput: rb.mixerInput, mode: rb.mode }))
            : (connectDoc.sources ?? [])
                .filter((src) => src.returnFeed)
                .map((src) => ({ mixerInput: src.mixerInput, mode: src.returnFeed!.synced }));
          for (const r of returnModes) {
            socket.send(JSON.stringify({
              type: 'RETURN_STATE',
              mixerInput: r.mixerInput,
              mode: r.mode,
              seq: nextSeq(id),
              ts: new Date().toISOString(),
            }));
          }
        } catch (err) {
          console.warn('[controller] guest snapshot connect sync error:', String(err));
        }
      }

      // -----------------------------------------------------------------------
      // Automation contract §4: SNAPSHOT_END (spec §4).
      // Signals to reconnecting automation clients that the resync is complete.
      // seq echoes the last event seq emitted during this snapshot so the client
      // can resume applying live broadcast events with seq > snapshotEnd.seq.
      // -----------------------------------------------------------------------
      socket.send(JSON.stringify({
        type: 'SNAPSHOT_END',
        seq: currentSeq(id),
        ts: new Date().toISOString(),
      }));
    }
  );
};

export default controllerWs;
