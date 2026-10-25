/**
 * Part 0 of an activation is timed by its recorder event (spec
 * iso-input-recording.md §6 rule 2, #569 AC 3), not by its file name.
 *
 * The flow starts — and program and every input recorder open part 0 — before
 * activation reaches `active` and starts the live sessions. Activation holds
 * the shared recorder-event socket open from before `flows.start`, and the
 * sessions replay the flow's buffered events with their receipt time.
 *
 * Here the mocked `activateStromFlow` (standing in for `flows.start`) emits
 * part 0 of program and of an SRT input on the fake socket, and the first
 * running-poll still reports the flow as not running. CouchDB, Strom's REST
 * client, the upload target and the uploader are mocked; the activation route,
 * the live sessions and the shared socket are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OutputDoc, ProductionDoc } from '../db/types.js';

const productions = new Map<string, ProductionDoc>();
const outputs = new Map<string, OutputDoc>();
const recordingDocs = new Map<string, Record<string, unknown>>();
let rev = 1;

function notFound(): Error {
  return Object.assign(new Error('not_found'), { statusCode: 404 });
}

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = productions.get(id);
      if (!doc) throw notFound();
      return structuredClone(doc);
    }),
    insert: vi.fn(async (doc: ProductionDoc) => {
      const stored = JSON.parse(JSON.stringify({ ...doc, _rev: `${++rev}-x` })) as ProductionDoc;
      productions.set(doc._id, stored);
      return { ok: true, id: doc._id, rev: stored._rev };
    }),
    find: vi.fn(async () => ({ docs: [] })),
    findTrusted: vi.fn(async () => ({ docs: [] })),
  }),
  getOutputsDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = outputs.get(id);
      if (!doc) throw notFound();
      return doc;
    }),
    find: vi.fn(), insert: vi.fn(), destroy: vi.fn(),
  }),
  getRecordingsDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = recordingDocs.get(id);
      if (!doc) throw notFound();
      return doc;
    }),
    find: vi.fn(),
    insert: vi.fn(async (doc: Record<string, unknown>) => {
      recordingDocs.set(doc['_id'] as string, { ...doc, _rev: '1-x' });
      return { ok: true };
    }),
  }),
  getSourcesDb: () => ({ get: vi.fn(async () => { throw notFound(); }) }),
  getGuestInvitesDb: () => ({ find: vi.fn(async () => ({ docs: [] })), destroy: vi.fn() }),
  getGuestSessionsDb: () => ({ find: vi.fn(async () => ({ docs: [] })), insert: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
  clearClipStateForProduction: vi.fn(),
  reinitConnectedControllers: vi.fn().mockResolvedValue(undefined),
}));

const mockActivateStromFlow = vi.fn();
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: (...args: unknown[]) => mockActivateStromFlow(...args),
  deactivateStromFlow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue('test-token') }));

const mockFlowsGet = vi.fn();
const mockList = vi.fn();
vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  return {
    ...actual,
    StromClient: class {
      flows = { get: mockFlowsGet };
      mixer = { multiviewEndpoint: vi.fn().mockResolvedValue(null) };
      media = { list: mockList, deleteFile: vi.fn().mockResolvedValue({ success: true }) };
    },
  };
});

vi.mock('../services/guest-sweep.js', () => ({ sweepGuestsOnProductionEnd: vi.fn().mockResolvedValue(undefined) }));

const target = { endpoint: 'silo.local', useSsl: true, region: 'us-east-1', accessKey: 'a', secretKey: 's', bucket: 'vod' };
vi.mock('../lib/recording-upload-target.js', () => ({
  resolveRecordingUploadTarget: vi.fn(async () => ({ target })),
}));

vi.mock('../lib/recording-uploader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/recording-uploader.js')>();
  return {
    ...actual,
    uploadRecordingFile: vi.fn(async (args: { productionId: string; mixerInput?: string }, e: { name: string; path: string; size: number }) => ({
      key: args.mixerInput ? `${args.productionId}/${args.mixerInput}/${e.name}` : `${args.productionId}/${e.name}`,
      sizeBytes: e.size,
      stromPath: e.path,
      // The file-name stamp: second-truncated and early, as Strom writes it.
      startedAt: '2026-11-01T18:00:00.000Z',
      durationMs: 300_000,
    })),
  };
});

const { buildServer } = await import('../server.js');
const { config } = await import('../config.js');
const { stopLiveRecordingUpload, setPartStableMsForTests } = await import('../services/live-recording-upload.js');
const {
  setRecorderSocketFactory, resetRecorderEvents, recorderEventSubscriberCount,
} = await import('../services/strom-recorder-events.js');
type Handlers = import('../services/strom-recorder-events.js').RecorderSocketHandlers;

const NOW = '2026-11-01T17:59:00.000Z';
const PROD = 'prod-1';
const FLOW = 'flow-1';
const PGM_DIR = `recordings/${PROD}`;
const IN = 'video_in_2';
const IN_DIR = `${PGM_DIR}/${IN}`;
const PGM_STEM = `${PROD}_20261101_180000`;
const IN_STEM = `${PROD}_${IN}_20261101_180000`;
const fileName = (stem: string, i: number) => `${stem}_${String(i).padStart(5, '0')}.mp4`;
/** When open-live received part 0's events: program, then the input 300 ms later. */
const PGM_OPENED_MS = Date.parse('2026-11-01T18:00:01.420Z');
const IN_OPENED_MS = PGM_OPENED_MS + 300;

const inputRecorder = {
  mixerInput: IN, sourceId: 'src-srt', sourceName: 'Camera 2', streamType: 'srt' as const,
  recorderBlockId: 'b-inrec-2-x', outputDir: IN_DIR,
};

let socket: Handlers | undefined;
let listings: Record<string, Array<{ name: string; path: string; is_dir: boolean; size: number }>>;
let segmentSecs: number;

function put(dir: string, stem: string, i: number): void {
  (listings[dir] ??= []).push({ name: fileName(stem, i), path: `${dir}/${fileName(stem, i)}`, is_dir: false, size: 4000 + i });
}

function fileChanged(blockId: string, dir: string, stem: string, i: number, atMs?: number): void {
  const now = atMs !== undefined ? vi.spyOn(Date, 'now').mockReturnValue(atMs) : undefined;
  socket!.onEvent({ type: 'RecorderFileChanged', data: { flow_id: FLOW, block_id: blockId, filename: `${dir}/${fileName(stem, i)}` } });
  now?.mockRestore();
}

beforeEach(() => {
  productions.clear();
  outputs.clear();
  recordingDocs.clear();
  listings = {};
  socket = undefined;
  segmentSecs = config.recordingSegmentSecs;
  (config as { recordingSegmentSecs: number }).recordingSegmentSecs = 300;
  setPartStableMsForTests(0);
  setRecorderSocketFactory(async (h) => {
    socket = h;
    queueMicrotask(() => h.onOpen());
    return () => {};
  });
  mockList.mockImplementation(async (dir: string) => ({ entries: (listings[dir] ?? []).map((e) => ({ ...e })) }));
  outputs.set('output-rec', {
    _id: 'output-rec', type: 'output', name: 'VOD', outputType: 'recording', createdAt: NOW, updatedAt: NOW,
  });
  productions.set(PROD, {
    _id: PROD, _rev: '1-x', type: 'production', name: 'Show', status: 'inactive', sources: [],
    outputAssignments: [{ outputId: 'output-rec' }], tally: { pgm: null, pvw: null }, createdAt: NOW, updatedAt: NOW,
  } as unknown as ProductionDoc);
});

afterEach(async () => {
  await stopLiveRecordingUpload(PROD);
  resetRecorderEvents();
  setRecorderSocketFactory(undefined);
  setPartStableMsForTests(undefined);
  (config as { recordingSegmentSecs: number }).recordingSegmentSecs = segmentSecs;
});

describe('part 0 start time of an activation (spec §6, #569 AC 3)', () => {
  it('registers program and SRT input part 0 by their recorder events, received before the production was active', async () => {
    let statusAtStart: string | undefined;
    mockActivateStromFlow.mockImplementation(async () => {
      // flows.start: both recorders open part 0 at once, while still activating.
      expect(socket).toBeDefined();
      statusAtStart = productions.get(PROD)?.status;
      put(PGM_DIR, PGM_STEM, 0);
      put(IN_DIR, IN_STEM, 0);
      fileChanged('b-out-rec', PGM_DIR, PGM_STEM, 0, PGM_OPENED_MS);
      fileChanged(inputRecorder.recorderBlockId, IN_DIR, IN_STEM, 0, IN_OPENED_MS);
      return {
        flowId: FLOW, mixerBlockId: null, audioMixerBlockId: null, loudnessMainBlockId: null,
        recorderBlockId: 'b-out-rec', recorderType: 'liverecorder', recorderOutputId: 'output-rec',
        inputRecorders: [inputRecorder], whepOutputEntries: undefined, pgmWhepEndpointId: undefined, warnings: [],
        sourceOffsetBlockIds: {}, sourceAudioOffsetBlockIds: {}, clipPlayerBlockIds: {}, returnBuses: [],
        returnWhepEntries: [], mixerInputMap: {},
      };
    });
    // The first running-poll still sees the flow starting: the sessions start later.
    mockFlowsGet
      .mockResolvedValueOnce({ flow: { id: FLOW, running: false, blocks: [] } })
      .mockResolvedValue({ flow: { id: FLOW, running: true, blocks: [] } });

    const app = await buildServer();
    await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/activate` });
    await vi.waitFor(() => expect(productions.get(PROD)?.status).toBe('active'), { timeout: 3000 });
    expect(statusAtStart).toBe('activating');
    // Activation's own hold is gone; the program and input sessions remain.
    await vi.waitFor(() => expect(recorderEventSubscriberCount()).toBe(2));

    // Both recorders split: part 0 is closed and uploaded live.
    put(PGM_DIR, PGM_STEM, 1);
    put(IN_DIR, IN_STEM, 1);
    fileChanged('b-out-rec', PGM_DIR, PGM_STEM, 1);
    fileChanged(inputRecorder.recorderBlockId, IN_DIR, IN_STEM, 1);
    await vi.waitFor(() => expect(recordingDocs.size).toBe(2));

    const docs = [...recordingDocs.values()];
    const pgm = docs.find((d) => d['kind'] === 'program')!;
    const input = docs.find((d) => d['kind'] === 'input')!;
    expect(pgm).toMatchObject({ key: `${PROD}/${fileName(PGM_STEM, 0)}`, partIndex: 0, activationId: FLOW, startedAtSource: 'event' });
    expect(input).toMatchObject({
      key: `${PROD}/${IN}/${fileName(IN_STEM, 0)}`, partIndex: 0, activationId: FLOW, mixerInput: IN,
      streamType: 'srt', startedAtSource: 'event',
    });
    expect(pgm['startedAt']).toBe(new Date(PGM_OPENED_MS).toISOString());
    expect(input['startedAt']).toBe(new Date(IN_OPENED_MS).toISOString());
    expect(Math.abs(Date.parse(input['startedAt'] as string) - Date.parse(pgm['startedAt'] as string))).toBeLessThanOrEqual(1000);
  });

  it('releases the hold when activation fails before any session starts', async () => {
    mockActivateStromFlow.mockRejectedValue(new Error('flows.start failed'));
    const app = await buildServer();
    await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/activate` });
    await vi.waitFor(() => expect(mockActivateStromFlow).toHaveBeenCalled());
    await vi.waitFor(() => expect(productions.get(PROD)?.status).toBe('inactive'));
    await vi.waitFor(() => expect(recorderEventSubscriberCount()).toBe(0));
  });
});
