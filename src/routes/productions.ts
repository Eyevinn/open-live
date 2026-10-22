import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb, getOutputsDb, getRecordingsDb } from '../db/index.js';
import { sweepGuestsOnProductionEnd } from '../services/guest-sweep.js';
import type { ProductionDoc, ProductionSourceAssignment, ProductionGraphicAssignment, ProductionOutputAssignment, OutputDoc, RecordingDoc, ActiveRecording, RecordingUploadSummary } from '../db/types.js';
import { StromClient, StromClientError } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { stromBrowserBaseUrl } from '../lib/strom-public-url.js';
import { activateStromFlow, deactivateStromFlow } from '../lib/flow-generator.js';
import { expandToStoredPadIndex } from '../lib/mixer-input-map.js';
import { setTally, broadcast, getSubscriberCount, getWatcherCount } from '../services/tally.service.js';
import { clearProductionPflState } from '../services/pfl-state.js';
import { clearPipState, clearAudioState, clearFxState, clearClipStateForProduction, reinitConnectedControllers } from '../ws/controller.js';
import { forceStopMeterRelay } from '../services/meter-relay.js';
import { forceStopClipRelay } from '../services/clip-relay.js';
import { config } from '../config.js';
import { uploadRecordings } from '../lib/recording-uploader.js';
import { parsePartName, recordingPartTimings } from '../lib/recording-parts.js';
import { upsertRecordingDoc } from '../lib/recording-registry.js';
import { resolveRecordingUploadTarget } from '../lib/recording-upload-target.js';
import { startLiveRecordingUpload, stopLiveRecordingUpload, type LiveRecordingSession } from '../services/live-recording-upload.js';
import { isIntercomEnabled, teardownIntercomProduction } from '../lib/intercom-manager.js';
import { getIdleSince, getIdleExpiresAt, notifyProductionActivated, notifyProductionDeactivated } from '../services/idle-watchdog.js';
import { buildProductionStatusEvent, deriveOutputSnapshot, stoppedStatus, type OutputStatusEntry } from '../lib/production-health.js';
import { settleOnStop, preserveGpuUsageOnDelete } from '../services/gpu-usage.js';
import { checkProductionStartAllowed } from '../services/production-gate.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLOW_POLL_INTERVAL_MS = 500;
const FLOW_POLL_TIMEOUT_MS = 30_000;
const MAX_DB_WRITE_RETRIES = 3;

// ---------------------------------------------------------------------------
// AbortController map — keyed by production ID, allows deactivate to cancel
// an in-progress activation polling loop.
// ---------------------------------------------------------------------------

const activationAbortControllers = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Error thrown when the WHIP callback base URL cannot be safely resolved from
 * an incoming request (e.g. an untrusted X-Forwarded-Host was supplied and
 * neither PUBLIC_BASE_URL nor a TRUSTED_HOSTS allow-list vouches for it).
 * Carries statusCode 400 so Fastify's error handler surfaces it as a client
 * error rather than a 500.
 */
export class UntrustedHostError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'UntrustedHostError';
  }
}

/**
 * Resolve the public base URL used to build WHIP callback URLs that get
 * persisted in CouchDB.
 *
 * Security (#50): the previous implementation read the raw X-Forwarded-Proto /
 * X-Forwarded-Host headers, bypassing Fastify's trustProxy mechanism and
 * letting any client inject `X-Forwarded-Host: attacker.com` to persist an
 * attacker-controlled WHIP callback endpoint.
 *
 * Resolution order:
 *   1. If PUBLIC_BASE_URL is configured, always use it (never trust the request).
 *   2. Otherwise derive proto/host from `req.protocol` / `req.host`, which
 *      honour X-Forwarded-* only for trusted proxies (Fastify trustProxy).
 *      - If a TRUSTED_HOSTS allow-list is configured, the derived host must be
 *        on it, else the request is rejected (UntrustedHostError → 400).
 *      - If no allow-list is configured, only loopback/localhost hosts are
 *        accepted; any other (proxy-forwarded) host is rejected so an attacker
 *        cannot persist an arbitrary host. This keeps local dev working while
 *        refusing to trust an unvalidated forwarded host in a proxied setup.
 *
 * Note: this reads `req.host` rather than `req.hostname`. Under Fastify 5,
 * `req.hostname` strips the port (e.g. `localhost:3100` → `localhost`), which
 * silently drops the port from every URL built here whenever the service runs
 * on a non-default port without PUBLIC_BASE_URL set. `req.host` retains the
 * port and is validated identically — it goes through the same trustProxy
 * resolution as `req.hostname` (Fastify derives `hostname` from `host`
 * internally), and the hostname-only part is still extracted below for the
 * loopback / TRUSTED_HOSTS check.
 */
export function resolvePublicBaseUrl(
  req: { protocol?: string; host?: string },
  cfg: { publicBaseUrl?: string; trustedHosts: readonly string[] } = config,
): string {
  if (cfg.publicBaseUrl) return cfg.publicBaseUrl;

  const proto = req.protocol ?? 'https';
  // req.host respects trustProxy the same way req.hostname does (it reflects
  // X-Forwarded-Host only when the connecting peer is a trusted proxy), but
  // unlike req.hostname it keeps the port. It still cannot vouch for *which*
  // host is legitimate, so we validate the hostname part below.
  const host = (req.host ?? '').toLowerCase();
  if (!host) {
    throw new UntrustedHostError(
      'Cannot determine request host to build the WHIP callback URL. ' +
      'Set PUBLIC_BASE_URL to the externally reachable URL of this service.',
    );
  }

  const hostname = host.split(':')[0]!;
  const isLoopback =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]';

  if (cfg.trustedHosts.length > 0) {
    if (!cfg.trustedHosts.includes(hostname)) {
      throw new UntrustedHostError(
        `Request host "${hostname}" is not in the TRUSTED_HOSTS allow-list. ` +
        'Set PUBLIC_BASE_URL or add the host to TRUSTED_HOSTS to build WHIP callback URLs.',
      );
    }
  } else if (!isLoopback) {
    // No allow-list and a non-loopback (proxy-forwarded) host: refuse to persist
    // it, since we have no way to distinguish a legitimate host from an injected one.
    throw new UntrustedHostError(
      `Refusing to build a WHIP callback URL from untrusted host "${hostname}". ` +
      'Set PUBLIC_BASE_URL to the externally reachable URL of this service, ' +
      'or list allowed hosts in TRUSTED_HOSTS.',
    );
  }

  return `${proto}://${host}`;
}

/** CouchDB answers a stale `_rev` with 409. */
function isConflict(err: unknown): boolean {
  return err instanceof Error && 'statusCode' in err && (err as { statusCode?: number }).statusCode === 409;
}

/**
 * Write a partial update to ProductionDoc with retry-on-409.
 * Re-reads the document before each retry to get the latest _rev.
 */
export async function updateProductionDoc(
  productionId: string,
  patch: Partial<ProductionDoc>,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_DB_WRITE_RETRIES; attempt++) {
    try {
      const doc = await getDb().get(productionId);
      const updated: ProductionDoc = {
        ...doc,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      await getDb().insert(updated);
      return;
    } catch (err) {
      // CouchDB 409 = revision conflict — retry after re-read
      if (isConflict(err) && attempt < MAX_DB_WRITE_RETRIES - 1) continue;
      throw err;
    }
  }
}

/**
 * Project a production doc for an API response, stripping the internal
 * shared-GPU accrual state (`activatedAt`, `gpuHours`, issue #500). Those fields
 * are surfaced ONLY via `/api/v1/usage/gpu` + `/metrics`; leaking them through
 * the production GET/list/PATCH responses would bloat payloads (up to
 * `GPU_USAGE_RETENTION_HOURS` bucket keys) and confuse existing clients — the
 * same `...doc` over-spread hazard called out in repo-patterns.md §"toApi()
 * spreads the whole doc". Callers add their own derived fields after.
 */
export function toProductionView<T extends ProductionDoc>(doc: T): Omit<T, 'activatedAt' | 'gpuHours'> {
  const { activatedAt: _activatedAt, gpuHours: _gpuHours, ...rest } = doc;
  return rest;
}

export interface DeactivateResult {
  id: string;
  name: string;
  status: ProductionDoc['status'];
  _rev: string;
}

/** Deactivations currently running, keyed by production ID. */
const inFlightDeactivations = new Map<string, Promise<DeactivateResult>>();

/**
 * `doc` with every live-session field cleared. Unless `stopped` carries the
 * status another stop path already recorded, the transition rule (spec §1)
 * applies: a production that was `active` (reached a live broadcast) becomes
 * `ended`; one that never reached `active` (still `activating`) becomes
 * `inactive`.
 */
function deactivatedDoc(
  doc: ProductionDoc,
  stopped?: Pick<ProductionDoc, 'status' | 'endedReason'>,
  lastRecordingUpload?: RecordingUploadSummary,
): ProductionDoc {
  const status = stopped?.status ?? stoppedStatus(doc.status);
  // Settle shared-GPU usage up to now (including the final partial hour) and
  // clear the accrual start before the flow fields are wiped (issue #500). The
  // settle is a no-op when metering is off or the production never accrued.
  const settledGpuHours = settleOnStop(doc);
  return {
    ...doc,
    status,
    endedReason: stopped ? stopped.endedReason : status === 'ended' ? 'deactivated' : undefined,
    activatedAt: undefined,
    ...(settledGpuHours ? { gpuHours: settledGpuHours } : {}),
    stromFlowId: undefined,
    mixerBlockId: undefined,
    audioMixerBlockId: undefined,
    loudnessMainBlockId: undefined,
    recorderBlockId: undefined,
    recording: undefined,
    // Replaced only by a deactivate that had a recording to upload (issue #534).
    ...(lastRecordingUpload ? { lastRecordingUpload } : {}),
    sourceOffsetBlockIds: undefined,
    sourceAudioOffsetBlockIds: undefined,
    clipPlayerBlockIds: undefined,
    mixerInputMap: undefined,
    whepEndpoint: undefined,
    pgmWhepEndpoint: undefined,
    whipEndpoints: undefined,
    srtOutputUri: undefined,
    whepOutputUrls: undefined,
    returnBuses: undefined,
    returnWhepUrls: undefined,
    intercomProductionId: undefined,
    tally: { pgm: null, pvw: null },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Persist the end of a deactivation whose teardown has already run against
 * `doc`. On a revision conflict the doc is re-read, and the write is retried
 * only if the stored doc still names no Strom flow or intercom grouping other
 * than the ones this run tore down:
 *  - same status: an unrelated field changed (a tally write, a rename), so the
 *    deactivation is re-applied on top of it;
 *  - `inactive`/`ended` with no flow: another stop path (the idle watchdog,
 *    another backend instance) got there first. Its status is kept and the
 *    refs it left behind are cleared.
 * Anything else (a new activation, a guest's new intercom grouping) rethrows
 * the conflict rather than dropping a resource this run did not tear down.
 */
async function writeDeactivatedDoc(
  doc: ProductionDoc,
  log: FastifyBaseLogger,
  lastRecordingUpload?: RecordingUploadSummary,
): Promise<{ doc: ProductionDoc; rev: string }> {
  let updated = deactivatedDoc(doc, undefined, lastRecordingUpload);
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await getDb().insert(updated);
      return { doc: updated, rev: response.rev };
    } catch (err) {
      if (!isConflict(err) || attempt >= MAX_DB_WRITE_RETRIES - 1) throw err;
      const current = await getDb().get(doc._id);
      const tornDown =
        (current.stromFlowId === undefined || current.stromFlowId === doc.stromFlowId) &&
        (current.intercomProductionId === undefined || current.intercomProductionId === doc.intercomProductionId);
      if (!tornDown) throw err;
      if (current.status === doc.status && current.stromFlowId === doc.stromFlowId) {
        updated = deactivatedDoc(current, undefined, lastRecordingUpload);
      } else if ((current.status === 'inactive' || current.status === 'ended') && !current.stromFlowId) {
        log.info({ productionId: doc._id, status: current.status }, 'Production already stopped by another writer — keeping its status');
        updated = deactivatedDoc(current, current, lastRecordingUpload);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Returns the id of the first `recording` output assigned to a production, if
 * any — used to stamp `RecordingDoc.outputId` at deactivate. Best-effort: a DB
 * read failure returns undefined rather than blocking teardown, since the field
 * is optional.
 */
async function firstRecordingOutput(
  doc: ProductionDoc,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<OutputDoc | undefined> {
  const assignedIds = (doc.outputAssignments ?? []).map((a) => a.outputId);
  if (assignedIds.length === 0) return undefined;
  for (const outputId of assignedIds) {
    try {
      const output = await getOutputsDb().get(outputId);
      if (output.outputType === 'recording') return output;
    } catch (err) {
      log.warn({ err, outputId }, 'could not resolve output while stamping RecordingDoc');
    }
  }
  return undefined;
}

/**
 * Uploads the recordings of the activation being torn down and summarises the
 * outcome for `ProductionDoc.lastRecordingUpload` (issue #534). Never throws.
 *
 * The target is the activation-time snapshot (`doc.recording`), so changing the
 * production's output assignments while it is live cannot change or drop the
 * upload. A production activated before the snapshot existed falls back to its
 * current assignments, as before.
 */
async function uploadProductionRecording(
  doc: ProductionDoc,
  stromFlowId: string,
  recorderBlockId: string,
  strom: StromClient,
  stromToken: string | undefined,
  log: FastifyBaseLogger,
  liveSession?: LiveRecordingSession,
): Promise<RecordingUploadSummary> {
  let outputId: string | undefined;
  let connectionId: string | undefined;
  if (doc.recording) {
    ({ outputId, connectionId } = doc.recording);
  } else {
    const output = await firstRecordingOutput(doc, log);
    outputId = output?._id;
    connectionId = output?.connectionId;
  }
  const summarise = (fields: Partial<RecordingUploadSummary>): RecordingUploadSummary => ({
    finishedAt: new Date().toISOString(),
    ...(outputId ? { outputId } : {}),
    ...(connectionId ? { connectionId } : {}),
    uploaded: 0,
    failed: [],
    ...fields,
  });

  const nothingUploaded = (reason: RecordingUploadSummary['reason'], message: string): RecordingUploadSummary => {
    log.warn({ productionId: doc._id, reason }, `VOD recording not uploaded — ${message}`);
    return summarise({ reason, message: `${message} The recording stays on Strom.` });
  };

  // Resolve the target. Absent (or "default") connectionId = the env default (MINIO_*).
  const resolved = await resolveRecordingUploadTarget(connectionId);
  if ('reason' in resolved) {
    if (resolved.err !== undefined) {
      log.error({ err: resolved.err, productionId: doc._id }, 'could not resolve storage target for recording upload');
    }
    return nothingUploaded(resolved.reason, resolved.message);
  }
  const { target } = resolved;

  let uploadRes: Awaited<ReturnType<typeof uploadRecordings>>;
  try {
    await strom.recorder.splitNow(stromFlowId, recorderBlockId).catch(() => undefined);
    uploadRes = await uploadRecordings({
      strom,
      stromUrl: config.stromUrl,
      stromToken,
      outputDir: `recordings/${doc._id}`,
      productionId: doc._id,
      target,
      // Guard (issue #366): re-check the production doc immediately before
      // uploadRecordings' delete-after-upload pass. Nothing else in the
      // deactivate handler writes to the production doc before its own final
      // status update, which runs after this — so `doc._rev` cannot
      // legitimately change between the read at the top of the handler and
      // here. A different _rev means something else (most plausibly a
      // reactivation) touched the doc while the upload was in flight; treat
      // the activation as still live and skip deletion rather than risk
      // deleting recordings it still needs.
      isStillRecording: async () => {
        try {
          const current = await getDb().get(doc._id);
          return current._rev !== doc._rev;
        } catch {
          // Doc gone entirely — nothing left to protect.
          return false;
        }
      },
    });
  } catch (err) {
    log.error({ err, productionId: doc._id }, 'VOD recording upload failed — continuing deactivation');
    return summarise({
      bucket: target.bucket,
      reason: 'upload-error',
      message: `The recording upload failed: ${err instanceof Error ? err.message : String(err)}. The recording stays on Strom.`,
    });
  }

  // Persist one RecordingDoc per uploaded object so #42's listing/playback
  // endpoint can enumerate and presign recordings without round-tripping the
  // bucket. Best-effort: a failed persist must not block teardown.
  const finalizedAt = new Date().toISOString();
  // Every part of one session shares the session stamp in its name, so offset
  // each part by its predecessors' durations (issue #553).
  const timings = recordingPartTimings(uploadRes.uploaded, config.recordingSegmentSecs);
  for (const [i, seg] of uploadRes.uploaded.entries()) {
    const timing = timings[i];
    const part = parsePartName(seg.key.slice(seg.key.lastIndexOf('/') + 1));
    // Only parts of the session the live upload saw are this activation's
    // (issue #556); leftovers of earlier activations get no activationId.
    const activationId = liveSession?.stem !== undefined && part?.stem === liveSession.stem
      ? liveSession.activationId
      : undefined;
    try {
      // Keyed by bucket+key and upserted (issue #554): a file whose Strom
      // delete failed is swept again by the next deactivate and must update
      // its RecordingDoc, not add a second one.
      await upsertRecordingDoc(getRecordingsDb(), {
        type: 'recording',
        productionId: doc._id,
        ...(outputId ? { outputId } : {}),
        // Record which connection wrote the asset (issue #520); absent = the
        // default (env) connection — no backfill on old docs.
        ...(connectionId ? { connectionId } : {}),
        bucket: target.bucket,
        key: seg.key,
        sizeBytes: seg.sizeBytes,
        ...(seg.durationMs !== undefined ? { durationMs: seg.durationMs } : {}),
        // The sweep also uploads segments earlier sessions left on Strom, so
        // take the start from each segment's own name, offset by its part
        // index (#553); otherwise this activation's start (issue #534), then
        // the legacy doc.updatedAt. A part ends after its own duration when
        // known, else at deactivate.
        startedAt: timing.startedAt ?? doc.recording?.startedAt ?? doc.updatedAt,
        endedAt: timing.endedAt ?? finalizedAt,
        ...(activationId ? { activationId } : {}),
        ...(part ? { partIndex: part.index } : {}),
        createdAt: finalizedAt,
        updatedAt: finalizedAt,
      });
    } catch (persistErr) {
      log.error({ persistErr, productionId: doc._id, key: seg.key }, 'RecordingDoc persist failed — object uploaded but unlisted');
    }
  }

  let reason: RecordingUploadSummary['reason'];
  let message: string | undefined;
  if (uploadRes.abortedOnAuthError) {
    // The store rejected our credentials, so the sweep stopped after the first
    // rejection instead of grinding through every segment (#465).
    reason = 'auth-error';
    message =
      `The object store rejected the credentials or permission (${uploadRes.abortedOnAuthError.code}); ` +
      'the upload stopped and the remaining files stay on Strom.';
    log.warn(
      { productionId: doc._id, code: uploadRes.abortedOnAuthError.code, file: uploadRes.abortedOnAuthError.file },
      'VOD recording upload sweep aborted on object-store auth/permission error — skipping remaining segments; deactivation continues',
    );
  }
  log.info(
    { productionId: doc._id, uploaded: uploadRes.uploaded.length, failed: uploadRes.failed.length },
    'VOD recordings uploaded to object storage',
  );
  return summarise({
    bucket: target.bucket,
    uploaded: uploadRes.uploaded.length,
    failed: uploadRes.failed,
    ...(reason ? { reason } : {}),
    ...(message ? { message } : {}),
  });
}

/**
 * Derive the per-output health snapshot for a production from its own state
 * (issue #255). The signal is flow-level, so every assigned output shares the
 * same derived status. A production reads as running when it is `active` with a
 * live `stromFlowId`; the caller passes `stromKnown` (false only when Strom
 * state genuinely could not be observed — e.g. reconcile lost contact).
 */
export function outputSnapshotForProduction(
  doc: Pick<ProductionDoc, 'status' | 'stromFlowId' | 'outputAssignments'>,
  opts: { stromKnown?: boolean } = {},
): OutputStatusEntry[] {
  const productionActive = doc.status === 'active';
  return deriveOutputSnapshot({
    outputIds: (doc.outputAssignments ?? []).map((a) => a.outputId),
    stromKnown: opts.stromKnown ?? true,
    productionActive,
    flowRunning: productionActive && !!doc.stromFlowId,
  });
}

/**
 * Broadcast the `PRODUCTION_STATUS` lifecycle event (spec §3) to the production's
 * WS subscriber set. Reuses the existing `broadcast()` fan-out (which stamps
 * `ts`). Emitted whenever the production's `ProductionStatus` changes.
 */
export function emitProductionStatus(
  doc: Pick<ProductionDoc, '_id' | 'status' | 'stromFlowId' | 'outputAssignments'>,
  opts: { stromKnown?: boolean } = {},
): void {
  broadcast(
    doc._id,
    buildProductionStatusEvent(doc._id, doc.status, outputSnapshotForProduction(doc, opts)),
  );
}

/**
 * Async activation polling loop — runs fire-and-forget after the HTTP
 * response has already been sent.
 *
 * Lifecycle:
 *   1. Call activateStromFlow to create + start the Strom flow.
 *   2. Persist stromFlowId + mixerBlockId (status stays 'activating').
 *   3. Poll strom.flows.get(flowId) every FLOW_POLL_INTERVAL_MS.
 *   4. On flow.state === 'playing': fetch WHEP URL, set status 'active'.
 *   5. On timeout, error, or abort: best-effort cleanup, set status 'inactive'.
 */
async function runActivationFlow(
  productionId: string,
  signal: AbortSignal,
  log: {
    error: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    info: (obj: unknown, msg: string) => void;
  },
  publicBaseUrl: string,
): Promise<void> {
  let stromFlowId: string | undefined;
  let mixerBlockId: string | undefined;
  let audioMixerBlockId: string | undefined;
  let loudnessMainBlockId: string | undefined;
  let whepOutputEntries: Array<{ outputId: string; endpointId: string }> | undefined;
  let pgmWhepEndpointId: string | undefined;

  // Force-stop the meter and clip relays bound to this run's (dying) flow,
  // mirroring deactivate (issue #435). A controller connecting while status is
  // still 'activating' starts both relays on `stromFlowId` (the connect path
  // checks only the doc's stromFlowId). If this activation then fails or is
  // aborted, the relays would otherwise stay bound to the dead flow and the next
  // activation's reinit/connects would only ref-count the stale relay — so no
  // client gets METER_DATA / LOUDNESS_DATA / reactive CLIP_STATE until every
  // controller disconnects. Passing the flow id records it as retired so a later
  // start on it rebinds to the new flow. No-op before any flow was created.
  const forceStopRelaysForDyingFlow = (): void => {
    if (!stromFlowId) return;
    forceStopMeterRelay(productionId, stromFlowId);
    forceStopClipRelay(productionId, stromFlowId);
  };

  try {
    // Load the current production doc
    const doc = await getDb().get(productionId);

    // Load assigned output docs; '__whep__' is a virtual output (no DB entry)
    const outputDocs: OutputDoc[] = [];
    for (const a of doc.outputAssignments ?? []) {
      if (a.outputId === '__whep__') {
        outputDocs.push({ _id: '__whep__', type: 'output', outputType: 'whep', name: 'WHEP Output', createdAt: '', updatedAt: '' });
        continue;
      }
      try {
        const od = await getOutputsDb().get(a.outputId) as unknown as OutputDoc;
        outputDocs.push(od);
      } catch {
        // skip outputs that no longer exist
      }
    }

    const stromToken = await getStromToken(config.stromToken);
    const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });

    // Step 1: Start the Strom flow
    if (signal.aborted) return;
    // When the recorder block (if any) starts recording — the flow is created
    // and started by the call below.
    const activationStartedAt = new Date().toISOString();
    const activation = await activateStromFlow(doc, strom, config.stromUrl, outputDocs.length > 0 ? outputDocs : undefined);
    stromFlowId = activation.flowId;
    mixerBlockId = activation.mixerBlockId ?? undefined;
    audioMixerBlockId = activation.audioMixerBlockId ?? undefined;
    loudnessMainBlockId = activation.loudnessMainBlockId ?? undefined;
    whepOutputEntries = activation.whepOutputEntries;
    pgmWhepEndpointId = activation.pgmWhepEndpointId;
    // mixerBlockId/audioMixerBlockId come directly from the flow generator — they are the
    // randomised IDs actually used in the live Strom flow, not the static template IDs.

    // Step 2: Persist stromFlowId + mixerBlockId + audioMixerBlockId
    if (signal.aborted) {
      forceStopRelaysForDyingFlow();
      await deactivateStromFlow(stromFlowId, strom).catch(() => undefined);
      return;
    }
    // Snapshot the recording's upload target with the recorder block (issue
    // #534): deactivate uploads to this, not to whatever the assignments say by
    // then. Written as undefined when there is no recorder so a stale snapshot
    // from an earlier activation never leaks into this one.
    const recordingOutput = activation.recorderOutputId
      ? outputDocs.find((o) => o._id === activation.recorderOutputId)
      : undefined;
    const recording: ActiveRecording | undefined = activation.recorderBlockId && recordingOutput
      ? {
          outputId: recordingOutput._id,
          ...(recordingOutput.connectionId ? { connectionId: recordingOutput.connectionId } : {}),
          startedAt: activationStartedAt,
        }
      : undefined;
    await updateProductionDoc(productionId, {
      stromFlowId,
      recording,
      ...(mixerBlockId !== undefined && { mixerBlockId }),
      ...(audioMixerBlockId !== undefined && { audioMixerBlockId }),
      ...(loudnessMainBlockId !== undefined && { loudnessMainBlockId }),
      ...(activation.recorderBlockId !== undefined && { recorderBlockId: activation.recorderBlockId }),
      ...(Object.keys(activation.sourceOffsetBlockIds).length > 0 && { sourceOffsetBlockIds: activation.sourceOffsetBlockIds }),
      ...(Object.keys(activation.sourceAudioOffsetBlockIds).length > 0 && { sourceAudioOffsetBlockIds: activation.sourceAudioOffsetBlockIds }),
      ...(Object.keys(activation.clipPlayerBlockIds).length > 0 && { clipPlayerBlockIds: activation.clipPlayerBlockIds }),
      ...(activation.returnBuses.length > 0 && { returnBuses: activation.returnBuses }),
      ...(Object.keys(activation.mixerInputMap).length > 0 && { mixerInputMap: activation.mixerInputMap }),
      ...(activation.warnings.length > 0 && { activationWarnings: activation.warnings }),
    });
    for (const w of activation.warnings) log.warn({ productionId, warning: w.type }, w.message);

    // Step 3: Poll until flow reaches 'playing' or we time out
    const deadline = Date.now() + FLOW_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (signal.aborted) {
        forceStopRelaysForDyingFlow();
        await deactivateStromFlow(stromFlowId, strom).catch(() => undefined);
        return;
      }

      const { flow } = await strom.flows.get(stromFlowId);

      if (flow.running === true) {
        // Resolve audioMixerBlockId from the running flow — this is the authoritative source.
        // Strom may assign a server-generated ID that differs from the template's block ID,
        // so always prefer the live flow value over the template-derived one.
        const runningAudioBlock = (flow.blocks ?? []).find(
          (b) => (b as unknown as { block_definition_id?: string }).block_definition_id === 'builtin.mixer',
        ) as { id?: string; properties?: Record<string, unknown> } | undefined;
        if (runningAudioBlock?.id) audioMixerBlockId = runningAudioBlock.id;


        // Re-resolve sourceOffsetBlockIds from the running flow — Strom may assign server-generated
        // IDs that differ from the template block IDs we stored at activation time.
        // Strategy: find all builtin.time_offset blocks and match their names to mixerInputs.
        // The flow generator names them "Offset V{padIndex}" where padIndex maps to video_in_{N},
        // so this is reliable without needing flow.links (which may be absent in the GET response).
        const runningOffsetBlocks = (flow.blocks ?? []).filter(
          (b) => b.block_definition_id === 'builtin.time_offset',
        );
        if (runningOffsetBlocks.length > 0) {
          const resolvedOffsetBlockIds: Record<string, string> = {};
          const resolvedAudioOffsetBlockIds: Record<string, string> = {};
          for (const offsetBlock of runningOffsetBlocks) {
            if (!offsetBlock.id) continue;
            // "Offset V{N}" → video_in_{N}
            const videoMatch = /^Offset V(\d+)$/.exec(offsetBlock.name ?? '');
            if (videoMatch) {
              resolvedOffsetBlockIds[`video_in_${videoMatch[1]}`] = offsetBlock.id;
              continue;
            }
            // "Offset A{N}" → video_in_{N} (audio delay, keyed by the same mixerInput)
            const audioMatch = /^Offset A(\d+)$/.exec(offsetBlock.name ?? '');
            if (audioMatch) {
              resolvedAudioOffsetBlockIds[`video_in_${audioMatch[1]}`] = offsetBlock.id;
            }
          }
          if (Object.keys(resolvedOffsetBlockIds).length > 0) {
            activation.sourceOffsetBlockIds = resolvedOffsetBlockIds;
            log.info({ productionId, resolvedOffsetBlockIds }, 'Re-resolved sourceOffsetBlockIds from running flow');
          }
          if (Object.keys(resolvedAudioOffsetBlockIds).length > 0) {
            activation.sourceAudioOffsetBlockIds = resolvedAudioOffsetBlockIds;
            log.info({ productionId, resolvedAudioOffsetBlockIds }, 'Re-resolved sourceAudioOffsetBlockIds from running flow');
          }
        }

        // Step 4: Retrieve WHEP multiview endpoint
        let whepEndpoint: string | undefined;
        if (mixerBlockId) {
          const resp = await strom.mixer.multiviewEndpoint(stromFlowId, mixerBlockId).catch(() => null);
          // Guard: deactivate may have fired while multiviewEndpoint() was in-flight.
          // Without this check, updateProductionDoc would write status:'active' after
          // deactivate has already written status:'inactive'.
          if (signal.aborted) {
            forceStopRelaysForDyingFlow();
            await deactivateStromFlow(stromFlowId, strom).catch(() => {});
            return;
          }
          if (resp?.endpoint) whepEndpoint = `${stromBrowserBaseUrl()}${resp.endpoint}`;
        }

        if (signal.aborted) {
          forceStopRelaysForDyingFlow();
          await deactivateStromFlow(stromFlowId, strom).catch(() => {});
          return;
        }

        // Derive initial tally from first two source assignments so the
        // controller shows selected sources immediately on first connect.
        const reloadedDoc = await getDb().get(productionId);

        // Compute WHIP ingest endpoints for __whip__ source assignments.
        // URLs point to the Open Live WHIP proxy — Strom URL stays internal.
        const whipEndpoints = reloadedDoc.sources
          .filter((s) => s.sourceId === 'Whip')
          .map((s) => ({
            mixerInput: s.mixerInput,
            url: `${publicBaseUrl}/api/v1/productions/${productionId}/whip/${encodeURIComponent(s.mixerInput)}`,
          }));
        const sortedSources = [...reloadedDoc.sources].sort((a, b) =>
          a.mixerInput.localeCompare(b.mixerInput),
        );
        const initialTally = {
          pgm: sortedSources[0]?.mixerInput ?? null,
          pvw: sortedSources[1]?.mixerInput ?? null,
        };
        setTally(productionId, initialTally);

        // NOTE: Do NOT call strom.mixer.transition() here.
        // Strom's trigger_transition API ignores from_input/to_input — it always
        // transitions from the current PGM to the current PVW in its overlay state.
        // Strom initialises with PGM=0 and PVW=1 by default, which already matches
        // our initialTally (pgm=video_in_0, pvw=video_in_1). Calling transition()
        // would fire an unintended TAKE that swaps PGM and PVW, making the
        // multiview show the opposite of what the controller displays.

        // Build WHEP output URLs from endpoint IDs. Strom serves each WHEP
        // output at /whep/{endpoint_id} — construct the URL directly rather
        // than calling listStreams() whose response type lacks a url field.
        const whepOutputUrls: Array<{ outputId: string; url: string }> | undefined =
          whepOutputEntries && whepOutputEntries.length > 0
            ? whepOutputEntries.map(({ outputId, endpointId }) => ({
                outputId,
                url: `${stromBrowserBaseUrl()}/whep/${endpointId}`,
              }))
            : undefined;

        // Per-guest return WHEP endpoints (issue #300). Store the internal Strom
        // URL + endpointId; the return REST routes derive the guest-scoped,
        // endpoint-path-checked URL from these (never `/whep-proxy?target=`).
        const returnWhepUrls: Array<{ mixerInput: string; url: string; endpointId: string }> | undefined =
          activation.returnWhepEntries.length > 0
            ? activation.returnWhepEntries.map(({ mixerInput, endpointId }) => ({
                mixerInput,
                url: `${config.stromUrl}/whep/${endpointId}`,
                endpointId,
              }))
            : undefined;

        await updateProductionDoc(productionId, {
          status: 'active',
          // Shared-GPU accrual start (issue #500): the flow has reached 'playing',
          // so record when the GPU slot allocation began, in the SAME write that
          // sets status 'active'. Cleared on every stop path. A restart that finds
          // the flow still live preserves this, so accrual resumes from here.
          activatedAt: new Date().toISOString(),
          whepEndpoint,
          pgmWhepEndpoint: pgmWhepEndpointId ? `${stromBrowserBaseUrl()}/whep/${pgmWhepEndpointId}` : undefined,
          whipEndpoints: whipEndpoints.length > 0 ? whipEndpoints : undefined,
          srtOutputUri: undefined,
          whepOutputUrls: whepOutputUrls && whepOutputUrls.length > 0 ? whepOutputUrls : undefined,
          ...(returnWhepUrls && returnWhepUrls.length > 0 && { returnWhepUrls }),
          ...(activation.returnBuses.length > 0 && { returnBuses: activation.returnBuses }),
          tally: initialTally,
          ...(audioMixerBlockId !== undefined && { audioMixerBlockId }),
          ...(loudnessMainBlockId !== undefined && { loudnessMainBlockId }),
          ...(Object.keys(activation.sourceOffsetBlockIds).length > 0 && { sourceOffsetBlockIds: activation.sourceOffsetBlockIds }),
          ...(Object.keys(activation.sourceAudioOffsetBlockIds).length > 0 && { sourceAudioOffsetBlockIds: activation.sourceAudioOffsetBlockIds }),
          ...(Object.keys(activation.clipPlayerBlockIds).length > 0 && { clipPlayerBlockIds: activation.clipPlayerBlockIds }),
        });

        notifyProductionActivated(productionId);
        // Upload closed recording parts while live (issue #556). Checked and
        // started in the same tick, so a deactivate that aborts this run either
        // stops it or prevents it.
        if (activation.recorderBlockId && !signal.aborted) {
          startLiveRecordingUpload({ _id: productionId, stromFlowId, recorderBlockId: activation.recorderBlockId, recording }, log);
        }
        // Emit the PRODUCTION_STATUS lifecycle event for the active transition
        // (spec §3). Flow is playing, so all assigned outputs derive as healthy.
        emitProductionStatus({
          _id: productionId,
          status: 'active',
          stromFlowId,
          outputAssignments: doc.outputAssignments,
        });
        // Studio shows ERROR frames as a toast. Controllers that connect later get
        // the same frame from the connect-time snapshot in ws/controller.ts.
        if (!signal.aborted) {
          for (const w of activation.warnings) broadcast(productionId, { type: 'ERROR', error: w.message });
        }
        log.info({ productionId, stromFlowId, whepEndpoint, initialTally, audioMixerBlockId }, 'Production activated — flow playing');

        // Controllers that stayed connected across a deactivate→reactivate are
        // never re-run through the WS connect handler, so re-run first-connect
        // audio init once and restart the meter/clip relays against this new
        // flow for them (issue #416). Best-effort — it internally swallows its
        // own errors and is a no-op when nobody is connected.
        await reinitConnectedControllers(productionId);
        return;
      }

      // Wait before next poll
      await new Promise<void>((resolve) => setTimeout(resolve, FLOW_POLL_INTERVAL_MS));
    }

    // Timeout reached
    throw new Error(`Strom flow ${stromFlowId} did not reach 'playing' state within ${FLOW_POLL_TIMEOUT_MS}ms`);
  } catch (err) {
    if (signal.aborted) {
      // Deactivate called during activation — cleanup already handled by deactivate handler
      return;
    }

    log.error({ err, productionId, stromFlowId }, 'Activation flow failed — resetting to inactive');

    // Force-stop the meter and clip relays bound to the failed flow (issue
    // #435). Unlike the abort path above, nothing else cleans these up on a
    // genuine failure (poll timeout, Strom error, failed final doc write), so
    // without this they stay bound to the dead flow and the next successful
    // activation never moves them.
    forceStopRelaysForDyingFlow();
    await stopLiveRecordingUpload(productionId);

    // Best-effort flow cleanup
    if (stromFlowId) {
      const stromToken = await getStromToken(config.stromToken).catch((err) => { log.error({ errMsg: err instanceof Error ? err.message : String(err) }, "SAT exchange failed — proceeding without auth"); return undefined; });
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      await deactivateStromFlow(stromFlowId, strom).catch(() => undefined);
    }

    // Settle any shared-GPU time accrued if the flow was briefly 'playing'
    // before the activation failed (issue #500), then clear the accrual start.
    // Re-read so the freshest activatedAt/gpuHours are settled; a no-op when the
    // flow never reached 'playing' (activatedAt was never set) or metering is off.
    const stopDoc = await getDb().get(productionId).catch(() => undefined);
    const settledGpuHours = stopDoc ? settleOnStop(stopDoc) : undefined;

    // Reset production to inactive, clearing all flow-related fields
    await updateProductionDoc(productionId, {
      status: 'inactive',
      activatedAt: undefined,
      ...(settledGpuHours ? { gpuHours: settledGpuHours } : {}),
      stromFlowId: undefined,
      mixerBlockId: undefined,
      whepEndpoint: undefined,
      pgmWhepEndpoint: undefined,
      whipEndpoints: undefined,
      activationWarnings: undefined,
    }).catch((resetErr) => {
      log.error({ resetErr, productionId }, 'Failed to reset production to inactive after activation failure');
    });

    notifyProductionDeactivated(productionId);
  } finally {
    // Only remove the entry if it still points to *this* run's controller.
    // A slow aborted run can otherwise finish after a newer activation has
    // registered its own controller and delete that entry, leaving the newer
    // run uncancellable — deactivate finds nothing to abort and the run writes
    // status 'active' over the deactivated doc (see #371).
    if (activationAbortControllers.get(productionId)?.signal === signal) {
      activationAbortControllers.delete(productionId);
    }
  }
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ProductionInput = z.object({
  name: z.string().min(1).max(256),
});

// Format-specific allowlists for production `values` that are forwarded verbatim
// to Strom block properties by flow-generator.ts. Validated here so malformed
// values are rejected with a 400 (via the global ZodError handler) rather than
// being injected into Strom flow properties (issue #88).
//
// - resolution keys (pgm_resolution, multiview_resolution) → e.g. "1280x720"
// - framerate keys  (pgm_framerate, multiview_framerate)   → e.g. "30" or "30000/1001"
//   (fractions must allow NTSC-style rates like 30000/1001, so up to 6 digits/side)
// - clock → forwarded as the flow-level `clock_type` property; fixed set only.
const RESOLUTION_RE = /^\d{3,5}x\d{3,5}$/;
const FRAMERATE_RE = /^\d{1,6}\/\d{1,6}$|^\d{1,3}$/;
const CLOCK_TYPES = new Set(['ntp', 'gst', 'system']);

const RESOLUTION_VALUE_KEYS = ['pgm_resolution', 'multiview_resolution'] as const;
const FRAMERATE_VALUE_KEYS = ['pgm_framerate', 'multiview_framerate'] as const;

const ProductionValues = z
  .record(z.union([z.string(), z.number(), z.boolean()]))
  .superRefine((values, ctx) => {
    for (const key of RESOLUTION_VALUE_KEYS) {
      const v = values[key];
      if (typeof v === 'string' && !RESOLUTION_RE.test(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must match <width>x<height> (e.g. "1280x720")`,
        });
      }
    }
    for (const key of FRAMERATE_VALUE_KEYS) {
      const v = values[key];
      if (typeof v === 'string' && !FRAMERATE_RE.test(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be an integer or fraction (e.g. "30" or "30000/1001")`,
        });
      }
    }
    const clock = values['clock'];
    if (typeof clock === 'string' && clock !== '' && !CLOCK_TYPES.has(clock)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clock'],
        message: `clock must be one of: ${[...CLOCK_TYPES].join(', ')}`,
      });
    }
  });

const ProductionPatch = z.object({
  name: z.string().min(1).max(256).optional(),
  values: ProductionValues.optional(),
  airTime: z.string().datetime().nullable().optional(),
});

// mixerInput must match the Strom pad naming convention (e.g. "video_in_0", "video_in_15")
const mixerInputSchema = z.string().regex(/^video_in_\d{1,2}$/, 'mixerInput must match video_in_N format').max(20);

// dskInput must match the Strom DSK pad naming convention (e.g. "dsk_in_0"). It is
// forwarded verbatim into a Strom flow link `to` field by flow-generator.ts
// (`${mixerBlockId}:${assignment.dskInput}`), so an unvalidated value containing a
// `:` or other unexpected characters corrupts the flow topology (issue #61). Mirror
// the mixerInput allowlist so only well-formed pad names reach the Strom pipeline.
const dskInputSchema = z.string().regex(/^dsk_in_\d+$/, 'dskInput must match dsk_in_N format').max(20);

/**
 * Declares a source assignment as a guest slot (issue #381 item 1): a return
 * feed (program-minus by default) reserved for a guest and built into the flow
 * as a per-guest return bus at activation (`assignReturnBuses`,
 * `src/lib/flow-generator.ts`). Present ⇒ the input is a guest slot invites can
 * target; absent ⇒ an ordinary source assignment. v1 accepts `lowLatency: false`
 * only (the fast/low-latency return is a post-v1 feature).
 */
const ReturnFeedInput = z
  .object({
    synced: z.enum(['program', 'program-minus']).default('program-minus'),
    lowLatency: z.literal(false).optional(),
  })
  .optional();

const SourceAssignmentInput = z.object({
  sourceId: z.string().min(1).max(128),
  mixerInput: mixerInputSchema,
  returnFeed: ReturnFeedInput,
});

const GraphicAssignmentInput = z.object({
  graphicId: z.string().min(1),
  dskInput: dskInputSchema,
});

const OutputAssignmentInput = z.object({
  outputId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const productionsRoutes: FastifyPluginAsync = async (fastify) => {
  // List all productions
  fastify.get('/api/v1/productions', async (_req, reply) => {
    const db = getDb();
    let result: Awaited<ReturnType<typeof db.find>>;
    try {
      result = await db.find({ selector: { type: 'production' } });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/productions — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable' });
    }
    const docs = (Array.isArray(result?.docs) ? (result.docs as ProductionDoc[]) : []).map((doc) => {
      if (doc.status !== 'active') return toProductionView(doc);
      const subscriberCount = getSubscriberCount(doc._id);
      const idleSinceAt = getIdleSince(doc._id);
      const idleExpiresAt = idleSinceAt !== undefined ? getIdleExpiresAt(idleSinceAt) : undefined;
      return { ...toProductionView(doc), subscriberCount, ...(idleExpiresAt !== undefined ? { idleExpiresAt } : {}) };
    });
    return reply.send(docs);
  });

  // Create a production
  fastify.post('/api/v1/productions', async (req, reply) => {
    const body = ProductionInput.parse(req.body);
    const now = new Date().toISOString();
    const doc: ProductionDoc = {
      _id: `prod-${randomUUID()}`,
      type: 'production',
      name: body.name,
      status: 'inactive',
      sources: [],
      pipeline: { stromConfig: null, status: 'stopped' },
      graphics: [],
      macros: [],
      tally: { pgm: null, pvw: null },
      createdAt: now,
      updatedAt: now,
    };
    const response = await getDb().insert(doc);
    return reply.status(201).send({ ...doc, _rev: response.rev });
  });

  // Get a production
  fastify.get<{ Params: { id: string } }>('/api/v1/productions/:id', async (req, reply) => {
    let doc: ProductionDoc;
    try {
      doc = await getDb().get(req.params.id);
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
    if (doc.status !== 'active' || !doc.stromFlowId || !doc.mixerBlockId) {
      return reply.send(toProductionView(doc));
    }
    try {
      const stromToken = await getStromToken(config.stromToken);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      const mixerState = await strom.mixer.getState(doc.stromFlowId, doc.mixerBlockId);
      // Strom returns input_resolutions indexed by the COMPACT mixer pad. The
      // client indexes by the stored mixerInput, so invert the pad compaction
      // (issue #463) and re-expand to a stored-pad-indexed array. Identity /
      // pass-through when no compaction map is present (older flows, or a
      // contiguous-from-0 production).
      const inputResolutions = expandToStoredPadIndex(mixerState.input_resolutions, doc.mixerInputMap);
      return reply.send({ ...toProductionView(doc), inputResolutions });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/productions/:id — failed to fetch input_resolutions from Strom');
      return reply.send(toProductionView(doc));
    }
  });

  // Update a production (name, templateId)
  fastify.patch<{ Params: { id: string } }>('/api/v1/productions/:id', async (req, reply) => {
    const body = ProductionPatch.parse(req.body);
    try {
      const doc = await getDb().get(req.params.id);
      const updated: ProductionDoc = {
        ...doc,
        ...(body.name !== undefined && { name: body.name }),
        ...(body.values !== undefined && { values: { ...(doc.values ?? {}), ...body.values } }),
        ...(body.airTime !== undefined && { airTime: body.airTime ?? undefined }),
        updatedAt: new Date().toISOString(),
      };
      const response = await getDb().insert(updated);
      return reply.send({ ...toProductionView(updated), _rev: response.rev });
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Delete a production
  fastify.delete<{ Params: { id: string } }>('/api/v1/productions/:id', async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);

      // Cancel any in-progress activation loop
      const abortCtrl = activationAbortControllers.get(doc._id);
      if (abortCtrl) {
        abortCtrl.abort();
        activationAbortControllers.delete(doc._id);
      }

      // Stop the live recording part upload with the production (issue #556).
      await stopLiveRecordingUpload(doc._id);

      // Stop and delete the Strom flow if one is running
      if (doc.stromFlowId) {
        const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
        const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
        await deactivateStromFlow(doc.stromFlowId, strom).catch(() => undefined);
      }

      // Preserve shared-GPU usage BEFORE destroying the doc (issue #500). A
      // production deleted right after a show is a normal, billable path, but
      // `gpuHours` lives only on this doc — so settle its final partial hour and
      // copy the buckets into a ledger record that survives the delete, keeping
      // `/api/v1/usage/gpu` + `/metrics` reporting them within the retention
      // window. Best-effort (never throws); a no-op when metering is off.
      await preserveGpuUsageOnDelete(doc, fastify.log);

      await getDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Activate a production — immediately returns 'activating', then polls Strom
  // for flow state in a fire-and-forget async loop.
  fastify.post<{ Params: { id: string } }>(
    '/api/v1/productions/:id/activate',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);

      // Guard: reject if already active or activating
      if (doc.status === 'active' || doc.status === 'activating') {
        return reply.status(409).send({
          error: `Production is already '${doc.status}'`,
          statusCode: 409,
        });
      }

      // Guard (issue #523): a NEW production cannot start while the workspace
      // balance is zero or negative (metered instances only; fails open on a
      // lookup error). This is the only place the balance is consulted — a
      // running production is never stopped because of balance.
      const gate = await checkProductionStartAllowed(req.log);
      if (!gate.allowed) {
        return reply.status(402).send({ error: gate.message, statusCode: 402 });
      }

      // Guard: reject if any non-WHEP output is already active in another production
      if (doc.outputAssignments && doc.outputAssignments.length > 0) {
        // findTrusted: literal selector written here, no request data (#257)
        const otherActiveProds = await getDb().findTrusted({
          selector: { type: 'production', status: { $in: ['active', 'activating'] } },
          fields: ['_id', 'name', 'outputAssignments'],
          limit: 200,
        });
        const activeOutputIds = new Set(
          otherActiveProds.docs.flatMap((p) =>
            ((p as unknown as ProductionDoc).outputAssignments ?? []).map((a) => a.outputId),
          ),
        );
        for (const assignment of doc.outputAssignments) {
          if (!activeOutputIds.has(assignment.outputId)) continue;
          let outputDoc: OutputDoc | undefined;
          try { outputDoc = await getOutputsDb().get(assignment.outputId); } catch { continue; }
          if (outputDoc.outputType === 'whep') continue;
          const conflictProd = otherActiveProds.docs.find((p) =>
            ((p as unknown as ProductionDoc).outputAssignments ?? []).some((a) => a.outputId === assignment.outputId),
          ) as unknown as ProductionDoc | undefined;
          return reply.status(409).send({
            error: `Output "${outputDoc.name}" is already active in production "${conflictProd?.name ?? 'another production'}"`,
            statusCode: 409,
          });
        }
      }

      // Resolve the public base URL for WHIP callback URLs BEFORE mutating any
      // state. Prefers the explicitly configured PUBLIC_BASE_URL; otherwise
      // derives it from trustProxy-aware request fields and validates the host
      // to prevent X-Forwarded-Host injection (#50). Throws UntrustedHostError
      // (→ 400) rather than persisting an attacker-controlled host into CouchDB.
      // Resolving here (before the 'activating' write) means a rejected host
      // does not leave the production stuck mid-activation.
      const publicBaseUrl = resolvePublicBaseUrl(req);

      // Transition to 'activating' immediately and respond; clear any deletion
      // warnings and any prior ended/auto-deactivated markers (cleared on next
      // activation, spec §Data Model).
      const activatingDoc: ProductionDoc = {
        ...doc,
        status: 'activating',
        deletionWarnings: undefined,
        activationWarnings: undefined,
        autoDeactivated: undefined,
        endedReason: undefined,
        updatedAt: new Date().toISOString(),
      };
      const insertResponse = await getDb().insert(activatingDoc);
      notifyProductionActivated(doc._id);
      emitProductionStatus(activatingDoc);

      // Set up AbortController so deactivate can cancel the polling loop
      const abortController = new AbortController();
      activationAbortControllers.set(doc._id, abortController);

      // Fire-and-forget — must never let a rejection escape to the global handler
      void runActivationFlow(doc._id, abortController.signal, fastify.log, publicBaseUrl).catch((err) => {
        fastify.log.error({ err, productionId: doc._id }, 'Unhandled error in runActivationFlow');
      });

      return reply.send({
        id: activatingDoc._id,
        name: activatingDoc.name,
        status: activatingDoc.status,
        stromFlowId: activatingDoc.stromFlowId,
        _rev: insertResponse.rev,
      });
    } catch (err) {
      // Untrusted / missing host for the WHIP callback URL is a client-input
      // problem (host-header injection attempt or misconfiguration), not a
      // server fault — surface it as a 400 rather than a generic 500.
      if (err instanceof UntrustedHostError) {
        return reply.status(400).send({ error: err.message, statusCode: 400 });
      }
      req.log.error({ err }, 'Activation failed');
      return reply.status(500).send({ error: 'Activation failed — check server logs', statusCode: 500 });
    }
  });

  // Deactivate a production — stops and deletes the Strom flow, cancels any
  // in-progress activation polling loop.
  //
  // Deactivate is idempotent: a request that arrives while another deactivate of
  // the same production is still running (the VOD upload alone can take tens of
  // seconds) joins that run and gets its result, instead of repeating the
  // teardown against the same stale revision and failing the final write.
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/deactivate', async (req, reply) => {
    const productionId = req.params.id;
    let run = inFlightDeactivations.get(productionId);
    if (run) {
      req.log.info({ productionId }, 'Deactivation already in progress — waiting for it');
    } else {
      run = (async () => {
        try {
          return await deactivate(productionId, req.log);
        } finally {
          inFlightDeactivations.delete(productionId);
        }
      })();
      inFlightDeactivations.set(productionId, run);
    }
    try {
      return reply.send(await run);
    } catch (err) {
      req.log.error({ err }, 'Deactivation failed');
      return reply.status(500).send({ error: 'Deactivation failed — check server logs', statusCode: 500 });
    }
  });

  async function deactivate(productionId: string, log: FastifyBaseLogger): Promise<DeactivateResult> {
    const doc = await getDb().get(productionId);

    // Cancel any in-progress activation loop
    const abortController = activationAbortControllers.get(doc._id);
    if (abortController) {
      abortController.abort();
      activationAbortControllers.delete(doc._id);
    }

    clearProductionPflState(doc._id);
    clearAudioState(doc._id);
    clearPipState(doc._id);
    clearFxState(doc._id);
    // Force-stop the meter and clip relays regardless of refCount (issue #416):
    // they are bound to this flow. A controller connecting before the final doc
    // write below can still start one on this flow; the next start with the new
    // flow rebinds it.
    forceStopMeterRelay(doc._id, doc.stromFlowId);
    forceStopClipRelay(doc._id, doc.stromFlowId);
    // Stop any clip completion-poll timers and wipe the in-memory clip-state
    // registry — live-only clip state must not survive deactivation (#278).
    clearClipStateForProduction(doc._id);
    // Broadcast group-state reset so all connected clients clear their ephemeral
    // group assignments — these are live-only and must not survive deactivation.
    broadcast(doc._id, { type: 'GRP_STATE_RESET' });
    broadcast(doc._id, { type: 'PRODUCTION_DEACTIVATED' });
    // Stop the live part upload and wait for a running pass, so the sweep below
    // only finds the last part and earlier failures, and never races it (#556).
    const liveSession = await stopLiveRecordingUpload(doc._id);
    let lastRecordingUpload: RecordingUploadSummary | undefined;
    if (doc.stromFlowId) {
      const stromToken = await getStromToken(config.stromToken).catch((err) => { log.error({ errMsg: err instanceof Error ? err.message : String(err) }, "SAT exchange failed — proceeding without auth"); return undefined; });
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });

      // VOD recording (issue #41): when a recorder block is active, finalise
      // the current segment and upload Strom's local recordings to object
      // storage. Best-effort: a failed upload must not block teardown. The
      // outcome is stored on the production as `lastRecordingUpload` (#534).
      if (doc.recorderBlockId) {
        lastRecordingUpload = await uploadProductionRecording(doc, doc.stromFlowId, doc.recorderBlockId, strom, stromToken, log, liveSession);
      }

      await deactivateStromFlow(doc.stromFlowId, strom);
    }

    // Tear down the Open Intercom talkback grouping (all its lines) with the
    // production lifecycle (issue #302). Best-effort: a failed teardown must not
    // block deactivation, mirroring the Strom/recording teardown contract.
    if (doc.intercomProductionId && isIntercomEnabled()) {
      await teardownIntercomProduction(doc.intercomProductionId).catch((err) => {
        log.warn({ err, productionId: doc._id }, 'intercom teardown failed — continuing deactivation');
      });
    }

    // Revoke the production's outstanding guest invites and mark any live guest
    // sessions `left` (issue #325). A guest invite token is the security
    // boundary of guest calling; a still-TTL-valid token must not be able to
    // join a deactivated production and provision a fresh intercom line. This
    // mirrors the per-invite DELETE revoke (guests.ts) and the kick/leave
    // session transition. Best-effort: a failed sweep must not block
    // deactivation, matching the Strom/intercom teardown contract.
    await sweepGuestsOnProductionEnd(doc._id, log);

    const { doc: stored, rev } = await writeDeactivatedDoc(doc, log, lastRecordingUpload);
    notifyProductionDeactivated(doc._id);
    emitProductionStatus(stored);
    return { id: stored._id, name: stored.name, status: stored.status, _rev: rev };
  }

  // Assign a source to a mixer input
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/sources', async (req, reply) => {
    const body = SourceAssignmentInput.parse(req.body);
    const assignment: ProductionSourceAssignment = {
      sourceId: body.sourceId,
      mixerInput: body.mixerInput,
      // A returnFeed makes this a guest slot (#381 item 1). Normalise lowLatency
      // to false — v1 builds only the synced (picture-switch) return.
      ...(body.returnFeed
        ? { returnFeed: { synced: body.returnFeed.synced, lowLatency: false as const } }
        : {}),
    };
    for (let attempt = 0; attempt < MAX_DB_WRITE_RETRIES; attempt++) {
      try {
        const doc = await getDb().get(req.params.id);
        // Replace existing assignment for the same mixerInput, or add new
        const existing = doc.sources.findIndex((s) => s.mixerInput === body.mixerInput);
        const unsorted = existing !== -1
          ? doc.sources.map((s, i) => (i === existing ? assignment : s))
          : [...doc.sources, assignment];
        const sources = [...unsorted].sort((a, b) => a.mixerInput.localeCompare(b.mixerInput));
        const updated: ProductionDoc = { ...doc, sources, updatedAt: new Date().toISOString() };
        const response = await getDb().insert(updated);
        return reply.status(201).send({ ...assignment, _rev: response.rev });
      } catch (err) {
        if (err instanceof Error && 'statusCode' in err && (err as { statusCode?: number }).statusCode === 409) {
          if (attempt < MAX_DB_WRITE_RETRIES - 1) continue;
        }
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  });

  // Remove a source assignment by mixerInput
  fastify.delete<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/sources/:mixerInput',
    async (req, reply) => {
      const mixerInputParsed = mixerInputSchema.safeParse(req.params.mixerInput);
      if (!mixerInputParsed.success) {
        return reply.status(400).send({ error: 'Invalid mixerInput format', statusCode: 400 });
      }
      for (let attempt = 0; attempt < MAX_DB_WRITE_RETRIES; attempt++) {
        try {
          const doc = await getDb().get(req.params.id);
          const exists = doc.sources.some((s) => s.mixerInput === req.params.mixerInput);
          if (!exists) return reply.status(404).send({ error: 'Source assignment not found', statusCode: 404 });
          const updated: ProductionDoc = {
            ...doc,
            sources: doc.sources.filter((s) => s.mixerInput !== req.params.mixerInput),
            updatedAt: new Date().toISOString(),
          };
          await getDb().insert(updated);
          return reply.status(204).send();
        } catch (err) {
          if (err instanceof Error && 'statusCode' in err && (err as { statusCode?: number }).statusCode === 409) {
            if (attempt < MAX_DB_WRITE_RETRIES - 1) continue;
          }
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
      }
    }
  );

  // Assign a graphic to a DSK pad
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/graphics', async (req, reply) => {
    const body = GraphicAssignmentInput.parse(req.body);
    try {
      const doc = await getDb().get(req.params.id);
      const existing = (doc.graphicAssignments ?? []).findIndex((g) => g.dskInput === body.dskInput);
      const assignment: ProductionGraphicAssignment = { graphicId: body.graphicId, dskInput: body.dskInput };
      const graphicAssignments = existing !== -1
        ? (doc.graphicAssignments ?? []).map((g, i) => (i === existing ? assignment : g))
        : [...(doc.graphicAssignments ?? []), assignment];
      const updated: ProductionDoc = { ...doc, graphicAssignments, updatedAt: new Date().toISOString() };
      const response = await getDb().insert(updated);
      return reply.status(201).send({ ...assignment, _rev: response.rev });
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Remove a graphic assignment by DSK pad
  fastify.delete<{ Params: { id: string; dskInput: string } }>(
    '/api/v1/productions/:id/graphics/:dskInput',
    async (req, reply) => {
      const dskInputParsed = dskInputSchema.safeParse(req.params.dskInput);
      if (!dskInputParsed.success) {
        return reply.status(400).send({ error: 'Invalid dskInput format', statusCode: 400 });
      }
      try {
        const doc = await getDb().get(req.params.id);
        const exists = (doc.graphicAssignments ?? []).some((g) => g.dskInput === req.params.dskInput);
        if (!exists) return reply.status(404).send({ error: 'Graphic assignment not found', statusCode: 404 });
        const updated: ProductionDoc = {
          ...doc,
          graphicAssignments: (doc.graphicAssignments ?? []).filter((g) => g.dskInput !== req.params.dskInput),
          updatedAt: new Date().toISOString(),
        };
        await getDb().insert(updated);
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  );

  // Assign an output to a production
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/outputs', async (req, reply) => {
    const body = OutputAssignmentInput.parse(req.body);
    try {
      const doc = await getDb().get(req.params.id);
      const already = (doc.outputAssignments ?? []).some((o) => o.outputId === body.outputId);
      if (already) return reply.status(409).send({ error: 'Output already assigned', statusCode: 409 });
      const assignment: ProductionOutputAssignment = { outputId: body.outputId };
      const outputAssignments = [...(doc.outputAssignments ?? []), assignment];
      const updated: ProductionDoc = { ...doc, outputAssignments, updatedAt: new Date().toISOString() };
      const response = await getDb().insert(updated);
      return reply.status(201).send({ ...assignment, _rev: response.rev });
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Remove an output assignment
  fastify.delete<{ Params: { id: string; outputId: string } }>(
    '/api/v1/productions/:id/outputs/:outputId',
    async (req, reply) => {
      try {
        const doc = await getDb().get(req.params.id);
        const exists = (doc.outputAssignments ?? []).some((o) => o.outputId === req.params.outputId);
        if (!exists) return reply.status(404).send({ error: 'Output assignment not found', statusCode: 404 });
        const updated: ProductionDoc = {
          ...doc,
          outputAssignments: (doc.outputAssignments ?? []).filter((o) => o.outputId !== req.params.outputId),
          updatedAt: new Date().toISOString(),
        };
        await getDb().insert(updated);
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  );
  // Connected controller count for a production (used by the companion module
  // to show a "peers connected" indicator on the landing page). `count` is
  // operators only; watch-only connections are reported separately.
  fastify.get<{ Params: { id: string } }>(
    '/api/v1/productions/:id/controllers',
    async (req, reply) => {
      return reply.send({ count: getSubscriberCount(req.params.id), watchers: getWatcherCount(req.params.id) });
    }
  );
};

export { activationAbortControllers };
export default productionsRoutes;
