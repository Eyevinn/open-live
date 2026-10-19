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
  /**
   * Optional id of the {@link StorageConnectionDoc} whose endpoint/region/
   * credentials presign this object (issue #520, OL-21). Absent = the implicit
   * default connection built from the `MINIO_*` / `S3_ENDPOINT` env — exactly
   * today's behaviour. A `connectionId` that no longer resolves is a Cue-time
   * error, the same place a bad bucket surfaces today.
   */
  connectionId?: string;
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

/**
 * Authenticated-HTML-source auth material (issue #314,
 * `docs/specs/authenticated-html-sources.md`, ADR-003).
 *
 * Additive and present only for `streamType: 'html'`; absent = today's
 * anonymous rendering behaviour (purely additive, no migration).
 *
 * Discriminated by `mode`:
 *  - `header`  → Design B: a static credential applied to the top-level
 *    navigation request. The credential VALUE is write-only over the API
 *    (accepted on write, never returned; encrypted at rest via
 *    `src/lib/html-auth-crypto.ts`, masked on read as `valueSet: true`).
 *  - `profile` → Design C: a named, persisted, isolated renderer profile,
 *    with a passive `status` so Studio can warn before activation.
 *
 * v1 scope note (ADR-003 OQ2 → CONFIRMED-NO): stock upstream `cefsrc` exposes
 * neither a per-navigation request header nor a per-source isolated user-data
 * dir, so Designs B and C **cannot render** yet — they are an upstream-gated
 * fast-follow. The `auth` field is accepted and stored at the contract level
 * (like the reserved `ClipReferenceTams` above), and the interactive-login
 * provisioning endpoint returns 501 until its channel is decided and
 * security-reviewed. The shipped v1 authentication path is Design D
 * (token-in-URL) — a token carried inside the source `address`, which needs no
 * new field and is redacted in logs (`src/lib/log-redact.ts`, issue #315).
 */
export interface HtmlSourceAuthHeader {
  /** Header name, e.g. "Authorization". Validated: token-header allowlist, max 64. */
  name: string;
  /**
   * Read-only echo of whether a credential value is stored. The value itself is
   * WRITE-ONLY over the API — accepted on write, never returned — and encrypted
   * at rest. Never contains the plaintext.
   */
  valueSet?: boolean;
}

export interface HtmlSourceAuthProfile {
  /** Server-issued profile id, "hprof-<uuid>". */
  profileId: string;
  /** Passive session status surfaced to Studio (ADR-003 OQ4). */
  status: 'unprovisioned' | 'provisioned' | 'expired';
  /** ISO 8601 UTC timestamp of the last successful provisioning, when any. */
  lastProvisionedAt?: string;
}

export interface HtmlSourceAuth {
  mode: 'header' | 'profile';
  header?: HtmlSourceAuthHeader;
  profile?: HtmlSourceAuthProfile;
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
   * 0-based audio elementary-stream index an SRT/EFP input uses (ADR-006).
   * Additive, no migration: absent => 0. Only valid for srt/efp stream types.
   */
  audioStreamIndex?: number;
  /**
   * Authenticated-HTML-source auth material (issue #314). Present only for
   * `streamType: 'html'`. Additive and defaulted-absent — every existing source
   * stays valid unchanged. See {@link HtmlSourceAuth}.
   *
   * The stored form differs from the API form: `header.value` is held encrypted
   * (`encv1:` bundle) on an internal field and never appears in `HtmlSourceAuth`
   * itself, which only echoes `valueSet`.
   */
  auth?: HtmlSourceAuth;
  /**
   * Internal-only ciphertext store for a Design-B header credential value
   * (issue #314). Encrypted at rest (`src/lib/html-auth-crypto.ts`), bound to
   * this source id via GCM AAD. Never returned by the API, never logged. Kept
   * separate from `auth.header` so the API-facing `auth` object can be echoed
   * back to clients without any risk of leaking the ciphertext.
   */
  authHeaderValueEnc?: string;
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

export type OutputType = 'mpegtssrt' | 'efpsrt' | 'whep' | 'recording' | 'rtmp';

/**
 * Platform preset for an RTMP destination (spec: rtmp-multi-destination.md,
 * ADR-004; Resolved Decision 1). The three named presets resolve their ingest
 * URL from a static server-side table; `'custom'` carries an operator-supplied
 * `rtmp(s)://` ingest URL validated for scheme + SSRF at the API boundary.
 */
export type RtmpPlatform = 'youtube' | 'twitch' | 'facebook' | 'custom';

/**
 * RTMP destination fields on an `OutputDoc` (present only when
 * `outputType === 'rtmp'`). Each RTMP destination is its own `OutputDoc`
 * (ADR-004 Decision 1); multiple destinations per production are expressed
 * through `ProductionDoc.outputAssignments[]`.
 */
export interface RtmpDestination {
  /** Which platform preset supplied (or, for 'custom', framed) the ingest URL. */
  platform: RtmpPlatform;
  /**
   * The resolved RTMP(S) ingest URL, WITHOUT the stream key, e.g.
   * "rtmps://a.rtmp.youtube.com/live2". For a named preset it is resolved
   * server-side from the static preset table at write time; for 'custom' it is
   * the validated operator-supplied URL. Never carries the key.
   */
  ingestUrl: string;
  /**
   * The platform stream key, encrypted at rest with the `encv1:` bundle
   * (`src/lib/rtmp-credentials-crypto.ts`, dedicated `RTMP_CREDENTIALS_KEY` —
   * ADR-004 Resolved Decision 2). WRITE-ONLY over the API: accepted on
   * create/patch, never returned. Stored on the doc, never composed into
   * `ingestUrl` or `OutputDoc.url`.
   */
  streamKeyEnc?: string; // encv1:<...> — never the plaintext, never returned
}

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
  // production id (spec: vod-recording-minio.md). NEVER populated for 'rtmp'
  // outputs — the ingest URL + key live in the structured `rtmp` object so the
  // key is never smeared into a free-text URL or the derived `connect` field.
  url?: string;
  /**
   * RTMP destination fields (spec: rtmp-multi-destination.md, ADR-004). Present
   * only when `outputType === 'rtmp'`; absent on all other output types and on
   * all pre-existing docs (additive, no migration).
   */
  rtmp?: RtmpDestination;
  /**
   * Optional id of the {@link StorageConnectionDoc} a `recording` output writes
   * its segments to (issue #520, OL-21). Present only on `recording` outputs;
   * absent = the implicit default connection built from the env, exactly as
   * today. Stamped onto each {@link RecordingDoc} written by this output.
   */
  connectionId?: string;
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
  /**
   * Id of the {@link StorageConnectionDoc} this asset was written to (issue
   * #520, OL-21). Absent = the implicit default (env) connection — no backfill
   * runs on existing recordings, and "absent" and `"default"` resolve
   * identically for playback presigning (spec §3.3).
   */
  connectionId?: string;
  bucket: string;
  key: string;            // object key, e.g. "<productionId>/<segment>.mp4"
  sizeBytes?: number;
  /** Media duration read from the MP4 movie header at upload (issue #534); absent when unreadable. */
  durationMs?: number;
  startedAt: string;      // ISO 8601 — when the recording session began, from the segment's file name
  endedAt?: string;       // ISO 8601 — when the segment was finalized/uploaded
  createdAt: string;
  updatedAt: string;
}

/**
 * The recording output a production's recorder block was wired for, captured
 * at activation (issue #534).
 */
export interface ActiveRecording {
  /** The `recording` OutputDoc wired into the recorder block. */
  outputId: string;
  /** That output's storage connection at activation; absent = the default (env) connection. */
  connectionId?: string;
  /** ISO 8601 — when the activation that built the recorder block started. */
  startedAt: string;
}

/**
 * Why a deactivate's recording upload uploaded nothing or stopped early (issue #534):
 *  - `no-storage-target`: no connection on the output and the `MINIO_*` env is incomplete;
 *  - `connection-not-found`: the output's storage connection no longer exists;
 *  - `connection-no-bucket`: the connection has no default bucket to write to;
 *  - `auth-error`: the store rejected the credentials or permission (sweep aborted);
 *  - `upload-error`: listing the recordings on Strom or the upload pass itself failed.
 */
export type RecordingUploadReason =
  | 'no-storage-target'
  | 'connection-not-found'
  | 'connection-no-bucket'
  | 'auth-error'
  | 'upload-error';

/** Summary of a deactivate's recording upload, stored on the production (issue #534). */
export interface RecordingUploadSummary {
  /** ISO 8601 — when the upload step finished. */
  finishedAt: string;
  /** The recording output the upload was for, when known. */
  outputId?: string;
  /** Storage connection used; absent = the default (env) connection. */
  connectionId?: string;
  /** Bucket written to, when a target was resolved. */
  bucket?: string;
  /** Number of files uploaded (and listed as recordings). */
  uploaded: number;
  /**
   * Files that failed to upload; they stay on Strom for the next sweep.
   * `error` includes up to the first 200 characters of the S3 error body. It
   * never holds the secret key or a presigned URL (PUT uses header auth). For
   * some codes S3 echoes `<AWSAccessKeyId>`/`<StringToSign>` later in the body;
   * the 200-character cut normally drops those.
   */
  failed: Array<{ file: string; error: string }>;
  /** Set when nothing was attempted or the sweep stopped early. */
  reason?: RecordingUploadReason;
  /** Human-readable explanation accompanying `reason`. */
  message?: string;
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
  /**
   * Whether the guest has muted their microphone from the guest page (issue #382).
   * The guest reports every mute change via `PUT /guests/:inviteId/session/mute`;
   * this is surfaced to the operator in `GUEST_STATE` and the guests projection.
   * A rejoin resets it to unmuted.
   */
  muted?: boolean;
  /**
   * Absolute Strom WHIP **session-resource** URL for this guest's live publish
   * (`/whip/{endpoint_id}/resource/{resource_id}`), captured from the `Location`
   * header Strom returns on the WHIP offer POST (`proxyWhipOffer`, issue #467).
   * Server-side teardown (`teardownGuestWhip` on leave/kick) DELETEs THIS URL —
   * a DELETE on the bare endpoint URL does not end the session, so without this
   * Strom kept the guest session until its 10 s inactivity reaper. Absent on a
   * return-only slot or before the guest has published; stale after a reconnect
   * until the next offer overwrites it. Internal — stripped from `sessionToApi`.
   */
  whipSessionUrl?: string;
  /**
   * Strom WHEP session id of this guest's most recent return-picture feed
   * (issue #380). Bound on `POST .../returns/:mixerInput/picture/whep` so the
   * matching `DELETE .../picture/whep/:sessionId` can verify a guest caller is
   * tearing down THEIR OWN return session rather than an arbitrary
   * caller-supplied :sessionId for another guest's feed.
   */
  returnWhepSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The backend-generated HMAC signing key for guest invite tokens (issue #391).
 *
 * Stored under a SINGLE FIXED id (`GUEST_SIGNING_KEY_DOC_ID`) so there is at most
 * one key per instance. The backend generates it the first time guest calling
 * needs a key and reads it back on every subsequent start, so restarts keep
 * existing invites valid. `GUEST_INVITE_SECRET` (env) still overrides it.
 *
 * `signingSecret` is a credential: it is NEVER logged (the `secret` substring is
 * matched by `src/lib/log-redact.ts` and the Fastify logger redact paths in
 * `src/server.ts`) and NEVER returned by any route.
 */
export interface GuestSigningKeyDoc {
  _id: string;              // fixed: "guest-invite-signing-key"
  _rev?: string;
  type: 'guest-signing-key';
  /** Randomly generated HMAC signing key (base64url). Never logged or returned. */
  signingSecret: string;
  createdAt: string;        // ISO 8601
}

/**
 * The backend-generated AES-256 credential encryption key (issue #438).
 *
 * On OSC no `SRT_PASSPHRASE_KEY` / `HTML_AUTH_KEY` is provisioned, so saving an
 * SRT passphrase or an authenticated-HTML-source credential failed closed with a
 * 503 (`Credential storage is not configured`). Mirroring the guest-invite
 * signing key (#391), the backend now generates this key on first start and
 * stores it under a SINGLE FIXED id (`CREDENTIAL_ENCRYPTION_KEY_DOC_ID`), reading
 * it back on every subsequent start so restarts still decrypt existing
 * credentials. It is the fallback key for the SRT passphrase crypto and the
 * HTML-auth crypto; `SRT_PASSPHRASE_KEY` / `HTML_AUTH_KEY` (env) still override it
 * when set, so self-hosted deployments are unchanged. RTMP stream keys keep their
 * dedicated `RTMP_CREDENTIALS_KEY` and NEVER fall back here (ADR-004 Decision 2).
 *
 * `encryptionSecret` is a credential: it is NEVER logged (the `secret` substring
 * is matched by `src/lib/log-redact.ts` and the Fastify logger redact paths in
 * `src/server.ts`) and NEVER returned by any route.
 */
export interface CredentialEncryptionKeyDoc {
  _id: string;              // fixed: "credential-encryption-key"
  _rev?: string;
  type: 'credential-encryption-key';
  /** Randomly generated 32-byte AES-256 key (base64). Never logged or returned. */
  encryptionSecret: string;
  createdAt: string;        // ISO 8601
}

/**
 * The backend-generated AES-256 RTMP stream-key encryption key (issue #447).
 *
 * This is the RTMP analogue of `CredentialEncryptionKeyDoc` (#438/#446), kept
 * DELIBERATELY SEPARATE: ADR-004 Resolved Decision 2 requires a dedicated
 * `RTMP_CREDENTIALS_KEY` with NO reuse of / fallback to the SRT/credential key,
 * so RTMP stream-key rotation stays isolated from SRT-passphrase / HTML-auth key
 * rotation. On OSC `RTMP_CREDENTIALS_KEY` is never provisioned, so saving an RTMP
 * stream key previously failed closed with a 503 and RTMP publishing was
 * unavailable on every OSC instance.
 *
 * Mirroring `CredentialEncryptionKeyDoc`, the backend now generates this key on
 * first start and stores it under its OWN single fixed id
 * (`RTMP_CREDENTIAL_KEY_DOC_ID`, distinct from
 * `CREDENTIAL_ENCRYPTION_KEY_DOC_ID`), reading it back on every subsequent start
 * so restarts still decrypt existing RTMP stream keys. It is the fallback key for
 * the RTMP stream-key crypto ONLY (`src/lib/rtmp-credentials-crypto.ts`);
 * `RTMP_CREDENTIALS_KEY` (env) still overrides it when set, so self-hosted
 * deployments are unchanged.
 *
 * `encryptionSecret` is a credential: it is NEVER logged (the `secret` substring
 * is matched by `src/lib/log-redact.ts` and the Fastify logger redact paths in
 * `src/server.ts`) and NEVER returned by any route.
 */
export interface RtmpCredentialKeyDoc {
  _id: string;              // fixed: "rtmp-credentials-key"
  _rev?: string;
  type: 'rtmp-credentials-key';
  /** Randomly generated 32-byte AES-256 key (base64). Never logged or returned. */
  encryptionSecret: string;
  createdAt: string;        // ISO 8601
}

// --------------- Storage connections (issue #520, OL-21) ---------------

/** Advisory least-privilege tag; NOT enforced by the backend in v1 (spec §2.1). */
export type StorageConnectionRole = 'clip' | 'recording' | 'both';

/**
 * A named, operator-managed object-storage connection (issue #520, OL-21,
 * `docs/specs/storage-connections.md`, ADR-009). Clip sources and recording
 * targets each OPTIONALLY choose a connection; absent means the implicit default
 * connection built from the `MINIO_*` / `S3_ENDPOINT` env, so existing
 * instances, `s3` references, and recordings keep working unchanged.
 *
 * A `StorageConnectionDoc` maps 1:1 onto a `MinioTarget`
 * (`src/lib/recording-uploader.ts`) once `secretKeyEnc` is decrypted and a bucket
 * is supplied, so the existing presign / putObject / list code paths are reused
 * with a per-connection target instead of `minioTargetFromConfig()`.
 *
 * The reserved id `"default"` is NEVER a stored document — it denotes the
 * env-derived connection, materialised on demand from `minioTargetFromConfig()`.
 *
 * `secretKeyEnc` is a credential: it is encrypted at rest (`encv1:` AES-256-GCM,
 * `src/lib/storage-connection-crypto.ts`), NEVER returned by any route (the API
 * exposes only `secretKeySet: boolean`), and NEVER logged (`secret` substring
 * redaction in `src/lib/log-redact.ts` and the Fastify logger redact paths).
 */
export interface StorageConnectionDoc {
  _id: string;              // "stconn-<uuid>"
  _rev?: string;
  type: 'storage-connection';
  name: string;
  endpoint: string;         // host[:port], scheme stripped (as MinioTarget.endpoint)
  useSsl: boolean;
  region: string;
  accessKey: string;        // access key id — not secret, stored/returned in clear
  secretKeyEnc: string;     // "encv1:<base64url(iv|tag|ciphertext)>" — NEVER plaintext, NEVER returned
  defaultBucket?: string;
  role: StorageConnectionRole;
  createdAt: string;        // ISO 8601
  updatedAt: string;        // ISO 8601
}

// --------------- Shared-GPU usage ledger (issue #500) ---------------

/**
 * A surviving snapshot of a deleted production's settled shared-GPU buckets
 * (issue #500).
 *
 * `gpuHours` normally lives ONLY on the owning `ProductionDoc`, so destroying a
 * production — a normal path, e.g. deleting it right after a show — would
 * permanently lose every retained closed-hour bucket AND the final partial hour,
 * making those billable hours unrecoverable. Before the production doc is
 * destroyed (`DELETE /api/v1/productions/:id`), its final partial hour is settled
 * (`settleOnStop`) and the resulting buckets are copied here as a ledger record
 * that OUTLIVES the production. The usage read path folds these records back in,
 * keyed by the SAME `production-<id>` resource, so `/api/v1/usage/gpu` and
 * `/metrics` keep reporting them until their buckets age past
 * `GPU_USAGE_RETENTION_HOURS` (pruned on read exactly like `ProductionDoc.gpuHours`).
 *
 * Kept under a deterministic id (`gpu-ledger-<productionId>`) so a re-delete (or a
 * delete after a settle wrote more buckets) upserts the same record rather than
 * duplicating it.
 */
export interface GpuUsageLedgerDoc {
  _id: string;              // "gpu-ledger-<productionId>"
  _rev?: string;
  type: 'gpu-usage-ledger';
  /** The deleted production's id — the usage read reuses its stable resource id. */
  productionId: string;
  /** Settled closed + final-partial UTC-hour buckets inherited from the production. */
  gpuHours: Record<string, number>;
  createdAt: string;        // ISO 8601
  updatedAt: string;        // ISO 8601
}

// --------------- Shared-GPU metering enablement marker ---------------

/**
 * Instance-wide record of when shared-GPU metering was first enabled on this
 * instance (issue #535, part of #526). Written once by `startGpuUsageSweep` under
 * a fixed id and never overwritten on later restarts. GPU accrual starts at
 * `max(activatedAt, enabledAt)`, so a production that was already live when
 * metering was switched on is never back-charged for the time before the switch.
 */
export interface GpuMeteringStateDoc {
  _id: string;              // fixed: "gpu-metering-state"
  _rev?: string;
  type: 'gpu-metering-state';
  /** First time metering was enabled on this instance — the accrual floor. */
  enabledAt: string;        // ISO 8601
}

// --------------- One-time data migration marker ---------------

/**
 * Marker for a completed one-time, instance-wide data migration. Each migration
 * has a fixed id (e.g. `audio-channel-order-v2`); the presence of its doc means
 * the migration has already run on this instance, so a later restart skips it.
 * Kept as a singleton-per-migration doc (mirroring the stored-key docs) rather
 * than a per-production flag so productions created AFTER the migration — which
 * are already in the new shape — are never re-migrated and corrupted.
 */
export interface MigrationStateDoc {
  _id: string;              // fixed per migration, e.g. "migration:audio-channel-order-v2"
  _rev?: string;
  type: 'migration-state';
  /** Stable migration identifier (same as the `_id` suffix). */
  migration: string;
  /** How many documents the migration actually changed (diagnostics only). */
  migratedCount: number;
  completedAt: string;      // ISO 8601
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

/**
 * Why a source's selected audio stream (`SourceDoc.audioStreamIndex`) was not
 * applied at activation (spec docs/specs/audio-stream-selection.md §5.4,
 * ADR-010 Decision 4). The input is always built on the first stream instead.
 */
export type AudioStreamNotAppliedReason =
  | 'stream-type-unsupported'
  | 'strom-capability-missing'
  | 'stream-not-present';

/**
 * A problem found while going on air that did not stop activation. Persisted as
 * `ProductionDoc.activationWarnings`, returned on the production resource and
 * replayed as WS `ERROR` frames on controller connect (spec §2.5).
 */
export type ActivationWarning =
  | { type: 'recording-no-audio'; message: string }
  | {
      type: 'audio-stream-not-applied';
      /** SourceDoc._id */
      sourceId: string;
      /** Stored assignment key (e.g. 'video_in_3'), not the compacted Strom pad. */
      mixerInput: string;
      /** Effective SourceDoc.audioStreamIndex (> 0), 0-based. */
      requestedIndex: number;
      /** v1 always clamps to the first stream. */
      appliedIndex: 0;
      reason: AudioStreamNotAppliedReason;
      /** Human text (1-based stream numbers), also used for the WS ERROR toast. */
      message: string;
    };

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
  /**
   * Upload target of the running recording, snapshotted at activation next to
   * {@link recorderBlockId} (issue #534). Deactivate uploads to this target
   * instead of re-reading the production's current output assignments, so
   * removing or re-pointing the recording output on a live production cannot
   * change where the running recording goes or drop its upload. Cleared on
   * deactivate.
   */
  recording?: ActiveRecording;
  /**
   * Outcome of the most recent deactivate that had a recording to upload (issue
   * #534). Kept until the next such deactivate replaces it. Never holds secrets
   * or presigned URLs.
   */
  lastRecordingUpload?: RecordingUploadSummary;
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
  /**
   * Per-production stamp for the issue #487 audio-channel-order migration. Set in
   * the SAME write that renumbers this doc's `ch{N}_aux{M}_pre` keys, so a
   * partial-failure retry of the one-time migration skips already-migrated docs
   * and never double-applies the (bijective) channel remap — which would corrupt
   * operator pre/post routing. Absent on docs the migration has not touched (and
   * on productions created after the migration, which are already numbered
   * correctly and are never scanned, being created after the instance marker).
   * See `services/migrate-audio-channel-order.ts`.
   */
  audioChannelOrderV2?: boolean;
  /** Scheduled on-air start time — ISO 8601 UTC string (e.g. "2026-05-01T18:30:00.000Z") */
  airTime?: string;
  pipeline: Pipeline;
  graphics: GraphicOverlay[];
  macros: Macro[];
  tally: Tally;
  mixerBlockId?: string;
  audioMixerBlockId?: string;
  /**
   * Persisted audio processing state (issue #527, OL-25) — per-channel gain,
   * HPF, gate, compressor, EQ and the main-bus compressor, EQ and limiter.
   * Keyed by elementId ('ch1' | 'main'), then by stage; only stages an operator
   * has actually set are present. Set via the WS `AUDIO_PROC_SET` handler and
   * the REST processing route; survives deactivate/reactivate and is re-applied
   * through the flow generator at build time (including the construction-time
   * `chN_hpf_enabled`). DELIBERATELY NOT cleared on deactivate and NOT touched
   * by the connect-time mixer reset. See {@link AudioProcessingStore}.
   */
  audioProcessing?: import('../lib/audio-processing.js').AudioProcessingStore;
  /** ID of the builtin.loudness block on the main audio bus — set on activate, cleared on deactivate */
  loudnessMainBlockId?: string;
  /** Maps mixerInput (e.g. 'video_in_1') → time_offset block ID — set on activate, cleared on deactivate */
  sourceOffsetBlockIds?: Record<string, string>;
  /** Maps mixerInput → audio time_offset block ID — set on activate, cleared on deactivate */
  sourceAudioOffsetBlockIds?: Record<string, string>;
  /** Maps mixerInput → media-player (builtin.media_player) block ID for clip sources — set on activate, cleared on deactivate */
  clipPlayerBlockIds?: Record<string, string>;
  /**
   * Maps a stored `mixerInput` (e.g. 'video_in_15') to the COMPACT vision-mixer
   * pad index actually wired in the live Strom flow (issue #463) — set on
   * activate, cleared on deactivate. Studio allocates guest slots from the top of
   * the mixer-input range down, so the mixer is sized to what the production uses
   * and the sparse stored pads are compacted to 0..N-1. The stored `mixerInput`
   * stays the external identity; the WS layer applies this map only at the Strom
   * boundary (switch/PiP/effect) and inverts it for Strom state read-backs.
   * Absent / identity for contiguous-from-0 productions.
   */
  mixerInputMap?: Record<string, number>;
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
  /**
   * Problems found while going on air that did not stop activation, such as a
   * recording that will have no sound. Cleared on next activation.
   */
  activationWarnings?: ActivationWarning[];
  /** Set when the idle watchdog auto-deactivated this production; cleared on next activation */
  autoDeactivated?: boolean;
  /**
   * Why this production reached `status: 'ended'` (issue #255). Optional,
   * defaulted-absent; disambiguates the `ended` transition (explicit deactivate
   * vs. idle auto-deactivate vs. reconcile losing the flow) without a separate
   * status value. Cleared on next activation.
   */
  endedReason?: EndedReason;
  /**
   * Shared-GPU usage accrual (issue #500, `docs/specs/shared-gpu-usage-metering.md`,
   * ADR-005). Both fields are additive, optional and defaulted-absent — existing
   * docs read as "never accrued", so there is no migration.
   *
   * `activatedAt` is the **recorded start** of the current GPU allocation: the
   * ISO 8601 UTC time the production's Strom flow reached `playing`. It is set in
   * the SAME write that sets `status: 'active'` (`routes/productions.ts`) and
   * cleared on every stop path (deactivate, idle auto-deactivate, activation
   * failure, reconcile losing the flow). A production found still live after a
   * restart keeps its `activatedAt`, so accrual resumes from the recorded start,
   * not from zero.
   *
   * These are INTERNAL accrual state: they are projected only via
   * `/api/v1/usage/gpu` and `/metrics`, and are stripped from the production
   * GET/list/PATCH responses (`toProductionView`) so they never bloat or confuse
   * existing clients (repo-patterns.md §"toApi() spreads the whole doc").
   */
  activatedAt?: string;
  /**
   * Closed, settled GPU-second buckets for this production, keyed by UTC hour
   * `"YYYY-MM-DDTHH:00:00Z"`. Append-only and immutable once written: the settle
   * sweep writes a key exactly once, when its hour has fully elapsed (and every
   * stop path settles the final partial hour). The current partial hour of a
   * live production is NEVER stored here — it is derived on read from
   * `activatedAt` — so there are no read-modify-write races on a live counter.
   * Pruned to `GPU_USAGE_RETENTION_HOURS` on settle. See {@link activatedAt}.
   */
  gpuHours?: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}
