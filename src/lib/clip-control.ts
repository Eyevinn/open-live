/**
 * Shared clip cue/play/stop/pause/seek control logic (epic #206, issues #277/#278).
 *
 * This module is the single coupling point between the REST clip endpoints
 * (#277, `src/routes/clips.ts`) and the WebSocket CLIP_* commands (#278,
 * `src/ws/controller.ts`). It:
 *
 *   - resolves a production doc + mixerInput to a running Strom flow id and the
 *     media-player block id persisted on activate
 *     (`ProductionDoc.clipPlayerBlockIds[mixerInput]`),
 *   - resolves the clip source's typed `ClipReference` (serialized in
 *     `SourceDoc.address`) to a playable playlist file string,
 *   - drives the Strom media-player block (setPlaylist/goto/control/seek), and
 *   - maps Strom's `PlayerStateResponse` to the camelCased `ClipState` contract.
 *
 * The cue → play → completed state machine and the `durationMs`/`positionMs`
 * semantics are defined independently of the `ClipReference` type
 * (spec §"Reference-type independence"): once cued, play/pause/stop/seek and
 * completion behave identically regardless of the byte source.
 *
 * Error surface (typed so callers can map to HTTP / WS error frames):
 *   - {@link ClipNotFoundError}     → 404 (no clip source / player block for this input)
 *   - {@link ClipNotActivatedError} → 409 (production not activated)
 *   - {@link ClipNotCuedError}      → 409 (play requested with nothing cued)
 *   - {@link ClipMediaError}        → 502 (clip URL unreachable, or media never
 *     loaded — issue #351)
 *   - `ClipReferenceNotImplementedError` (from clip-reference.ts) → 501 (tams)
 *   - `StromClientError` propagates (callers map status 0 → 503, else 502)
 */

import { createHash, createHmac } from 'crypto';
import type { StromClient, PlayerStateResponse } from './strom.js';
import type { ClipReference, ClipState, ProductionDoc, SourceDoc } from '../db/types.js';
import { deserializeClipReference } from './clip-reference.js';
import { minioTargetFromConfig, type MinioTarget } from './recording-uploader.js';
import { config } from '../config.js';
import { markClipPlayPending } from '../services/clip-state.service.js';

/** Strom reports/accepts media-player position and duration in nanoseconds. */
const NS_PER_MS = 1_000_000;

/** Thrown when the production has no clip source / player block for a mixer input (→ 404). */
export class ClipNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message = 'Clip source not found') {
    super(message);
    this.name = 'ClipNotFoundError';
  }
}

/** Thrown when the production is not activated so no flow/player block exists (→ 409). */
export class ClipNotActivatedError extends Error {
  readonly statusCode = 409;
  constructor(message = 'Production is not activated') {
    super(message);
    this.name = 'ClipNotActivatedError';
  }
}

/** Thrown when `play` is requested but no clip has been cued (→ 409). */
export class ClipNotCuedError extends Error {
  readonly statusCode = 409;
  constructor(message = 'No clip cued') {
    super(message);
    this.name = 'ClipNotCuedError';
  }
}

/**
 * Thrown when a clip's media cannot be fetched or loaded (→ 502; issue #351).
 * Covers both the pre-cue reachability preflight (unfetchable URL — HTTP
 * error, DNS failure, refused connection, timeout) and the post-cue readiness
 * check (URL was reachable but Strom never reported a loaded duration). Either
 * way, without this the operator saw an indefinite `cued`/`playing` at
 * 0:00/0:00 with no error surfaced (the reported bug).
 */
export class ClipMediaError extends Error {
  readonly statusCode = 502;
  constructor(message: string) {
    super(message);
    this.name = 'ClipMediaError';
  }
}

/**
 * Resolves the running Strom flow id + media-player block id for a clip source
 * assigned to `mixerInput`, or throws a typed error:
 *   - ClipNotActivatedError (409) when the production has no running flow.
 *   - ClipNotFoundError (404) when no player block is registered for the input
 *     (i.e. no clip source assigned there).
 */
export function resolveClipTarget(
  doc: ProductionDoc,
  mixerInput: string,
): { flowId: string; blockId: string } {
  const blockId = doc.clipPlayerBlockIds?.[mixerInput];
  // A clip source with no player block only ever happens when the production is
  // not activated (blocks are set on activate) — treat the missing-flow case as
  // "not activated" (409) and a running flow with no block for this input as
  // "clip source not found" (404).
  if (!doc.stromFlowId) {
    // If there IS a clip source assigned but the flow is down, that's a 409.
    // If there's simply no clip source for this input, that's a 404 regardless.
    if (blockId) throw new ClipNotActivatedError();
    throw new ClipNotFoundError();
  }
  if (!blockId) throw new ClipNotFoundError();
  return { flowId: doc.stromFlowId, blockId };
}

/** Builds a SigV4-presigned GET URL for an S3/MinIO object (dependency-free). */
function presignS3Get(target: MinioTarget, key: string, expiresS: number, now: Date = new Date()): string {
  const scheme = target.useSsl ? 'https' : 'http';
  const host = target.endpoint;
  const canonicalUri = `/${encodeURI(target.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${target.region}/s3/aws4_request`;
  const signedHeaders = 'host';

  const query = new URLSearchParams({
    'X-Amz-Algorithm': algorithm,
    'X-Amz-Credential': `${target.accessKey}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresS),
    'X-Amz-SignedHeaders': signedHeaders,
  });
  const canonicalQuery = query.toString();

  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const sha256Hex = (data: string) => createHash('sha256').update(data).digest('hex');
  const stringToSign = [algorithm, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();
  const kDate = hmac(`AWS4${target.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, target.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `${scheme}://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * Resolves a clip source's typed {@link ClipReference} (serialized in
 * `SourceDoc.address`) to a single playable playlist-file string for Strom's
 * `player.setPlaylist({ files })`.
 *
 *   - `url` → the URL as-is (already SSRF-validated by deserializeClipReference).
 *   - `s3`  → a SigV4-presigned GET URL against the configured object store.
 *   - `tams`→ rejected (501) by deserializeClipReference/validateClipReference.
 *
 * Reference resolution is confined to `cue`; downstream play/pause/stop/seek and
 * the state machine never see the reference type (spec invariant).
 */
export function resolveClipFile(source: SourceDoc): string {
  const ref: ClipReference = deserializeClipReference(source.address);
  switch (ref.type) {
    case 'url':
      return ref.url;
    case 's3': {
      const target = minioTargetFromConfig();
      if (!target) {
        throw new ClipNotFoundError('Object storage is not configured — cannot resolve s3 clip reference');
      }
      return presignS3Get(target, ref.key, config.recordingPresignTtlS);
    }
    case 'tams':
      // deserializeClipReference already throws ClipReferenceNotImplementedError,
      // but keep the exhaustive guard so a schema change surfaces here.
      throw new Error('Clip reference type "tams" is reserved and not implemented in v1');
    default: {
      const _never: never = ref;
      throw new Error(`Unknown clip reference type: ${JSON.stringify(_never)}`);
    }
  }
}

/** Poll cadence (ms) for {@link waitForClipReady}'s post-cue duration wait. */
const CUE_READY_POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Preflight-checks that a clip's resolved URL is actually fetchable before
 * committing it to Strom (issue #351). `setPlaylist`/`goto` accept the load
 * optimistically — Strom fetches the file asynchronously inside its own
 * pipeline — so without this check an unfetchable URL (HTTP 403, DNS
 * failure, connection refused, …) silently cues the operator into a clip
 * that will never load.
 *
 * Issues a `HEAD` request first; an origin that rejects `HEAD` (405/501 —
 * some presigned-URL / CDN configurations) falls back to a ranged GET of the
 * first byte so this never downloads the whole file just to check
 * reachability. Operates on `url` as already resolved by {@link resolveClipFile}
 * — for a `url` reference this is SSRF-validated by `deserializeClipReference`
 * (`httpUrlOnly`) before it ever reaches here; for `s3` it is a presigned URL
 * against the configured object store. This performs no additional host
 * validation of its own, only a liveness check of the already-approved URL.
 */
async function preflightClipUrl(url: string, timeoutMs: number): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ClipMediaError(`Clip URL could not be reached: ${reason}`);
  }
  if (!res.ok) {
    throw new ClipMediaError(`Clip URL returned HTTP ${res.status}`);
  }
}

/**
 * Polls `player.getState` until Strom reports a non-zero `duration_ns` — the
 * only reliable "media actually loaded" signal, since `MediaPlayerState::
 * state()` reports a ready/playing state regardless (issue #351's root
 * cause) — or `timeoutMs` elapses, in which case the cue is failed rather
 * than left reporting `cued` for media that never loaded.
 */
async function waitForClipReady(
  strom: StromClient,
  flowId: string,
  blockId: string,
  timeoutMs: number,
): Promise<PlayerStateResponse> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const player = await strom.player.getState(flowId, blockId);
    if (player.duration_ns) return player;
    if (Date.now() >= deadline) {
      throw new ClipMediaError('Clip media could not be loaded');
    }
    await sleep(CUE_READY_POLL_INTERVAL_MS);
  }
}

/**
 * Maps Strom's `PlayerStateResponse` to the camelCased `ClipState` contract.
 *
 * `justCued` is set right after a cue (setPlaylist + goto) — Strom reports a
 * ready playlist as `stopped`/`paused`, but the clip-control contract calls this
 * transient ready state `cued`. `completed` is decided by the caller (poll
 * fallback in #278); this mapper only translates the raw player state.
 */
export function mapPlayerState(
  mixerInput: string,
  player: PlayerStateResponse,
  opts: { clipId?: string; justCued?: boolean } = {},
): ClipState {
  let state: ClipState['state'];
  if (opts.justCued) {
    state = 'cued';
  } else if (player.state === 'playing') {
    state = 'playing';
  } else if (player.state === 'paused') {
    state = 'paused';
  } else {
    // 'stopped' — either never started, or stopped after play.
    state = 'stopped';
  }
  return {
    mixerInput,
    state,
    ...(opts.clipId !== undefined ? { clipId: opts.clipId } : {}),
    // Strom reports position/duration in nanoseconds; the ClipState contract is ms.
    ...(player.position_ns !== undefined ? { positionMs: Math.round(player.position_ns / NS_PER_MS) } : {}),
    ...(player.duration_ns !== undefined ? { durationMs: Math.round(player.duration_ns / NS_PER_MS) } : {}),
  };
}

/**
 * Cue a clip into the ready state: load the playlist and seek to the first
 * entry, leaving the player parked at its first frame (spec §"State machine":
 * cue = setPlaylist({files:[clip]}) + goto({index:0}) + leave paused/ready).
 *
 * Strom's `setPlaylist`/`goto` both START playback (goto → `load_current_file`
 * sets the pipeline Playing; setPlaylist auto-`goto(0)` from Stopped), so Cue
 * would run the clip instead of parking it (issue #350). Strom has no
 * "load paused" mode, so we explicitly `control({action:'stop'})` afterwards —
 * in Strom `stop` is pause + seek 0, i.e. exactly "parked at the first frame".
 * This also fixes the restore path (`controller.ts` re-cues a persisted cue).
 *
 * The clip source is resolved from the production's source assignments for this
 * mixer input; `clipId`, when supplied, must match the assigned source id.
 *
 * Before touching Strom, the resolved URL is preflight-checked for
 * reachability, and after `setPlaylist`/`goto`/the parking `stop` the cue
 * blocks until Strom confirms a loaded duration (or fails) — see
 * {@link preflightClipUrl} / {@link waitForClipReady} (issue #351). This means
 * `cueClip` throws {@link ClipMediaError} instead of ever reporting `cued` for
 * a clip whose media cannot be fetched or loaded.
 */
export async function cueClip(
  strom: StromClient,
  doc: ProductionDoc,
  source: SourceDoc,
  mixerInput: string,
  clipId?: string,
): Promise<ClipState> {
  const { flowId, blockId } = resolveClipTarget(doc, mixerInput);
  const file = resolveClipFile(source);
  await preflightClipUrl(file, config.clipPreflightTimeoutMs);
  await strom.player.setPlaylist(flowId, blockId, { files: [file] });
  await strom.player.goto(flowId, blockId, { index: 0 });
  // Park at frame 0: Strom's stop = pause + seek 0 (issue #350).
  await strom.player.control(flowId, blockId, { action: 'stop' });
  const player = await waitForClipReady(strom, flowId, blockId, config.clipCueReadyTimeoutMs);
  return mapPlayerState(mixerInput, player, { clipId: clipId ?? source._id, justCued: true });
}

/** Play the currently cued clip (player.control({action:'play'})). */
export async function playClip(strom: StromClient, doc: ProductionDoc, mixerInput: string, clipId?: string): Promise<ClipState> {
  const { flowId, blockId } = resolveClipTarget(doc, mixerInput);
  // Tell the reactive relay that the imminent Strom `playing` push is a real
  // Play (not the goto-induced edge on a still-`cued` clip) so it is not
  // suppressed by the cued-clip guard (issue #350).
  markClipPlayPending(doc._id, mixerInput);
  await strom.player.control(flowId, blockId, { action: 'play' });
  const player = await strom.player.getState(flowId, blockId);
  return mapPlayerState(mixerInput, player, { clipId });
}

/** Pause the currently playing clip (player.control({action:'pause'})). */
export async function pauseClip(strom: StromClient, doc: ProductionDoc, mixerInput: string, clipId?: string): Promise<ClipState> {
  const { flowId, blockId } = resolveClipTarget(doc, mixerInput);
  await strom.player.control(flowId, blockId, { action: 'pause' });
  const player = await strom.player.getState(flowId, blockId);
  return mapPlayerState(mixerInput, player, { clipId });
}

/** Stop the clip (player.control({action:'stop'})). */
export async function stopClip(strom: StromClient, doc: ProductionDoc, mixerInput: string, clipId?: string): Promise<ClipState> {
  const { flowId, blockId } = resolveClipTarget(doc, mixerInput);
  await strom.player.control(flowId, blockId, { action: 'stop' });
  const player = await strom.player.getState(flowId, blockId);
  return mapPlayerState(mixerInput, player, { clipId });
}

/** Seek within the clip (player.seek({position_ns}); Strom expects nanoseconds). */
export async function seekClip(strom: StromClient, doc: ProductionDoc, mixerInput: string, positionMs: number, clipId?: string): Promise<ClipState> {
  const { flowId, blockId } = resolveClipTarget(doc, mixerInput);
  await strom.player.seek(flowId, blockId, { position_ns: positionMs * NS_PER_MS });
  const player = await strom.player.getState(flowId, blockId);
  return mapPlayerState(mixerInput, player, { clipId });
}

/** Read the current player state and map it to a ClipState (no side effects). */
export async function getClipState(strom: StromClient, doc: ProductionDoc, mixerInput: string, clipId?: string): Promise<ClipState> {
  const { flowId, blockId } = resolveClipTarget(doc, mixerInput);
  const player = await strom.player.getState(flowId, blockId);
  return mapPlayerState(mixerInput, player, { clipId });
}

/** Finds the clip SourceDoc assigned to a mixer input, given a source loader. */
export async function resolveClipSource(
  doc: ProductionDoc,
  mixerInput: string,
  loadSource: (sourceId: string) => Promise<SourceDoc>,
): Promise<SourceDoc> {
  const assignment = (doc.sources ?? []).find((s) => s.mixerInput === mixerInput);
  if (!assignment) throw new ClipNotFoundError();
  let source: SourceDoc;
  try {
    source = await loadSource(assignment.sourceId);
  } catch {
    throw new ClipNotFoundError();
  }
  if (source.streamType !== 'clip') throw new ClipNotFoundError('Source is not a clip source');
  return source;
}
