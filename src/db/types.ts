import type { PipConfig } from '../lib/strom.js';

// --------------- Macro types ---------------

export type MacroActionType = 'CUT' | 'TRANSITION' | 'TAKE' | 'GRAPHIC_ON' | 'GRAPHIC_OFF' | 'DSK_TOGGLE';

export interface MacroAction {
  type: MacroActionType;
  sourceId?: string;
  transitionType?: string;
  durationMs?: number;
  overlayId?: string;
  layer?: number;
  visible?: boolean;
}

export interface Macro {
  id: string;      // "macro-<uuid>"
  slot: number;    // 0-7 (F1-F8)
  label: string;
  color: string;   // hex color, e.g. "#3B82F6"
  actions: MacroAction[];
}

// --------------- Source types ---------------

export type StreamType = 'srt' | 'efp' | 'whip' | 'test1' | 'test2' | 'html' | 'clip';

export type SourceStatus = 'active' | 'inactive';

// --------------- Clip reference types (issue #275, epic #206) ---------------

/**
 * Typed, versioned clip reference for `streamType: 'clip'` sources.
 *
 * A discriminated union so new byte sources can be added without breaking the
 * contract or overloading a bare `address` string (per PM direction on #206).
 * The reference is a *contract-level* (API/zod) concern; it is stored serialized
 * as a JSON string in the existing optional `SourceDoc.address` field, so no
 * persisted schema migration is introduced. See
 * `docs/specs/clip-story-playback.md` §"Clip source model" / §"Migration".
 *
 * v1 implements `url` and `s3`; `tams` is accepted at the type level but rejected
 * at runtime (501/not-implemented). No variant assumes a fixed media length — any
 * reference may carry an optional `timerange`.
 */

/** Any fetchable file / object-storage URL. A presigned URL reduces to this. */
export interface ClipReferenceUrl {
  type: 'url';
  url: string;
  /** Optional; nothing in the model assumes a fixed file length. */
  timerange?: string;
}

/** Object storage (MinIO / S3 objects from epic #5). */
export interface ClipReferenceS3 {
  type: 's3';
  bucket: string;
  key: string;
  timerange?: string;
}

/** BBC Time-Addressable Media Store (flow + timerange). Reserved — not v1. */
export interface ClipReferenceTams {
  type: 'tams';
  store: string;
  flowId: string;
  timerange: string;
}

export type ClipReference = ClipReferenceUrl | ClipReferenceS3 | ClipReferenceTams;

/**
 * Live clip playback state for a `clip` source assigned to a mixer input
 * (epic #206, issues #277/#278). CamelCased mirror of Strom's
 * `PlayerStateResponse` plus the cue/play/completed clip state machine
 * (spec `docs/specs/clip-story-playback.md` §"State machine").
 *
 * Live playback state (`playing`/`paused`/`completed`/`error` and playhead
 * position) is held in the in-memory `clip-state` service (mirroring tally) and
 * driven reactively from Strom's pushed media_player events (issue #307 / OQ2).
 * The CUE POINT, however, is persisted on the doc (`ProductionDoc.clipCues`) so a
 * cued clip survives deactivate/reactivate and server restart, restored to
 * `cued` and never auto-playing (issue #307 / OQ3).
 */
export interface ClipState {
  mixerInput: string;
  state: 'idle' | 'cued' | 'playing' | 'paused' | 'stopped' | 'completed' | 'error';
  clipId?: string;
  positionMs?: number;
  durationMs?: number;
  error?: string;
}

/**
 * A persisted clip cue (epic #206, issue #307 / OQ3). Records which clip is cued
 * on a mixerInput and where its cue point sits, so the cue can be restored to the
 * `cued` state (never auto-playing) after deactivate/reactivate or a restart.
 */
export interface PersistedClipCue {
  /** The cued clip source id. */
  clipId: string;
  /** Cue-point position in ms (defaults to 0 — start of media). */
  positionMs?: number;
  /** Media duration in ms, when known at cue time (for connect-time snapshot). */
  durationMs?: number;
}

export interface SourceDoc {
  _id: string;
  _rev?: string;
  type: 'source';
  name: string;
  address: string;
  streamType: StreamType;
  status: SourceStatus;
  liveCamera?: boolean;
  /** SRT receiver buffer latency in ms. Only applies to srt/efp stream types. Default 125. */
  latency?: number;
  /**
   * Optional id of the Gateway (`GatewayDoc._id`) that registered this source
   * (issue #263). Absent for manually-created sources. Enables the
   * forget-gateway cascade and Studio's Sources chip. Additive and
   * defaulted-absent — every existing source stays valid unchanged.
   */
  gatewayId?: string;
  createdAt: string;
  updatedAt: string;
}

// --------------- Gateway types (issue #263, OL-5 Studio Gateways Phase 1) ---------------

/**
 * Gateway health, reusing the OL-4 vocabulary (`docs/specs/production-lifecycle-health.md`).
 * Deliberately NO `degraded` value — matching the OL-4 decision (no verified
 * per-signal source from an ingest box). Derived on read from `lastSeenAt`
 * (compute-on-read); never persisted on the `GatewayDoc`.
 */
export type GatewayHealth = 'healthy' | 'down' | 'unknown';

/** Strom FlowState vocabulary (`src/lib/strom.ts`) as reported per gateway input. */
export type GatewayInputFlowState = 'idle' | 'playing' | 'paused';

export interface GatewayInputStatus {
  inputId: string;
  name: string;
  flowState: GatewayInputFlowState;
  /** References SourceDoc._id when this input registered a source; null otherwise. */
  sourceId: string | null;
  uplink: { bitrateKbps: number; rtt_ms: number; dropped: number } | null;
}

export interface GatewayDoc {
  _id: string;                     // "gw-<uuid>"
  _rev?: string;
  type: 'gateway';
  name: string;
  /** SHA-256 hash of the per-gateway bearer token. Raw token is never persisted (ADR-001). */
  tokenHash: string;
  /** ISO 8601 UTC time of the most recent heartbeat/online frame; null until first contact. */
  lastSeenAt: string | null;
  // ---- last-heartbeat snapshot (all optional; absent until first heartbeat) ----
  host?: string;
  stromVersion?: string;
  deviceCount?: number;
  streamingCount?: number;
  inputs?: GatewayInputStatus[];
  createdAt: string;
  updatedAt: string;
}

// --------------- Graphic types ---------------

export interface GraphicDoc {
  _id: string;        // "gfx-{uuid}"
  _rev?: string;
  type: 'graphic';
  name: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

// --------------- Output types ---------------

export type OutputType = 'mpegtssrt' | 'efpsrt' | 'whep' | 'recording';

/**
 * Output health surfaced to single-source downstream consumers (issue #255).
 *
 * The enum shape is future-proofed to include `degraded`, but only
 * `healthy | down | unknown` are ever derived/emitted today — Strom exposes no
 * per-output liveness signal to populate `degraded` truthfully (spec §2 / OQ-2).
 * `unknown` is also the absent-value semantics: an omitted `status` is
 * equivalent to `unknown`.
 */
export type OutputStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface OutputDoc {
  _id: string;           // "output-{uuid}"
  _rev?: string;
  type: 'output';
  name: string;
  outputType: OutputType;
  // SRT URI for mpegtssrt/efpsrt; undefined for whep. A 'recording' output
  // carries no url — its destination is derived from the MinIO config plus the
  // production id (spec: vod-recording-minio.md).
  url?: string;
  /**
   * Derived output health (issue #255). Optional; when absent, read as
   * `unknown`. Computed on read from the owning production's live flow state
   * rather than persisted (see `src/lib/production-health.ts`).
   */
  status?: OutputStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionOutputAssignment {
  outputId: string;      // references OutputDoc._id
}

// --------------- Recording (VOD) types ---------------

/**
 * A recorded VOD asset archived to object storage (epic #5, issue #42).
 *
 * Written on production deactivate: after open-live uploads Strom's local
 * recorder segments to MinIO/S3 (issue #41), one `RecordingDoc` is persisted
 * per uploaded object so the listing/playback endpoint can enumerate and
 * presign recordings without round-tripping the bucket on every request. The
 * listing endpoint still reconciles against the bucket prefix so a crash
 * between upload and persist does not permanently hide an object (spec §Risks).
 */
export interface RecordingDoc {
  _id: string;            // "recording-<uuid>"
  _rev?: string;
  type: 'recording';
  productionId: string;   // references ProductionDoc._id
  outputId?: string;      // the 'recording' OutputDoc that produced it, when known
  bucket: string;
  key: string;            // object key, e.g. "<productionId>/<segment>.mp4"
  sizeBytes?: number;
  durationMs?: number;
  startedAt: string;      // ISO 8601 — when the recording session began
  endedAt?: string;       // ISO 8601 — when the segment was finalized/uploaded
  createdAt: string;
  updatedAt: string;
}

// --------------- Guest calling types (issue #299, epic #208) ---------------

/**
 * A production-scoped, expiring invite for a remote guest to join via a browser
 * (epic #208, issue #299, `docs/specs/guest-calling-intercom.md` §"Data Model").
 *
 * Lives in its own logical collection (`type: 'guest-invite'`). Only the SHA-256
 * hash of the HMAC-signed invite token is persisted — the raw token is returned
 * to the operator exactly once on create and NEVER stored, so a database read
 * can never recover a live token (spec §Risks: "hashed storage … mandatory").
 */
export interface GuestInviteDoc {
  _id: string;              // "guest-invite-<uuid>"
  _rev?: string;
  type: 'guest-invite';
  productionId: string;
  tokenHash: string;        // SHA-256 hash of the raw token; raw token never persisted
  label?: string;
  /** Input the guest will occupy; allocated on join if absent. */
  mixerInput?: string;
  expiresAt: string;        // ISO 8601
  createdAt: string;
  updatedAt: string;
}

/** Lifecycle state of a joined guest. `invited`/`left`/`error` are transient. */
export type GuestSessionState = 'joined' | 'previewing' | 'on-air' | 'left' | 'error';

/**
 * A live guest session created when a guest redeems an invite (epic #208,
 * issue #299, `docs/specs/guest-calling-intercom.md` §"Data Model").
 * `previewing`/`on-air` are DERIVED from the vision mixer's PVW/PGM
 * contribution in a later sub-issue; v1 persists `joined`/`left`/`error`.
 */
export interface GuestSessionDoc {
  _id: string;              // "guest-session-<uuid>"
  _rev?: string;
  type: 'guest-session';
  productionId: string;
  inviteId: string;
  mixerInput: string;
  state: GuestSessionState;
  /** Reference into intercom-manager, when a talkback line is provisioned (later sub-issue). */
  intercomLineId?: string;
  whipSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

// --------------- Production config types ---------------

export interface ProductionConfigDoc {
  _id: string;         // "cfg-<uuid>"
  _rev?: string;
  type: 'production-config';
  name: string;
  values: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

// --------------- Production types ---------------

/**
 * Maps a source from the sources catalogue to a mixer input in the template.
 */
export interface ProductionSourceAssignment {
  sourceId: string;   // references SourceDoc._id
  mixerInput: string; // references TemplateInputSlot.id (e.g. 'video_in_0')
  /**
   * Optional per-guest return feed (mix-minus) for guest-calling (epic #208,
   * issue #299, `docs/specs/guest-calling-intercom.md` §"Return feed design").
   * The return belongs to the assignment, not the guest session, so a rejoin on
   * the same `mixerInput` keeps it and crew-added contributors can have one.
   * Additive and defaulted-absent; POPULATED BY A LATER SUB-ISSUE (return /
   * mix-minus wiring) — declared here only so the data model is stable.
   * v1 accepts `lowLatency: false` only.
   */
  returnFeed?: { synced: 'program' | 'program-minus'; lowLatency?: boolean };
}

/**
 * Maps a graphic from the graphics catalogue to a DSK pad on the vision mixer.
 */
export interface ProductionGraphicAssignment {
  graphicId: string;  // references GraphicDoc._id
  dskInput: string;   // DSK pad name (e.g. 'dsk_in_0', 'dsk_in_1')
}

export type PipelineStatus = 'stopped' | 'running';

export interface Pipeline {
  stromConfig: Record<string, unknown> | null;
  status: PipelineStatus;
}

export interface GraphicOverlay {
  id: string;
  name: string;
  template: string;
  params: Record<string, unknown>;
  active: boolean;
}

export interface Tally {
  pgm: string | null;
  pvw: string | null;
}

/**
 * Production lifecycle status (issue #255).
 *
 * - `inactive`   — not currently running (never started, or reset to a clean
 *   idle state). Also the status of a failed/aborted activation that never
 *   reached `active`.
 * - `activating` — activation in progress (flow created, not yet `playing`).
 * - `active`     — reached a live broadcast (flow `playing`).
 * - `ended`      — ran a broadcast and that broadcast has finished (an `active`
 *   production that then stopped via deactivate, idle auto-deactivate, or
 *   reconcile finding its Strom flow gone). Distinct from `inactive` so a
 *   single-source downstream consumer can tell "never started" from "finished".
 *   Not terminal: re-activating moves back through `activating` → `active`.
 */
export type ProductionStatus = 'active' | 'inactive' | 'activating' | 'ended';

/** Machine-readable reason a production reached `ended` (issue #255, optional). */
export type EndedReason = 'deactivated' | 'idle' | 'flow-lost';

export interface ProductionDoc {
  _id: string;
  _rev?: string;
  type: 'production';
  name: string;
  status: ProductionStatus;
  /** Source-to-mixer-input assignments for this production */
  sources: ProductionSourceAssignment[];
  /** Output assignments for this production */
  outputAssignments?: ProductionOutputAssignment[];
  /** WHEP output URLs — set when flow reaches 'playing', cleared on deactivate */
  whepOutputUrls?: Array<{ outputId: string; url: string }>;
  /** Graphic-to-DSK-pad assignments for this production */
  graphicAssignments?: ProductionGraphicAssignment[];
  /**
   * Persisted Picture-in-Picture layout (background + zones + per-source crops)
   * per PiP slot. Set via the WS SET_PIP handler; survives deactivate/reactivate
   * and server restarts so operators do not have to reconfigure PiP placement.
   * Indexed by PiP slot number.
   */
  pipConfigs?: PipConfig[];
  /** ID of the running Strom flow (set on activate, cleared on deactivate) */
  stromFlowId?: string;
  /** ID of the builtin.recorder block — set on activate when a 'recording' output is assigned, cleared on deactivate */
  recorderBlockId?: string;
  /** WHEP multiview endpoint URL — set when flow reaches 'playing' state, cleared on deactivate */
  whepEndpoint?: string;
  /** WHEP PGM output endpoint URL — set when flow reaches 'playing' state, cleared on deactivate */
  pgmWhepEndpoint?: string;
  /** WHIP ingest endpoint URLs for each __whip__ source assignment — set on activate, cleared on deactivate */
  whipEndpoints?: Array<{ mixerInput: string; url: string }>;
  /** SRT program output URI (listener) — set on activate, cleared on deactivate */
  srtOutputUri?: string;
  /** Template property values chosen at production creation, keyed by property id */
  values?: Record<string, string | number | boolean>;
  /** Scheduled on-air start time — ISO 8601 UTC string (e.g. "2026-05-01T18:30:00.000Z") */
  airTime?: string;
  pipeline: Pipeline;
  graphics: GraphicOverlay[];
  macros: Macro[];
  tally: Tally;
  mixerBlockId?: string;
  audioMixerBlockId?: string;
  /** ID of the builtin.loudness block on the main audio bus — set on activate, cleared on deactivate */
  loudnessMainBlockId?: string;
  /** Maps mixerInput (e.g. 'video_in_1') → time_offset block ID — set on activate, cleared on deactivate */
  sourceOffsetBlockIds?: Record<string, string>;
  /** Maps mixerInput → audio time_offset block ID — set on activate, cleared on deactivate */
  sourceAudioOffsetBlockIds?: Record<string, string>;
  /** Maps mixerInput → media-player (builtin.media_player) block ID for clip sources — set on activate, cleared on deactivate */
  clipPlayerBlockIds?: Record<string, string>;
  /**
   * Persisted clip cue points (epic #206, issue #307 / OQ3). Maps a clip source's
   * mixerInput to the currently-cued clip and its cue position. A cued clip
   * survives deactivate/reactivate AND server restart — on restore it is put back
   * into the `cued` state at the cue point and NEVER auto-plays, matching the
   * persistence rule for `pipConfigs` (PiP layout). Written on CLIP_CUE, cleared
   * on CLIP_STOP / completion. Additive and defaulted-absent; unlike the
   * activate-set block-id maps, it is deliberately NOT cleared on deactivate.
   */
  clipCues?: Record<string, PersistedClipCue>;
  /**
   * Per-guest return feed topology (epic #208, issue #300) — set on activate,
   * cleared on deactivate. Each entry maps a guest's mixerInput to its return aux
   * bus, its own audio channel (excluded in `program-minus`) and the live mode,
   * so the WS layer can drive send-level changes and mirror `to_main` into returns.
   */
  returnBuses?: Array<{ mixerInput: string; auxBus: number; ownChannel: number; mode: 'program' | 'program-minus' }>;
  /** Per-guest return WHEP output URLs — set when flow reaches 'playing', cleared on deactivate */
  returnWhepUrls?: Array<{ mixerInput: string; url: string; endpointId: string }>;
  /**
   * Open Intercom production/line grouping id — set when guest calling is
   * enabled for this production (epic #208, issue #299,
   * `docs/specs/guest-calling-intercom.md` §"Data Model"). Lets talkback lines
   * be provisioned / torn down with the production lifecycle. Additive and
   * defaulted-absent; POPULATED BY A LATER SUB-ISSUE (intercom provisioning) —
   * declared here only so the data model is stable.
   */
  intercomProductionId?: string;
  /** Warnings accumulated when a referenced source/graphic/output was deleted while production was inactive */
  deletionWarnings?: Array<{ type: 'source' | 'graphic' | 'output'; name: string }>;
  /** Set when the idle watchdog auto-deactivated this production; cleared on next activation */
  autoDeactivated?: boolean;
  /**
   * Why this production reached `status: 'ended'` (issue #255). Optional,
   * defaulted-absent; disambiguates the `ended` transition (explicit deactivate
   * vs. idle auto-deactivate vs. reconcile losing the flow) without a separate
   * status value. Cleared on next activation.
   */
  endedReason?: EndedReason;
  createdAt: string;
  updatedAt: string;
}
