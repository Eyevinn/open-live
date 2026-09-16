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
