/**
 * OL-32 input recording parts — live upload and registration (spec
 * iso-input-recording.md §5.2, §5.3, §3.1):
 *  - one live session per recorder: an input's parts are uploaded from its own
 *    directory to `<productionId>/<mixerInput>/<file>` and registered with
 *    `kind: 'input'`, mixerInput, sourceId, sourceName, streamType and, for a
 *    WHIP input, the overlapping guests;
 *  - events for an input file never move the program session;
 *  - a retried input part updates its RecordingDoc (idempotent by bucket+key);
 *  - stopping returns every session, inputs by mixerInput.
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
const mockGuestFind = vi.fn();
const mockInviteGet = vi.fn();
vi.mock('../db/index.js', () => ({
  getDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getRecordingsDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = recordingDocs.get(id);
      if (!doc) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return doc;
    }),
    insert: mockRecInsert,
  }),
  getGuestSessionsDb: () => ({ find: mockGuestFind }),
  getGuestInvitesDb: () => ({ get: mockInviteGet }),
}));

const target = { endpoint: 'silo.local', useSsl: true, region: 'us-east-1', accessKey: 'a', secretKey: 's', bucket: 'vod' };
vi.mock('../lib/recording-upload-target.js', () => ({
  resolveRecordingUploadTarget: vi.fn(async () => ({ target })),
}));

const mockUploadFile = vi.fn();
vi.mock('../lib/recording-uploader.js', async (orig) => {
  const actual = await orig<typeof import('../lib/recording-uploader.js')>();
  return { ...actual, uploadRecordingFile: (...args: unknown[]) => mockUploadFile(...args) };
});

import { config as realConfig } from '../config.js';
import { recordingDocId } from '../lib/recording-registry.js';
import { setRecorderSocketFactory, resetRecorderEvents, type RecorderSocketHandlers } from '../services/strom-recorder-events.js';
import {
  startLiveRecordingUpload, stopLiveRecordingUpload, setPartStableMsForTests,
  resetLiveRecordingUploads, waitForLiveRecordingPass,
} from '../services/live-recording-upload.js';

const config = realConfig as { recordingSegmentSecs: number };

const PROD = 'prod-iso';
const PGM_DIR = `recordings/${PROD}`;
const IN = 'video_in_15';
const IN_DIR = `${PGM_DIR}/${IN}`;
const IN_STEM = `${PROD}_${IN}_20261101_180000`;
const PGM_STEM = `${PROD}_20261101_180000`;
const fileName = (stem: string, i: number) => `${stem}_${String(i).padStart(5, '0')}.mp4`;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const doc = {
  _id: PROD,
  stromFlowId: 'flow-iso',
  recorderBlockId: 'b-out-pgm',
  recorderType: 'liverecorder' as const,
  recording: { outputId: 'out-rec', connectionId: 'conn-1', startedAt: '2026-11-01T18:00:00.000Z' },
  inputRecordings: [{
    mixerInput: IN, sourceId: 'Whip', sourceName: 'Guest 1 · In 16', streamType: 'whip' as const,
    recorderBlockId: 'b-inrec-15', outputDir: IN_DIR,
  }],
};

/** Strom's listing by directory. */
let listings: Record<string, Array<{ name: string; path: string; is_dir: boolean; size: number }>>;
let socket: RecorderSocketHandlers | undefined;
let segmentSecs: number;

function put(dir: string, stem: string, i: number, size = 2000 + i) {
  (listings[dir] ??= []).push({ name: fileName(stem, i), path: `${dir}/${fileName(stem, i)}`, is_dir: false, size });
}

function fileChanged(blockId: string, dir: string, stem: string, i: number) {
  socket!.onEvent({
    type: 'RecorderFileChanged',
    data: { flow_id: 'flow-iso', block_id: blockId, filename: `${dir}/${fileName(stem, i)}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  recordingDocs.clear();
  segmentSecs = config.recordingSegmentSecs;
  config.recordingSegmentSecs = 300;
  setPartStableMsForTests(0);
  socket = undefined;
  setRecorderSocketFactory(async (h) => { socket = h; return () => {}; });
  listings = {};
  mockList.mockImplementation(async (dir: string) => ({ entries: (listings[dir] ?? []).map((e) => ({ ...e })) }));
  mockDeleteFile.mockImplementation(async (path: string) => {
    for (const dir of Object.keys(listings)) listings[dir] = listings[dir]!.filter((e) => e.path !== path);
    return { success: true };
  });
  mockUploadFile.mockImplementation(async (args: { productionId: string; mixerInput?: string }, e: { name: string; path: string }) => {
    const dir = e.path.slice(0, e.path.lastIndexOf('/'));
    return {
      key: args.mixerInput ? `${args.productionId}/${args.mixerInput}/${e.name}` : `${args.productionId}/${e.name}`,
      sizeBytes: listings[dir]!.find((l) => l.path === e.path)!.size,
      stromPath: e.path,
      startedAt: '2026-11-01T18:00:00.000Z',
      durationMs: 300_000,
    };
  });
  mockRecInsert.mockImplementation(async (d: Record<string, unknown>) => {
    const id = d['_id'] as string;
    const existing = recordingDocs.get(id);
    if (existing && existing['_rev'] !== d['_rev']) throw Object.assign(new Error('conflict'), { statusCode: 409 });
    recordingDocs.set(id, { ...d, _rev: `${Number(String(existing?.['_rev'] ?? '0').split('-')[0]) + 1}-x` });
    return { ok: true };
  });
  mockGuestFind.mockResolvedValue({
    docs: [
      // Left before the part started: not on it.
      { inviteId: 'inv-old', mixerInput: IN, state: 'left', createdAt: '2026-11-01T17:00:00.000Z', updatedAt: '2026-11-01T17:30:00.000Z' },
      { inviteId: 'inv-anna', mixerInput: IN, state: 'left', createdAt: '2026-11-01T17:59:00.000Z', updatedAt: '2026-11-01T18:02:00.000Z' },
      { inviteId: 'inv-bo', mixerInput: IN, state: 'joined', createdAt: '2026-11-01T18:03:00.000Z', updatedAt: '2026-11-01T18:03:00.000Z' },
    ],
  });
  mockInviteGet.mockImplementation(async (id: string) => {
    if (id === 'inv-anna') return { _id: id, label: 'Anna' };
    if (id === 'inv-bo') return { _id: id };
    throw Object.assign(new Error('missing'), { statusCode: 404 });
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

describe('live upload of input parts (spec §5.3)', () => {
  it("uploads a closed input part to the input's key and registers its metadata", async () => {
    put(IN_DIR, IN_STEM, 0);
    put(IN_DIR, IN_STEM, 1);
    put(PGM_DIR, PGM_STEM, 0);
    await started();
    const opened = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T18:05:00.040Z'));
    fileChanged('b-inrec-15', IN_DIR, IN_STEM, 1);
    opened.mockRestore();
    await waitForLiveRecordingPass(PROD);

    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockUploadFile.mock.calls[0]![0]).toMatchObject({ productionId: PROD, mixerInput: IN });
    expect(mockUploadFile.mock.calls[0]![1]).toMatchObject({ path: `${IN_DIR}/${fileName(IN_STEM, 0)}` });
    const key = `${PROD}/${IN}/${fileName(IN_STEM, 0)}`;
    expect(recordingDocs.get(recordingDocId('vod', key))).toMatchObject({
      type: 'recording',
      productionId: PROD,
      outputId: 'out-rec',
      connectionId: 'conn-1',
      bucket: 'vod',
      key,
      kind: 'input',
      mixerInput: IN,
      sourceId: 'Whip',
      sourceName: 'Guest 1 · In 16',
      streamType: 'whip',
      activationId: 'flow-iso',
      recorderType: 'liverecorder',
      partIndex: 0,
      guests: [
        { inviteId: 'inv-anna', label: 'Anna', joinedAt: '2026-11-01T17:59:00.000Z', leftAt: '2026-11-01T18:02:00.000Z' },
        { inviteId: 'inv-bo', joinedAt: '2026-11-01T18:03:00.000Z' },
      ],
      guestLabel: 'Anna',
    });
    expect(mockDeleteFile).toHaveBeenCalledWith(`${IN_DIR}/${fileName(IN_STEM, 0)}`);
    // The program directory was not touched by the input event.
    expect(listings[PGM_DIR]!.map((e) => e.name)).toEqual([fileName(PGM_STEM, 0)]);
  });

  it('an input event never moves the program session, and the reverse', async () => {
    put(PGM_DIR, PGM_STEM, 0);
    put(PGM_DIR, PGM_STEM, 1);
    put(IN_DIR, IN_STEM, 0);
    await started();
    // An input file opening (even with Strom renaming the block) must not count for program.
    socket!.onEvent({
      type: 'RecorderFileChanged',
      data: { flow_id: 'flow-iso', block_id: 'renamed', filename: `${IN_DIR}/${fileName(IN_STEM, 1)}` },
    });
    await waitForLiveRecordingPass(PROD);
    fileChanged('b-out-pgm', PGM_DIR, PGM_STEM, 1);
    await waitForLiveRecordingPass(PROD);
    const paths = mockUploadFile.mock.calls.map((c) => (c[1] as { path: string }).path);
    // Program part 0 closed by the program event; input part 0 closed by the
    // input event (Strom may rename blocks, so matched by exact directory).
    expect(paths.sort()).toEqual([`${IN_DIR}/${fileName(IN_STEM, 0)}`, `${PGM_DIR}/${fileName(PGM_STEM, 0)}`].sort());
    const pgmDoc = recordingDocs.get(recordingDocId('vod', `${PROD}/${fileName(PGM_STEM, 0)}`));
    expect(pgmDoc).toMatchObject({ kind: 'program' });
    expect(pgmDoc).not.toHaveProperty('mixerInput');
  });

  it('re-registering an input part updates the same RecordingDoc', async () => {
    put(IN_DIR, IN_STEM, 0);
    put(IN_DIR, IN_STEM, 1);
    mockDeleteFile.mockRejectedValueOnce(new Error('Strom 500'));
    await started();
    fileChanged('b-inrec-15', IN_DIR, IN_STEM, 1);
    await waitForLiveRecordingPass(PROD);
    fileChanged('b-inrec-15', IN_DIR, IN_STEM, 1);
    await waitForLiveRecordingPass(PROD);
    expect(mockUploadFile).toHaveBeenCalledTimes(2);
    expect([...recordingDocs.values()].filter((d) => d['kind'] === 'input')).toHaveLength(1);
  });

  it('stopping returns the program session with each input session by mixerInput', async () => {
    put(IN_DIR, IN_STEM, 0);
    await started();
    fileChanged('b-inrec-15', IN_DIR, IN_STEM, 0);
    await waitForLiveRecordingPass(PROD);
    const session = await stopLiveRecordingUpload(PROD);
    expect(session?.activationId).toBe('flow-iso');
    const input = session?.inputs?.get(IN);
    expect(input).toMatchObject({ activationId: 'flow-iso', stem: IN_STEM });
    expect(input?.openedAt.has(fileName(IN_STEM, 0))).toBe(true);
    expect(await stopLiveRecordingUpload(PROD)).toBeUndefined();
  });

  it('a production without input recording has no inputs on its session', async () => {
    startLiveRecordingUpload({ ...doc, inputRecordings: undefined }, log);
    await vi.waitFor(() => expect(socket).toBeDefined());
    const session = await stopLiveRecordingUpload(PROD);
    expect(session).toBeDefined();
    expect(session!.inputs).toBeUndefined();
  });
});
