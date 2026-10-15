/**
 * Per-activation recording index: a JSON sidecar, `recordings.json`, in the
 * activation's recordings directory on Strom. It maps each recorded input to
 * its source and guest, and gives every recorder file the wall-clock time it
 * was opened, so recordings can be joined to tally and tags afterwards.
 *
 * File times come from Strom's `RecorderFileChanged` event, which a recorder
 * sends when it opens a file — on its first buffer, so for a WHIP slot, when
 * the guest's media first arrives, not when the flow started. Strom that
 * reports the file's start on its pipeline clock gives `startMs`, exact
 * across a flow's recorders; `openedAtMs`, when open-live received the event,
 * is late by the event's delivery and the encoder's start-up, which differ
 * between an input's video and audio files by tens of ms.
 *
 * The sidecar is rewritten after each event and once more on close, which
 * deactivate does after the flow has stopped. Best-effort throughout: nothing
 * here may block activation or deactivation.
 */
import { config } from '../config.js';
import { getGuestInvitesDb, getGuestSessionsDb } from '../db/index.js';
import type { GuestSessionDoc, StreamType } from '../db/types.js';
import { RECORDING_INDEX_FILE } from '../lib/recording-uploader.js';
import { StromClient, type FlowEvent } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';

const OPEN_TIMEOUT_MS = 2000;
const RECONNECT_DELAY_MS = 5000;

export interface RecordedFile {
  /** Strom media path */
  path: string;
  /** When open-live received Strom's RecorderFileChanged for it (UTC ms) */
  openedAtMs: number;
  /** The file's t=0 on Strom's pipeline clock (UTC ms, may be fractional); absent if Strom does not report it */
  startMs?: number;
}

export interface RecorderIndexEntry {
  recorderBlockId: string;
  outputDir: string;
  /** The first file's startMs, or its openedAtMs without one; null until the recorder opens a file */
  startedAtMs: number | null;
  files: RecordedFile[];
}

export interface InputIndexEntry {
  sourceId: string;
  sourceName: string;
  streamType: StreamType;
  recordMode: 'passthrough' | 'transcode';
  outputDir: string;
  /**
   * One recorder per track, each writing its own files. Each file's timeline
   * starts at its startMs (else, less exactly, its openedAtMs), which is how a
   * track's files line up with the other's.
   */
  tracks: { video?: RecorderIndexEntry; audio?: RecorderIndexEntry };
  /** Guest sessions on this input during the activation, from the guest-session docs */
  guests: Array<{ inviteId: string; label?: string; joinedAt: string; leftAt?: string }>;
}

export interface RecordingIndex {
  version: 1;
  productionId: string;
  productionName: string;
  flowId: string;
  /** Strom media directory holding this activation's recordings and this file */
  dir: string;
  /** When open-live started the flow (UTC ms) */
  activatedAtMs: number;
  updatedAtMs: number;
  program: RecorderIndexEntry | null;
  inputs: Record<string, InputIndexEntry>;
}

export type RecordingIndexInit = Omit<RecordingIndex, 'version' | 'updatedAtMs' | 'program' | 'inputs'> & {
  program: { recorderBlockId: string; outputDir: string } | null;
  inputs: Array<Omit<InputIndexEntry, 'tracks' | 'guests'> & { mixerInput: string; blockIds: { video?: string; audio?: string } }>;
};

interface FileEvent {
  flowId: string;
  blockId: string;
  path: string;
  atMs: number;
  startMs?: number;
}

interface OpenIndex {
  productionId: string;
  closed: boolean;
  stopWs: () => void;
  /** Events received before bind, while the flow id is unknown */
  pending: FileEvent[];
  index: RecordingIndex | null;
  recorders: Map<string, RecorderIndexEntry>;
  dirty: boolean;
  writing: Promise<void> | null;
}

/** One activation's index, as returned by openRecordingIndex. */
export type RecordingIndexHandle = Readonly<Pick<OpenIndex, 'productionId'>>;

const open = new Map<string, OpenIndex>();

/**
 * Starts listening for recorder events. Call before the flow is created, so a
 * recorder that opens its first file at once is not missed. Closes any index
 * still open for the production.
 */
export async function openRecordingIndex(productionId: string): Promise<RecordingIndexHandle> {
  await closeRecordingIndex(productionId);
  const entry: OpenIndex = {
    productionId,
    closed: false,
    stopWs: () => {},
    pending: [],
    index: null,
    recorders: new Map(),
    dirty: false,
    writing: null,
  };
  open.set(productionId, entry);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, OPEN_TIMEOUT_MS);
    connect(entry, () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return entry;
}

/**
 * A client with a current token: in OSC mode the token is a short-lived SAT
 * that getStromToken refreshes, so one taken at open would expire mid-show.
 */
async function stromClient(): Promise<StromClient> {
  return new StromClient({ baseUrl: config.stromUrl, token: await getStromToken(config.stromToken) });
}

function connect(entry: OpenIndex, onOpen?: () => void): void {
  if (entry.closed) return;
  const retry = () => {
    if (!entry.closed) setTimeout(() => connect(entry), RECONNECT_DELAY_MS).unref?.();
  };
  void stromClient()
    .then((strom) => {
      if (entry.closed) return;
      entry.stopWs = strom.connectWebSocket((event) => onEvent(entry, event), retry, onOpen);
    })
    .catch((err: unknown) => {
      console.warn(`[recording-index] ${entry.productionId}: cannot listen for recorder events, retrying`, err);
      retry();
    });
}

function onEvent(entry: OpenIndex, event: FlowEvent): void {
  if (entry.closed) return;
  if (event.type === 'RecorderFileChanged') {
    const { flow_id, block_id, filename, start_utc_us } = event.data;
    const fileEvent: FileEvent = {
      flowId: flow_id,
      blockId: block_id,
      path: filename,
      atMs: Date.now(),
      ...(typeof start_utc_us === 'number' && Number.isFinite(start_utc_us) && { startMs: start_utc_us / 1000 }),
    };
    if (entry.index) applyFileEvent(entry, fileEvent);
    else entry.pending.push(fileEvent);
    return;
  }
  if ((event.type === 'FlowDeleted' || event.type === 'FlowStopped') && event.data.flow_id === entry.index?.flowId) {
    void closeRecordingIndex(entry);
  }
}

function applyFileEvent(entry: OpenIndex, event: FileEvent): void {
  if (event.flowId !== entry.index?.flowId) return;
  const recorder = entry.recorders.get(event.blockId);
  if (!recorder || recorder.files.some((f) => f.path === event.path)) return;
  recorder.files.push({ path: event.path, openedAtMs: event.atMs, ...(event.startMs !== undefined && { startMs: event.startMs }) });
  recorder.startedAtMs ??= event.startMs ?? event.atMs;
  scheduleWrite(entry);
}

/** The production's open index, if any. */
export function currentRecordingIndex(productionId: string): RecordingIndexHandle | undefined {
  return open.get(productionId);
}

/** Sets what this activation records and writes the first sidecar. */
export function bindRecordingIndex(handle: RecordingIndexHandle, init: RecordingIndexInit): void {
  const entry = handle as OpenIndex;
  if (entry.closed) return;
  const program = init.program ? { ...init.program, startedAtMs: null, files: [] } : null;
  const inputs: Record<string, InputIndexEntry> = {};
  for (const { mixerInput, blockIds, ...input } of init.inputs) {
    const tracks: InputIndexEntry['tracks'] = {};
    for (const track of ['video', 'audio'] as const) {
      const recorderBlockId = blockIds[track];
      if (recorderBlockId) tracks[track] = { recorderBlockId, outputDir: input.outputDir, startedAtMs: null, files: [] };
    }
    inputs[mixerInput] = { ...input, tracks, guests: [] };
  }
  entry.index = { ...init, version: 1, updatedAtMs: Date.now(), program, inputs };
  if (program) entry.recorders.set(program.recorderBlockId, program);
  for (const input of Object.values(inputs)) {
    for (const recorder of Object.values(input.tracks)) entry.recorders.set(recorder.recorderBlockId, recorder);
  }
  for (const event of entry.pending.splice(0)) applyFileEvent(entry, event);
  scheduleWrite(entry);
}

/**
 * Stops listening and waits for a final write. Given a production id, closes
 * whatever index is open for it; given a handle, only that one.
 */
export async function closeRecordingIndex(target: string | RecordingIndexHandle): Promise<void> {
  const entry = typeof target === 'string' ? open.get(target) : (target as OpenIndex);
  // An index stops being the production's current one only by being closed.
  if (!entry || entry.closed) return;
  open.delete(entry.productionId);
  entry.closed = true;
  entry.stopWs();
  if (entry.index) scheduleWrite(entry);
  await entry.writing;
}

function scheduleWrite(entry: OpenIndex): void {
  entry.dirty = true;
  if (entry.writing) return;
  entry.writing = (async () => {
    while (entry.dirty) {
      entry.dirty = false;
      await write(entry).catch((err) => {
        console.warn(`[recording-index] ${entry.index?.productionId}: sidecar write failed`, err);
      });
    }
    entry.writing = null;
  })();
}

async function write(entry: OpenIndex): Promise<void> {
  const index = entry.index;
  if (!index) return;
  await refreshGuests(index);
  index.updatedAtMs = Date.now();
  await (await stromClient()).media.upload(index.dir, RECORDING_INDEX_FILE, JSON.stringify(index, null, 2));
}

/** Guest sessions on recorded inputs touched since the activation started. */
async function refreshGuests(index: RecordingIndex): Promise<void> {
  const since = new Date(index.activatedAtMs).toISOString();
  let sessions: GuestSessionDoc[];
  try {
    const res = await getGuestSessionsDb().find({ selector: { type: 'guest-session', productionId: index.productionId } });
    sessions = (Array.isArray(res?.docs) ? res.docs : []).filter((s) => s.updatedAt >= since && s.mixerInput in index.inputs);
  } catch {
    return;
  }
  const labels = new Map<string, string | undefined>();
  for (const inviteId of new Set(sessions.map((s) => s.inviteId))) {
    labels.set(inviteId, await getGuestInvitesDb().get(inviteId).then((i) => i.label, () => undefined));
  }
  for (const [mixerInput, input] of Object.entries(index.inputs)) {
    input.guests = sessions
      .filter((s) => s.mixerInput === mixerInput)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((s) => ({
        inviteId: s.inviteId,
        ...(labels.get(s.inviteId) !== undefined && { label: labels.get(s.inviteId) }),
        joinedAt: s.createdAt,
        ...((s.state === 'left' || s.state === 'error') && { leftAt: s.updatedAt }),
      }));
  }
}
