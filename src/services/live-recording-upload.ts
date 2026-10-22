/**
 * Live recording part upload (issue #556, OL-31e; folds in OL-31d).
 *
 * With `RECORDING_SEGMENT_SECS` > 0 Strom's recorder closes a part every N
 * seconds and opens the next, announcing each new file with
 * `RecorderFileChanged`. While the production runs, this uploads the closed
 * parts, so deactivate only has the last part (and any earlier failures) left.
 *
 * For each closed part, in order, and only when every step passes:
 *   1. its size on Strom's media listing has stayed the same for
 *      `stableMs` (the finalisation rule: Strom's finalisation timing is not
 *      known, so a part still being written is never uploaded);
 *   2. it is streamed to the activation's storage target (OL-31a);
 *   3. the uploaded byte count equals the listed size;
 *   4. it is registered idempotently by bucket+key (OL-31c);
 *   5. it is deleted from Strom.
 * Any failure leaves the file on Strom. The next event, the reconnect sweep or
 * the deactivate sweep retries it; a retried part updates its RecordingDoc
 * rather than adding a second one.
 *
 * Which files are closed: an event announcing file N closes every earlier file
 * in the production's output directory. After a (re)connect of the shared
 * event socket, events may have been missed, so the sweep treats every file
 * but the newest (by session stem, then part index) as closed. The newest file
 * may be the one the recorder is writing and is never touched.
 *
 * Passes run one at a time per production. Deactivate and production delete
 * call {@link stopLiveRecordingUpload} before their own teardown, which waits
 * for the running pass so the deactivate sweep never races it.
 */
import { config } from '../config.js';
import { getDb, getRecordingsDb } from '../db/index.js';
import type { ActiveRecording, ProductionDoc } from '../db/types.js';
import { comparePartNames, parsePartName, recordingPartTimings, type PartName } from '../lib/recording-parts.js';
import { upsertRecordingDoc } from '../lib/recording-registry.js';
import { resolveRecordingUploadTarget } from '../lib/recording-upload-target.js';
import { S3AuthError, uploadRecordingFile, type UploadedSegment } from '../lib/recording-uploader.js';
import { StromClient, type MediaEntry } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { subscribeRecorderEvents, type RecorderFileEvent } from './strom-recorder-events.js';

/** How long a closed part's listed size must stay unchanged before it is uploaded. */
export const PART_STABLE_MS = 5000;

interface Log {
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
  error(obj: unknown, msg: string): void;
}

/** What deactivate needs to know about the live session it stopped. */
export interface LiveRecordingSession {
  /** `RecordingDoc.activationId` for this activation's parts: the Strom flow id. */
  activationId: string;
  /** Session stem of this activation's files, once one has been seen. */
  stem?: string;
}

interface LiveRecording {
  productionId: string;
  flowId: string;
  recorderBlockId: string;
  outputDir: string;
  recording?: ActiveRecording;
  log: Log;
  /** The newest file a recorder event announced: it is open, everything before it is closed. */
  openFile?: PartName;
  /** Parts of this activation uploaded so far, for part start times. */
  uploaded: UploadedSegment[];
  stopped: boolean;
  running: Promise<void> | undefined;
  /** A trigger arrived while a pass was running: run one more. */
  rerun: boolean;
  /** Ends a pending stability wait early on stop. */
  wake: (() => void) | undefined;
  unsubscribe: () => void;
}

const live = new Map<string, LiveRecording>();
let stableMs = PART_STABLE_MS;

/** The recorder's output directory, as the flow generator sets it. */
export function recordingOutputDir(productionId: string): string {
  return `recordings/${productionId}`;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

async function stromClient(): Promise<{ strom: StromClient; token: string | undefined }> {
  const token = await getStromToken(config.stromToken);
  return { strom: new StromClient({ baseUrl: config.stromUrl, token }), token };
}

/**
 * Starts uploading closed parts for a production that has just gone live with
 * a recorder (or was found live after a restart). A no-op with
 * `RECORDING_SEGMENT_SECS=0` (one file per activation, uploaded at deactivate)
 * or without a recorder. Replaces any session already running for it.
 */
export function startLiveRecordingUpload(
  doc: Pick<ProductionDoc, '_id' | 'stromFlowId' | 'recorderBlockId' | 'recording'>,
  log: Log,
): void {
  if (config.recordingSegmentSecs <= 0 || !doc.stromFlowId || !doc.recorderBlockId) return;
  const previous = live.get(doc._id);
  if (previous) void stopSession(previous);

  const rec: LiveRecording = {
    productionId: doc._id,
    flowId: doc.stromFlowId,
    recorderBlockId: doc.recorderBlockId,
    outputDir: recordingOutputDir(doc._id),
    ...(doc.recording ? { recording: doc.recording } : {}),
    log,
    uploaded: [],
    stopped: false,
    running: undefined,
    rerun: false,
    wake: undefined,
    unsubscribe: () => {},
  };
  live.set(doc._id, rec);
  rec.unsubscribe = subscribeRecorderEvents({
    onFileChanged: (event) => onFileChanged(rec, event),
    // Events sent while the socket was down are lost: sweep everything but the newest file.
    onConnected: () => trigger(rec),
  });
  log.info({ productionId: rec.productionId, flowId: rec.flowId }, 'live recording part upload started');
}

/**
 * Stops the production's live part upload and waits for a running pass to
 * finish, so the caller's own sweep cannot race it. Returns what the session
 * knew about this activation's files, or undefined when none was running.
 */
export async function stopLiveRecordingUpload(productionId: string): Promise<LiveRecordingSession | undefined> {
  const rec = live.get(productionId);
  if (!rec) return undefined;
  return stopSession(rec);
}

async function stopSession(rec: LiveRecording): Promise<LiveRecordingSession> {
  if (live.get(rec.productionId) === rec) live.delete(rec.productionId);
  rec.stopped = true;
  rec.unsubscribe();
  rec.wake?.();
  await rec.running?.catch(() => undefined);
  return { activationId: rec.flowId, ...(rec.openFile ? { stem: rec.openFile.stem } : {}) };
}

/** True while a live part upload runs for the production. */
export function isLiveRecordingUploadActive(productionId: string): boolean {
  return live.has(productionId);
}

/**
 * After a restart, resumes the live part upload for every production found
 * live with a recorder. Its first connect sweeps the parts closed while
 * open-live was down. Best-effort: a failure is logged and skipped.
 */
export async function resumeLiveRecordingUploads(log: Log): Promise<void> {
  if (config.recordingSegmentSecs <= 0) return;
  try {
    const result = await getDb().find({ selector: { type: 'production', status: 'active' } });
    for (const doc of result.docs as ProductionDoc[]) {
      if (doc.stromFlowId && doc.recorderBlockId) startLiveRecordingUpload(doc, log);
    }
  } catch (err) {
    log.warn({ err }, 'could not resume live recording part upload after restart');
  }
}

function onFileChanged(rec: LiveRecording, event: RecorderFileEvent): void {
  if (rec.stopped || event.flowId !== rec.flowId) return;
  // Strom may rename blocks it is given, so a file in our output directory counts too.
  const inOutputDir = event.filename.startsWith(`${rec.outputDir}/`) || event.filename.includes(`/${rec.outputDir}/`);
  if (event.blockId !== rec.recorderBlockId && !inOutputDir) return;
  const part = parsePartName(baseName(event.filename));
  if (!part) return;
  if (!rec.openFile || comparePartNames(part, rec.openFile) > 0) rec.openFile = part;
  trigger(rec);
}

/** Runs a pass now, or once more after the running one. */
function trigger(rec: LiveRecording): void {
  if (rec.stopped) return;
  if (rec.running) {
    rec.rerun = true;
    return;
  }
  rec.running = (async () => {
    try {
      do {
        rec.rerun = false;
        await runPass(rec).catch((err: unknown) => {
          rec.log.error({ err, productionId: rec.productionId }, 'live recording part upload pass failed — parts stay on Strom');
        });
      } while (rec.rerun && !rec.stopped);
    } finally {
      rec.running = undefined;
    }
  })();
}

function wait(rec: LiveRecording, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      rec.wake = undefined;
      resolve();
    }
    rec.wake = done;
  });
}

export interface ListedPart {
  entry: MediaEntry;
  part: PartName;
}

export function listParts(entries: MediaEntry[] | undefined): ListedPart[] {
  const parts: ListedPart[] = [];
  for (const entry of entries ?? []) {
    if (entry.is_dir) continue;
    const part = parsePartName(entry.name);
    if (part) parts.push({ entry, part });
  }
  return parts.sort((a, b) => comparePartNames(a.part, b.part));
}

/**
 * The closed parts in a listing: every file before the open one. The open one
 * is the newest of the file the last event announced and the newest listed
 * file, so a file the recorder may still be writing is never included.
 */
export function openPart(parts: ListedPart[], openFile: PartName | undefined): PartName | undefined {
  const newest = parts[parts.length - 1]?.part;
  if (!newest) return openFile;
  return openFile && comparePartNames(openFile, newest) > 0 ? openFile : newest;
}

/** Every listed part before the open one (see {@link openPart}). `parts` is sorted. */
export function closedParts(parts: ListedPart[], openFile: PartName | undefined): ListedPart[] {
  const open = openPart(parts, openFile);
  return open ? parts.filter((p) => comparePartNames(p.part, open) < 0) : [];
}

async function runPass(rec: LiveRecording): Promise<void> {
  const { strom, token } = await stromClient();
  const listed = listParts((await strom.media.list(rec.outputDir)).entries);
  const first = closedParts(listed, rec.openFile);
  // The newest listed file counts as open too (after a restart no event has
  // been seen yet); its stem is this activation's session.
  rec.openFile = openPart(listed, rec.openFile);
  if (first.length === 0 || rec.stopped) return;

  // Finalisation rule (OL-31d): only a part whose listed size has not changed
  // over `stableMs` is uploaded; anything else waits for the next trigger.
  await wait(rec, stableMs);
  if (rec.stopped) return;
  const now = new Map(listParts((await strom.media.list(rec.outputDir)).entries).map((p) => [p.entry.path, p.entry]));
  const stable = first.filter((p) => {
    const later = now.get(p.entry.path);
    return typeof p.entry.size === 'number' && p.entry.size > 0 && later?.size === p.entry.size;
  });
  for (const p of first) {
    if (!stable.includes(p)) {
      rec.log.warn({ productionId: rec.productionId, file: p.entry.path }, 'recording part size not stable yet — left on Strom for the next pass');
    }
  }
  if (stable.length === 0) return;

  const resolved = await resolveRecordingUploadTarget(rec.recording?.connectionId);
  if ('reason' in resolved) {
    rec.log.warn(
      { productionId: rec.productionId, reason: resolved.reason, err: resolved.err },
      `live recording part upload skipped — ${resolved.message} Parts stay on Strom for the deactivate upload.`,
    );
    return;
  }
  const { target } = resolved;

  for (const { entry, part } of stable) {
    if (rec.stopped) return;
    const logCtx = { productionId: rec.productionId, file: entry.path };
    let seg: UploadedSegment;
    try {
      seg = await uploadRecordingFile({ stromUrl: config.stromUrl, stromToken: token, productionId: rec.productionId, target }, entry);
    } catch (err) {
      rec.log.warn({ ...logCtx, err }, 'recording part upload failed — left on Strom for retry');
      // A rejected credential fails every other part the same way.
      if (err instanceof S3AuthError) return;
      continue;
    }
    if (seg.sizeBytes !== entry.size) {
      rec.log.warn(
        { ...logCtx, uploadedBytes: seg.sizeBytes, listedBytes: entry.size },
        'recording part upload size does not match Strom — left on Strom for retry',
      );
      continue;
    }

    const ofThisActivation = rec.openFile ? part.stem === rec.openFile.stem : undefined;
    const timings = recordingPartTimings([...rec.uploaded, seg], config.recordingSegmentSecs);
    const timing = timings[timings.length - 1]!;
    const finishedAt = new Date().toISOString();
    try {
      await upsertRecordingDoc(getRecordingsDb(), {
        type: 'recording',
        productionId: rec.productionId,
        ...(rec.recording?.outputId ? { outputId: rec.recording.outputId } : {}),
        ...(rec.recording?.connectionId ? { connectionId: rec.recording.connectionId } : {}),
        bucket: target.bucket,
        key: seg.key,
        sizeBytes: seg.sizeBytes,
        ...(seg.durationMs !== undefined ? { durationMs: seg.durationMs } : {}),
        startedAt: timing.startedAt ?? rec.recording?.startedAt ?? finishedAt,
        endedAt: timing.endedAt ?? finishedAt,
        ...(ofThisActivation ? { activationId: rec.flowId } : {}),
        partIndex: part.index,
        createdAt: finishedAt,
        updatedAt: finishedAt,
      });
    } catch (err) {
      rec.log.error({ ...logCtx, err }, 'recording part uploaded but not registered — left on Strom for retry');
      continue;
    }
    if (ofThisActivation) rec.uploaded.push(seg);

    try {
      await strom.media.deleteFile(entry.path);
    } catch (err) {
      // The part is stored and listed; the deactivate sweep re-uploads it and
      // updates the same RecordingDoc.
      rec.log.warn({ ...logCtx, err }, 'recording part uploaded but not deleted from Strom');
      continue;
    }
    rec.log.info({ ...logCtx, key: seg.key, sizeBytes: seg.sizeBytes }, 'recording part uploaded during the production');
  }
}

/** Overrides the stability wait. Tests only. */
export function setPartStableMsForTests(ms: number | undefined): void {
  stableMs = ms ?? PART_STABLE_MS;
}

/** Stops every session without waiting. Tests only. */
export function resetLiveRecordingUploads(): void {
  for (const rec of [...live.values()]) void stopSession(rec);
  live.clear();
}

/** Resolves once the production's running pass (and any queued rerun) is done. Tests only. */
export async function waitForLiveRecordingPass(productionId: string): Promise<void> {
  for (let rec = live.get(productionId); rec?.running; rec = live.get(productionId)) {
    await rec.running.catch(() => undefined);
  }
}
