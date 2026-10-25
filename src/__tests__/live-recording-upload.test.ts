/**
 * Live recording part upload (issue #556): RecorderFileChanged for part N
 * uploads the closed parts before it, the reconnect sweep never touches the
 * newest file, a part is deleted from Strom only after a stable size, a
 * matching byte count and a successful registration, a failed part is retried
 * by the next trigger, and stopping tears the listener down.
 *
 * Strom, the event socket, the uploader and CouchDB are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockList = vi.fn();
const mockDeleteFile = vi.fn();
vi.mock('../lib/strom.js', () => ({
  StromClient: class {
    media = { list: mockList, deleteFile: mockDeleteFile };
  },
}));

vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue('tok') }));

const recordingDocs = new Map<string, Record<string, unknown>>();
const mockRecInsert = vi.fn();
const mockFind = vi.fn();
vi.mock('../db/index.js', () => ({
  getDb: () => ({ find: mockFind }),
  getRecordingsDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = recordingDocs.get(id);
      if (!doc) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return doc;
    }),
    insert: mockRecInsert,
  }),
}));

const target = { endpoint: 'silo.local', useSsl: true, region: 'us-east-1', accessKey: 'a', secretKey: 's', bucket: 'vod' };
const mockResolveTarget = vi.fn();
vi.mock('../lib/recording-upload-target.js', () => ({
  resolveRecordingUploadTarget: (...args: unknown[]) => mockResolveTarget(...args),
}));

const mockUploadFile = vi.fn();
vi.mock('../lib/recording-uploader.js', async (orig) => {
  const actual = await orig<typeof import('../lib/recording-uploader.js')>();
  return { ...actual, uploadRecordingFile: (...args: unknown[]) => mockUploadFile(...args) };
});

import { config as realConfig } from '../config.js';
import { S3AuthError } from '../lib/recording-uploader.js';
import { recordingDocId } from '../lib/recording-registry.js';
import {
  setRecorderSocketFactory,
  resetRecorderEvents,
  recorderEventSubscriberCount,
  type RecorderSocketHandlers,
} from '../services/strom-recorder-events.js';
import {
  startLiveRecordingUpload,
  stopLiveRecordingUpload,
  resumeLiveRecordingUploads,
  isLiveRecordingUploadActive,
  setPartStableMsForTests,
  resetLiveRecordingUploads,
  waitForLiveRecordingPass,
} from '../services/live-recording-upload.js';

/** The config object is mutable at runtime; its type is read-only. */
const config = realConfig as { recordingSegmentSecs: number };

const PROD = 'prod-1';
const DIR = `recordings/${PROD}`;
const STEM = `${PROD}_20261022_080000`;
const name = (i: number, stem = STEM) => `${stem}_${String(i).padStart(5, '0')}.mp4`;
const entry = (i: number, size = 1000 + i, stem = STEM) => ({ name: name(i, stem), path: `${DIR}/${name(i, stem)}`, is_dir: false, size });

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const doc = {
  _id: PROD,
  stromFlowId: 'flow-1',
  recorderBlockId: 'rec-1',
  recording: { outputId: 'out-rec', startedAt: '2026-10-22T08:00:00.000Z' },
};

let socket: RecorderSocketHandlers | undefined;
let segmentSecs: number;

function fileChanged(i: number, over: Partial<{ flow_id: string; block_id: string; filename: string; start_utc_us: number }> = {}) {
  socket!.onEvent({
    type: 'RecorderFileChanged',
    data: { flow_id: 'flow-1', block_id: 'rec-1', filename: `${DIR}/${name(i)}`, ...over },
  });
}

/** Strom's listing, as a mutable list of entries. */
let listing: Array<ReturnType<typeof entry>>;

beforeEach(async () => {
  vi.clearAllMocks();
  recordingDocs.clear();
  segmentSecs = config.recordingSegmentSecs;
  config.recordingSegmentSecs = 60;
  setPartStableMsForTests(0);
  socket = undefined;
  setRecorderSocketFactory(async (h) => {
    socket = h;
    return () => {};
  });
  listing = [];
  mockList.mockImplementation(async () => ({ entries: listing.map((e) => ({ ...e })) }));
  mockDeleteFile.mockImplementation(async (path: string) => {
    listing = listing.filter((e) => e.path !== path);
    return { success: true };
  });
  mockResolveTarget.mockResolvedValue({ target });
  mockUploadFile.mockImplementation(async (_args: unknown, e: { name: string; path: string }) => ({
    key: `${PROD}/${e.name}`,
    sizeBytes: listing.find((l) => l.path === e.path)!.size,
    stromPath: e.path,
    startedAt: '2026-10-22T08:00:00.000Z',
    durationMs: 60_000,
  }));
  mockRecInsert.mockImplementation(async (d: Record<string, unknown>) => {
    const id = d['_id'] as string;
    const existing = recordingDocs.get(id);
    if (existing && existing['_rev'] !== d['_rev']) throw Object.assign(new Error('conflict'), { statusCode: 409 });
    recordingDocs.set(id, { ...d, _rev: `${Number(String(existing?.['_rev'] ?? '0').split('-')[0]) + 1}-x` });
    return { ok: true };
  });
});

afterEach(() => {
  resetLiveRecordingUploads();
  resetRecorderEvents();
  setRecorderSocketFactory(undefined);
  setPartStableMsForTests(undefined);
  config.recordingSegmentSecs = segmentSecs;
});

async function started(): Promise<void> {
  startLiveRecordingUpload(doc, log);
  await vi.waitFor(() => expect(socket).toBeDefined());
}

const uploadedPaths = () => mockUploadFile.mock.calls.map((c) => (c[1] as { path: string }).path);

describe('live recording part upload — event to upload mapping', () => {
  it('uploads, registers and deletes part N-1 when part N opens; leaves N alone', async () => {
    listing = [entry(0), entry(1)];
    await started();
    fileChanged(1);
    await waitForLiveRecordingPass(PROD);

    expect(uploadedPaths()).toEqual([`${DIR}/${name(0)}`]);
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith(`${DIR}/${name(0)}`);
    const reg = recordingDocs.get(recordingDocId('vod', `${PROD}/${name(0)}`));
    expect(reg).toMatchObject({
      productionId: PROD,
      outputId: 'out-rec',
      bucket: 'vod',
      key: `${PROD}/${name(0)}`,
      sizeBytes: 1000,
      durationMs: 60_000,
      activationId: 'flow-1',
      partIndex: 0,
      startedAt: '2026-10-22T08:00:00.000Z',
      // Part 0 opened before the session subscribed: the name stamp (spec §6 rule 4).
      startedAtSource: 'filename',
      endedAt: '2026-10-22T08:01:00.000Z',
      kind: 'program',
      recorderType: 'recorder',
    });
    expect(listing.map((e) => e.name)).toEqual([name(1)]);
  });

  it('chains a part no event was seen for from its predecessor (spec §6 rule 3)', async () => {
    listing = [entry(0), entry(1), entry(2)];
    await started();
    socket!.onOpen();
    await waitForLiveRecordingPass(PROD);
    expect(recordingDocs.get(recordingDocId('vod', `${PROD}/${name(0)}`))).toMatchObject({
      startedAt: '2026-10-22T08:00:00.000Z', startedAtSource: 'filename',
    });
    expect(recordingDocs.get(recordingDocId('vod', `${PROD}/${name(1)}`))).toMatchObject({
      partIndex: 1, startedAt: '2026-10-22T08:01:00.000Z', startedAtSource: 'chained', endedAt: '2026-10-22T08:02:00.000Z',
    });
  });

  it('starts a part at the time its RecorderFileChanged arrived (spec §6 rule 2)', async () => {
    const opened = Date.parse('2026-10-22T08:01:00.250Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(opened);
    listing = [entry(0), entry(1)];
    await started();
    fileChanged(1);
    await waitForLiveRecordingPass(PROD);
    now.mockRestore();
    listing.push(entry(2));
    fileChanged(2);
    await waitForLiveRecordingPass(PROD);
    expect(recordingDocs.get(recordingDocId('vod', `${PROD}/${name(1)}`))).toMatchObject({
      partIndex: 1, startedAt: '2026-10-22T08:01:00.250Z', startedAtSource: 'event', endedAt: '2026-10-22T08:02:00.250Z',
    });
  });

  it("prefers Strom's start_utc_us over the receipt time (spec §6 rule 1)", async () => {
    listing = [entry(0), entry(1)];
    await started();
    fileChanged(1, { start_utc_us: Date.parse('2026-10-22T08:01:00.004Z') * 1000 });
    listing.push(entry(2));
    fileChanged(2);
    await waitForLiveRecordingPass(PROD);
    expect(recordingDocs.get(recordingDocId('vod', `${PROD}/${name(1)}`))).toMatchObject({
      startedAt: '2026-10-22T08:01:00.004Z', startedAtSource: 'strom',
    });
  });

  it('stamps recorderType from the activation (Live Recorder)', async () => {
    listing = [entry(0), entry(1)];
    startLiveRecordingUpload({ ...doc, recorderType: 'liverecorder' }, log);
    await vi.waitFor(() => expect(socket).toBeDefined());
    fileChanged(1);
    await waitForLiveRecordingPass(PROD);
    expect(recordingDocs.get(recordingDocId('vod', `${PROD}/${name(0)}`))).toMatchObject({
      kind: 'program', recorderType: 'liverecorder',
    });
  });

  it('treats N-1 as closed even before the listing shows file N', async () => {
    listing = [entry(0)];
    await started();
    fileChanged(1);
    await waitForLiveRecordingPass(PROD);
    expect(uploadedPaths()).toEqual([`${DIR}/${name(0)}`]);
  });

  it('ignores events from another flow or recorder', async () => {
    listing = [entry(0), entry(1)];
    await started();
    fileChanged(1, { flow_id: 'other-flow' });
    socket!.onEvent({
      type: 'RecorderFileChanged',
      data: { flow_id: 'flow-1', block_id: 'other-rec', filename: `recordings/other/${name(1)}` },
    });
    await waitForLiveRecordingPass(PROD);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('matches files by exact directory: an event from a nested input directory is ignored (spec §5.3)', async () => {
    listing = [entry(0), entry(1)];
    await started();
    // An input recorder's file under the program directory, from another block.
    socket!.onEvent({
      type: 'RecorderFileChanged',
      data: {
        flow_id: 'flow-1',
        block_id: 'b-inrec-2',
        filename: `${DIR}/video_in_2/${PROD}_video_in_2_20261022_080000_00007.mp4`,
      },
    });
    await waitForLiveRecordingPass(PROD);
    expect(mockList).not.toHaveBeenCalled();
    const session = await stopLiveRecordingUpload(PROD);
    expect(session?.stem).toBeUndefined();
    expect(session?.openedAt.size).toBe(0);
  });

  it('matches a file in the output directory behind a media-root prefix, whatever the block id', async () => {
    listing = [entry(0), entry(1)];
    await started();
    fileChanged(1, { block_id: 'renamed-by-strom', filename: `/data/media/${DIR}/${name(1)}` });
    await waitForLiveRecordingPass(PROD);
    expect(uploadedPaths()).toEqual([`${DIR}/${name(0)}`]);
  });

  it('with RECORDING_SEGMENT_SECS=0 keeps the subscription for open times but never uploads', async () => {
    config.recordingSegmentSecs = 0;
    listing = [entry(0)];
    await started();
    expect(isLiveRecordingUploadActive(PROD)).toBe(true);
    expect(recorderEventSubscriberCount()).toBe(1);
    socket!.onOpen();
    fileChanged(0);
    await waitForLiveRecordingPass(PROD);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockUploadFile).not.toHaveBeenCalled();
    const session = await stopLiveRecordingUpload(PROD);
    expect(session?.stem).toBe(STEM);
    expect(session?.openedAt.get(name(0))?.openedAtMs).toEqual(expect.any(Number));
    expect(recorderEventSubscriberCount()).toBe(0);
  });
});

describe('live recording part upload — reconnect sweep', () => {
  it('uploads every file except the newest by index after a (re)connect', async () => {
    listing = [entry(2), entry(0), entry(1)];
    await started();
    socket!.onOpen();
    await waitForLiveRecordingPass(PROD);
    expect(uploadedPaths()).toEqual([`${DIR}/${name(0)}`, `${DIR}/${name(1)}`]);
    expect(mockDeleteFile).not.toHaveBeenCalledWith(`${DIR}/${name(2)}`);
    expect(listing.map((e) => e.name)).toEqual([name(2)]);
  });

  it('never touches a lone file, the one still open', async () => {
    listing = [entry(0)];
    await started();
    socket!.onOpen();
    await waitForLiveRecordingPass(PROD);
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('counts the newest session as open: an earlier session leftover is uploaded without activationId', async () => {
    const OLD = `${PROD}_20261021_200000`;
    listing = [entry(7, 500, OLD), entry(0)];
    await started();
    socket!.onOpen();
    await waitForLiveRecordingPass(PROD);
    expect(uploadedPaths()).toEqual([`${DIR}/${name(7, OLD)}`]);
    const reg = recordingDocs.get(recordingDocId('vod', `${PROD}/${name(7, OLD)}`));
    expect(reg?.['partIndex']).toBe(7);
    expect(reg?.['activationId']).toBeUndefined();
  });

  it('resumes after a restart for every live production with a recorder', async () => {
    mockFind.mockResolvedValue({ docs: [doc, { _id: 'prod-2', stromFlowId: 'flow-2' }] });
    await resumeLiveRecordingUploads(log);
    expect(isLiveRecordingUploadActive(PROD)).toBe(true);
    expect(isLiveRecordingUploadActive('prod-2')).toBe(false);
  });
});

describe('live recording part upload — finalisation and verification', () => {
  it('leaves a part whose size is still changing', async () => {
    listing = [entry(0), entry(1)];
    let calls = 0;
    mockList.mockImplementation(async () => {
      calls++;
      return { entries: listing.map((e) => (calls > 1 && e.name === name(0) ? { ...e, size: e.size + 10 } : { ...e })) };
    });
    await started();
    fileChanged(1);
    await waitForLiveRecordingPass(PROD);
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('keeps the part on Strom and unlisted when the uploaded bytes differ from the listing', async () => {
    listing = [entry(0), entry(1)];
    mockUploadFile.mockResolvedValueOnce({ key: `${PROD}/${name(0)}`, sizeBytes: 999, stromPath: `${DIR}/${name(0)}` });
    await started();
    fileChanged(1);
    await waitForLiveRecordingPass(PROD);
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(recordingDocs.size).toBe(0);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('keeps the part on Strom when registration fails', async () => {
    listing = [entry(0), entry(1)];
    mockRecInsert.mockRejectedValue(Object.assign(new Error('db down'), { statusCode: 503 }));
    await started();
    fileChanged(1);
    await waitForLiveRecordingPass(PROD);
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('keeps every part on Strom when the storage target cannot be resolved', async () => {
    listing = [entry(0), entry(1)];
    mockResolveTarget.mockResolvedValue({ reason: 'connection-not-found', message: 'gone.' });
    await started();
    fileChanged(1);
    await waitForLiveRecordingPass(PROD);
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });
});

describe('live recording part upload — retry after failure', () => {
  it('retries a failed part on the next event and lists it exactly once', async () => {
    listing = [entry(0), entry(1)];
    mockUploadFile.mockRejectedValueOnce(new Error('S3 UploadPart 1 failed: 503'));
    await started();
    fileChanged(1);
    await waitForLiveRecordingPass(PROD);
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(recordingDocs.size).toBe(0);

    listing.push(entry(2));
    fileChanged(2);
    await waitForLiveRecordingPass(PROD);
    expect(uploadedPaths()).toEqual([`${DIR}/${name(0)}`, `${DIR}/${name(0)}`, `${DIR}/${name(1)}`]);
    expect([...recordingDocs.values()].map((d) => d['key'])).toEqual([`${PROD}/${name(0)}`, `${PROD}/${name(1)}`]);
    expect(listing.map((e) => e.name)).toEqual([name(2)]);
  });

  it('a part whose Strom delete failed is re-uploaded later and updates the same RecordingDoc', async () => {
    listing = [entry(0), entry(1)];
    mockDeleteFile.mockRejectedValueOnce(new Error('Strom 500'));
    await started();
    fileChanged(1);
    await waitForLiveRecordingPass(PROD);
    socket!.onOpen();
    await waitForLiveRecordingPass(PROD);
    expect(uploadedPaths()).toEqual([`${DIR}/${name(0)}`, `${DIR}/${name(0)}`]);
    expect(recordingDocs.size).toBe(1);
    expect(listing.map((e) => e.name)).toEqual([name(1)]);
  });

  it('stops the pass on an object-store auth error', async () => {
    listing = [entry(0), entry(1), entry(2)];
    mockUploadFile.mockRejectedValueOnce(new S3AuthError('AccessDenied', 'S3 PutObject failed: 403'));
    await started();
    fileChanged(2);
    await waitForLiveRecordingPass(PROD);
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });
});

describe('live recording part upload — teardown', () => {
  it('unsubscribes from recorder events on stop and reports the session', async () => {
    listing = [entry(0)];
    await started();
    fileChanged(0);
    await waitForLiveRecordingPass(PROD);
    expect(recorderEventSubscriberCount()).toBe(1);
    const session = await stopLiveRecordingUpload(PROD);
    expect(session).toMatchObject({ activationId: 'flow-1', stem: STEM });
    expect([...session!.openedAt.keys()]).toEqual([name(0)]);
    expect(recorderEventSubscriberCount()).toBe(0);
    expect(isLiveRecordingUploadActive(PROD)).toBe(false);
    // Events after stop do nothing.
    mockList.mockClear();
    fileChanged(1);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('waits for the running upload before returning, and starts no further part', async () => {
    listing = [entry(0), entry(1), entry(2)];
    let release!: () => void;
    mockUploadFile.mockImplementationOnce(async (_a: unknown, e: { name: string; path: string }) => {
      await new Promise<void>((r) => (release = r));
      return { key: `${PROD}/${e.name}`, sizeBytes: 1000, stromPath: e.path };
    });
    await started();
    fileChanged(2);
    await vi.waitFor(() => expect(mockUploadFile).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = stopLiveRecordingUpload(PROD).then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);
    release();
    await stopping;
    // The in-flight part finished; part 1 was not started after the stop.
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when nothing was running', async () => {
    expect(await stopLiveRecordingUpload('nope')).toBeUndefined();
  });
});
