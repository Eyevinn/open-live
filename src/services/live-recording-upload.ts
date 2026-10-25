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
 * Files are matched to the session by exact directory (spec
 * iso-input-recording.md §5.3): a file counts when its directory, after any
 * media-root prefix Strom adds, equals the recorder's output directory (or the
 * event names the recorder block). A file in a subdirectory — the per-input
 * recordings of OL-32 — never counts for the program session.
 *
 * Each session also records when open-live first saw each file open (spec §6):
 * that is the part's start time when it is registered, here or by the
 * deactivate sweep. Part 0 opens before the session starts (the flow starts
 * before the production is `active`), so a session first replays its flow's
 * buffered events, which activation keeps the socket open for. The subscription is kept for this even with
 * `RECORDING_SEGMENT_SECS=0`; only the upload passes are skipped then.
 *
 * One session runs per recorder (spec §5.3): program, and one per input the
 * activation records to its own files (OL-32, `ProductionDoc.inputRecordings`)
 * in `recordings/<productionId>/<mixerInput>/`. Input parts are uploaded to
 * `<productionId>/<mixerInput>/<file>` and registered with `kind: 'input'` and
 * the input's metadata.
 *
 * Passes run one at a time per recorder. Deactivate and production delete
 * call {@link stopLiveRecordingUpload} before their own teardown, which stops
 * every session of the production and waits for their running passes, so the
 * deactivate sweep never races them.
 */
import { config } from '../config.js';
import { getDb, getRecordingsDb } from '../db/index.js';
import type { ActiveInputRecording, ActiveRecording, ProductionDoc, RecorderType } from '../db/types.js';
import { inputRecordingFields } from '../lib/input-recording-metadata.js';
import {
  comparePartNames, parsePartName, resolvePartTimings,
  type KnownPartStart, type PartName, type PartOpenTime,
} from '../lib/recording-parts.js';
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
  /** When each file of the recorder was seen opening, by file base name (spec §6). */
  openedAt: Map<string, PartOpenTime>;
  /** Start (and duration) of every part registered while live, by `partKey` — for chaining (spec §6 rule 3). */
  known: Map<string, KnownPartStart>;
  /**
   * On the program session: the session of each input recorder of the
   * activation (OL-32), by stored mixerInput. Absent when no input recorded.
   */
  inputs?: Map<string, LiveRecordingSession>;
}

interface LiveRecording {
  productionId: string;
  flowId: string;
  recorderBlockId: string;
  outputDir: string;
  recorderType: RecorderType;
  recording?: ActiveRecording;
  /** Set on an input recorder's session (OL-32): the input it records. Absent for program. */
  input?: ActiveInputRecording;
  /** False with `RECORDING_SEGMENT_SECS=0`: the session only records open times. */
  uploadsLive: boolean;
  /** See {@link LiveRecordingSession.openedAt}. */
  openedAt: Map<string, PartOpenTime>;
  /** See {@link LiveRecordingSession.known}. */
  known: Map<string, KnownPartStart>;
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

/** Every recorder session of one production: program, then its inputs. */
interface ProductionSessions {
  program: LiveRecording;
  inputs: LiveRecording[];
}

const live = new Map<string, ProductionSessions>();
let stableMs = PART_STABLE_MS;

/** The recorder's output directory, as the flow generator sets it. */
export function recordingOutputDir(productionId: string): string {
  return `recordings/${productionId}`;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Whether a recorder event's file lies directly in `outputDir` (spec §5.3).
 * Strom reports media paths relative to its media root, but may prefix the
 * root itself, so a directory that ends in `/<outputDir>` matches too. A file
 * in a subdirectory of `outputDir` does not.
 */
export function isFileInDir(filename: string, outputDir: string): boolean {
  const slash = filename.lastIndexOf('/');
  if (slash < 0) return false;
  const dir = filename.slice(0, slash).replace(/\/+$/, '');
  const want = outputDir.replace(/^\/+|\/+$/g, '');
  return dir === want || dir.endsWith(`/${want}`);
}

async function stromClient(): Promise<{ strom: StromClient; token: string | undefined }> {
  const token = await getStromToken(config.stromToken);
  return { strom: new StromClient({ baseUrl: config.stromUrl, token }), token };
}

/**
 * Starts uploading closed parts for a production that has just gone live with
 * a recorder (or was found live after a restart). With
 * `RECORDING_SEGMENT_SECS=0` (one file per activation, uploaded at deactivate)
 * the session only records file open times (spec §6). A no-op without a
 * recorder. Replaces any session already running for it.
 */
export function startLiveRecordingUpload(
  doc: Pick<ProductionDoc, '_id' | 'stromFlowId' | 'recorderBlockId' | 'recorderType' | 'recording' | 'inputRecordings'>,
  log: Log,
): void {
  if (!doc.stromFlowId || !doc.recorderBlockId) return;
  const previous = live.get(doc._id);
  if (previous) void stopProduction(doc._id, previous);

  const newSession = (recorderBlockId: string, outputDir: string, input?: ActiveInputRecording): LiveRecording => ({
    productionId: doc._id,
    flowId: doc.stromFlowId!,
    recorderBlockId,
    outputDir,
    recorderType: doc.recorderType ?? 'recorder',
    ...(doc.recording ? { recording: doc.recording } : {}),
    ...(input ? { input } : {}),
    uploadsLive: config.recordingSegmentSecs > 0,
    openedAt: new Map(),
    known: new Map(),
    log,
    uploaded: [],
    stopped: false,
    running: undefined,
    rerun: false,
    wake: undefined,
    unsubscribe: () => {},
  });
  const sessions: ProductionSessions = {
    program: newSession(doc.recorderBlockId, recordingOutputDir(doc._id)),
    inputs: (doc.inputRecordings ?? []).map((input) => newSession(input.recorderBlockId, input.outputDir, input)),
  };
  live.set(doc._id, sessions);
  for (const rec of [sessions.program, ...sessions.inputs]) {
    rec.unsubscribe = subscribeRecorderEvents({
      onFileChanged: (event) => onFileChanged(rec, event),
      // Events sent while the socket was down are lost: sweep everything but the newest file.
      onConnected: () => trigger(rec),
    // Part 0 opened before this session existed (the flow starts before the
    // production is active): take this flow's buffered events first (spec §6).
    }, { replayFlowId: rec.flowId });
  }
  const rec = sessions.program;
  log.info(
    {
      productionId: rec.productionId, flowId: rec.flowId, recorderType: rec.recorderType, uploadsLive: rec.uploadsLive,
      inputs: sessions.inputs.map((r) => r.input!.mixerInput),
    },
    rec.uploadsLive ? 'live recording part upload started' : 'live recording session started (open times only, RECORDING_SEGMENT_SECS=0)',
  );
}

/**
 * Stops the production's live part upload and waits for a running pass to
 * finish, so the caller's own sweep cannot race it. Returns what the session
 * knew about this activation's files, or undefined when none was running.
 */
export async function stopLiveRecordingUpload(productionId: string): Promise<LiveRecordingSession | undefined> {
  const sessions = live.get(productionId);
  if (!sessions) return undefined;
  return stopProduction(productionId, sessions);
}

/** Stops every session of a production; returns the program session with its inputs'. */
async function stopProduction(productionId: string, sessions: ProductionSessions): Promise<LiveRecordingSession> {
  if (live.get(productionId) === sessions) live.delete(productionId);
  const [program, ...inputs] = await Promise.all([sessions.program, ...sessions.inputs].map(stopSession));
  if (inputs.length === 0) return program!;
  return {
    ...program!,
    inputs: new Map(inputs.map((session, i) => [sessions.inputs[i]!.input!.mixerInput, session])),
  };
}

async function stopSession(rec: LiveRecording): Promise<LiveRecordingSession> {
  rec.stopped = true;
  rec.unsubscribe();
  rec.wake?.();
  await rec.running?.catch(() => undefined);
  return {
    activationId: rec.flowId,
    ...(rec.openFile ? { stem: rec.openFile.stem } : {}),
    openedAt: rec.openedAt,
    known: rec.known,
  };
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
  // Strom may rename blocks it is given, so a file directly in our output
  // directory counts too — by exact directory, never by prefix (spec §5.3):
  // input recordings nest under the program directory.
  if (event.blockId !== rec.recorderBlockId && !isFileInDir(event.filename, rec.outputDir)) return;
  const name = baseName(event.filename);
  const part = parsePartName(name);
  if (!part) return;
  // First sighting of the file is its open time (spec §6 rule 2): when the
  // event was received, which for a replayed event is before this session.
  if (!rec.openedAt.has(name)) {
    rec.openedAt.set(name, {
      openedAtMs: event.receivedAtMs,
      ...(event.startUtcUs !== undefined ? { startUtcUs: event.startUtcUs } : {}),
    });
  }
  if (!rec.openFile || comparePartNames(part, rec.openFile) > 0) rec.openFile = part;
  trigger(rec);
}

/** Runs a pass now, or once more after the running one. */
function trigger(rec: LiveRecording): void {
  if (rec.stopped || !rec.uploadsLive) return;
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
    const logCtx = { productionId: rec.productionId, file: entry.path, ...(rec.input ? { mixerInput: rec.input.mixerInput } : {}) };
    let seg: UploadedSegment;
    try {
      seg = await uploadRecordingFile({
        stromUrl: config.stromUrl, stromToken: token, productionId: rec.productionId, target,
        ...(rec.input ? { mixerInput: rec.input.mixerInput } : {}),
      }, entry);
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
    const timings = resolvePartTimings([...rec.uploaded, seg], {
      segmentSecs: config.recordingSegmentSecs,
      openedAt: rec.openedAt,
      known: rec.known,
    });
    const timing = timings[timings.length - 1]!;
    const finishedAt = new Date().toISOString();
    const startedAt = timing.startedAt ?? rec.recording?.startedAt ?? finishedAt;
    const endedAt = timing.endedAt ?? finishedAt;
    try {
      // Program, or one input's own recording (OL-32): only this activation's
      // parts are known to hold this activation's source.
      const kindFields = rec.input
        ? await inputRecordingFields(rec.productionId, rec.input.mixerInput, ofThisActivation ? rec.input : undefined, { startedAt, endedAt })
        : { kind: 'program' as const };
      await upsertRecordingDoc(getRecordingsDb(), {
        type: 'recording',
        productionId: rec.productionId,
        ...(rec.recording?.outputId ? { outputId: rec.recording.outputId } : {}),
        ...(rec.recording?.connectionId ? { connectionId: rec.recording.connectionId } : {}),
        bucket: target.bucket,
        key: seg.key,
        sizeBytes: seg.sizeBytes,
        ...(seg.durationMs !== undefined ? { durationMs: seg.durationMs } : {}),
        startedAt,
        ...(timing.startedAtSource ? { startedAtSource: timing.startedAtSource } : {}),
        endedAt,
        ...(ofThisActivation ? { activationId: rec.flowId } : {}),
        partIndex: part.index,
        ...kindFields,
        // A leftover of an earlier activation may come from either block; only
        // this activation's parts are known to come from this recorder.
        ...(ofThisActivation ? { recorderType: rec.recorderType } : {}),
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
  for (const [productionId, sessions] of [...live.entries()]) void stopProduction(productionId, sessions);
  live.clear();
}

/** Resolves once the production's running pass (and any queued rerun) is done. Tests only. */
export async function waitForLiveRecordingPass(productionId: string): Promise<void> {
  for (;;) {
    const sessions = live.get(productionId);
    const running = sessions ? [sessions.program, ...sessions.inputs].filter((r) => r.running) : [];
    if (running.length === 0) return;
    await Promise.all(running.map((r) => r.running!.catch(() => undefined)));
  }
}
